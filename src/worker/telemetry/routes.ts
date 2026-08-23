import { Hono } from 'hono'
import { authenticateSession } from '../auth/session-auth'
import type { AuthDependencies, Env } from '../auth/types'
import { createD1TelemetryRepository, type TelemetryRepository } from '../../telemetry/repository'
import {
  MAX_TELEMETRY_REQUEST_BODY_BYTES,
  parseTelemetryBatch,
  type TelemetryBatch,
} from '../../telemetry'

const UNAUTHORIZED_ERROR = 'Unauthorized'
const INVALID_TELEMETRY_ERROR = 'Invalid telemetry payload'
const PAYLOAD_TOO_LARGE_ERROR = 'Payload too large'
const TELEMETRY_ERROR = 'Telemetry failed'

export type TelemetryRouteDependencies = {
  auth?: AuthDependencies
  repository?: (env: Env, userId: string) => TelemetryRepository
  /** Alias retained for consistency with the sync route dependency shape. */
  repositories?: (env: Env, userId: string) => TelemetryRepository
}

const defaultRepository = (env: Env, userId: string): TelemetryRepository => (
  createD1TelemetryRepository(env.DB, userId)
)

/** An isolated authenticated route surface for privacy-conscious raw telemetry. */
export const createTelemetryApp = (dependencies: TelemetryRouteDependencies = {}) => {
  const app = new Hono<{ Bindings: Env }>()
  registerTelemetryRoutes(app, dependencies)
  return app
}

export const registerTelemetryRoutes = (
  app: Hono<{ Bindings: Env }>,
  dependencies: TelemetryRouteDependencies = {},
): void => {
  const repositoryFor = dependencies.repository ?? dependencies.repositories ?? defaultRepository
  const auth = dependencies.auth ?? {}

  app.post('/api/telemetry/batch', async (c) => {
    let session
    try {
      session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
    } catch {
      return c.json({ error: TELEMETRY_ERROR }, 500)
    }

    let body: string
    try {
      body = await c.req.text()
    } catch {
      return c.json({ error: INVALID_TELEMETRY_ERROR }, 400)
    }
    if (new TextEncoder().encode(body).byteLength > MAX_TELEMETRY_REQUEST_BODY_BYTES) {
      return c.json({ error: PAYLOAD_TOO_LARGE_ERROR }, 413)
    }

    let payload: TelemetryBatch
    try {
      payload = parseTelemetryBatch(JSON.parse(body))
    } catch {
      return c.json({ error: INVALID_TELEMETRY_ERROR }, 400)
    }

    try {
      const result = await repositoryFor(c.env, session.user.id).insertBatch(payload.events)
      return c.json({ accepted: result.inserted, duplicates: result.duplicates })
    } catch {
      return c.json({ error: TELEMETRY_ERROR }, 500)
    }
  })
}
