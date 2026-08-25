import type { D1Database } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { createCard } from '../../domain/card'
import type { ReviewAction } from '../../review/types'
import type { ReadingSession } from '../../session/types'
import {
  MAX_SYNC_CARD_IDS_PER_SESSION,
  MAX_SYNC_FIELD_BYTES,
  MAX_SYNC_ITEMS_PER_TYPE,
  MAX_SYNC_RECORD_BYTES,
  MAX_SYNC_LOOKUP_EVENTS_PER_SESSION,
  MAX_SYNC_REQUEST_BODY_BYTES,
  MAX_SYNC_RESPONSE_BODY_BYTES,
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
      loadAllWithUpdatedAt: async (_limit: number) => saved.cards,
      saveAt: async (value: typeof card, updatedAt: Date) => { saved.cards = [{ card: value, updatedAt }] },
    },
    reviewActions: {
      loadAllWithUpdatedAt: async (_limit: number) => saved.actions,
      saveAt: async (value: ReviewAction, updatedAt: Date) => { saved.actions = [{ action: value, updatedAt }] },
    },
    sessions: {
      loadAllWithUpdatedAt: async (_limit: number) => saved.sessions,
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
    const malformed = await app.request('/api/sync', { method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' }, body: JSON.stringify({ cards: [{ secret: 'do-not-echo' }] }) }, env)
    expect(malformed.status).toBe(400)
    expect(await malformed.json()).toEqual({ error: 'Invalid sync payload' })
  })

  it('rejects an authenticated body over the byte limit without echoing it', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const oversizedBody = 'sensitive-sync-content'.repeat(Math.ceil(MAX_SYNC_REQUEST_BODY_BYTES / 21))

    const response = await app.request('/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: oversizedBody,
    }, env)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
  })

  it('requires JSON POSTs and rejects cross-origin requests generically', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)

    const missingOrigin = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' }, body: '{}',
    }, env)
    expect(missingOrigin.status).toBe(403)
    expect(await missingOrigin.json()).toEqual({ error: 'Forbidden' })
    expect(missingOrigin.headers.get('Cache-Control')).toBe('private, no-store')

    const missingContentType = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', Origin: 'https://app.test' }, body: '{}',
    }, env)
    expect(missingContentType.status).toBe(400)
    expect(await missingContentType.json()).toEqual({ error: 'Invalid sync payload' })
    expect(missingContentType.headers.get('Cache-Control')).toBe('private, no-store')

    const crossOrigin = await app.request('/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://other.test' },
      body: '{}',
    }, env)
    expect(crossOrigin.status).toBe(403)
    expect(await crossOrigin.json()).toEqual({ error: 'Forbidden' })
    expect(crossOrigin.headers.get('Cache-Control')).toBe('private, no-store')

    const crossOriginGet = await app.request('/api/sync', {
      headers: { Cookie: 'lime_session=token', Origin: 'https://other.test' },
    }, env)
    expect(crossOriginGet.status).toBe(403)
    expect(await crossOriginGet.json()).toEqual({ error: 'Forbidden' })
    expect(crossOriginGet.headers.get('Cache-Control')).toBe('private, no-store')

    for (const malformedOrigin of [
      'https://app.test/path',
      'https://app.test?query',
      'https://user@app.test',
      'https://:@app.test',
      'not-an-origin',
    ]) {
      const malformed = await app.request('/api/sync', {
        headers: { Cookie: 'lime_session=token', Origin: malformedOrigin },
      }, env)
      expect(malformed.status).toBe(403)
      expect(await malformed.json()).toEqual({ error: 'Forbidden' })
    }

    const sameOrigin = await app.request('/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify({ cards: [], reviewActions: [], sessions: [] }),
    }, env)
    expect(sameOrigin.status).toBe(200)
    expect(sameOrigin.headers.get('Cache-Control')).toBe('private, no-store')

    const unsupported = await app.request('/api/sync', { method: 'PUT', headers: { Cookie: 'lime_session=token' } }, env)
    expect(unsupported.status).toBe(405)
    expect(unsupported.headers.get('Content-Type')).toMatch(/^application\/json(?:;|$)/i)
    expect(await unsupported.json()).toEqual({ error: 'Method not allowed' })
    expect(unsupported.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects a sync type array over its item limit without details', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const response = await app.request('/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
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
    const post = await app.request('/api/sync', { method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' }, body: JSON.stringify(payload) }, env)
    expect(post.status).toBe(200)
    expect(await post.json()).toEqual({ summary: { cards: 1, reviewActions: 1, sessions: 1 } })
    expect(post.headers.get('Cache-Control')).toBe('private, no-store')

    const get = await app.request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(get.status).toBe(200)
    const result = await get.json() as typeof payload
    expect(result.cards[0]?.card.createdAt).toBe('2025-01-01T00:00:00.000Z')
    expect(result.reviewActions[0]?.action.timestamp).toBe('2025-01-01T00:00:00.000Z')
    expect(get.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('returns a generic 413 instead of truncating an over-cap GET type', async () => {
    const fake = repositories()
    const cards = new Array(MAX_SYNC_ITEMS_PER_TYPE + 1).fill(null).map(() => ({ card: fake.sample.card, updatedAt: new Date() }))
    const requestedLimits: number[] = []
    const dependencies: SyncRouteDependencies = {
      auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 },
      repositories: () => ({
        cards: { loadAllWithUpdatedAt: async (limit: number) => { requestedLimits.push(limit ?? -1); return cards }, saveAt: async () => {} },
        reviewActions: { loadAllWithUpdatedAt: async (limit: number) => { requestedLimits.push(limit ?? -1); return [] }, saveAt: async () => {} },
        sessions: { loadAllWithUpdatedAt: async (limit: number) => { requestedLimits.push(limit ?? -1); return [] }, saveAt: async () => {} },
      }),
    }

    const response = await createSyncApp(dependencies).request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(requestedLimits).toEqual([MAX_SYNC_ITEMS_PER_TYPE + 1, MAX_SYNC_ITEMS_PER_TYPE + 1, MAX_SYNC_ITEMS_PER_TYPE + 1])
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })

  it('rejects oversized nested GET session data without truncating it', async () => {
    const fake = repositories()
    const oversizedSession = {
      ...fake.sample.readingSession,
      cardIds: new Array(MAX_SYNC_CARD_IDS_PER_SESSION + 1).fill('card-1'),
    }
    const dependencies: SyncRouteDependencies = {
      auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 },
      repositories: () => ({
        cards: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
        reviewActions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
        sessions: { loadAllWithUpdatedAt: async (_limit: number) => [{ session: oversizedSession, updatedAt: new Date() }], saveAt: async () => {} },
      }),
    }

    const response = await createSyncApp(dependencies).request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
  })

  it('rejects overlong fields and records in inbound sync payloads', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const fake = repositories()
    const oversizedField = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify({
        cards: [{ card: serializeCard({ ...fake.sample.card, word: 'x'.repeat(MAX_SYNC_FIELD_BYTES + 1) }), updatedAt: '2025-01-01T00:00:00.000Z' }],
        reviewActions: [], sessions: [],
      }),
    }, env)
    expect(oversizedField.status).toBe(400)
    expect(await oversizedField.json()).toEqual({ error: 'Invalid sync payload' })

    const event = { id: 'lookup-1', word: 'hola', source: 'article' as const, position: { paragraph: 0, character: 0 }, timestamp: new Date('2025-01-01T00:00:00.000Z'), inSrs: false }
    const oversizedRecord = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify({
        cards: [], reviewActions: [],
        sessions: [{ session: serializeReadingSession({ ...fake.sample.readingSession, lookupEvents: new Array(MAX_SYNC_LOOKUP_EVENTS_PER_SESSION).fill(event) }), updatedAt: '2025-01-01T00:00:00.000Z' }],
      }),
    }, env)
    expect(MAX_SYNC_RECORD_BYTES).toBeGreaterThan(MAX_SYNC_FIELD_BYTES)
    expect(oversizedRecord.status).toBe(400)
    expect(await oversizedRecord.json()).toEqual({ error: 'Invalid sync payload' })
  })

  it('rejects declared and chunked bodies over the limit before JSON parsing', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const declared = await app.request('/api/sync', {
      method: 'POST',
      headers: {
        Cookie: 'lime_session=token',
        'Content-Type': 'application/json',
        Origin: 'https://app.test',
        'Content-Length': String(MAX_SYNC_REQUEST_BODY_BYTES + 1),
      },
      body: '{}',
    }, env)
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({ error: 'Payload too large' })

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        controller.enqueue(new Uint8Array(MAX_SYNC_REQUEST_BODY_BYTES))
        controller.close()
      },
    })
    const chunked = await app.fetch(new Request('https://app.test/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: stream,
      duplex: 'half',
    } as RequestInit), env)
    expect(chunked.status).toBe(413)
    expect(await chunked.json()).toEqual({ error: 'Payload too large' })
  })

  it('maps a cancellation rejection after an oversized chunk to 413', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        controller.enqueue(new Uint8Array(MAX_SYNC_REQUEST_BODY_BYTES))
      },
      cancel() {
        return Promise.reject(new Error('stream cancellation failed'))
      },
    })
    const response = await createSyncApp(dependencies).fetch(new Request('https://app.test/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: stream,
      duplex: 'half',
    } as RequestInit), env)

    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
  })

  it('cancels and promptly rejects an aborted request body without hanging', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const controller = new AbortController()
    let cancelled = false
    let resolveReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>((resolve) => { resolveReadStarted = resolve })
    const stream = new ReadableStream<Uint8Array>({
      start(streamController) {
        streamController.enqueue(new TextEncoder().encode('{'))
      },
      pull() {
        resolveReadStarted?.()
      },
      cancel() {
        cancelled = true
      },
    })
    const request = new Request('https://app.test/api/sync', {
      method: 'POST',
      headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: stream,
      signal: controller.signal,
      duplex: 'half',
    } as RequestInit)
    const pending = createSyncApp(dependencies).fetch(request, env)
    await readStarted
    controller.abort()
    const response = await pending

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: 'Invalid sync payload' })
    expect(cancelled).toBe(true)
  })

  it('rejects an aggregate GET response over the byte limit before full stringification', async () => {
    const fake = repositories()
    const cards = new Array(MAX_SYNC_ITEMS_PER_TYPE).fill(null).map((_, index) => ({
      card: { ...fake.sample.card, id: `card-${index}`, word: 'x'.repeat(4_000) },
      updatedAt: new Date(),
    }))
    const dependencies: SyncRouteDependencies = {
      auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 },
      repositories: () => ({
        cards: { loadAllWithUpdatedAt: async (_limit: number) => cards, saveAt: async () => {} },
        reviewActions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
        sessions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
      }),
    }

    const response = await createSyncApp(dependencies).request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
  })

  it('limits session card IDs and lookup events and rejects invalid positions', async () => {
    const dependencies: SyncRouteDependencies = { auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repositories: () => repositories() }
    const app = createSyncApp(dependencies)
    const fake = repositories()
    const serialized = serializeReadingSession(fake.sample.readingSession)
    const envelope = (sessionValue: typeof serialized) => ({ sessions: [{ session: sessionValue }], cards: [], reviewActions: [] })
    const cardEnvelope = (cardValue: ReturnType<typeof serializeCard>) => ({ cards: [{ card: cardValue, updatedAt: '2025-01-01T00:00:00.000Z' }], reviewActions: [], sessions: [] })
    const tooManyCards = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify(envelope({ ...serialized, cardIds: new Array(MAX_SYNC_CARD_IDS_PER_SESSION + 1).fill('card-1') })),
    }, env)
    expect(tooManyCards.status).toBe(400)

    const tooManyLookups = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify(envelope({
        ...serialized,
        lookupEvents: new Array(MAX_SYNC_LOOKUP_EVENTS_PER_SESSION + 1).fill({
          id: 'lookup-1', word: 'hola', source: 'article', position: { paragraph: 0, character: 0 },
          timestamp: '2025-01-01T00:00:00.000Z', inSrs: false,
        }),
      })),
    }, env)
    expect(tooManyLookups.status).toBe(400)

    const negativePosition = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify(envelope({
        ...serialized,
        lookupEvents: [{
          id: 'lookup-1', word: 'hola', source: 'article', position: { paragraph: -1, character: 0 },
          timestamp: '2025-01-01T00:00:00.000Z', inSrs: false,
        }],
      })),
    }, env)
    expect(negativePosition.status).toBe(400)

    const negativeCounter = await app.request('/api/sync', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify(cardEnvelope({ ...serializeCard(fake.sample.card), reps: -1 })),
    }, env)
    expect(negativeCounter.status).toBe(400)
  })

  it('returns a generic 413 for overlong stored fields without truncating them', async () => {
    const fake = repositories()
    const oversized = { ...fake.sample.card, word: 'x'.repeat(MAX_SYNC_FIELD_BYTES + 1) }
    const dependencies: SyncRouteDependencies = {
      auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 },
      repositories: () => ({
        cards: { loadAllWithUpdatedAt: async (_limit: number) => [{ card: oversized, updatedAt: new Date() }], saveAt: async () => {} },
        reviewActions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
        sessions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
      }),
    }
    const response = await createSyncApp(dependencies).request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
  })

  it('returns a generic 413 when serialized GET data exceeds the response limit', async () => {
    const fake = repositories()
    const oversized = { ...fake.sample.card, word: 'x'.repeat(MAX_SYNC_RESPONSE_BODY_BYTES) }
    const dependencies: SyncRouteDependencies = {
      auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 },
      repositories: () => ({
        cards: { loadAllWithUpdatedAt: async (_limit: number) => [{ card: oversized, updatedAt: new Date() }], saveAt: async () => {} },
        reviewActions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
        sessions: { loadAllWithUpdatedAt: async (_limit: number) => [], saveAt: async () => {} },
      }),
    }
    const response = await createSyncApp(dependencies).request('/api/sync', { headers: { Cookie: 'lime_session=token' } }, env)
    expect(response.status).toBe(413)
    expect(await response.json()).toEqual({ error: 'Payload too large' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
