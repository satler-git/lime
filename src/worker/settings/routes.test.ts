import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { createSettingsApp } from './routes'
import type { AuthSession, AuthStore, CryptoProvider, Env, GoogleProfile, User } from '../auth/types'

const user: User = {
  id: 'user-1',
  googleId: 'google-1',
  email: 'reader@example.test',
  name: 'Reader',
  picture: null,
  createdAt: 1,
  updatedAt: 1,
}

const session: AuthSession = { user, expiresAt: 2_000 }

const crypto: CryptoProvider = {
  randomBytes: async (length) => new Uint8Array(length),
  sha256: async (value) => `hash:${value}`,
  sha256Base64Url: async (value) => value,
}

class FakeAuthStore implements AuthStore {
  async upsertUser(_profile: GoogleProfile, _id: string, _now: number): Promise<User> {
    return user
  }

  async createSession(): Promise<void> {}

  async findSession(): Promise<AuthSession | null> {
    return session
  }

  async deleteSession(): Promise<void> {}
}

/** Small D1-shaped fake that supports the user_settings table used by the route. */
class FakeD1 {
  private readonly rows = new Map<string, { review_limit: number; new_limit: number; updated_at: number }>()
  readonly calls: Array<{ sql: string; args: unknown[] }> = []

  readonly db = {
    prepare: (sql: string) => {
      return {
        bind: (...args: unknown[]) => {
          this.calls.push({ sql, args })
          return {
            first: async <T>() => {
              if (sql.includes('SELECT review_limit, new_limit FROM user_settings WHERE user_id = ?')) {
                const row = this.rows.get(args[0] as string)
                if (row === undefined) return null
                return { review_limit: row.review_limit, new_limit: row.new_limit } as T
              }
              return null
            },
            run: async () => {
              if (sql.includes('INSERT INTO user_settings')) {
                const [userId, reviewLimit, newLimit, updatedAt] = args as [string, number, number, number]
                this.rows.set(userId, {
                  review_limit: reviewLimit,
                  new_limit: newLimit,
                  updated_at: updatedAt,
                })
              }
              return { success: true, results: [], meta: {} }
            },
            all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
          } as unknown as D1PreparedStatement
        },
      }
    },
  } as unknown as D1Database
}

const env = (db: D1Database): Env => ({
  APP_URL: 'https://app.test',
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  DB: db,
})

describe('settings API', () => {
  it('returns 401 when unauthenticated and null limits for an authenticated user with no saved row', async () => {
    const fakeD1 = new FakeD1()
    const app = createSettingsApp({ auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 } })

    const unauthorized = await app.request('/api/settings/limits', {}, env(fakeD1.db))
    expect(unauthorized.status).toBe(401)
    expect(await unauthorized.json()).toEqual({ error: 'Unauthorized' })
    expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store')

    const get = await app.request('/api/settings/limits', { headers: { Cookie: 'lime_session=token' } }, env(fakeD1.db))
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ reviewLimit: null, newLimit: null })
    expect(get.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('upserts and returns limits', async () => {
    const fakeD1 = new FakeD1()
    const app = createSettingsApp({ auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 } })

    const post = await app.request('/api/settings/limits', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewLimit: 30, newLimit: 10 }),
    }, env(fakeD1.db))

    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ reviewLimit: 30, newLimit: 10 })
    expect(post.headers.get('Cache-Control')).toBe('private, no-store')

    const get = await app.request('/api/settings/limits', { headers: { Cookie: 'lime_session=token' } }, env(fakeD1.db))
    expect(get.status).toBe(200)
    expect(await get.json()).toEqual({ reviewLimit: 30, newLimit: 10 })
    expect(get.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects non-negative-integer limits and malformed bodies', async () => {
    const fakeD1 = new FakeD1()
    const app = createSettingsApp({ auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 } })

    const invalid = [
      { reviewLimit: -1, newLimit: 10 },
      { reviewLimit: 30, newLimit: 'ten' },
      { reviewLimit: 1.5, newLimit: 10 },
      {},
      'not-json',
    ]

    for (const body of invalid) {
      const response = await app.request('/api/settings/limits', {
        method: 'POST',
        headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }, env(fakeD1.db))

      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid limits' })
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
  })
})
