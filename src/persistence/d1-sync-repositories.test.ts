import type { D1Database, D1PreparedStatement } from '@cloudflare/workers-types'
import { describe, expect, it } from 'vitest'
import { createCard } from '../domain/card'
import { D1CardRepository, D1ReadingSessionRepository, D1ReviewActionRepository } from './d1-sync-repositories'
import type { ReviewAction } from '../review/types'
import type { ReadingSession } from '../session/types'

const card = createCard({ id: 'card-1', word: 'bonjour', now: new Date('2025-01-01T00:00:00.000Z') })
const action: ReviewAction = {
  id: 'action-1', sessionId: 'session-1', cardId: card.id, rating: 'good',
  timestamp: new Date('2025-01-02T00:00:00.000Z'), previousState: card, nextState: { ...card, state: 'review', lastReview: new Date('2025-01-02T00:00:00.000Z') },
  undone: false,
}
const readingSession: ReadingSession = {
  id: 'session-1', cardIds: [card.id], status: 'reading', createdAt: new Date('2025-01-01T00:00:00.000Z'),
  startedAt: new Date('2025-01-01T00:01:00.000Z'), lookupEvents: [],
}

type Stored = Record<string, unknown>

/** Small D1-shaped fake that applies the INSERT conflict predicates used by the adapters. */
class FakeD1 {
  readonly calls: Array<{ sql: string; args: unknown[] }> = []
  private readonly rows = new Map<string, Stored>()

  readonly db = { prepare: (sql: string) => {
    const statement = {
      bind: (...args: unknown[]) => {
        this.calls.push({ sql, args })
        return {
          run: async () => {
            if (!sql.startsWith('INSERT INTO')) return { success: true }
            const table = sql.match(/INSERT INTO (\w+)/)?.[1] as string
            const userId = args[0] as string
            const id = args[1] as string
            const key = `${table}:${userId}:${id}`
            const updatedAt = args[args.length - 1] as number
            const existing = this.rows.get(key)
            if (existing !== undefined && updatedAt < (existing.updated_at as number)) return { success: true }
            if (table === 'cards') {
              const [_, cardId, word, createdAt, due, stability, difficulty, elapsedDays, scheduledDays, learningSteps, reps, lapses, state, lastReview] = args
              this.rows.set(key, { id: cardId, word, created_at: createdAt, due, stability, difficulty, elapsed_days: elapsedDays, scheduled_days: scheduledDays, learning_steps: learningSteps, reps, lapses, state, last_review: lastReview, updated_at: updatedAt })
            } else if (table === 'review_actions') {
              const [__, actionId, sessionId, cardId, rating, timestamp, previous, next, undone, undoneAt] = args
              this.rows.set(key, { id: actionId, session_id: sessionId, card_id: cardId, rating, timestamp, previous_state_json: previous, next_state_json: next, undone, undone_at: undoneAt, updated_at: updatedAt })
            } else {
              const [__, sessionId, status, createdAt, startedAt, quizStartedAt, completedAt, abandonedAt, cardIds, events] = args
              this.rows.set(key, { id: sessionId, status, created_at: createdAt, started_at: startedAt, quiz_started_at: quizStartedAt, completed_at: completedAt, abandoned_at: abandonedAt, card_ids_json: cardIds, lookup_events_json: events, updated_at: updatedAt })
            }
            return { success: true }
          },
          first: async <T>() => this.select<T>(sql, args, true),
          all: async <T>() => ({ results: this.select<T>(sql, args, false) as T[], success: true, meta: {} }),
        } as unknown as D1PreparedStatement
      },
    }
    return statement
  }} as unknown as D1Database

  private select<T>(sql: string, args: unknown[], first: boolean): T | T[] | null {
    const table = sql.match(/FROM (\w+)/)?.[1] as string
    const userId = args[0] as string
    let rows = [...this.rows.entries()]
      .filter(([key]) => key.startsWith(`${table}:${userId}:`))
      .map(([, row]) => row)
    if (sql.includes('AND id = ?')) rows = rows.filter((row) => row.id === args[1])
    if (sql.includes('AND session_id = ?')) rows = rows.filter((row) => row.session_id === args[1] && row.card_id === args[2] && row.undone === 0)
    if (sql.includes('AND due <= ?')) rows = rows.filter((row) => (row.due as number) <= (args[1] as number))
    if (first) return (rows[0] as T | undefined) ?? null
    return rows as T[]
  }
}

describe('D1 sync repositories', () => {
  it('scopes reads and writes by user and round-trips Date fields', async () => {
    const fake = new FakeD1()
    const repository = new D1CardRepository(fake.db, 'user-a')
    await repository.saveAt(card, new Date('2025-01-03T00:00:00.000Z'))
    const loaded = await repository.load(card.id)

    expect(loaded?.createdAt).toEqual(card.createdAt)
    expect(loaded?.due).toEqual(card.due)
    expect(fake.calls[0]?.args[0]).toBe('user-a')
    expect(fake.calls[1]?.args).toEqual(['user-a', card.id])
    expect(await new D1CardRepository(fake.db, 'user-b').load(card.id)).toBeNull()
    expect(fake.calls[2]?.args[0]).toBe('user-b')
  })

  it('keeps the newest card, action, and session envelope', async () => {
    const fake = new FakeD1()
    const cards = new D1CardRepository(fake.db, 'user-a')
    await cards.saveAt(card, new Date('2025-01-03T00:00:00.000Z'))
    await cards.saveAt({ ...card, word: 'stale' }, new Date('2025-01-02T00:00:00.000Z'))
    expect((await cards.load(card.id))?.word).toBe(card.word)

    const actions = new D1ReviewActionRepository(fake.db, 'user-a')
    await actions.saveAt(action, new Date('2025-01-03T00:00:00.000Z'))
    await actions.saveAt({ ...action, undone: true }, new Date('2025-01-04T00:00:00.000Z'))
    await actions.saveAt({ ...action, undone: false }, new Date('2025-01-03T00:00:00.000Z'))
    expect((await actions.load(action.id))?.undone).toBe(true)

    const sessions = new D1ReadingSessionRepository(fake.db, 'user-a')
    await sessions.saveAt(readingSession, new Date('2025-01-03T00:00:00.000Z'))
    await sessions.saveAt({ ...readingSession, status: 'completed' }, new Date('2025-01-02T00:00:00.000Z'))
    expect((await sessions.load(readingSession.id))?.status).toBe('reading')
    expect((await sessions.load(readingSession.id))?.startedAt).toEqual(readingSession.startedAt)
  })
})
