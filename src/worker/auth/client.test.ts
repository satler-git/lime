import { describe, expect, it, vi } from 'vitest'
import {
  AuthClient,
  AuthClientError,
  AuthInvalidResponseError,
  createAuthClient,
  MAX_AUTH_RESPONSE_BODY_BYTES,
  type AuthFetch,
} from './index'

const jsonResponse = (value: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
  ...init,
})

const serializeErrorGraph = (value: unknown, seen = new Set<object>()): string => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)
  return Object.getOwnPropertyNames(value)
    .map((property) => `${property}:${serializeErrorGraph(Object.getOwnPropertyDescriptor(value, property)?.value, seen)}`)
    .join('|')
}

describe('AuthClient', () => {
  it('navigates to the relative Google login route without fetching or handling an OAuth code', () => {
    const fetcher = vi.fn<AuthFetch>()
    const redirect = vi.fn()
    const client = createAuthClient({ fetch: fetcher, redirect })

    client.login()

    expect(redirect).toHaveBeenCalledWith('/auth/google')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('can use an injected location assign function when no redirect override is supplied', () => {
    const assign = vi.fn()
    const client = new AuthClient({
      location: { origin: 'https://app.example.test', assign },
      fetch: vi.fn<AuthFetch>(),
    })

    client.login()

    expect(assign).toHaveBeenCalledWith('/auth/google')
  })

  it('resolves login and API routes under a relative deployment base path', () => {
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const redirect = vi.fn()
    const client = new AuthClient({ baseUrl: '/deployment/', fetch: fetcher, redirect })

    client.login()
    expect(redirect).toHaveBeenCalledWith('/deployment/auth/google')
    return client.logout().then(() => {
      expect(fetcher).toHaveBeenCalledWith('/deployment/auth/logout', expect.anything())
    })
  })

  it('resolves login and API routes under an absolute base URL path', () => {
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(new Response(null, { status: 204 }))
    const redirect = vi.fn()
    const client = new AuthClient({
      baseUrl: 'https://app.example.test/api',
      origin: 'https://app.example.test',
      fetch: fetcher,
      redirect,
    })

    client.login()
    expect(redirect).toHaveBeenCalledWith('https://app.example.test/api/auth/google')
    return client.logout().then(() => {
      expect(fetcher).toHaveBeenCalledWith('https://app.example.test/api/auth/logout', expect.anything())
    })
  })

  it('rejects cross-origin and protocol-relative base URLs before any operation', () => {
    const fetcher = vi.fn<AuthFetch>()
    const options = { fetch: fetcher, origin: 'https://app.example.test', redirect: vi.fn() }

    expect(() => new AuthClient({ ...options, baseUrl: 'https://evil.example' })).toThrow('same-origin')
    for (const baseUrl of ['//evil.example', '//app.example.test', '///app.example.test']) {
      expect(() => new AuthClient({ ...options, baseUrl })).toThrow(/protocol-relative/i)
    }
    for (const baseUrl of ['\\\\evil.example', 'https:\\\\evil.example', 'https://app.example.test\\deployment']) {
      expect(() => new AuthClient({ ...options, baseUrl })).toThrow(/backslash/i)
    }
    for (const baseUrl of [
      '/deployment?query',
      '/deployment#fragment',
      '/deployment path',
      '/deployment\tpath',
      'https://app.example.test?query',
      'https://app.example.test#fragment',
      'https://app.example.test\u0000/deployment',
    ]) {
      expect(() => new AuthClient({ ...options, baseUrl })).toThrow(/(?:query|fragment|whitespace|control)/i)
    }
    for (const baseUrl of [
      'https://user@app.example.test',
      'https://:password@app.example.test',
      'https://@app.example.test',
      'https://:@app.example.test',
    ]) {
      expect(() => new AuthClient({ ...options, baseUrl })).toThrow(/credentials/i)
    }
    for (const origin of [
      'https://user@app.example.test',
      'https://:@app.example.test',
      'https://app.example.test/',
      'https://app.example.test/path',
      'https://app.example.test?query',
      'https://app.example.test#fragment',
    ]) {
      expect(() => new AuthClient({ ...options, origin })).toThrow(/origin/i)
    }
    expect(() => new AuthClient({ ...options, baseUrl: 'https://app.example.test' })).not.toThrow()
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('gets and sanitizes the current user with same-origin no-store credentials', async () => {
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({
      user: {
        id: 'user-1',
        email: 'reader@example.test',
        name: 'Reader',
        picture: null,
        googleId: 'provider-id',
        accessToken: 'must-not-be-exposed',
      },
    }))
    const client = new AuthClient({ fetch: fetcher })

    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 'user-1',
      email: 'reader@example.test',
      name: 'Reader',
      picture: null,
    })
    expect(fetcher).toHaveBeenCalledWith('/auth/me', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    })
  })

  it('treats empty name and picture as null', async () => {
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({
      user: {
        id: 'user-1',
        email: 'reader@example.test',
        name: '',
        picture: '',
      },
    }))
    const client = new AuthClient({ fetch: fetcher })

    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 'user-1',
      email: 'reader@example.test',
      name: null,
      picture: null,
    })
  })

  it('trims and coalesces whitespace-only name and picture to null', async () => {
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({
      user: {
        id: 'user-1',
        email: 'reader@example.test',
        name: '   ',
        picture: '\t\n',
      },
    }))
    const client = new AuthClient({ fetch: fetcher })

    await expect(client.getCurrentUser()).resolves.toEqual({
      id: 'user-1',
      email: 'reader@example.test',
      name: null,
      picture: null,
    })
  })

  it('returns null for an unauthenticated current-user response', async () => {
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({ error: 'secret server detail' }, { status: 401 }))
    const client = new AuthClient({ fetch: fetcher })

    await expect(client.getCurrentUser()).resolves.toBeNull()
  })

  it('rejects malformed current-user responses with a safe typed error', async () => {
    const secret = 'malformed-response-secret'
    const fetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({ user: { id: secret, email: 42 } }))
    const client = new AuthClient({ fetch: fetcher })

    const error = await client.getCurrentUser().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthInvalidResponseError)
    expect((error as Error).message).toBe('Invalid authentication response')
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })

  it('logs out with a same-origin no-store POST and accepts 204 or a validated JSON object', async () => {
    const fetcher = vi.fn<AuthFetch>()
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, ignored: 'field' }))
    const client = new AuthClient({ fetch: fetcher })

    await expect(client.logout()).resolves.toBeUndefined()
    await expect(client.logout()).resolves.toBeUndefined()
    expect(fetcher).toHaveBeenNthCalledWith(1, '/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
    })
  })

  it('cancels auth response bodies on early status, media-type, and size failures', async () => {
    const responseFor = (status: number, contentType?: string, contentLength?: string) => {
      const cancel = vi.fn()
      const stream = new ReadableStream<Uint8Array>({ cancel })
      const response = new Response(stream, {
        status,
        headers: {
          ...(contentType === undefined ? {} : { 'Content-Type': contentType }),
          ...(contentLength === undefined ? {} : { 'Content-Length': contentLength }),
        },
      })
      return { response, cancel }
    }

    const unauthorized = responseFor(401, 'application/json')
    await expect(new AuthClient({ fetch: vi.fn<AuthFetch>().mockResolvedValue(unauthorized.response) }).getCurrentUser()).resolves.toBeNull()
    const tooLargeStatus = responseFor(413, 'application/json')
    await expect(new AuthClient({ fetch: vi.fn<AuthFetch>().mockResolvedValue(tooLargeStatus.response) }).logout()).rejects.toBeInstanceOf(AuthClientError)
    const wrongType = responseFor(200, 'text/html')
    await expect(new AuthClient({ fetch: vi.fn<AuthFetch>().mockResolvedValue(wrongType.response) }).getCurrentUser()).rejects.toBeInstanceOf(AuthInvalidResponseError)
    const oversized = responseFor(200, 'application/json', String(MAX_AUTH_RESPONSE_BODY_BYTES + 1))
    await expect(new AuthClient({ fetch: vi.fn<AuthFetch>().mockResolvedValue(oversized.response) }).getCurrentUser()).rejects.toBeInstanceOf(AuthInvalidResponseError)

    expect(unauthorized.cancel).toHaveBeenCalled()
    expect(tooLargeStatus.cancel).toHaveBeenCalled()
    expect(wrongType.cancel).toHaveBeenCalled()
    expect(oversized.cancel).toHaveBeenCalled()
  })

  it('rejects logout HTTP and malformed JSON responses without retaining server details', async () => {
    const secret = 'logout-server-secret'
    const httpFetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({ error: secret }, { status: 500 }))
    const httpError = await new AuthClient({ fetch: httpFetcher }).logout().catch((caught: unknown) => caught)
    expect(httpError).toBeInstanceOf(AuthClientError)
    expect((httpError as AuthClientError).kind).toBe('http')
    expect(serializeErrorGraph(httpError)).not.toContain(secret)

    for (const value of [{ success: false }, { ok: false }, { ok: true }, {}, { success: true, ok: false }]) {
      const malformedFetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse(value))
      const malformedError = await new AuthClient({ fetch: malformedFetcher }).logout().catch((caught: unknown) => caught)
      expect(malformedError).toBeInstanceOf(AuthInvalidResponseError)
      expect(serializeErrorGraph(malformedError)).not.toContain(JSON.stringify(value))
    }

    const malformedFetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse({ success: 'not-boolean' }))
    const malformedError = await new AuthClient({ fetch: malformedFetcher }).logout().catch((caught: unknown) => caught)
    expect(malformedError).toBeInstanceOf(AuthInvalidResponseError)
    expect(serializeErrorGraph(malformedError)).not.toContain('not-boolean')
  })

  it('bounds successful JSON responses at the named auth response limit', async () => {
    const secret = 'oversized-auth-response-secret'
    const declaredFetcher = vi.fn<AuthFetch>().mockResolvedValue(jsonResponse(secret, {
      headers: { 'Content-Length': String(MAX_AUTH_RESPONSE_BODY_BYTES + 1) },
    }))
    const declaredError = await new AuthClient({ fetch: declaredFetcher }).getCurrentUser().catch((caught: unknown) => caught)
    expect(declaredError).toBeInstanceOf(AuthInvalidResponseError)
    expect(serializeErrorGraph(declaredError)).not.toContain(secret)

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        controller.enqueue(new Uint8Array(MAX_AUTH_RESPONSE_BODY_BYTES))
        controller.close()
      },
    })
    const streamedFetcher = vi.fn<AuthFetch>().mockResolvedValue(new Response(stream, {
      headers: { 'Content-Type': 'application/json' },
    }))
    const streamedError = await new AuthClient({ fetch: streamedFetcher }).getCurrentUser().catch((caught: unknown) => caught)
    expect(streamedError).toBeInstanceOf(AuthInvalidResponseError)
  })

  it('propagates AbortSignal and reports aborts without exposing the fetch error', async () => {
    const controller = new AbortController()
    const fetcher = vi.fn<AuthFetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal)
      throw { name: 'AbortError', detail: 'abort-secret' }
    })
    const client = new AuthClient({ fetch: fetcher })

    const error = await client.logout(controller.signal).catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthClientError)
    expect((error as AuthClientError).kind).toBe('aborted')
    expect((error as Error).message).toBe('Authentication request aborted')
    expect(serializeErrorGraph(error)).not.toContain('abort-secret')
  })

  it('does not retain network failure details or a response cause', async () => {
    const secret = 'network-secret'
    const failure = Object.assign(new Error(`request URL includes ${secret}`), { cause: secret })
    const fetcher = vi.fn<AuthFetch>(async () => { throw failure })
    const client = new AuthClient({ fetch: fetcher })

    const error = await client.getCurrentUser().catch((caught: unknown) => caught)
    expect(error).toBeInstanceOf(AuthClientError)
    expect((error as Error).message).toBe('Authentication request failed')
    expect((error as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })
})
