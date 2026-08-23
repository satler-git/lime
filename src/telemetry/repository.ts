import type { D1Database } from '@cloudflare/workers-types'
import type { TelemetryEvent } from './types'

export type TelemetryInsertResult = {
  inserted: number
  duplicates: number
}

export interface TelemetryRepository {
  insertBatch(events: readonly TelemetryEvent[]): Promise<TelemetryInsertResult>
}

const eventMilliseconds = (event: TelemetryEvent): number => {
  const timestamp = Date.parse(event.occurredAt)
  if (!Number.isFinite(timestamp)) throw new Error('Invalid telemetry timestamp')
  return timestamp
}

/** D1 raw-event persistence scoped permanently to one authenticated user. */
export class D1TelemetryRepository implements TelemetryRepository {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async insertBatch(events: readonly TelemetryEvent[]): Promise<TelemetryInsertResult> {
    let inserted = 0
    for (const event of events) {
      const result = await this.db.prepare(
        `INSERT OR IGNORE INTO telemetry_events
          (user_id, session_id, cycle_id, client_event_id, event_type, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        this.userId,
        event.sessionId,
        event.cycleId,
        event.clientEventId,
        event.type,
        eventMilliseconds(event),
        JSON.stringify(event.payload),
      ).run()
      inserted += result.meta?.changes ?? 0
    }
    return { inserted, duplicates: events.length - inserted }
  }
}

export const createD1TelemetryRepository = (db: D1Database, userId: string): TelemetryRepository => (
  new D1TelemetryRepository(db, userId)
)
