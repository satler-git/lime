import type { Card, CardState, Rating } from '../domain/card'
import type { ReviewAction } from '../review/types'
import type { LookupEvent, LookupSource, ReadingSession, SessionStatus, TextPosition } from '../session/types'

/** JSON-safe representation of a card. Domain Date values are never exposed as Date objects. */
export type SerializedCard = Omit<Card, 'createdAt' | 'due' | 'lastReview'> & {
  createdAt: string
  due: string
  lastReview: string | null
}

export type SerializedReviewAction = Omit<ReviewAction, 'timestamp' | 'previousState' | 'nextState' | 'undoneAt'> & {
  timestamp: string
  previousState: SerializedCard
  nextState: SerializedCard
  undoneAt: string | null
}

export type SerializedLookupEvent = Omit<LookupEvent, 'timestamp'> & { timestamp: string }

export type SerializedReadingSession = Omit<ReadingSession, 'createdAt' | 'startedAt' | 'quizStartedAt' | 'completedAt' | 'abandonedAt' | 'lookupEvents'> & {
  cardIds: string[]
  createdAt: string
  startedAt: string | null
  quizStartedAt: string | null
  completedAt: string | null
  abandonedAt: string | null
  lookupEvents: SerializedLookupEvent[]
}

/** A sync envelope carries a server-independent conflict timestamp. */
export type CardSyncEnvelope = { updatedAt: string; card: SerializedCard }
export type ReviewActionSyncEnvelope = { updatedAt: string; action: SerializedReviewAction }
export type ReadingSessionSyncEnvelope = { updatedAt: string; session: SerializedReadingSession }

export type SyncRequest = {
  cards: CardSyncEnvelope[]
  reviewActions: ReviewActionSyncEnvelope[]
  sessions: ReadingSessionSyncEnvelope[]
}

export type SyncResponse = SyncRequest
export type SyncBatchResponse = {
  summary: {
    cards: number
    reviewActions: number
    sessions: number
  }
}

export const MAX_SYNC_REQUEST_BODY_BYTES = 1 * 1024 * 1024
export const MAX_SYNC_RESPONSE_BODY_BYTES = 4 * 1024 * 1024
/** Explicit current sync hard cap: at most this many records per top-level type per batch or GET response; no cursor protocol yet. */
export const MAX_SYNC_ITEMS_PER_TYPE = 1_000
export const MAX_SYNC_CARD_IDS_PER_SESSION = 1_000
export const MAX_SYNC_LOOKUP_EVENTS_PER_SESSION = 1_000

const cardStates: readonly CardState[] = ['new', 'learning', 'review', 'relearning']
const ratings: readonly Rating[] = ['again', 'hard', 'good', 'easy']
const sessionStatuses: readonly SessionStatus[] = ['created', 'reading', 'quiz', 'completed', 'abandoned']
const lookupSources: readonly LookupSource[] = ['article', 'example']

export class SyncValidationError extends Error {
  constructor() {
    super('Invalid sync payload')
    this.name = 'SyncValidationError'
  }
}

const invalid = (): never => { throw new SyncValidationError() }
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : invalid()
const stringValue = (value: unknown): string => typeof value === 'string' && value.trim().length > 0 ? value : invalid()
const numberValue = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : invalid()
const nonNegativeNumberValue = (value: unknown): number => {
  const number = numberValue(value)
  return number >= 0 ? number : invalid()
}
const nonNegativeIntegerValue = (value: unknown): number => {
  const number = numberValue(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : invalid()
}
const difficultyValue = (value: unknown): number => {
  const number = nonNegativeNumberValue(value)
  return number <= 10 ? number : invalid()
}
const booleanValue = (value: unknown): boolean => typeof value === 'boolean' ? value : invalid()
const dateString = (value: unknown): string => {
  const text = stringValue(value)
  return Number.isNaN(Date.parse(text)) ? invalid() : text
}
const nullableDateString = (value: unknown): string | null => value === null ? null : dateString(value)
const arrayValue = (value: unknown): unknown[] => Array.isArray(value) ? value : invalid()
const boundedArrayValue = (value: unknown): unknown[] => {
  const array = arrayValue(value)
  return array.length <= MAX_SYNC_ITEMS_PER_TYPE ? array : invalid()
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T =>
  typeof value === 'string' && values.includes(value as T) ? value as T : invalid()

const parsePosition = (value: unknown): TextPosition => {
  const input = record(value)
  return {
    paragraph: nonNegativeIntegerValue(input.paragraph),
    character: nonNegativeIntegerValue(input.character),
  }
}

const parseCard = (value: unknown): SerializedCard => {
  const input = record(value)
  const lastReview = nullableDateString(input.lastReview)
  return {
    id: stringValue(input.id),
    word: stringValue(input.word),
    createdAt: dateString(input.createdAt),
    due: dateString(input.due),
    stability: nonNegativeNumberValue(input.stability),
    difficulty: difficultyValue(input.difficulty),
    elapsedDays: nonNegativeIntegerValue(input.elapsedDays),
    scheduledDays: nonNegativeIntegerValue(input.scheduledDays),
    learningSteps: nonNegativeIntegerValue(input.learningSteps),
    reps: nonNegativeIntegerValue(input.reps),
    lapses: nonNegativeIntegerValue(input.lapses),
    state: oneOf(input.state, cardStates),
    lastReview,
  }
}

const parseAction = (value: unknown): SerializedReviewAction => {
  const input = record(value)
  return {
    id: stringValue(input.id),
    sessionId: stringValue(input.sessionId),
    cardId: stringValue(input.cardId),
    rating: oneOf(input.rating, ratings),
    timestamp: dateString(input.timestamp),
    previousState: parseCard(input.previousState),
    nextState: parseCard(input.nextState),
    undone: booleanValue(input.undone),
    undoneAt: nullableDateString(input.undoneAt),
  }
}

const parseLookupEvent = (value: unknown): SerializedLookupEvent => {
  const input = record(value)
  return {
    id: stringValue(input.id),
    word: stringValue(input.word),
    source: oneOf(input.source, lookupSources),
    position: parsePosition(input.position),
    timestamp: dateString(input.timestamp),
    inSrs: booleanValue(input.inSrs),
  }
}

const parseSession = (value: unknown): SerializedReadingSession => {
  const input = record(value)
  const cardIds = arrayValue(input.cardIds)
  if (cardIds.length > MAX_SYNC_CARD_IDS_PER_SESSION) invalid()
  const lookupEvents = arrayValue(input.lookupEvents)
  if (lookupEvents.length > MAX_SYNC_LOOKUP_EVENTS_PER_SESSION) invalid()
  return {
    id: stringValue(input.id),
    cardIds: cardIds.map(stringValue),
    status: oneOf(input.status, sessionStatuses),
    createdAt: dateString(input.createdAt),
    startedAt: nullableDateString(input.startedAt),
    quizStartedAt: nullableDateString(input.quizStartedAt),
    completedAt: nullableDateString(input.completedAt),
    abandonedAt: nullableDateString(input.abandonedAt),
    lookupEvents: lookupEvents.map(parseLookupEvent),
  }
}

const parseEnvelope = <T>(value: unknown, key: string, parser: (value: unknown) => T): { updatedAt: string; value: T } => {
  const input = record(value)
  const parsed = parser(input[key])
  return { updatedAt: dateString(input.updatedAt), value: parsed }
}

export function parseSyncRequest(value: unknown): SyncRequest {
  const input = record(value)
  const cards = boundedArrayValue(input.cards).map((entry) => {
    const parsed = parseEnvelope(entry, 'card', parseCard)
    return { updatedAt: parsed.updatedAt, card: parsed.value }
  })
  const reviewActions = boundedArrayValue(input.reviewActions).map((entry) => {
    const parsed = parseEnvelope(entry, 'action', parseAction)
    return { updatedAt: parsed.updatedAt, action: parsed.value }
  })
  const sessions = boundedArrayValue(input.sessions).map((entry) => {
    const parsed = parseEnvelope(entry, 'session', parseSession)
    return { updatedAt: parsed.updatedAt, session: parsed.value }
  })
  return { cards, reviewActions, sessions }
}

export const serializeCard = (card: Card): SerializedCard => ({
  ...card,
  createdAt: card.createdAt.toISOString(),
  due: card.due.toISOString(),
  lastReview: card.lastReview?.toISOString() ?? null,
})

export const deserializeCard = (card: SerializedCard): Card => {
  const { createdAt, due, lastReview, ...values } = card
  return {
    ...values,
    createdAt: new Date(createdAt),
    due: new Date(due),
    ...(lastReview === null ? {} : { lastReview: new Date(lastReview) }),
  }
}

export const serializeReviewAction = (action: ReviewAction): SerializedReviewAction => ({
  ...action,
  timestamp: action.timestamp.toISOString(),
  previousState: serializeCard(action.previousState),
  nextState: serializeCard(action.nextState),
  undoneAt: action.undoneAt?.toISOString() ?? null,
})

export const deserializeReviewAction = (action: SerializedReviewAction): ReviewAction => {
  const { timestamp, previousState, nextState, undoneAt, ...values } = action
  return {
    ...values,
    timestamp: new Date(timestamp),
    previousState: deserializeCard(previousState),
    nextState: deserializeCard(nextState),
    ...(undoneAt === null ? {} : { undoneAt: new Date(undoneAt) }),
  }
}

export const serializeReadingSession = (session: ReadingSession): SerializedReadingSession => ({
  ...session,
  cardIds: [...session.cardIds],
  createdAt: session.createdAt.toISOString(),
  startedAt: session.startedAt?.toISOString() ?? null,
  quizStartedAt: session.quizStartedAt?.toISOString() ?? null,
  completedAt: session.completedAt?.toISOString() ?? null,
  abandonedAt: session.abandonedAt?.toISOString() ?? null,
  lookupEvents: session.lookupEvents.map((event) => ({ ...event, timestamp: event.timestamp.toISOString() })),
})

export const deserializeReadingSession = (session: SerializedReadingSession): ReadingSession => {
  const {
    cardIds, createdAt, startedAt, quizStartedAt, completedAt, abandonedAt, lookupEvents, ...values
  } = session
  return {
    ...values,
    cardIds: [...cardIds],
    createdAt: new Date(createdAt),
    ...(startedAt === null ? {} : { startedAt: new Date(startedAt) }),
    ...(quizStartedAt === null ? {} : { quizStartedAt: new Date(quizStartedAt) }),
    ...(completedAt === null ? {} : { completedAt: new Date(completedAt) }),
    ...(abandonedAt === null ? {} : { abandonedAt: new Date(abandonedAt) }),
    lookupEvents: lookupEvents.map((event) => ({ ...event, timestamp: new Date(event.timestamp) })),
  }
}
