import { Hono } from 'hono'
import { authenticateSession } from '../auth/session-auth'
import type { AuthDependencies, Env } from '../auth/types'
import { createD1SyncRepositories, type D1SyncRepositories } from '../../persistence/d1-sync-repositories'
import {
  deserializeCard,
  deserializeReadingSession,
  deserializeReviewAction,
  MAX_SYNC_CARD_IDS_PER_SESSION,
  MAX_SYNC_ITEMS_PER_TYPE,
  MAX_SYNC_LOOKUP_EVENTS_PER_SESSION,
  MAX_SYNC_REQUEST_BODY_BYTES,
  MAX_SYNC_RESPONSE_BODY_BYTES,
  parseSyncRequest,
  serializeCard,
  serializeReadingSession,
  serializeReviewAction,
  type SyncBatchResponse,
  type SyncRequest,
} from '../../sync/types'

const UNAUTHORIZED_ERROR = 'Unauthorized'
const INVALID_SYNC_ERROR = 'Invalid sync payload'
const FORBIDDEN_ERROR = 'Forbidden'
const PAYLOAD_TOO_LARGE_ERROR = 'Payload too large'
const METHOD_NOT_ALLOWED_ERROR = 'Method not allowed'
const SYNC_ERROR = 'Sync failed'
const CACHE_CONTROL = 'private, no-store'

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(PAYLOAD_TOO_LARGE_ERROR)
    this.name = 'RequestBodyTooLargeError'
  }
}

class SyncResponseTooLargeError extends Error {
  constructor() {
    super(PAYLOAD_TOO_LARGE_ERROR)
    this.name = 'SyncResponseTooLargeError'
  }
}

const contentLengthExceedsLimit = (request: Request): boolean => {
  const contentLength = request.headers.get('Content-Length')
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false
  const length = Number(contentLength)
  return !Number.isSafeInteger(length) || length > MAX_SYNC_REQUEST_BODY_BYTES
}

/** Read an inbound body without ever buffering more than the configured limit. */
const readBoundedRequestBody = async (request: Request): Promise<string> => {
  if (contentLengthExceedsLimit(request)) throw new RequestBodyTooLargeError()
  if (request.body === null) return ''

  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_SYNC_REQUEST_BODY_BYTES) {
        try { await reader.cancel() } catch {}
        throw new RequestBodyTooLargeError()
      }
      chunks.push(value)
    }
  } catch (error) {
    try { await reader.cancel() } catch {}
    throw error
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(bytes)
}

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

const exceedsSyncItemLimit = (items: readonly unknown[]): boolean => items.length > MAX_SYNC_ITEMS_PER_TYPE

/**
 * The current sync protocol has an explicit hard cap: one thousand records per
 * top-level type per GET or batch, plus one thousand card IDs and lookup events
 * per session. A cursor protocol is intentionally deferred; over-cap responses
 * fail instead of being truncated.
 */
const responseFor = async (repositories: SyncRepositories): Promise<SyncRequest> => {
  const loadLimit = MAX_SYNC_ITEMS_PER_TYPE + 1
  const [cards, reviewActions, sessions] = await Promise.all([
    repositories.cards.loadAllWithUpdatedAt(loadLimit),
    repositories.reviewActions.loadAllWithUpdatedAt(loadLimit),
    repositories.sessions.loadAllWithUpdatedAt(loadLimit),
  ])
  if (exceedsSyncItemLimit(cards) || exceedsSyncItemLimit(reviewActions) || exceedsSyncItemLimit(sessions)) {
    throw new SyncResponseTooLargeError()
  }
  for (const { session } of sessions) {
    if (session.cardIds.length > MAX_SYNC_CARD_IDS_PER_SESSION || session.lookupEvents.length > MAX_SYNC_LOOKUP_EVENTS_PER_SESSION) {
      throw new SyncResponseTooLargeError()
    }
  }
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

  app.use('/api/sync', async (c, next) => {
    c.header('Cache-Control', CACHE_CONTROL)
    const origin = c.req.raw.headers.get('Origin')
    if (origin === null) {
      // Browsers send Origin on credentialed POSTs; GET remains usable by non-browser clients.
      if (c.req.method === 'POST') return c.json({ error: FORBIDDEN_ERROR }, 403)
      await next()
      return
    }
    try {
      if (new URL(origin).origin !== new URL(c.env.APP_URL).origin) {
        return c.json({ error: FORBIDDEN_ERROR }, 403)
      }
    } catch {
      return c.json({ error: FORBIDDEN_ERROR }, 403)
    }
    await next()
  })

  app.get('/api/sync', async (c) => {
    try {
      const session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
      const responseBody = JSON.stringify(await responseFor(repositoriesFor(c.env, session.user.id)))
      if (new TextEncoder().encode(responseBody).byteLength > MAX_SYNC_RESPONSE_BODY_BYTES) {
        return c.json({ error: PAYLOAD_TOO_LARGE_ERROR }, 413)
      }
      return c.body(responseBody, 200, { 'Content-Type': 'application/json' })
    } catch (error) {
      if (error instanceof SyncResponseTooLargeError) return c.json({ error: PAYLOAD_TOO_LARGE_ERROR }, 413)
      return c.json({ error: SYNC_ERROR }, 500)
    }
  })

  app.post('/api/sync', async (c) => {
    const request = c.req.raw
    const contentType = request.headers.get('Content-Type')
    if (contentType === null || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: INVALID_SYNC_ERROR }, 400)
    }
    let session
    try {
      session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
    } catch {
      return c.json({ error: SYNC_ERROR }, 500)
    }

    let requestBody: string
    try {
      requestBody = await readBoundedRequestBody(c.req.raw)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return c.json({ error: PAYLOAD_TOO_LARGE_ERROR }, 413)
      return c.json({ error: INVALID_SYNC_ERROR }, 400)
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

  // Keep unsupported methods on the sync path JSON-shaped; only GET and POST
  // are handled by the sync protocol.
  app.all('/api/sync', (c) => c.json({ error: METHOD_NOT_ALLOWED_ERROR }, 405))
}
