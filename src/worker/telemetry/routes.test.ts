import type { D1Database } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import {
  MAX_TELEMETRY_ITEMS_PER_BATCH,
  MAX_TELEMETRY_REQUEST_BODY_BYTES,
  validateTelemetryBatch,
  type TelemetryEvent,
} from '../../telemetry'
import { createTelemetryApp, type TelemetryRouteDependencies } from './routes'
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

const sample = (): TelemetryEvent => ({
  sessionId: 'session-1', cycleId: 'cycle-1', clientEventId: 'event-1',
  occurredAt: '2025-01-01T00:00:00.000Z', type: 'cycle_end', payload: {},
})

const dependencies = (repository: TelemetryRouteDependencies['repository']): TelemetryRouteDependencies => ({
  auth: { store: new FakeAuthStore(), crypto, now: () => 1_000 }, repository,
})

describe('telemetry API', () => {
  it('rejects unauthenticated requests and never echoes invalid secrets', async () => {
    const repository = async () => ({ inserted: 1, duplicates: 0 })
    const app = createTelemetryApp(dependencies(() => ({ insertBatch: repository })))
    const unauthorized = await app.request('/api/telemetry/batch', { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json', Origin: 'https://app.test' } }, env)
    expect(unauthorized.status).toBe(401)
    expect(unauthorized.headers.get('Cache-Control')).toBe('private, no-store')

    const invalid = await app.request('/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify({ events: [{ ...sample(), payload: { apiKey: 'do-not-echo' } }] }),
    }, env)
    expect(invalid.status).toBe(400)
    expect(await invalid.json()).toEqual({ error: 'Invalid telemetry payload' })
  })

  it('requires a matching Origin, JSON content type, and private no-store responses', async () => {
    const app = createTelemetryApp(dependencies(() => ({ insertBatch: async () => ({ inserted: 0, duplicates: 0 }) })))
    const missingOrigin = await app.request('/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json' }, body: '{}',
    }, env)
    expect(missingOrigin.status).toBe(403)
    expect(await missingOrigin.json()).toEqual({ error: 'Forbidden' })
    expect(missingOrigin.headers.get('Cache-Control')).toBe('private, no-store')

    const mismatchedOrigin = await app.request('/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://other.test' }, body: '{}',
    }, env)
    expect(mismatchedOrigin.status).toBe(403)
    expect(await mismatchedOrigin.json()).toEqual({ error: 'Forbidden' })
    expect(mismatchedOrigin.headers.get('Cache-Control')).toBe('private, no-store')

    for (const contentType of [undefined, 'text/plain']) {
      const headers = new Headers({ Cookie: 'lime_session=token', Origin: 'https://app.test' })
      if (contentType !== undefined) headers.set('Content-Type', contentType)
      const response = await app.request('/api/telemetry/batch', { method: 'POST', headers, body: '{}' }, env)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid telemetry payload' })
      expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    }
  })

  it('accepts JSON charset parameters and rejects oversized bodies before persistence', async () => {
    let called = false
    const app = createTelemetryApp(dependencies(() => ({ insertBatch: async () => { called = true; return { inserted: 0, duplicates: 0 } } })))
    const oversized = await app.request('/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json; charset=utf-8', Origin: 'https://app.test' },
      body: 'x'.repeat(MAX_TELEMETRY_REQUEST_BODY_BYTES + 1),
    }, env)
    expect(oversized.status).toBe(413)
    expect(await oversized.json()).toEqual({ error: 'Payload too large' })
    expect(oversized.headers.get('Cache-Control')).toBe('private, no-store')
    expect(called).toBe(false)

    const tooMany = await app.request('/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: JSON.stringify({ events: new Array(MAX_TELEMETRY_ITEMS_PER_BATCH + 1).fill(sample()) }),
    }, env)
    expect(tooMany.status).toBe(400)
    expect(await tooMany.json()).toEqual({ error: 'Invalid telemetry payload' })
    expect(tooMany.headers.get('Cache-Control')).toBe('private, no-store')
    expect(called).toBe(false)
  })

  it('rejects declared and chunked bodies over the limit and maps cancellation failures to 413', async () => {
    const dependenciesForTest = dependencies(() => ({ insertBatch: async () => ({ inserted: 0, duplicates: 0 }) }))
    const declared = await createTelemetryApp(dependenciesForTest).request('/api/telemetry/batch', {
      method: 'POST', headers: {
        Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test',
        'Content-Length': String(MAX_TELEMETRY_REQUEST_BODY_BYTES + 1),
      }, body: '{}',
    }, env)
    expect(declared.status).toBe(413)
    expect(await declared.json()).toEqual({ error: 'Payload too large' })

    const makeStream = (cancel?: () => Promise<void>) => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{'))
        controller.enqueue(new Uint8Array(MAX_TELEMETRY_REQUEST_BODY_BYTES))
      },
      ...(cancel === undefined ? {} : { cancel }),
    })
    for (const stream of [makeStream(), makeStream(() => Promise.reject(new Error('cancel failed')))]) {
      const response = await createTelemetryApp(dependenciesForTest).fetch(new Request('https://app.test/api/telemetry/batch', {
        method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
        body: stream, duplex: 'half',
      } as RequestInit), env)
      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({ error: 'Payload too large' })
    }
  })

  it('accepts a valid body delivered in multiple stream chunks', async () => {
    let received: TelemetryEvent[] = []
    const app = createTelemetryApp(dependencies(() => ({
      insertBatch: async (events) => { received = [...events]; return { inserted: events.length, duplicates: 0 } },
    })))
    const body = JSON.stringify({ events: [sample()] })
    const bytes = new TextEncoder().encode(body)
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 1))
        controller.enqueue(bytes.subarray(1))
        controller.close()
      },
    })
    const response = await app.fetch(new Request('https://app.test/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json', Origin: 'https://app.test' },
      body: stream, duplex: 'half',
    } as RequestInit), env)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 1, duplicates: 0 })
    expect(received).toEqual(validateTelemetryBatch(JSON.parse(body)).events)
  })

  it('passes only authenticated user scope to the repository and reports idempotent results', async () => {
    let scopedUserId: string | undefined
    let received: TelemetryEvent[] = []
    const app = createTelemetryApp(dependencies((_env, userId) => {
      scopedUserId = userId
      return { insertBatch: async (events) => { received = [...events]; return { inserted: 1, duplicates: events.length - 1 } } }
    }))
    const second = { ...sample(), clientEventId: 'event-2' }
    const response = await app.request('/api/telemetry/batch', {
      method: 'POST', headers: { Cookie: 'lime_session=token', 'Content-Type': 'application/json; charset=utf-8', Origin: 'https://app.test' },
      body: JSON.stringify({ events: [sample(), second] }),
    }, env)
    const result = await response.json()
    expect(response.status, JSON.stringify(result)).toBe(200)
    expect(result).toEqual({ accepted: 1, duplicates: 1 })
    expect(scopedUserId).toBe('user-1')
    expect(received).toEqual(validateTelemetryBatch({ events: [sample(), second] }).events)
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
  })
})
