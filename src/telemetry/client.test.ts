import { describe, expect, it, vi } from 'vitest'
import {
  MAX_TELEMETRY_ITEMS_PER_BATCH,
  MAX_TELEMETRY_REQUEST_BODY_BYTES,
  TelemetryClientError,
  TelemetryPayloadTooLargeError,
  TelemetryQueue,
  TelemetryValidationError,
  type TelemetryEvent,
  type TelemetryEventInput,
  type TelemetryFetch,
} from './index'

const event = (overrides: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'type' | 'payload'>): TelemetryEventInput => ({
  sessionId: 'session-1',
  cycleId: 'cycle-1',
  occurredAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
}) as TelemetryEventInput

const response = (): Response => new Response(null, { status: 204 })

const queueFor = (fetcher: TelemetryFetch, clientEventIdFactory = (() => {
  let count = 0
  return () => `generated-id-${count++}`
})()) => new TelemetryQueue({
  fetch: fetcher,
  clientEventIdFactory,
})

describe('TelemetryQueue', () => {
  it('validates before enqueueing and generates client event IDs', () => {
    const fetcher = vi.fn<TelemetryFetch>()
    const queue = queueFor(fetcher, () => 'fixed-client-event-id')

    const accepted = queue.enqueue(event({ type: 'cycle_end', payload: {} }))
    expect(accepted.clientEventId).toBe('fixed-client-event-id')
    expect(queue.pendingCount()).toBe(1)

    expect(() => queue.enqueue(event({ type: 'cycle_end', payload: { secret: 'do-not-accept' } as never })))
      .toThrowError(TelemetryValidationError)
    expect(queue.pendingCount()).toBe(1)
  })

  it('regenerates generated IDs that collide with pending events', () => {
    const fetcher = vi.fn<TelemetryFetch>()
    let calls = 0
    const queue = queueFor(fetcher, () => ['duplicate-id', 'duplicate-id', 'fresh-id'][calls++] ?? 'fresh-id')

    const first = queue.enqueue(event({ type: 'cycle_end', payload: {} }))
    const second = queue.enqueue(event({ type: 'scroll_backward', payload: {} }))

    expect(first.clientEventId).toBe('duplicate-id')
    expect(second.clientEventId).toBe('fresh-id')
    expect(calls).toBe(3)
    expect(queue.pendingCount()).toBe(2)
  })

  it('rejects duplicate explicit and exhausted generated IDs without dropping pending events', () => {
    const fetcher = vi.fn<TelemetryFetch>()
    const queue = queueFor(fetcher, () => 'same-id')
    queue.enqueue(event({ type: 'cycle_end', payload: {}, clientEventId: 'same-id' }))

    expect(() => queue.enqueue(event({ type: 'scroll_backward', payload: {}, clientEventId: 'same-id' })))
      .toThrowError(TelemetryValidationError)
    expect(() => queue.enqueue(event({ type: 'scroll_backward', payload: {} })))
      .toThrowError(TelemetryValidationError)
    expect(queue.pendingCount()).toBe(1)
  })

  it('preserves caller-supplied IDs for explicit replay', () => {
    const queue = queueFor(vi.fn<TelemetryFetch>(), () => 'generated-id')
    const replay = queue.enqueue(event({ type: 'cycle_end', payload: {}, clientEventId: 'imported-id' }))
    expect(replay.clientEventId).toBe('imported-id')
  })

  it('keeps flushed events and duplicate protection isolated from returned-event mutations', async () => {
    const fetcher = vi.fn<TelemetryFetch>(async () => response())
    const queue = queueFor(fetcher, () => 'original-client-event-id')
    const returned = queue.enqueue(event({
      type: 'quiz_answer',
      payload: { questionId: 'original-question', optionId: 'original-option' },
    }))

    returned.clientEventId = 'mutated-client-event-id'
    if (returned.type !== 'quiz_answer') throw new Error('Expected quiz answer event')
    returned.payload.questionId = 'injected-secret'
    returned.payload.optionId = 'mutated-option'

    expect(() => queue.enqueue(event({
      type: 'cycle_end',
      payload: {},
      clientEventId: 'original-client-event-id',
    }))).toThrowError(TelemetryValidationError)

    await queue.flush()

    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).events).toEqual([{
      sessionId: 'session-1',
      cycleId: 'cycle-1',
      clientEventId: 'original-client-event-id',
      occurredAt: '2025-01-01T00:00:00.000Z',
      type: 'quiz_answer',
      payload: { questionId: 'original-question', optionId: 'original-option' },
    }])
  })

  it('splits batches at the shared item limit', async () => {
    const fetcher = vi.fn<TelemetryFetch>(async () => response())
    const queue = queueFor(fetcher, (() => {
      let count = 0
      return () => `event-${count++}`
    })())
    for (let index = 0; index < MAX_TELEMETRY_ITEMS_PER_BATCH + 1; index += 1) {
      queue.enqueue(event({ type: 'cycle_end', payload: {} }))
    }

    await queue.flush()

    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)).events).toHaveLength(MAX_TELEMETRY_ITEMS_PER_BATCH)
    expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)).events).toHaveLength(1)
  })

  it('splits a batch before the request body byte limit', async () => {
    const fetcher = vi.fn<TelemetryFetch>(async () => response())
    const queue = queueFor(fetcher, (() => {
      let count = 0
      return () => `event-${count++}`
    })())
    const large = 'x'.repeat(256)
    for (let index = 0; index < MAX_TELEMETRY_ITEMS_PER_BATCH; index += 1) {
      queue.enqueue(event({
        sessionId: large,
        cycleId: large,
        type: 'quiz_answer',
        payload: { questionId: large, optionId: large },
      }))
    }

    await queue.flush()

    expect(fetcher.mock.calls.length).toBeGreaterThan(1)
    for (const call of fetcher.mock.calls) {
      expect(new TextEncoder().encode(String(call[1]?.body)).byteLength)
        .toBeLessThanOrEqual(MAX_TELEMETRY_REQUEST_BODY_BYTES)
    }
  })

  it('removes only events sent successfully, including when new events arrive during a flush', async () => {
    let release: (() => void) | undefined
    const fetcher = vi.fn<TelemetryFetch>(async () => new Promise<Response>((resolve) => {
      release = () => resolve(response())
    }))
    const queue = queueFor(fetcher)
    queue.enqueue(event({ type: 'cycle_end', payload: {} }))

    const flushing = queue.flush()
    queue.enqueue(event({ type: 'scroll_backward', payload: {} }))
    release?.()
    await flushing

    expect(queue.pendingCount()).toBe(1)
    expect(fetcher).toHaveBeenCalledTimes(1)
  })

  it('retains failed events and retries them', async () => {
    const fetcher = vi.fn<TelemetryFetch>()
      .mockRejectedValueOnce(new Error('network detail must not escape'))
      .mockResolvedValueOnce(response())
    const queue = queueFor(fetcher)
    queue.enqueue(event({ type: 'cycle_end', payload: {} }))

    const firstError = await queue.flush().catch((error: unknown) => error)
    expect(firstError).toBeInstanceOf(TelemetryClientError)
    expect((firstError as TelemetryClientError).kind).toBe('network')
    expect((firstError as Error).message).toBe('Telemetry request failed')
    expect(queue.pendingCount()).toBe(1)

    await queue.flush()
    expect(queue.pendingCount()).toBe(0)
    expect(fetcher).toHaveBeenCalledTimes(2)
  })

  it('passes same-origin request controls and AbortSignal, and reports aborts safely', async () => {
    const controller = new AbortController()
    const secret = 'abort-secret-must-not-escape'
    const fetcher = vi.fn<TelemetryFetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal)
      expect(init?.credentials).toBe('same-origin')
      expect(init?.cache).toBe('no-store')
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
      throw { name: 'AbortError', detail: secret }
    })
    const queue = queueFor(fetcher)
    queue.enqueue(event({ type: 'cycle_end', payload: {} }))

    const error = await queue.flush(controller.signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TelemetryClientError)
    expect((error as TelemetryClientError).kind).toBe('aborted')
    expect((error as Error).message).toBe('Telemetry request aborted')
    expect(String(error)).not.toContain(secret)
    expect(queue.pendingCount()).toBe(1)
  })

  it('does not echo HTTP or request failure details', async () => {
    const secret = 'server-secret-must-not-escape'
    const fetcher = vi.fn<TelemetryFetch>(async () => new Response(secret, { status: 500 }))
    const queue = queueFor(fetcher)
    queue.enqueue(event({ type: 'cycle_end', payload: {} }))

    const error = await queue.flush().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TelemetryClientError)
    expect((error as TelemetryClientError).kind).toBe('http')
    expect((error as Error).message).toBe('Telemetry request failed')
    expect(String(error)).not.toContain(secret)
    expect(queue.pendingCount()).toBe(1)
  })

  it('maps a server payload-limit response to a safe error and retains events', async () => {
    const fetcher = vi.fn<TelemetryFetch>(async () => new Response('server detail', { status: 413 }))
    const queue = queueFor(fetcher)
    queue.enqueue(event({ type: 'cycle_end', payload: {} }))

    const error = await queue.flush().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(TelemetryPayloadTooLargeError)
    expect((error as Error).message).toBe('Telemetry payload too large')
    expect(queue.pendingCount()).toBe(1)
  })
})
