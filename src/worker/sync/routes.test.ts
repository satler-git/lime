import type { D1Database } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { createCard } from '../../domain/card'
import type { ReviewAction } from '../../review/types'
import type { ReadingSession } from '../../session/types'
import {
  MAX_SYNC_ITEMS_PER_TYPE,
  MAX_SYNC_REQUEST_BODY_BYTES,
  serializeCard,
  serializeReadingSession,
  serializeReviewAction,
} from '../../sync/types'
import { createSyncApp, type SyncRouteDependencies } from './routes'
import type { AuthSession, AuthStore, CryptoProvider, Env, GoogleProfile, User } from '../auth/types'

const user: User = { id: 'user-1', googleId: 'google-1', email: 'reader@example.test', name: 'Reader', picture: null, createdAt: 1, updatedAt: 1 }
const session: AuthSession = { user, expiresAt: 2_000 }
const env: Env = { APP_URL: 'https://app.test', GOOGLE_CLIENT_ID: 'id', GOOGLE_CLIENT_SECRET: 'secret', DB: {} as D1Database }
const crypto: CryptoProvider = {
  randomBytes: async (length) => new Uint8Array(length), sha256: async (value) => `hash:${value}`, sha256Base64Url: async (value) => value,
}

class FakeAuthStore implements AuthStore {
  async upsertUser(_profile: GoogleProfile, _id: string, _now: number): Promise<User> { return user }
  async createSession(): Promise<void> {}
  async findSession(): Promise<AuthSession | null> { return session }
  async deleteSession(): Promise<void> {}
}

const repositories = () => {
  const card = createCard({ id: 'card-1', word: 'hola', now: new Date('2025-01-01T00:00:00.000Z') })
  const action: ReviewAction = { id: 'action-1', sessionId: 'session-1', cardId: card.id, rating: 'good', timestamp: card.createdAt, previousState: card, nextState: card, undone: false }
  const readingSession: ReadingSession = { id: 'session-1', cardIds: [card.id], status: 'created', createdAt: card.createdAt, lookupEvents: [] }
  const saved = { cards: [] as Array<{ card: typeof card; updatedAt: Date }>, actions: [] as Array<{ action: ReviewAction; updatedAt: Date }>, sessions: [] as Array<{ session: ReadingSession; updatedAt: Date }> }
  return {
    saved,
    cards: {
      loadAllWithUpdatedAt: async () => saved.cards,
      saveAt: async (value: typeof card, updatedAt: Date) => { saved.cards = [{ card: value, updatedAt }] },
    },
    reviewActions: {
      loadAllWithUpdatedAt: async () => saved.actions,
      saveAt: async (value: ReviewAction, updatedAt: Date) => { saved.actions = [{ action: value, updatedAt }] },
    },
    sessions: {
      loadAllWithUpdatedAt: async () => saved.sessions,
      saveAt: async (value: ReadingSession, updatedAt: Date) => { saved.sessions = [{ session: value, updatedAt }] },
    },
    sample: { card, action, readingSession },
  }
}

describe('sync API', () => {
  it('rejects unauthenticated requests and malformed authenticated JSON without details', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    expect((await app.request('/api/sync', {}, env)).status).toBe(401)
    const malformed = await app.request('/api/sync', { method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' }, body: JSON.stringify({ cards: [{ secret: 'do-not-echo' }] }) }, env)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid sync payload' })
  })

  it('rejects an authenticated body over the byte limit without echoing it', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const oversizedBody = 'sensitive-sync-content'.repeat(Math.ceil(MAX_SYNC_REQUEST_BODY_BYTES / 21))

    const response = await app.request('/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' },
      body: oversizedBody,
    }, env)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
  })

  it('rejects a sync type array over its item limit without details', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const response = await app.request('/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ cards: new Array(MAX_SYNC_ITEMS_PER_TYPE + 1).fill(null), reviewActions: [], sessions: [] }),
    }, env)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid sync payload' })
  })

  it('accepts an authenticated batch and returns a summary and Date-safe records', async () => {
    const fake = repositories()
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => fake }
    const app = createSyncApp(dependencies)
    const payload = {
      cards: [{ card: serializeCard(fake.sample.card), updatedAt: '2025-01-03T00:00:00.000Z' }],
      reviewActions: [{ action: serializeReviewAction(fake.sample.action), updatedAt: '2025-01-03T00:00:00.000Z' }],
      sessions: [{ session: serializeReadingSession(fake.sample.readingSession), updatedAt: '2025-01-03T00:00:00.000Z' }],
    }
    const post = await app.request('/api/sync', { method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, env)
    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ summary: { cards: 1, reviewActions: 1, sessions: 1 } })

    const get = await app.request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(get.status).toBe(200)
    const result = await get.json() as typeof payload
    expect(result.cards[0]?.card.createdAt).toBe('2025-01-01T00:00:00.000Z')
    expect(result.reviewActions[0]?.action.timestamp).toBe('2025-01-01T00:00:00.000Z')
  })
})
