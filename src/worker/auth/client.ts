import { hasControlCharacters, hasUserinfoSyntax, parseExpectedOrigin } from '../origin'
import { cancelResponseBody } from '../../response'
import type { User } from './types'

export type AuthFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type AuthRedirect = (url: string) => void

/** The browser location values used to resolve and navigate to the Worker routes. */
export type AuthClientLocation = {
  readonly origin: string
  readonly assign?: (url: string) => void
}

export type AuthClientOptions = {
  /** Same-origin base URL, or a relative deployment path prefix. */
  baseUrl?: string
  /** Expected origin for validating an absolute baseUrl; defaults to location.origin. */
  origin?: string
  /** Injectable browser location for tests and non-browser callers. */
  location?: AuthClientLocation
  fetch?: AuthFetch
  /** Injectable navigation function. login() never fetches or processes an OAuth code. */
  redirect?: AuthRedirect
}

/** The deliberately small, token-free user shape exposed to browser callers. */
export type AuthUser = Pick<User, 'id' | 'email' | 'name' | 'picture'>

export type AuthClientErrorKind =
  | 'http'
  | 'network'
  | 'aborted'
  | 'redirect'
  | 'invalid-response'

/** Maximum number of bytes buffered from a successful auth JSON response. */
export const MAX_AUTH_RESPONSE_BODY_BYTES = 64 * 1024

/** Safe typed failure from the browser auth transport. It never retains bodies or causes. */
export class AuthClientError extends Error {
  readonly kind: AuthClientErrorKind
  readonly status?: number

  constructor(kind: AuthClientErrorKind, message: string, status?: number) {
    super(message)
    this.name = 'AuthClientError'
    this.kind = kind
    this.status = status
  }
}

export class AuthInvalidResponseError extends AuthClientError {
  constructor(status?: number) {
    super('invalid-response', 'Invalid authentication response', status)
    this.name = 'AuthInvalidResponseError'
  }
}

/** The narrow browser transport boundary for the authenticated Worker auth API. */
export interface AuthClient {
  login(): void
  getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null>
  logout(signal?: AbortSignal): Promise<void>
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const errorName = (value: unknown): unknown => isRecord(value) ? value.name : undefined

const expectedOriginFor = (
  explicitOrigin: string | undefined,
  location: AuthClientLocation | undefined,
): string | undefined => {
  const value = explicitOrigin ?? location?.origin
  if (value === undefined) return undefined

  return parseExpectedOrigin(value)
}

const endpointFor = (
  baseUrl: string | undefined,
  expectedOrigin: string | undefined,
  path: '/auth/google' | '/auth/me' | '/auth/logout',
): string => {
  const value = baseUrl ?? ''
  if (value.length === 0) return path

  // Reject characters that URL parsing may normalize before construction.
  if (hasControlCharacters(value)) {
    throw new TypeError('Control characters in auth base URLs are not supported')
  }
  if (/\s/.test(value)) {
    throw new TypeError('Whitespace in auth base URLs is not supported')
  }
  // WHATWG URL parsing accepts backslashes as alternate slash syntax. Reject them
  // before construction so they cannot turn a seemingly relative value into a URL.
  if (value.includes('\\')) {
    throw new TypeError('Backslashes in auth base URLs are not supported')
  }
  if (value.startsWith('//')) {
    throw new TypeError('Protocol-relative auth base URLs are not supported')
  }

  let resolvedBase: URL
  try {
    resolvedBase = new URL(value)
  } catch {
    // Relative paths are useful in browser tests and deployments behind a path prefix.
    if (value.startsWith('/')) {
      if (value.includes('?') || value.includes('#') || /\s/.test(value)) {
        throw new TypeError('Relative auth base URLs must not contain query, fragment, or whitespace')
      }
      return `${value.replace(/\/+$/, '')}${path}`
    }
    throw new TypeError('A valid auth base URL is required')
  }

  if (hasUserinfoSyntax(value) || resolvedBase.username.length > 0 || resolvedBase.password.length > 0) {
    throw new TypeError('Auth base URLs must not contain credentials')
  }
  if (expectedOrigin === undefined) {
    throw new TypeError('An expected origin is required for an absolute auth base URL')
  }
  if (resolvedBase.origin !== expectedOrigin) {
    throw new TypeError('Auth base URL must be same-origin')
  }

  return new URL(path, resolvedBase).toString()
}

const hasJsonContentType = (response: Response): boolean => {
  const contentType = response.headers.get('Content-Type')
  return contentType !== null && contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const parseUser = (value: unknown, status: number): AuthUser => {
  if (!isRecord(value) || !isRecord(value.user)) throw new AuthInvalidResponseError(status)

  const { id, email, name, picture } = value.user
  if (
    !nonEmptyString(id) ||
    !nonEmptyString(email) ||
    (name !== null && typeof name !== 'string') ||
    (picture !== null && typeof picture !== 'string')
  ) {
    throw new AuthInvalidResponseError(status)
  }

  return { id, email, name, picture }
}

const parseLogoutResponse = (value: unknown, status: number): void => {
  if (!isRecord(value)) throw new AuthInvalidResponseError(status)

  // The documented JSON success shape is { success: true }. Explicit failure
  // markers are rejected even when they arrive alongside a successful marker.
  if (value.success === false || value.ok === false) throw new AuthInvalidResponseError(status)
  if (value.success !== true) throw new AuthInvalidResponseError(status)
  if ('success' in value && typeof value.success !== 'boolean') throw new AuthInvalidResponseError(status)
  if ('ok' in value && typeof value.ok !== 'boolean') throw new AuthInvalidResponseError(status)
}

const isAborted = (signal: AbortSignal | undefined, error: unknown): boolean => (
  signal?.aborted === true || errorName(error) === 'AbortError'
)

const responseContentLengthExceedsLimit = (response: Response): boolean => {
  const contentLength = response.headers.get('Content-Length')
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false
  const length = Number(contentLength)
  return !Number.isSafeInteger(length) || length > MAX_AUTH_RESPONSE_BODY_BYTES
}

const readBoundedResponseBody = async (response: Response, signal?: AbortSignal): Promise<string> => {
  if (signal?.aborted) throw new AuthClientError('aborted', 'Authentication request aborted')
  if (responseContentLengthExceedsLimit(response)) {
    cancelResponseBody(response)
    throw new AuthInvalidResponseError(response.status)
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
      if (signal?.aborted || aborted) throw new AuthClientError('aborted', 'Authentication request aborted')
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch (error: unknown) {
        if (isAborted(signal, error) || aborted) {
          throw new AuthClientError('aborted', 'Authentication request aborted')
        }
        throw error
      }
      if (result.done) {
        if (signal?.aborted || aborted) throw new AuthClientError('aborted', 'Authentication request aborted')
        break
      }
      size += result.value.byteLength
      if (size > MAX_AUTH_RESPONSE_BODY_BYTES) {
        await reader.cancel()
        throw new AuthInvalidResponseError(response.status)
      }
      chunks.push(result.value)
    }
  } catch (error: unknown) {
    try { await reader.cancel() } catch {}
    if (isAborted(signal, error) || aborted) {
      throw new AuthClientError('aborted', 'Authentication request aborted')
    }
    if (error instanceof AuthInvalidResponseError) throw error
    throw new AuthInvalidResponseError(response.status)
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

/** Browser/client adapter for the existing Google OAuth Worker routes. */
export class AuthClient implements AuthClient {
  private readonly loginEndpoint: string
  private readonly meEndpoint: string
  private readonly logoutEndpoint: string
  private readonly fetcher: AuthFetch
  private readonly redirect: AuthRedirect

  constructor(options: AuthClientOptions = {}) {
    const location = options.location ?? (
      typeof globalThis.location === 'undefined' ? undefined : globalThis.location
    )
    const expectedOrigin = expectedOriginFor(options.origin, location)
    this.loginEndpoint = endpointFor(options.baseUrl, expectedOrigin, '/auth/google')
    this.meEndpoint = endpointFor(options.baseUrl, expectedOrigin, '/auth/me')
    this.logoutEndpoint = endpointFor(options.baseUrl, expectedOrigin, '/auth/logout')

    const fetcher = options.fetch ?? globalThis.fetch
    if (fetcher === undefined) throw new TypeError('A fetch implementation is required')
    this.fetcher = fetcher.bind(globalThis)

    this.redirect = options.redirect ?? ((url) => {
      if (location === undefined || location.assign === undefined) {
        throw new TypeError('A redirect function is required')
      }
      location.assign(url)
    })
  }

  login(): void {
    try {
      this.redirect(this.loginEndpoint)
    } catch {
      throw new AuthClientError('redirect', 'Unable to start authentication')
    }
  }

  async getCurrentUser(signal?: AbortSignal): Promise<AuthUser | null> {
    const response = await this.request(this.meEndpoint, 'GET', signal)
    if (response.status === 401) {
      cancelResponseBody(response)
      return null
    }
    if (!response.ok) {
      cancelResponseBody(response)
      throw new AuthClientError('http', 'Authentication request failed', response.status)
    }

    const payload = await this.json(response, signal)
    return parseUser(payload, response.status)
  }

  async logout(signal?: AbortSignal): Promise<void> {
    const response = await this.request(this.logoutEndpoint, 'POST', signal)
    if (response.status === 204) {
      cancelResponseBody(response)
      return
    }
    if (!response.ok) {
      cancelResponseBody(response)
      throw new AuthClientError('http', 'Authentication request failed', response.status)
    }

    const payload = await this.json(response, signal)
    parseLogoutResponse(payload, response.status)
  }

  private async request(endpoint: string, method: 'GET' | 'POST', signal: AbortSignal | undefined): Promise<Response> {
    try {
      return await this.fetcher(endpoint, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        ...(signal === undefined ? {} : { signal }),
      })
    } catch (error: unknown) {
      if (isAborted(signal, error)) throw new AuthClientError('aborted', 'Authentication request aborted')
      throw new AuthClientError('network', 'Authentication request failed')
    }
  }

  private async json(response: Response, signal: AbortSignal | undefined): Promise<unknown> {
    if (!hasJsonContentType(response)) {
      cancelResponseBody(response)
      throw new AuthInvalidResponseError(response.status)
    }
    try {
      const body = await readBoundedResponseBody(response, signal)
      return JSON.parse(body) as unknown
    } catch (error: unknown) {
      if (isAborted(signal, error)) throw new AuthClientError('aborted', 'Authentication request aborted')
      if (error instanceof AuthInvalidResponseError) throw error
      throw new AuthInvalidResponseError(response.status)
    }
  }
}

export const createAuthClient = (options: AuthClientOptions = {}): AuthClient => new AuthClient(options)
