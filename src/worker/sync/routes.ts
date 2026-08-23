import { Hono } from 'hono'
import { authenticateSession } from '../auth/session-auth'
import type { AuthDependencies, Env } from '../auth/types'
import { createD1SyncRepositories, type D1SyncRepositories } from '../../persistence/d1-sync-repositories'
import {
  deserializeCard,
  deserializeReadingSession,
  deserializeReviewAction,
  MAX_SYNC_REQUEST_BODY_BYTES,
  parseSyncRequest,
  serializeCard,
  serializeReadingSession,
  serializeReviewAction,
  type SyncBatchResponse,
  type SyncRequest,
} from '../../sync/types'

const UNAUTHORIZED_ERROR = 'Unauthorized'
const INVALID_SYNC_ERROR = 'Invalid sync payload'
const PAYLOAD_TOO_LARGE_ERROR = 'Payload too large'
const SYNC_ERROR = 'Sync failed'

export type SyncRepositories = {
  cards: Pick<D1SyncRepositories['cards'], 'loadAllWithUpdatedAt' | 'saveAt'>
  reviewActions: Pick<D1SyncRepositories['reviewActions'], 'loadAllWithUpdatedAt' | 'saveAt'>
  sessions: Pick<D1SyncRepositories['sessions'], 'loadAllWithUpdatedAt' | 'saveAt'>
}

export type SyncRouteDependencies = {
  auth?: AuthDependencies
  repositories?: (env: Env, userId: string) => SyncRepositories
}

const defaultRepositories = (env: Env, userId: string): SyncRepositories => createD1SyncRepositories(env.DB, userId)

const responseFor = async (repositories: SyncRepositories): Promise<SyncRequest> => {
  const [cards, reviewActions, sessions] = await Promise.all([
    repositories.cards.loadAllWithUpdatedAt(),
    repositories.reviewActions.loadAllWithUpdatedAt(),
    repositories.sessions.loadAllWithUpdatedAt(),
  ])
  return {
    cards: cards.map(({ card, updatedAt }) => ({ card: serializeCard(card), updatedAt: updatedAt.toISOString() })),
    reviewActions: reviewActions.map(({ action, updatedAt }) => ({ action: serializeReviewAction(action), updatedAt: updatedAt.toISOString() })),
    sessions: sessions.map(({ session, updatedAt }) => ({ session: serializeReadingSession(session), updatedAt: updatedAt.toISOString() })),
  }
}

const writeBatch = async (repositories: SyncRepositories, payload: SyncRequest): Promise<void> => {
  for (const envelope of payload.cards) {
    await repositories.cards.saveAt(deserializeCard(envelope.card), new Date(envelope.updatedAt))
  }
  for (const envelope of payload.reviewActions) {
    await repositories.reviewActions.saveAt(deserializeReviewAction(envelope.action), new Date(envelope.updatedAt))
  }
  for (const envelope of payload.sessions) {
    await repositories.sessions.saveAt(deserializeReadingSession(envelope.session), new Date(envelope.updatedAt))
  }
}

/** Authenticated, deliberately small sync surface for the Worker. */
export const createSyncApp = (dependencies: SyncRouteDependencies = {}) => {
  const app = new Hono<{ Bindings: Env }>()
  registerSyncRoutes(app, dependencies)
  return app
}

export const registerSyncRoutes = (
  app: Hono<{ Bindings: Env }>,
  dependencies: SyncRouteDependencies = {},
): void => {
  const repositoriesFor = dependencies.repositories ?? defaultRepositories
  const auth = dependencies.auth ?? {}

  app.get('/api/sync', async (c) => {
    try {
      const session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
      return c.json(await responseFor(repositoriesFor(c.env, session.user.id)))
    } catch {
      return c.json({ error: SYNC_ERROR }, 500)
    }
  })

  app.post('/api/sync', async (c) => {
    let session
    try {
      session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
    } catch {
      return c.json({ error: SYNC_ERROR }, 500)
    }

    let requestBody: string
    try {
      requestBody = await c.req.text()
    } catch {
      return c.json({ error: INVALID_SYNC_ERROR }, 400)
    }
    if (new TextEncoder().encode(requestBody).byteLength > MAX_SYNC_REQUEST_BODY_BYTES) {
      return c.json({ error: PAYLOAD_TOO_LARGE_ERROR }, 413)
    }

    let payload: SyncRequest
    try {
      payload = parseSyncRequest(JSON.parse(requestBody))
    } catch {
      return c.json({ error: INVALID_SYNC_ERROR }, 400)
    }

    try {
      await writeBatch(repositoriesFor(c.env, session.user.id), payload)
      const response: SyncBatchResponse = {
        summary: {
          cards: payload.cards.length,
          reviewActions: payload.reviewActions.length,
          sessions: payload.sessions.length,
        },
      }
      return c.json(response)
    } catch {
      return c.json({ error: SYNC_ERROR }, 500)
    }
  })
}
