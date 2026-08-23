import type { D1Database } from '@cloudflare/workers-types'
import type { AuthSession, AuthStore, GoogleProfile, User } from './types'

interface UserRow {
  id: string
  google_id: string
  email: string
  name: string | null
  picture: string | null
  created_at: number
  updated_at: number
}

interface SessionUserRow extends UserRow {
  expires_at: number
}

const mapUser = (row: UserRow): User => ({
  id: row.id,
  googleId: row.google_id,
  email: row.email,
  name: row.name,
  picture: row.picture,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

export class D1AuthStore implements AuthStore {
  constructor(private readonly db: D1Database) {}

  async upsertUser(profile: GoogleProfile, id: string, now: number): Promise<User> {
    await this.db
      .prepare(
        `INSERT INTO users (id, google_id, email, name, picture, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (google_id) DO UPDATE SET
           email = excluded.email,
           name = excluded.name,
           picture = excluded.picture,
           updated_at = excluded.updated_at`,
      )
      .bind(id, profile.googleId, profile.email, profile.name, profile.picture, now, now)
      .run()

    const row = await this.db
      .prepare('SELECT id, google_id, email, name, picture, created_at, updated_at FROM users WHERE google_id = ?')
      .bind(profile.googleId)
      .first<UserRow>()

    if (row === null) throw new Error('User could not be loaded')
    return mapUser(row)
  }

  async createSession(userId: string, tokenHash: string, expiresAt: number, now: number): Promise<void> {
    await this.db
      .prepare('INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)')
      .bind(tokenHash, userId, expiresAt, now)
      .run()
  }

  async findSession(tokenHash: string, now: number): Promise<AuthSession | null> {
    const row = await this.db
      .prepare(
        `SELECT u.id, u.google_id, u.email, u.name, u.picture, u.created_at, u.updated_at, s.expires_at
         FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = ? AND s.expires_at > ?`,
      )
      .bind(tokenHash, now)
      .first<SessionUserRow>()

    return row === null ? null : { user: mapUser(row), expiresAt: row.expires_at }
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
  }
}
