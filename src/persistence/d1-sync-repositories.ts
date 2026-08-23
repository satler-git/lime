import type { D1Database } from '@cloudflare/workers-types'
import type { Card, CardId, CardState } from '../domain/card'
import type { CardRepository } from '../repositories/card-repository'
import type { ReviewAction, ReviewActionRepository } from '../review/types'
import { cloneReviewAction } from '../review/repository'
import type { ReadingSession, ReadingSessionRepository, SessionStatus } from '../session'
import { cloneReadingSession } from '../session/session-service'
import {
  deserializeReadingSession,
  deserializeReviewAction,
  serializeCard,
  serializeReadingSession,
  serializeReviewAction,
  type SerializedReadingSession,
  type SerializedReviewAction,
} from '../sync/types'

interface CardRow {
  id: string
  word: string
  created_at: number
  due: number
  stability: number
  difficulty: number
  elapsed_days: number
  scheduled_days: number
  learning_steps: number
  reps: number
  lapses: number
  state: CardState
  last_review: number | null
  updated_at: number
}

interface ReviewActionRow {
  id: string
  session_id: string
  card_id: string
  rating: ReviewAction['rating']
  timestamp: number
  previous_state_json: string
  next_state_json: string
  undone: number
  undone_at: number | null
  updated_at: number
}

interface ReadingSessionRow {
  id: string
  status: SessionStatus
  created_at: number
  started_at: number | null
  quiz_started_at: number | null
  completed_at: number | null
  abandoned_at: number | null
  lookup_events_json: string
  card_ids_json: string
  updated_at: number
}

const milliseconds = (date: Date): number => {
  const value = date.getTime()
  if (!Number.isFinite(value)) throw new Error('Invalid date')
  return value
}

const dateFromMilliseconds = (value: number): Date => {
  if (!Number.isFinite(value)) throw new Error('Invalid persisted date')
  return new Date(value)
}

const optionalDate = (value: number | null): Date | undefined => value === null ? undefined : dateFromMilliseconds(value)

const mapCard = (row: CardRow): Card => {
  const lastReview = optionalDate(row.last_review)
  return {
    id: row.id,
    word: row.word,
    createdAt: dateFromMilliseconds(row.created_at),
    due: dateFromMilliseconds(row.due),
    stability: row.stability,
    difficulty: row.difficulty,
    elapsedDays: row.elapsed_days,
    scheduledDays: row.scheduled_days,
    learningSteps: row.learning_steps,
    reps: row.reps,
    lapses: row.lapses,
    state: row.state,
    ...(lastReview === undefined ? {} : { lastReview }),
  }
}

const mapAction = (row: ReviewActionRow): ReviewAction => {
  const previousState = JSON.parse(row.previous_state_json) as Parameters<typeof deserializeReviewAction>[0]['previousState']
  const nextState = JSON.parse(row.next_state_json) as Parameters<typeof deserializeReviewAction>[0]['nextState']
  const serialized: SerializedReviewAction = {
    id: row.id,
    sessionId: row.session_id,
    cardId: row.card_id,
    rating: row.rating,
    timestamp: new Date(row.timestamp).toISOString(),
    previousState,
    nextState,
    undone: row.undone !== 0,
    undoneAt: row.undone_at === null ? null : new Date(row.undone_at).toISOString(),
  }
  return deserializeReviewAction(serialized)
}

const mapSession = (row: ReadingSessionRow): ReadingSession => {
  const serialized: SerializedReadingSession = {
    id: row.id,
    cardIds: JSON.parse(row.card_ids_json) as string[],
    status: row.status,
    createdAt: new Date(row.created_at).toISOString(),
    startedAt: row.started_at === null ? null : new Date(row.started_at).toISOString(),
    quizStartedAt: row.quiz_started_at === null ? null : new Date(row.quiz_started_at).toISOString(),
    completedAt: row.completed_at === null ? null : new Date(row.completed_at).toISOString(),
    abandonedAt: row.abandoned_at === null ? null : new Date(row.abandoned_at).toISOString(),
    lookupEvents: JSON.parse(row.lookup_events_json) as SerializedReadingSession['lookupEvents'],
  }
  return deserializeReadingSession(serialized)
}

/** D1 card persistence scoped permanently to one authenticated user. */
export class D1CardRepository implements CardRepository {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async save(card: Card): Promise<void> {
    await this.saveAt(card, new Date())
  }

  async saveAt(card: Card, updatedAt: Date): Promise<void> {
    const serialized = serializeCard(card)
    await this.db.prepare(
      `INSERT INTO cards (user_id, id, word, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET
         word = excluded.word, created_at = excluded.created_at, due = excluded.due,
         stability = excluded.stability, difficulty = excluded.difficulty, elapsed_days = excluded.elapsed_days,
         scheduled_days = excluded.scheduled_days, learning_steps = excluded.learning_steps, reps = excluded.reps,
         lapses = excluded.lapses, state = excluded.state, last_review = excluded.last_review, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= cards.updated_at`,
    ).bind(
      this.userId, serialized.id, serialized.word, milliseconds(new Date(serialized.createdAt)), milliseconds(new Date(serialized.due)),
      serialized.stability, serialized.difficulty, serialized.elapsedDays, serialized.scheduledDays, serialized.learningSteps,
      serialized.reps, serialized.lapses, serialized.state, serialized.lastReview === null ? null : milliseconds(new Date(serialized.lastReview)),
      milliseconds(updatedAt),
    ).run()
  }

  async load(id: CardId): Promise<Card | null> {
    const row = await this.db.prepare(
      'SELECT id, word, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, updated_at FROM cards WHERE user_id = ? AND id = ?',
    ).bind(this.userId, id).first<CardRow>()
    return row === null ? null : mapCard(row)
  }

  async loadAll(): Promise<Card[]> {
    const result = await this.db.prepare(
      'SELECT id, word, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, updated_at FROM cards WHERE user_id = ? ORDER BY id',
    ).bind(this.userId).all<CardRow>()
    return result.results.map(mapCard)
  }

  async loadAllWithUpdatedAt(): Promise<Array<{ card: Card; updatedAt: Date }>> {
    const result = await this.db.prepare(
      'SELECT id, word, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, updated_at FROM cards WHERE user_id = ? ORDER BY id',
    ).bind(this.userId).all<CardRow>()
    return result.results.map((row) => ({ card: mapCard(row), updatedAt: new Date(row.updated_at) }))
  }

  async getDue(now: Date): Promise<Card[]> {
    const result = await this.db.prepare(
      'SELECT id, word, created_at, due, stability, difficulty, elapsed_days, scheduled_days, learning_steps, reps, lapses, state, last_review, updated_at FROM cards WHERE user_id = ? AND due <= ? ORDER BY due, id',
    ).bind(this.userId, milliseconds(now)).all<CardRow>()
    return result.results.map(mapCard)
  }

  restore(card: Card): Promise<void> { return this.save(card) }
}

/** D1 review-action persistence scoped permanently to one authenticated user. */
export class D1ReviewActionRepository implements ReviewActionRepository {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async save(action: ReviewAction): Promise<void> {
    await this.saveAt(action, new Date())
  }

  async saveAt(action: ReviewAction, updatedAt: Date): Promise<void> {
    const serialized = serializeReviewAction(action)
    await this.db.prepare(
      `INSERT INTO review_actions (user_id, id, session_id, card_id, rating, timestamp, previous_state_json, next_state_json, undone, undone_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET
         session_id = excluded.session_id, card_id = excluded.card_id, rating = excluded.rating,
         timestamp = excluded.timestamp, previous_state_json = excluded.previous_state_json,
         next_state_json = excluded.next_state_json, undone = excluded.undone, undone_at = excluded.undone_at,
         updated_at = excluded.updated_at
       WHERE excluded.updated_at >= review_actions.updated_at`,
    ).bind(
      this.userId, serialized.id, serialized.sessionId, serialized.cardId, serialized.rating, milliseconds(new Date(serialized.timestamp)),
      JSON.stringify(serialized.previousState), JSON.stringify(serialized.nextState), serialized.undone ? 1 : 0,
      serialized.undoneAt === null ? null : milliseconds(new Date(serialized.undoneAt)), milliseconds(updatedAt),
    ).run()
  }

  async load(id: string): Promise<ReviewAction | null> {
    const row = await this.db.prepare(
      'SELECT id, session_id, card_id, rating, timestamp, previous_state_json, next_state_json, undone, undone_at, updated_at FROM review_actions WHERE user_id = ? AND id = ?',
    ).bind(this.userId, id).first<ReviewActionRow>()
    return row === null ? null : cloneReviewAction(mapAction(row))
  }

  async loadAll(): Promise<ReviewAction[]> {
    const result = await this.db.prepare(
      'SELECT id, session_id, card_id, rating, timestamp, previous_state_json, next_state_json, undone, undone_at, updated_at FROM review_actions WHERE user_id = ? ORDER BY timestamp, id',
    ).bind(this.userId).all<ReviewActionRow>()
    return result.results.map(mapAction).map(cloneReviewAction)
  }

  async loadAllWithUpdatedAt(): Promise<Array<{ action: ReviewAction; updatedAt: Date }>> {
    const result = await this.db.prepare(
      'SELECT id, session_id, card_id, rating, timestamp, previous_state_json, next_state_json, undone, undone_at, updated_at FROM review_actions WHERE user_id = ? ORDER BY timestamp, id',
    ).bind(this.userId).all<ReviewActionRow>()
    return result.results.map((row) => ({ action: cloneReviewAction(mapAction(row)), updatedAt: new Date(row.updated_at) }))
  }

  async findLatestNonUndone(sessionId: string, cardId: CardId): Promise<ReviewAction | null> {
    const row = await this.db.prepare(
      'SELECT id, session_id, card_id, rating, timestamp, previous_state_json, next_state_json, undone, undone_at, updated_at FROM review_actions WHERE user_id = ? AND session_id = ? AND card_id = ? AND undone = 0 ORDER BY timestamp DESC, id DESC LIMIT 1',
    ).bind(this.userId, sessionId, cardId).first<ReviewActionRow>()
    return row === null ? null : cloneReviewAction(mapAction(row))
  }
}

/** D1 reading-session persistence scoped permanently to one authenticated user. */
export class D1ReadingSessionRepository implements ReadingSessionRepository {
  constructor(private readonly db: D1Database, private readonly userId: string) {}

  async save(session: ReadingSession): Promise<void> {
    await this.saveAt(session, new Date())
  }

  async saveAt(session: ReadingSession, updatedAt: Date): Promise<void> {
    const serialized = serializeReadingSession(session)
    await this.db.prepare(
      `INSERT INTO reading_sessions (user_id, id, status, created_at, started_at, quiz_started_at, completed_at, abandoned_at, card_ids_json, lookup_events_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, id) DO UPDATE SET
         status = excluded.status, created_at = excluded.created_at, started_at = excluded.started_at,
         quiz_started_at = excluded.quiz_started_at, completed_at = excluded.completed_at, abandoned_at = excluded.abandoned_at,
         card_ids_json = excluded.card_ids_json, lookup_events_json = excluded.lookup_events_json, updated_at = excluded.updated_at
       WHERE excluded.updated_at >= reading_sessions.updated_at`,
    ).bind(
      this.userId, serialized.id, serialized.status, milliseconds(new Date(serialized.createdAt)),
      serialized.startedAt === null ? null : milliseconds(new Date(serialized.startedAt)),
      serialized.quizStartedAt === null ? null : milliseconds(new Date(serialized.quizStartedAt)),
      serialized.completedAt === null ? null : milliseconds(new Date(serialized.completedAt)),
      serialized.abandonedAt === null ? null : milliseconds(new Date(serialized.abandonedAt)),
      JSON.stringify(serialized.cardIds), JSON.stringify(serialized.lookupEvents), milliseconds(updatedAt),
    ).run()
  }

  async load(id: string): Promise<ReadingSession | null> {
    const row = await this.db.prepare(
      'SELECT id, status, created_at, started_at, quiz_started_at, completed_at, abandoned_at, card_ids_json, lookup_events_json, updated_at FROM reading_sessions WHERE user_id = ? AND id = ?',
    ).bind(this.userId, id).first<ReadingSessionRow>()
    return row === null ? null : cloneReadingSession(mapSession(row))
  }

  async loadAll(): Promise<ReadingSession[]> {
    const result = await this.db.prepare(
      'SELECT id, status, created_at, started_at, quiz_started_at, completed_at, abandoned_at, card_ids_json, lookup_events_json, updated_at FROM reading_sessions WHERE user_id = ? ORDER BY created_at, id',
    ).bind(this.userId).all<ReadingSessionRow>()
    return result.results.map(mapSession).map(cloneReadingSession)
  }

  async loadAllWithUpdatedAt(): Promise<Array<{ session: ReadingSession; updatedAt: Date }>> {
    const result = await this.db.prepare(
      'SELECT id, status, created_at, started_at, quiz_started_at, completed_at, abandoned_at, card_ids_json, lookup_events_json, updated_at FROM reading_sessions WHERE user_id = ? ORDER BY created_at, id',
    ).bind(this.userId).all<ReadingSessionRow>()
    return result.results.map((row) => ({ session: cloneReadingSession(mapSession(row)), updatedAt: new Date(row.updated_at) }))
  }
}

export type D1SyncRepositories = {
  cards: D1CardRepository
  reviewActions: D1ReviewActionRepository
  sessions: D1ReadingSessionRepository
}

export const createD1SyncRepositories = (db: D1Database, userId: string): D1SyncRepositories => ({
  cards: new D1CardRepository(db, userId),
  reviewActions: new D1ReviewActionRepository(db, userId),
  sessions: new D1ReadingSessionRepository(db, userId),
})
