import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import { Hono } from 'hono'
import { D1AuthStore } from './d1-auth-store'
import { authenticateSession } from './session-auth'
import { webCryptoProvider, toBase64Url } from './crypto'
import { buildGoogleAuthorizationUrl, exchangeGoogleCode, fetchGoogleProfile } from './oauth'
import { sameOrigin } from '../origin'
import type { AuthDependencies, Env } from './types'
import {
  CODE_VERIFIER_COOKIE,
  CODE_VERIFIER_MAX_AGE_SECONDS,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  STATE_COOKIE,
  STATE_MAX_AGE_SECONDS,
} from './types'

const GENERIC_AUTH_ERROR = 'Authentication failed'
const UNAUTHORIZED_ERROR = 'Unauthorized'
const FORBIDDEN_ERROR = 'Forbidden'
const CACHE_CONTROL = 'private, no-store'

const privateNoStore = (c: { header(name: string, value: string): void }): void => {
  c.header('Cache-Control', CACHE_CONTROL)
}

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
  path: '/',
  maxAge,
})

const createId = async (dependencies: Required<Pick<AuthDependencies, 'crypto'>>): Promise<string> =>
  toBase64Url(await dependencies.crypto.randomBytes(16))

export const createAuthApp = (dependencies: AuthDependencies = {}) => {
  const cryptoProvider = dependencies.crypto ?? webCryptoProvider
  const fetcher = dependencies.fetcher ?? globalThis.fetch.bind(globalThis)
  const now = dependencies.now ?? (() => Date.now())
  const app = new Hono<{ Bindings: Env }>()

  const storeFor = (env: Env) => dependencies.store ?? new D1AuthStore(env.DB)

  for (const path of ['/auth/google', '/auth/google/callback', '/auth/me', '/auth/logout'] as const) {
    app.use(path, async (c, next) => {
      privateNoStore(c)
      await next()
    })
  }

  app.get('/auth/google', async (c) => {
    try {
      const state = toBase64Url(await cryptoProvider.randomBytes(32))
      const codeVerifier = toBase64Url(await cryptoProvider.randomBytes(32))
      const codeChallenge = await cryptoProvider.sha256Base64Url(codeVerifier)
      setCookie(c, STATE_COOKIE, state, cookieOptions(STATE_MAX_AGE_SECONDS))
      setCookie(c, CODE_VERIFIER_COOKIE, codeVerifier, cookieOptions(CODE_VERIFIER_MAX_AGE_SECONDS))
      return c.redirect(buildGoogleAuthorizationUrl(c.env, state, codeChallenge), 302)
    } catch {
      return c.json({ error: GENERIC_AUTH_ERROR }, 500)
    }
  })

  app.get('/auth/google/callback', async (c) => {
    const stateCookie = getCookie(c, STATE_COOKIE)
    const codeVerifier = getCookie(c, CODE_VERIFIER_COOKIE)
    const state = c.req.query('state')
    deleteCookie(c, STATE_COOKIE, cookieOptions(0))
    deleteCookie(c, CODE_VERIFIER_COOKIE, cookieOptions(0))

    if (
      stateCookie === undefined ||
      state === undefined ||
      stateCookie !== state ||
      codeVerifier === undefined ||
      codeVerifier.length === 0
    ) {
      return c.json({ error: 'Invalid authentication request' }, 400)
    }

    const code = c.req.query('code')
    if (code === undefined || code.length === 0) {
      return c.json({ error: 'Invalid authentication request' }, 400)
    }

    try {
      const accessToken = await exchangeGoogleCode(c.env, code, codeVerifier, fetcher, c.req.raw.signal)
      const profile = await fetchGoogleProfile(accessToken, fetcher, c.req.raw.signal)
      const store = storeFor(c.env)
      const timestamp = now()
      const user = await store.upsertUser(profile, await createId({ crypto: cryptoProvider }), timestamp)
      const sessionToken = toBase64Url(await cryptoProvider.randomBytes(32))
      const tokenHash = await cryptoProvider.sha256(sessionToken)
      await store.createSession(user.id, tokenHash, timestamp + SESSION_MAX_AGE_SECONDS * 1000, timestamp)

      setCookie(c, SESSION_COOKIE, sessionToken, cookieOptions(SESSION_MAX_AGE_SECONDS))
      return c.redirect(c.env.APP_URL, 302)
    } catch {
      return c.json({ error: GENERIC_AUTH_ERROR }, 502)
    }
  })

  app.get('/auth/me', async (c) => {
    try {
      const session = await authenticateSession(c, { store: storeFor(c.env), crypto: cryptoProvider, now })
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
      const { id, email, name, picture } = session.user
      return c.json({ user: { id, email, name, picture } })
    } catch {
      return c.json({ error: GENERIC_AUTH_ERROR }, 500)
    }
  })

  app.post('/auth/logout', async (c) => {
    const origin = c.req.raw.headers.get('Origin')
    // Logout changes credential state, so browser CSRF protection is strict: an
    // Origin must be present and must match the configured application origin.
    if (origin === null || !sameOrigin(origin, c.env.APP_URL)) {
      return c.json({ error: FORBIDDEN_ERROR }, 403)
    }

    const sessionToken = getCookie(c, SESSION_COOKIE)
    let failed = false
    if (sessionToken !== undefined) {
      try {
        await storeFor(c.env).deleteSession(await cryptoProvider.sha256(sessionToken))
      } catch {
        failed = true
      }
    }

    deleteCookie(c, SESSION_COOKIE, cookieOptions(0))
    return failed ? c.json({ error: GENERIC_AUTH_ERROR }, 500) : c.body(null, 204)
  })

  app.onError(() => new Response(JSON.stringify({ error: GENERIC_AUTH_ERROR }), {
    status: 500,
    headers: {
      'content-type': 'application/json',
      'Cache-Control': CACHE_CONTROL,
    },
  }))

  return app
}
