import { validateTelemetryBatch } from './service'
import {
  MAX_TELEMETRY_ITEMS_PER_BATCH,
  MAX_TELEMETRY_REQUEST_BODY_BYTES,
  TelemetryValidationError,
  type TelemetryEvent,
  type TelemetryEventType,
} from './types'

export type TelemetryFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type TelemetryClientEventIdFactory = () => string

export type TelemetryEventInput = {
  [Type in TelemetryEventType]: Omit<Extract<TelemetryEvent, { type: Type }>, 'clientEventId'> & {
    /** Existing IDs are accepted for replay/import use; otherwise the queue generates one. */
    clientEventId?: string
  }
}[TelemetryEventType]

export type TelemetryQueueOptions = {
  /** Same-origin base URL, or a relative deployment path prefix. */
  baseUrl?: string
  /** Expected origin for validating an absolute baseUrl; defaults to the browser origin. */
  origin?: string
  fetch?: TelemetryFetch
  clientEventIdFactory?: TelemetryClientEventIdFactory
}

export type TelemetryClientErrorKind =
  | 'aborted'
  | 'network'
  | 'http'
  | 'payload-too-large'
  | 'invalid-event'

/** Safe client-side failure. It never retains fetch errors or response bodies. */
export class TelemetryClientError extends Error {
  readonly kind: TelemetryClientErrorKind
  readonly status?: number

  constructor(kind: TelemetryClientErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'TelemetryClientError'
    this.kind = kind
    this.status = status
  }
}

export class TelemetryPayloadTooLargeError extends TelemetryClientError {
  constructor() {
    super('payload-too-large', 'Telemetry payload too large', 413)
    this.name = 'TelemetryPayloadTooLargeError'
  }
}

const secureRandomUuid = (): string | undefined => {
  const crypto = globalThis.crypto
  if (crypto === undefined || typeof crypto.getRandomValues !== 'function') return undefined

  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  // Keep the fallback UUID-shaped while retaining all available entropy.
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const defaultIdFactory: TelemetryClientEventIdFactory = () => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    try { return globalThis.crypto.randomUUID() } catch {}
  }
  try {
    const secureId = secureRandomUuid()
    if (secureId !== undefined) return secureId
  } catch {}
  // Very old/non-browser runtimes may expose neither Web Crypto API.
  return `telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const MAX_ID_GENERATION_ATTEMPTS = 32

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const expectedOriginFor = (explicitOrigin: string | undefined): string | undefined => {
  const value = explicitOrigin ?? (typeof globalThis.location === 'undefined' ? undefined : globalThis.location.origin)
  if (value === undefined) return undefined

  try {
    const origin = new URL(value).origin
    if (origin === 'null') throw new TypeError()
    return origin
  } catch {
    throw new TypeError('A valid same-origin origin is required')
  }
}

const endpointFor = (baseUrl: string | undefined, expectedOrigin: string | undefined): string => {
  const value = baseUrl?.trim() ?? ''
  if (value.length === 0) return '/api/telemetry/batch'
  if (value.startsWith('//')) throw new TypeError('Protocol-relative telemetry base URLs are not supported')

  let resolvedBase: URL
  try {
    resolvedBase = new URL(value)
  } catch {
    if (value.startsWith('/')) return `${value.replace(/\/+$/, '')}/api/telemetry/batch`
    throw new TypeError('A valid telemetry base URL is required')
  }

  if (expectedOrigin === undefined) {
    throw new TypeError('An expected origin is required for an absolute telemetry base URL')
  }
  if (resolvedBase.origin !== expectedOrigin) throw new TypeError('Telemetry base URL must be same-origin')
  return new URL('/api/telemetry/batch', resolvedBase).toString()
}

const serializedBatch = (events: readonly TelemetryEvent[]): string => {
  try {
    return JSON.stringify({ events })
  } catch {
    throw new TelemetryClientError('invalid-event', 'Invalid telemetry batch')
  }
}

const byteLength = (value: string): number => new TextEncoder().encode(value).byteLength

const splitBatches = (events: readonly TelemetryEvent[]): TelemetryEvent[][] => {
  const batches: TelemetryEvent[][] = []
  let current: TelemetryEvent[] = []

  for (const event of events) {
    const candidate = [...current, event]
    const candidateBody = serializedBatch(candidate)
    const tooMany = candidate.length > MAX_TELEMETRY_ITEMS_PER_BATCH
    const tooLarge = byteLength(candidateBody) > MAX_TELEMETRY_REQUEST_BODY_BYTES

    if (current.length > 0 && (tooMany || tooLarge)) {
      batches.push(current)
      current = [event]
      const singleBody = serializedBatch(current)
      if (byteLength(singleBody) > MAX_TELEMETRY_REQUEST_BODY_BYTES) {
        throw new TelemetryPayloadTooLargeError()
      }
    } else if (current.length === 0 && tooLarge) {
      throw new TelemetryPayloadTooLargeError()
    } else {
      current = candidate
    }
  }

  if (current.length > 0) batches.push(current)
  return batches
}

const errorName = (value: unknown): unknown => isRecord(value) ? value.name : undefined

/** The narrow browser transport boundary for authenticated raw telemetry. */
export interface TelemetryTransport {
  enqueue(event: TelemetryEventInput): TelemetryEvent
  flush(signal?: AbortSignal): Promise<void>
  pendingCount(): number
}

/**
 * In-memory telemetry queue. Generated IDs are only probabilistically unique for
 * this queue's lifetime: pending collisions are retried, but IDs are not
 * persisted or reserved after flush, reload, or recreation of the queue.
 */
export class TelemetryQueue implements TelemetryTransport {
  private readonly endpoint: string
  private readonly fetcher: TelemetryFetch
  private readonly idFactory: TelemetryClientEventIdFactory
  private events: TelemetryEvent[] = []
  private activeFlush?: Promise<void>

  constructor(options: TelemetryQueueOptions = {}) {
    this.endpoint = endpointFor(options.baseUrl, expectedOriginFor(options.origin))
    const fetcher = options.fetch ?? globalThis.fetch
    if (fetcher === undefined) throw new TypeError('A fetch implementation is required')
    this.fetcher = fetcher.bind(globalThis)
    this.idFactory = options.clientEventIdFactory ?? defaultIdFactory
  }

  enqueue(event: TelemetryEventInput): TelemetryEvent {
    let candidate: unknown = event
    const generatedId = isRecord(event) && event.clientEventId === undefined
    if (generatedId) {
      let clientEventId: string | undefined
      for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
        try {
          const nextId = this.idFactory()
          if (!this.events.some((pending) => pending.clientEventId === nextId)) {
            clientEventId = nextId
            break
          }
        } catch {
          throw new TelemetryClientError('invalid-event', 'Unable to create telemetry event')
        }
      }
      if (clientEventId === undefined) {
        throw new TelemetryValidationError()
      }
      candidate = { ...event, clientEventId }
    }

    // The shared server validator provides the closed event union, bounds, and a defensive copy.
    const validated = validateTelemetryBatch({ events: [candidate] }).events[0]
    if (validated === undefined) throw new TelemetryClientError('invalid-event', 'Invalid telemetry event')
    if (this.events.some((pending) => pending.clientEventId === validated.clientEventId)) {
      // Explicit IDs are retained exactly for replay/import, but may not collide with
      // another pending event. Generated IDs have already been retried above.
      throw new TelemetryValidationError()
    }
    // Keep the queued event private, then return another copy so callers cannot mutate pending data.
    const queued = validateTelemetryBatch({ events: [validated] }).events[0]
    if (queued === undefined) throw new TelemetryClientError('invalid-event', 'Invalid telemetry event')
    this.events.push(queued)

    const returned = validateTelemetryBatch({ events: [queued] }).events[0]
    if (returned === undefined) throw new TelemetryClientError('invalid-event', 'Invalid telemetry event')
    return returned
  }

  pendingCount(): number {
    return this.events.length
  }

  flush(signal?: AbortSignal): Promise<void> {
    if (this.activeFlush !== undefined) return this.activeFlush

    const flush = this.flushPending(signal)
    this.activeFlush = flush
    void flush.then(
      () => { if (this.activeFlush === flush) this.activeFlush = undefined },
      () => { if (this.activeFlush === flush) this.activeFlush = undefined },
    )
    return flush
  }

  private async flushPending(signal: AbortSignal | undefined): Promise<void> {
    const snapshot = [...this.events]
    const batches = splitBatches(snapshot)

    for (const batch of batches) {
      const body = serializedBatch(batch)
      let response: Response
      try {
        response = await this.fetcher(this.endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body,
          ...(signal === undefined ? {} : { signal }),
        })
      } catch (error: unknown) {
        if (signal?.aborted || errorName(error) === 'AbortError') {
          throw new TelemetryClientError('aborted', 'Telemetry request aborted')
        }
        throw new TelemetryClientError('network', 'Telemetry request failed')
      }

      if (!response.ok) {
        if (response.status === 413) throw new TelemetryPayloadTooLargeError()
        throw new TelemetryClientError('http', 'Telemetry request failed', response.status)
      }
      this.removeSent(batch)
    }
  }

  private removeSent(sent: readonly TelemetryEvent[]): void {
    const sentSet = new Set(sent)
    this.events = this.events.filter((event) => !sentSet.has(event))
  }
}

export const createTelemetryQueue = (options: TelemetryQueueOptions = {}): TelemetryQueue => (
  new TelemetryQueue(options)
)
