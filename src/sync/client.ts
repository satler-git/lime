import { hasControlCharacters, hasUserinfoSyntax, parseExpectedOrigin } from '../worker/origin'
import { cancelResponseBody } from '../response'
import {
  MAX_SYNC_ITEMS_PER_TYPE,
  MAX_SYNC_REQUEST_BODY_BYTES,
  MAX_SYNC_RESPONSE_BODY_BYTES,
  parseSyncRequest,
  type SyncBatchResponse,
  type SyncRequest,
  type SyncResponse,
} from './types'

export type SyncFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type SyncClientOptions = {
  /**
   * Same-origin base URL (or path prefix for a relative URL) used to resolve `/api/sync`.
   * Absolute URLs must resolve to the expected origin; protocol-relative URLs are not supported.
   */
  baseUrl?: string
  /**
   * Explicit expected origin for deterministic tests and SSR. In a browser, this
   * defaults to `globalThis.location.origin` when omitted.
   */
  origin?: string
  fetch?: SyncFetch
}

export type SyncClientErrorKind =
  | 'unauthorized'
  | 'http'
  | 'network'
  | 'aborted'
  | 'invalid-request'
  | 'invalid-response'
  | 'payload-too-large'

/** Safe, typed failure from the sync transport. It never retains server or fetch error details. */
export class SyncClientError extends Error {
  readonly kind: SyncClientErrorKind
  readonly status?: number

  constructor(kind: SyncClientErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'SyncClientError'
    this.kind = kind
    this.status = status
  }
}

export class SyncUnauthorizedError extends SyncClientError {
  constructor() {
    super('unauthorized', 'Sync authentication required', 401)
    this.name = 'SyncUnauthorizedError'
  }
}

export class SyncInvalidResponseError extends SyncClientError {
  constructor(status?: number) {
    super('invalid-response', 'Invalid sync response', status)
    this.name = 'SyncInvalidResponseError'
  }
}

export class SyncPayloadTooLargeError extends SyncClientError {
  constructor() {
    super('payload-too-large', 'Sync payload too large', 413)
    this.name = 'SyncPayloadTooLargeError'
  }
}

/** The browser/client boundary for the authenticated Worker sync API. */
export interface SyncTransport {
  pull(signal?: AbortSignal): Promise<SyncResponse>
  push(batch: SyncRequest, signal?: AbortSignal): Promise<SyncBatchResponse>
}

const expectedOriginFor = (explicitOrigin: string | undefined): string | undefined => {
  const value = explicitOrigin ?? (typeof globalThis.location === 'undefined' ? undefined : globalThis.location.origin)
  if (value === undefined) return undefined

  return parseExpectedOrigin(value)
}

const endpointFor = (baseUrl: string | undefined, expectedOrigin: string | undefined): string => {
  const value = baseUrl ?? ''
  if (value.length === 0) return '/api/sync'

  // Reject characters that URL parsing may normalize before construction.
  if (hasControlCharacters(value)) {
    throw new TypeError('Control characters in sync base URLs are not supported')
  }
  if (/\s/.test(value)) {
    throw new TypeError('Whitespace in sync base URLs is not supported')
  }
  // WHATWG URL parsing accepts backslashes as alternate slash syntax. Reject them
  // before construction so they cannot turn a seemingly relative value into a URL.
  if (value.includes('\\')) {
    throw new TypeError('Backslashes in sync base URLs are not supported')
  }
  if (value.startsWith('//')) {
    throw new TypeError('Protocol-relative sync base URLs are not supported')
  }

  let resolvedBase: URL
  try {
    resolvedBase = new URL(value)
  } catch {
    // Relative paths are useful in browser tests and deployments behind a path prefix.
    if (value.startsWith('/')) {
      if (value.includes('?') || value.includes('#') || /\s/.test(value)) {
        throw new TypeError('Relative sync base URLs must not contain query, fragment, or whitespace')
      }
      return `${value.replace(/\/+$/, '')}/api/sync`
    }
    throw new TypeError('A valid sync base URL is required')
  }

  if (hasUserinfoSyntax(value) || resolvedBase.username.length > 0 || resolvedBase.password.length > 0) {
    throw new TypeError('Sync base URLs must not contain credentials')
  }
  if (expectedOrigin === undefined) {
    throw new TypeError('An expected origin is required for an absolute sync base URL')
  }
  if (resolvedBase.origin !== expectedOrigin) {
    throw new TypeError('Sync base URL must be same-origin')
  }

  return new URL('/api/sync', resolvedBase).toString()
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SYNC_ITEMS_PER_TYPE

const parseBatchResponse = (value: unknown, status: number): SyncBatchResponse => {
  if (!isRecord(value) || !isRecord(value.summary)) throw new SyncInvalidResponseError(status)
  const { cards, reviewActions, sessions } = value.summary
  if (!isCount(cards) || !isCount(reviewActions) || !isCount(sessions)) {
    throw new SyncInvalidResponseError(status)
  }
  return { summary: { cards, reviewActions, sessions } }
}

const requestError = (kind: 'network' | 'aborted' | 'invalid-request', message: string): SyncClientError =>
  new SyncClientError(kind, message)

const hasJsonContentType = (response: Response): boolean => {
  const contentType = response.headers.get('Content-Type')
  return contentType !== null && contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

const responseContentLengthExceedsLimit = (response: Response): boolean => {
  const contentLength = response.headers.get('Content-Length')
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false
  const length = Number(contentLength)
  return !Number.isSafeInteger(length) || length > MAX_SYNC_RESPONSE_BODY_BYTES
}

const isAborted = (signal: AbortSignal | undefined, error: unknown): boolean => (
  signal?.aborted === true || (isRecord(error) && error.name === 'AbortError')
)

const readBoundedResponseBody = async (response: Response, signal?: AbortSignal): Promise<string> => {
  if (signal?.aborted) throw requestError('aborted', 'Sync request aborted')
  if (responseContentLengthExceedsLimit(response)) {
    cancelResponseBody(response)
    throw new SyncInvalidResponseError(response.status)
  }
  if (response.body === null) return ''

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let aborted = false
  const onAbort = () => {
    aborted = true
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted || aborted) throw requestError('aborted', 'Sync request aborted')
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error: unknown) {
        if (isAborted(signal, error) || aborted) throw requestError('aborted', 'Sync request aborted')
        throw error
      }
      if (result.done) {
        if (signal?.aborted || aborted) throw requestError('aborted', 'Sync request aborted')
        break
      }
      size += result.value.byteLength
      if (size > MAX_SYNC_RESPONSE_BODY_BYTES) {
        await reader.cancel()
        throw new SyncInvalidResponseError(response.status)
      }
      chunks.push(result.value)
    }
  } catch (error) {
    try { await reader.cancel() } catch {}
    if (isAborted(signal, error) || aborted) throw requestError('aborted', 'Sync request aborted')
    throw error
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

export class SyncClient implements SyncTransport {
  private readonly endpoint: string
  private readonly fetcher: SyncFetch

  constructor(options: SyncClientOptions = {}) {
    this.endpoint = endpointFor(options.baseUrl, expectedOriginFor(options.origin))
    const fetcher = options.fetch ?? globalThis.fetch
    if (fetcher === undefined) throw new TypeError('A fetch implementation is required')
    this.fetcher = fetcher.bind(globalThis)
  }

  async pull(signal?: AbortSignal): Promise<SyncResponse> {
    const { response, payload } = await this.request('GET', undefined, signal)
    try {
      return parseSyncRequest(payload)
    } catch {
      throw new SyncInvalidResponseError(response.status)
    }
  }

  async push(batch: SyncRequest, signal?: AbortSignal): Promise<SyncBatchResponse> {
    let body: string
    try {
      // Check the raw serialized size first so an oversized request remains the
      // typed 413-style client error even when its contents also exceed a field cap.
      const rawBody = JSON.stringify(batch)
      if (rawBody === undefined || new TextEncoder().encode(rawBody).byteLength > MAX_SYNC_REQUEST_BODY_BYTES) {
        throw new SyncPayloadTooLargeError()
      }
      // Parse so callers cannot bypass the shared per-type and per-field limits or
      // send values that the Worker would reject. The parser also strips unknown fields.
      const sanitizedBatch = parseSyncRequest(batch)
      body = JSON.stringify(sanitizedBatch)
    } catch (error) {
      if (error instanceof SyncPayloadTooLargeError) throw error
      throw requestError('invalid-request', 'Invalid sync batch')
    }

    if (new TextEncoder().encode(body).byteLength > MAX_SYNC_REQUEST_BODY_BYTES) {
      throw new SyncPayloadTooLargeError()
    }

    const { response, payload } = await this.request('POST', body, signal)
    return parseBatchResponse(payload, response.status)
  }

  private async request(
    method: 'GET' | 'POST',
    body: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<{ response: Response; payload: unknown }> {
    let response: Response
    try {
      response = await this.fetcher(this.endpoint, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(method === 'POST'
          ? { headers: { 'Content-Type': 'application/json' }, body }
          : {}),
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error: unknown) {
      if (signal?.aborted || (isRecord(error) && error.name === 'AbortError')) {
        throw requestError('aborted', 'Sync request aborted')
      }
      // Fetch errors can contain URLs, headers, response bodies, or credentials.
      throw requestError('network', 'Sync request failed')
    }

    if (response.status === 401) {
      cancelResponseBody(response)
      throw new SyncUnauthorizedError()
    }
    if (response.status === 413) {
      cancelResponseBody(response)
      throw new SyncPayloadTooLargeError()
    }
    if (!response.ok) {
      cancelResponseBody(response)
      throw new SyncClientError('http', 'Sync request failed', response.status)
    }
    // Only successful responses from the handled GET/POST sync endpoints are parsed.
    // Their media type is part of the protocol so an HTML/proxy error cannot be accepted as JSON.
    if (!hasJsonContentType(response)) {
      cancelResponseBody(response)
      throw new SyncInvalidResponseError(response.status)
    }

    try {
      const body = await readBoundedResponseBody(response, signal)
      return { response, payload: JSON.parse(body) as unknown }
    } catch (error) {
      if (signal?.aborted) throw requestError('aborted', 'Sync request aborted')
      if (error instanceof SyncClientError && error.kind === 'aborted') throw error
      if (error instanceof SyncInvalidResponseError) throw error
      // Response parsing failures may include untrusted server content; do not retain it.
      throw new SyncInvalidResponseError(response.status)
    }
  }
}

export const createSyncClient = (options: SyncClientOptions = {}): SyncClient => new SyncClient(options)
