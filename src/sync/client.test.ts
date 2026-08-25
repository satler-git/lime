import { describe, expect, it, vi } from 'vitest'
import {
  MAX_SYNC_FIELD_BYTES,
  MAX_SYNC_ITEMS_PER_TYPE,
  MAX_SYNC_RECORD_BYTES,
  MAX_SYNC_REQUEST_BODY_BYTES,
  MAX_SYNC_RESPONSE_BODY_BYTES,
  SyncClient,
  SyncClientError,
  SyncInvalidResponseError,
  SyncPayloadTooLargeError,
  SyncUnauthorizedError,
  type SyncFetch,
} from './index'
import type { SyncRequest } from './types'

const responseFor = (value: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init })

const card = {
  id: 'card-1',
  word: 'hola',
  createdAt: '2025-01-01T00:00:00.000Z',
  due: '2025-01-02T00:00:00.000Z',
  stability: 0,
  difficulty: 0,
  elapsedDays: 0.5,
  scheduledDays: 0.5,
  learningSteps: 0,
  reps: 0,
  lapses: 0,
  state: 'new' as const,
  lastReview: null,
}

const batch: SyncRequest = {
  cards: [{ card, updatedAt: '2025-01-03T00:00:00.000Z' }],
  reviewActions: [],
  sessions: [],
}

const serializeErrorGraph = (value: unknown, seen = new Set<object>()): string => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  return Object.getOwnPropertyNames(value)
    .map((property) => `${property}:${serializeErrorGraph(Object.getOwnPropertyDescriptor(value, property)?.value, seen)}`)
    .join('|')
}

describe('SyncClient', () => {
  it('pulls and sanitizes a same-origin Worker response', async () => {
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({
      cards: [{ card: { ...card, serverOnly: 'not returned' }, updatedAt: batch.cards[0]?.updatedAt }],
      reviewActions: [],
      sessions: [],
      serverOnly: 'not returned',
    }))
    const client = new SyncClient({ baseUrl: 'https://app.example.test/', origin: 'https://app.example.test', fetch: fetcher })

    await expect(client.pull()).resolves.toEqual(batch)
    expect(fetcher).toHaveBeenCalledWith('https://app.example.test/api/sync', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
  })

  it('rejects cross-origin absolute and every protocol-relative base URL', () => {
    const fetcher = vi.fn<SyncFetch>()
    expect(() => new SyncClient({ baseUrl: 'https://evil.example', origin: 'https://app.example.test', fetch: fetcher })).toThrow('same-origin')
    for (const baseUrl of ['//evil.example', '//app.example.test', '///app.example.test']) {
      expect(() => new SyncClient({ baseUrl, origin: 'https://app.example.test', fetch: fetcher })).toThrow(/protocol-relative/i)
    }
    for (const baseUrl of ['\\\\evil.example', 'https:\\\\evil.example', 'https://app.example.test\\deployment']) {
      expect(() => new SyncClient({ baseUrl, origin: 'https://app.example.test', fetch: fetcher })).toThrow(/backslash/i)
    }
    for (const baseUrl of [
      '/deployment?query',
      '/deployment#fragment',
      '/deployment path',
      '/deployment\tpath',
      'https://app.example.test\u0000/deployment',
    ]) {
      expect(() => new SyncClient({ baseUrl, origin: 'https://app.example.test', fetch: fetcher })).toThrow(/(?:query|fragment|whitespace|control)/i)
    }
    for (const baseUrl of [
      'https://user@app.example.test',
      'https://:password@app.example.test',
      'https://@app.example.test',
      'https://:@app.example.test',
    ]) {
      expect(() => new SyncClient({ baseUrl, origin: 'https://app.example.test', fetch: fetcher })).toThrow(/credentials/i)
    }
    for (const origin of [
      'https://user@app.example.test',
      'https://:@app.example.test',
      'https://app.example.test/',
      'https://app.example.test/path',
      'https://app.example.test?query',
      'https://app.example.test#fragment',
    ]) {
      expect(() => new SyncClient({ baseUrl: '/deployment', origin, fetch: fetcher })).toThrow(/origin/i)
    }
    expect(() => new SyncClient({ baseUrl: 'https://app.example.test', fetch: fetcher })).toThrow('expected origin')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('allows an explicit same-origin absolute base URL and keeps relative paths working', async () => {
    const sameOriginFetcher = vi.fn<SyncFetch>(async () => responseFor(batch))
    const sameOriginClient = new SyncClient({
      baseUrl: 'https://app.example.test/deployment',
      origin: 'https://app.example.test',
      fetch: sameOriginFetcher,
    })
    await expect(sameOriginClient.pull()).resolves.toEqual(batch)
    expect(sameOriginFetcher).toHaveBeenCalledWith('https://app.example.test/deployment/api/sync', expect.anything())

    const relativeFetcher = vi.fn<SyncFetch>(async () => responseFor(batch))
    await expect(new SyncClient({ baseUrl: '/deployment', fetch: relativeFetcher }).pull()).resolves.toEqual(batch)
    expect(relativeFetcher).toHaveBeenCalledWith('/deployment/api/sync', expect.anything())
  })

  it('pushes JSON with same-origin credentials and returns the validated summary', async () => {
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({ summary: { cards: 1, reviewActions: 0, sessions: 0 }, ignored: 'field' }))
    const client = new SyncClient({ baseUrl: 'https://app.example.test', origin: 'https://app.example.test', fetch: fetcher })

    await expect(client.push(batch)).resolves.toEqual({ summary: { cards: 1, reviewActions: 0, sessions: 0 } })
    expect(fetcher).toHaveBeenCalledWith('https://app.example.test/api/sync', expect.objectContaining({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
    }))
    const request = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual(batch)
  })

  it('requires successful sync responses to declare application/json', async () => {
    for (const contentType of [undefined, 'text/html']) {
      const responseInit: ResponseInit = contentType === undefined ? {} : { headers: { 'Content-Type': contentType } }
      const fetcher = vi.fn<SyncFetch>(async () => new Response(JSON.stringify(batch), responseInit))
      const client = new SyncClient({ fetch: fetcher })

      await expect(client.pull()).rejects.toBeInstanceOf(SyncInvalidResponseError)
    }

    const parameterized = vi.fn<SyncFetch>(async () => responseFor(batch, {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }))
    await expect(new SyncClient({ fetch: parameterized }).pull()).resolves.toEqual(batch)

    const pushFetcher = vi.fn<SyncFetch>(async () => new Response(JSON.stringify({ summary: { cards: 1, reviewActions: 0, sessions: 0 } }), {
      headers: { 'Content-Type': 'text/plain' },
    }))
    await expect(new SyncClient({ fetch: pushFetcher }).push(batch)).rejects.toBeInstanceOf(SyncInvalidResponseError)
  })

  it('rejects unsafe summary counts', async () => {
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({
      summary: { cards: Number.MAX_SAFE_INTEGER + 1, reviewActions: 0, sessions: 0 },
    }))
    const client = new SyncClient({ fetch: fetcher })

    await expect(client.push(batch)).rejects.toBeInstanceOf(SyncInvalidResponseError)
  })

  it('rejects summary counts above the shared item cap', async () => {
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({
      summary: { cards: MAX_SYNC_ITEMS_PER_TYPE + 1, reviewActions: 0, sessions: 0 },
    }))
    const client = new SyncClient({ fetch: fetcher })

    await expect(client.push(batch)).rejects.toBeInstanceOf(SyncInvalidResponseError)
  })

  it('turns unauthorized responses into a typed safe error', async () => {
    const secret = 'session-secret-not-for-errors'
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({ error: secret }, { status: 401 }))
    const client = new SyncClient({ fetch: fetcher })

    const error = await client.pull().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncUnauthorizedError)
    expect(error).toBeInstanceOf(SyncClientError)
    expect((error as Error).message).toBe('Sync authentication required')
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('cancels sync response bodies on 401, 413, and media-type failures', async () => {
    const responseFor = (status: number, contentType?: string) => {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({ cancel })
      const response = new Response(stream, {
        status,
        headers: contentType === undefined ? {} : { 'Content-Type': contentType },
      })
      return { response, cancel }
    }

    const unauthorized = responseFor(401, 'application/json')
    await expect(new SyncClient({ fetch: vi.fn<SyncFetch>().mockResolvedValue(unauthorized.response) }).pull()).rejects.toBeInstanceOf(SyncUnauthorizedError)
    const tooLarge = responseFor(413, 'application/json')
    await expect(new SyncClient({ fetch: vi.fn<SyncFetch>().mockResolvedValue(tooLarge.response) }).pull()).rejects.toBeInstanceOf(SyncPayloadTooLargeError)
    const wrongType = responseFor(200, 'text/html')
    await expect(new SyncClient({ fetch: vi.fn<SyncFetch>().mockResolvedValue(wrongType.response) }).pull()).rejects.toBeInstanceOf(SyncInvalidResponseError)

    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(unauthorized.cancel).toHaveBeenCalled()
    expect(tooLarge.cancel).toHaveBeenCalled()
    expect(wrongType.cancel).toHaveBeenCalled()
  })

  it('rejects malformed responses without retaining response details', async () => {
    const secret = 'response-secret-not-for-errors'
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({ cards: [{ secret }], reviewActions: [], sessions: [] }))
    const client = new SyncClient({ fetch: fetcher })

    const error = await client.pull().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncInvalidResponseError)
    expect((error as Error).message).toBe('Invalid sync response')
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('rejects an oversized outbound body before invoking fetch', async () => {
    const secret = 'oversized-body-secret'
    const fetcher = vi.fn<SyncFetch>()
    const client = new SyncClient({ fetch: fetcher })
    const oversizedBatch: SyncRequest = {
      cards: [{ card: { ...card, word: `${secret}${'x'.repeat(MAX_SYNC_REQUEST_BODY_BYTES)}` }, updatedAt: batch.cards[0]?.updatedAt ?? '' }],
      reviewActions: [],
      sessions: [],
    }

    const error = await client.push(oversizedBatch).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncPayloadTooLargeError)
    expect(fetcher).not.toHaveBeenCalled()
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('passes AbortSignal through and reports cancellation safely', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<SyncFetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal)
      throw { name: 'AbortError', detail: 'secret-abort-detail' }
    })
    const client = new SyncClient({ fetch: fetcher })

    const error = await client.pull(controller.signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncClientError)
    expect((error as SyncClientError).kind).toBe('aborted')
    expect(serializeErrorGraph(error)).not.toContain('secret-abort-detail')
  })

  it('does not echo network failure details', async () => {
    const secret = 'network-secret-not-for-errors'
    const failure = Object.assign(new Error(`request URL includes ${secret}`), { headers: { Authorization: secret } })
    const fetcher = vi.fn<SyncFetch>(async () => { throw failure })
    const client = new SyncClient({ fetch: fetcher })

    const error = await client.pull().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncClientError)
    expect((error as Error).message).toBe('Sync request failed')
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('maps an HTTP 413 response to a safe payload-too-large error', async () => {
    const secret = 'server-payload-details'
    const fetcher = vi.fn<SyncFetch>(async () => responseFor({ error: secret }, { status: 413 }))
    const client = new SyncClient({ fetch: fetcher })

    const error = await client.pull().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncPayloadTooLargeError)
    expect((error as SyncClientError).status).toBe(413)
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('rejects a response over the byte limit without parsing or retaining its contents', async () => {
    const secret = 'oversized-response-secret'
    const fetcher = vi.fn<SyncFetch>(async () => responseFor(secret, {
      headers: { 'Content-Length': String(MAX_SYNC_RESPONSE_BODY_BYTES + 1) },
    }))
    const client = new SyncClient({ fetch: fetcher })

    const error = await client.pull().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncInvalidResponseError)
    expect((error as Error).message).toBe('Invalid sync response')
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('bounds a response when its length is not declared', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        controller.enqueue(new Uint8Array(MAX_SYNC_RESPONSE_BODY_BYTES))
        controller.close()
      },
    })
    const fetcher = vi.fn<SyncFetch>(async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = new SyncClient({ fetch: fetcher })

    await expect(client.pull()).rejects.toBeInstanceOf(SyncInvalidResponseError)
  })

  it('reports an abort that happens after headers while reading response chunks', async () => {
    const controller = new AbortController()
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{'))
      },
    })
    const fetcher = vi.fn<SyncFetch>(async () => new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }))
    const client = new SyncClient({ fetch: fetcher })
    const pending = client.pull(controller.signal)
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    controller.abort()

    const error = await pending.catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(SyncClientError)
    expect((error as SyncClientError).kind).toBe('aborted')
  })
})
