import { Hono } from 'hono'
import type { D1Database } from '@cloudflare/workers-types'
import { authenticateSession } from '../auth/session-auth'
import type { AuthDependencies, Env } from '../auth/types'

const UNAUTHORIZED_ERROR = 'Unauthorized'
const INVALID_LIMITS_ERROR = 'Invalid limits'
const SETTINGS_ERROR = 'Settings failed'
const CACHE_CONTROL = 'private, no-store'

const privateNoStore = (c: { header(name: string, value: string): void }): void => {
  c.header('Cache-Control', CACHE_CONTROL)
}

export type UserLimits = {
  reviewLimit: number
  newLimit: number
}

export type UserLimitsResponse = {
  reviewLimit: number | null
  newLimit: number | null
}

export interface SettingsStore {
  getLimits(userId: string): Promise<UserLimits | null>
  setLimits(userId: string, limits: UserLimits, updatedAt: number): Promise<UserLimits>
}

/** D1-backed settings persistence scoped permanently to one authenticated user. */
export class D1SettingsStore implements SettingsStore {
  constructor(private readonly db: D1Database) {}

  async getLimits(userId: string): Promise<UserLimits | null> {
    const row = await this.db
      .prepare('SELECT review_limit, new_limit FROM user_settings WHERE user_id = ?')
      .bind(userId)
      .first<{ review_limit: number; new_limit: number }>()

    if (row === null) return null
    return { reviewLimit: row.review_limit, newLimit: row.new_limit }
  }

  async setLimits(userId: string, limits: UserLimits, updatedAt: number): Promise<UserLimits> {
    await this.db
      .prepare(
        `INSERT INTO user_settings (user_id, review_limit, new_limit, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET
           review_limit = excluded.review_limit,
           new_limit = excluded.new_limit,
           updated_at = excluded.updated_at`,
      )
      .bind(userId, limits.reviewLimit, limits.newLimit, updatedAt)
      .run()

    return limits
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const isNonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
)

export type SettingsRouteDependencies = {
  auth?: AuthDependencies
  store?: (env: Env) => SettingsStore
  now?: () => number
}

const defaultStore = (env: Env): SettingsStore => new D1SettingsStore(env.DB)

export const createSettingsApp = (dependencies: SettingsRouteDependencies = {}): Hono<{ Bindings: Env }> => {
  const app = new Hono<{ Bindings: Env }>()
  registerSettingsRoutes(app, dependencies)
  return app
}

export const registerSettingsRoutes = (
  app: Hono<{ Bindings: Env }>,
  dependencies: SettingsRouteDependencies = {},
): void => {
  const storeFor = dependencies.store ?? defaultStore
  const auth = dependencies.auth ?? {}
  const now = dependencies.now ?? (() => Date.now())

  app.use('/api/settings/limits', async (c, next) => {
    privateNoStore(c)
    await next()
  })

  app.get('/api/settings/limits', async (c) => {
    try {
      const session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)

      const limits = await storeFor(c.env).getLimits(session.user.id)
      if (limits === null) {
        return c.json({ reviewLimit: null, newLimit: null } as UserLimitsResponse)
      }

      return c.json({ reviewLimit: limits.reviewLimit, newLimit: limits.newLimit })
    } catch {
      return c.json({ error: SETTINGS_ERROR }, 500)
    }
  })

  app.post('/api/settings/limits', async (c) => {
    try {
      const session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)

      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: INVALID_LIMITS_ERROR }, 400)
      }

      if (!isRecord(body)) return c.json({ error: INVALID_LIMITS_ERROR }, 400)

      const { reviewLimit, newLimit } = body
      if (!isNonNegativeInteger(reviewLimit) || !isNonNegativeInteger(newLimit)) {
        return c.json({ error: INVALID_LIMITS_ERROR }, 400)
      }

      const saved = await storeFor(c.env).setLimits(session.user.id, { reviewLimit, newLimit }, now())
      return c.json({ reviewLimit: saved.reviewLimit, newLimit: saved.newLimit })
    } catch {
      return c.json({ error: SETTINGS_ERROR }, 500)
    }
  })
}
