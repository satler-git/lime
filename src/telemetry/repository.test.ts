import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { D1TelemetryRepository } from './repository'
import type { TelemetryEvent } from './types'

const telemetryEvent: TelemetryEvent = {
  sessionId: 'session-1',
  cycleId: 'cycle-1',
  clientEventId: 'event-1',
  occurredAt: '2025-01-01T00:00:00.000Z',
  type: 'cycle_end',
  payload: {},
}

class FakeD1 {
  readonly calls: Array<{ sql: string; args: unknown[] }> = []
  private readonly ids = new Set<string>()

  readonly db = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => {
        this.calls.push({ sql, args })
        return {
          run: async () => {
            const key = `${args[0]}:${args[3]}`
            const duplicate = this.ids.has(key)
            if (!duplicate) this.ids.add(key)
            return { success: true, meta: { changes: duplicate ? 0 : 1 } }
          },
        } as unknown as D1PreparedStatement
      },
    }),
  } as unknown as D1Database
}

describe('D1 telemetry repository', () => {
  it('inserts events idempotently and scopes the composite key by user', async () => {
    const fake = new FakeD1()
    const first = await new D1TelemetryRepository(fake.db, 'user-a').insertBatch([telemetryEvent, telemetryEvent])
    expect(first).toEqual({ inserted: 1, duplicates: 1 })
    expect(fake.calls[0]?.args).toEqual([
      'user-a', 'session-1', 'cycle-1', 'event-1', 'cycle_end', Date.parse(telemetryEvent.occurredAt), '{}',
    ])

    const second = await new D1TelemetryRepository(fake.db, 'user-b').insertBatch([telemetryEvent])
    expect(second).toEqual({ inserted: 1, duplicates: 0 })
    expect(fake.calls[2]?.args[0]).toBe('user-b')
    expect(fake.calls[0]?.sql).toContain('INSERT OR IGNORE')
  })
})
