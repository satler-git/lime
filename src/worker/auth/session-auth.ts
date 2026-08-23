import { getCookie } from 'hono/cookie'
import type { Context } from 'hono'
import { D1AuthStore } from './d1-auth-store'
import { webCryptoProvider } from './crypto'
import type { AuthDependencies, AuthSession, Env } from './types'
import { SESSION_COOKIE } from './types'

/** Resolve the existing session cookie boundary without exposing the token itself. */
export async function authenticateSession(
  c: Context<{ Bindings: Env }>,
  dependencies: AuthDependencies = {},
): Promise<AuthSession | null> {
  const token = getCookie(c, SESSION_COOKIE)
  if (token === undefined || token.length === 0) return null

  const cryptoProvider = dependencies.crypto ?? webCryptoProvider
  const store = dependencies.store ?? new D1AuthStore(c.env.DB)
  const now = dependencies.now ?? (() => Date.now())
  return store.findSession(await cryptoProvider.sha256(token), now())
}
