import { Hono } from 'hono'
import { authenticateSession } from '../auth/session-auth'
import type { AuthDependencies, Env } from '../auth/types'
import { createD1TelemetryRepository, type TelemetryRepository } from '../../telemetry/repository'
import {
  MAX_TELEMETRY_REQUEST_BODY_BYTES,
  validateTelemetryBatch,
  type TelemetryBatch,
} from '../../telemetry'

const UNAUTHORIZED_ERROR = 'Unauthorized'
const INVALID_TELEMETRY_ERROR = 'Invalid telemetry payload'
const FORBIDDEN_ERROR = 'Forbidden'
const PAYLOAD_TOO_LARGE_ERROR = 'Payload too large'
const TELEMETRY_ERROR = 'Telemetry failed'
const CACHE_CONTROL = 'private, no-store'

class RequestBodyTooLargeError extends Error {
  constructor() {
    super(PAYLOAD_TOO_LARGE_ERROR)
    this.name = 'RequestBodyTooLargeError'
  }
}

const contentLengthExceedsLimit = (request: Request): boolean => {
  const contentLength = request.headers.get('Content-Length')
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false
  const length = Number(contentLength)
  return !Number.isSafeInteger(length) || length > MAX_TELEMETRY_REQUEST_BODY_BYTES
}

/** Read an inbound body without retaining chunks or allocating a second full byte buffer. */
const readBoundedRequestBody = async (request: Request): Promise<string> => {
  if (contentLengthExceedsLimit(request)) throw new RequestBodyTooLargeError()
  if (request.body === null) return ''

  const bytes = new Uint8Array(MAX_TELEMETRY_REQUEST_BODY_BYTES)
  const reader = request.body.getReader()
  let offset = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (value.byteLength > bytes.byteLength - offset) {
        try { await reader.cancel() } catch {}
        throw new RequestBodyTooLargeError()
      }
      bytes.set(value, offset)
      offset += value.byteLength
    }
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) throw error
    try { await reader.cancel() } catch {}
    throw error
  }

  return new TextDecoder().decode(bytes.subarray(0, offset))
}

export type TelemetryRouteDependencies = {
  auth?: AuthDependencies
  repository?: (env: Env, userId: string) => TelemetryRepository
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
  const repositoryFor = dependencies.repository ?? defaultRepository
  const auth = dependencies.auth ?? {}

  app.use('/api/telemetry/batch', async (c, next) => {
    c.header('Cache-Control', CACHE_CONTROL)
    const origin = c.req.raw.headers.get('Origin')
    if (c.req.method === 'POST' && origin === null) {
      return c.json({ error: FORBIDDEN_ERROR }, 403)
    }
    if (origin !== null) {
      try {
        if (new URL(origin).origin !== new URL(c.env.APP_URL).origin) {
          return c.json({ error: FORBIDDEN_ERROR }, 403)
        }
      } catch {
        return c.json({ error: FORBIDDEN_ERROR }, 403)
      }
    }
    await next()
  })

  app.post('/api/telemetry/batch', async (c) => {
    const contentType = c.req.raw.headers.get('Content-Type')
    if (contentType === null || contentType.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: INVALID_TELEMETRY_ERROR }, 400)
    }

    let session
    try {
      session = await authenticateSession(c, auth)
      if (session === null) return c.json({ error: UNAUTHORIZED_ERROR }, 401)
    } catch {
      return c.json({ error: TELEMETRY_ERROR }, 500)
    }

    let body: string
    try {
      body = await readBoundedRequestBody(c.req.raw)
    } catch (error) {
      if (error instanceof RequestBodyTooLargeError) return c.json({ error: PAYLOAD_TOO_LARGE_ERROR }, 413)
      return c.json({ error: INVALID_TELEMETRY_ERROR }, 400)
    }

    let payload: TelemetryBatch
    try {
      payload = validateTelemetryBatch(JSON.parse(body))
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
