import type { D1Database } from '@cloudflare/workers-types'
import { describe, expect, it, vi } from 'vitest'
import { buildGoogleAuthorizationUrl } from './oauth'
import { webCryptoProvider } from './crypto'
import { createAuthApp } from './routes'
import type { AuthSession, AuthStore, CryptoProvider, Env, GoogleProfile, User } from './types'

const env: Env = {
  APP_URL: 'https://app.example.test',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
  DB: {} as D1Database,
}

const user: User = {
  id: 'user-1',
  googleId: 'google-1',
  email: 'reader@example.test',
  name: 'Reader',
  picture: null,
  createdAt: 1_000,
  updatedAt: 1_000,
}

class FakeStore implements AuthStore {
  public profile: GoogleProfile | undefined
  public session: { userId: string; tokenHash: string; expiresAt: number; now: number } | undefined
  public deletedTokenHash: string | undefined
  public sessionToFind: AuthSession | null = null

  async upsertUser(profile: GoogleProfile, id: string, now: number): Promise<User> {
    this.profile = profile
    return { ...user, id, createdAt: now, updatedAt: now }
  }

  async createSession(userId: string, tokenHash: string, expiresAt: number, now: number): Promise<void> {
    this.session = { userId, tokenHash, expiresAt, now }
  }

  async findSession(): Promise<AuthSession | null> {
    return this.sessionToFind
  }

  async deleteSession(tokenHash: string): Promise<void> {
    this.deletedTokenHash = tokenHash
  }
}

const cryptoFor = (values: number[]): CryptoProvider => ({
  async randomBytes(length) {
    return new Uint8Array(length).fill(values.shift() ?? 0)
  },
  async sha256(value) {
    return `hash:${value}`
  },
  async sha256Base64Url(value) {
    return `challenge:${value}`
  },
})

const cookieValue = (header: string | null, name: string): string => {
  const match = header?.match(new RegExp(`${name}=([^;]+)`))
  if (match === null || match === undefined) throw new Error(`Missing ${name} cookie`)
  return match[1]
}

describe('Google OAuth foundation', () => {
  it('constructs the authorization URL with the callback, requested scopes, and PKCE fields', () => {
    const url = new URL(buildGoogleAuthorizationUrl(env, 'random-state', 'random-challenge'))

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(url.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID)
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.example.test/auth/google/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toBe('openid email profile')
    expect(url.searchParams.get('state')).toBe('random-state')
    expect(url.searchParams.get('code_challenge')).toBe('random-challenge')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
  })

  it('encodes SHA-256 digests as unpadded base64url', async () => {
    await expect(webCryptoProvider.sha256Base64Url('hello'))
      .resolves.toBe('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')
  })

  it('rejects a callback when the state does not match the state cookie', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const app = createAuthApp({ fetcher })
    const response = await app.request('/auth/google/callback?code=not-used&state=wrong', {
      headers: { Cookie: 'lime_oauth_state=expected; lime_oauth_code_verifier=verifier' },
    }, env)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid authentication request' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(response.headers.get('set-cookie')).toContain('lime_oauth_state=;')
    expect(response.headers.get('set-cookie')).toContain('lime_oauth_code_verifier=;')
  })

  it('rejects a callback when the PKCE verifier is missing', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const app = createAuthApp({ fetcher })
    const response = await app.request('/auth/google/callback?code=not-used&state=expected', {
      headers: { Cookie: 'lime_oauth_state=expected' },
    }, env)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid authentication request' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(response.headers.get('set-cookie')).toContain('lime_oauth_state=;')
    expect(response.headers.get('set-cookie')).toContain('lime_oauth_code_verifier=;')
  })

  it('rejects a callback when the state is missing', async () => {
    const fetcher = vi.fn<typeof fetch>()
    const app = createAuthApp({ fetcher })
    const response = await app.request('/auth/google/callback?code=not-used', {
      headers: { Cookie: 'lime_oauth_state=expected; lime_oauth_code_verifier=verifier' },
    }, env)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid authentication request' })
    expect(fetcher).not.toHaveBeenCalled()
    expect(response.headers.get('set-cookie')).toContain('lime_oauth_state=;')
    expect(response.headers.get('set-cookie')).toContain('lime_oauth_code_verifier=;')
  })

  it('upserts the Google user and creates a hashed session', async () => {
    const store = new FakeStore()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'provider-access-token' }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        sub: 'google-1',
        email: 'reader@example.test',
        name: 'Reader',
      }), { status: 200 }))
    const app = createAuthApp({
      store,
      fetcher,
      crypto: cryptoFor([1, 2, 3]),
      now: () => 1_000,
    })

    const start = await app.request('/auth/google', {}, env)
    const state = cookieValue(start.headers.get('set-cookie'), 'lime_oauth_state')
    const codeVerifier = cookieValue(start.headers.get('set-cookie'), 'lime_oauth_code_verifier')
    const authorizationUrl = new URL(start.headers.get('location') as string)
    expect(authorizationUrl.searchParams.get('code_challenge')).toBe(`challenge:${codeVerifier}`)
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(start.headers.get('set-cookie')).toContain('lime_oauth_code_verifier=')
    expect(start.headers.get('set-cookie')).toContain('HttpOnly')
    expect(start.headers.get('set-cookie')).toContain('Secure')
    expect(start.headers.get('set-cookie')).toContain('SameSite=Lax')
    const callback = await app.request(`/auth/google/callback?code=authorization-code&state=${state}`, {
      headers: { Cookie: `lime_oauth_state=${state}; lime_oauth_code_verifier=${codeVerifier}` },
    }, env)

    expect(callback.status).toBe(302)
    expect(callback.headers.get('location')).toBe(env.APP_URL)
    expect(store.profile).toEqual({
      googleId: 'google-1',
      email: 'reader@example.test',
      name: 'Reader',
      picture: null,
    })
    expect(store.session).toMatchObject({
      userId: expect.any(String),
      tokenHash: expect.stringMatching(/^hash:/),
      now: 1_000,
      expiresAt: 1_000 + 30 * 24 * 60 * 60 * 1000,
    })
    expect(callback.headers.get('set-cookie')).toMatch(/lime_session=.*HttpOnly/)
    expect(callback.headers.get('set-cookie')).toContain('Secure')
    expect(callback.headers.get('set-cookie')).toContain('SameSite=Lax')

    const tokenRequest = fetcher.mock.calls[0]?.[1]
    expect(tokenRequest?.body).toBeInstanceOf(URLSearchParams)
    expect((tokenRequest?.body as URLSearchParams).get('code')).toBe('authorization-code')
    expect((tokenRequest?.body as URLSearchParams).get('code_verifier')).toBe(codeVerifier)
    expect((tokenRequest?.body as URLSearchParams).get('client_secret')).toBe(env.GOOGLE_CLIENT_SECRET)
  })

  it('returns a user for a live session and rejects an expired session', async () => {
    const store = new FakeStore()
    store.sessionToFind = { user, expiresAt: 2_000 }
    const app = createAuthApp({ store, crypto: cryptoFor([]), now: () => 1_500 })

    const authenticated = await app.request('/auth/me', {
      headers: { Cookie: 'lime_session=opaque-token' },
    }, env)
    expect(authenticated.status).toBe(200)
    expect(await authenticated.json()).toEqual({ user })

    store.sessionToFind = null
    const expired = await app.request('/auth/me', {
      headers: { Cookie: 'lime_session=expired-token' },
    }, env)
    expect(expired.status).toBe(401)
    expect(await expired.json()).toEqual({ error: 'Unauthorized' })
  })

  it('revokes the session and clears the cookie on logout', async () => {
    const store = new FakeStore()
    const app = createAuthApp({ store, crypto: cryptoFor([]) })

    const response = await app.request('/auth/logout', {
      method: 'POST',
      headers: { Cookie: 'lime_session=opaque-token' },
    }, env)

    expect(response.status).toBe(204)
    expect(store.deletedTokenHash).toBe('hash:opaque-token')
    expect(response.headers.get('set-cookie')).toContain('lime_session=;')
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(response.headers.get('set-cookie')).toContain('HttpOnly')
    expect(response.headers.get('set-cookie')).toContain('Secure')
  })
})
