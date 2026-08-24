import type { CardId } from '../domain/card'
import { normalizeWord } from '../domain/word'
import {
  type LookupEvent,
  type ReadingSession,
  type ReadingSessionServiceOptions,
  type SessionClock,
  type SessionCycle,
  type SessionIdFactory,
  type SessionStatus,
  type TextPosition,
  type LookupSource,
  type UnregisteredLookup,
} from './types'

export type RecordLookupInput = {
  word: string
  source: LookupSource
  position: TextPosition
  /** Defaults to the service clock when omitted. */
  timestamp?: Date
  inSrs: boolean
}

export class SessionTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionTransitionError'
  }
}

export class InvalidLookupError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvalidLookupError'
  }
}

const defaultClock: SessionClock = () => new Date()

const defaultIdFactory: SessionIdFactory = (kind = 'id') => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const copyDate = (date: Date): Date => new Date(date.getTime())

const copyPosition = (position: TextPosition): TextPosition => ({
  paragraph: position.paragraph,
  character: position.character,
})

const copyLookupEvent = (event: LookupEvent): LookupEvent => ({
  ...event,
  position: copyPosition(event.position),
  timestamp: copyDate(event.timestamp),
})

/** Clone a session at the boundary of every operation. */
export function cloneReadingSession(session: ReadingSession): ReadingSession {
  return {
    ...session,
    cardIds: [...session.cardIds],
    createdAt: copyDate(session.createdAt),
    ...(session.startedAt === undefined ? {} : { startedAt: copyDate(session.startedAt) }),
    ...(session.quizStartedAt === undefined ? {} : { quizStartedAt: copyDate(session.quizStartedAt) }),
    ...(session.completedAt === undefined ? {} : { completedAt: copyDate(session.completedAt) }),
    ...(session.abandonedAt === undefined ? {} : { abandonedAt: copyDate(session.abandonedAt) }),
    lookupEvents: session.lookupEvents.map(copyLookupEvent),
  }
}

const assertDate = (date: Date, name: string): void => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be a valid Date`)
  }
}

const assertPosition: (position: unknown) => asserts position is TextPosition = (position) => {
  if (position === null || typeof position !== 'object') {
    throw new InvalidLookupError('position must be an object')
  }
  const candidate = position as TextPosition
  if (!Number.isInteger(candidate.paragraph) || candidate.paragraph < 0) {
    throw new InvalidLookupError('position.paragraph must be a non-negative integer')
  }
  if (!Number.isInteger(candidate.character) || candidate.character < 0) {
    throw new InvalidLookupError('position.character must be a non-negative integer')
  }
}

/** Validate lookup input without performing any provider or persistence work. */
export function validateLookupInput(input: RecordLookupInput): void {
  if (input === null || typeof input !== 'object') {
    throw new InvalidLookupError('Lookup input must be an object')
  }
  if (typeof input.word !== 'string' || input.word.trim().length === 0) {
    throw new InvalidLookupError('A lookup word is required')
  }
  if (input.source !== 'article' && input.source !== 'example') {
    throw new InvalidLookupError('Lookup source must be article or example')
  }
  assertPosition(input.position)
  if (typeof input.inSrs !== 'boolean') {
    throw new InvalidLookupError('inSrs must be a boolean')
  }
  if (input.timestamp !== undefined) {
    assertDate(input.timestamp, 'lookup timestamp')
  }
}

const cardIdsFromCycle = (cycle: SessionCycle): CardId[] => cycle.map((item) => typeof item === 'string' ? item : item.id)

const assertCanTransition = (session: ReadingSession, expected: SessionStatus, next: SessionStatus): void => {
  if (session.status !== expected) {
    throw new SessionTransitionError(`Cannot transition session from ${session.status} to ${next}; expected ${expected}`)
  }
}

const assertReading = (session: ReadingSession): void => {
  if (session.status !== 'reading') {
    throw new SessionTransitionError(`Cannot record a lookup in a ${session.status} session; session must be reading`)
  }
}

/**
 * Pure reading-session state service. It never mutates a supplied session or
 * stores state internally; callers can persist each returned snapshot through
 * any repository implementation.
 */
export class ReadingSessionService {
  private readonly clock: SessionClock
  private readonly idFactory: SessionIdFactory

  constructor(options: ReadingSessionServiceOptions = {}) {
    this.clock = options.clock ?? defaultClock
    this.idFactory = options.idFactory ?? defaultIdFactory
  }

  /** Capture the cycle's card IDs without retaining references to the cycle. */
  createSnapshot(cycle: SessionCycle): ReadingSession {
    const createdAt = copyDate(this.clock())
    assertDate(createdAt, 'clock result')

    return {
      id: this.idFactory('session'),
      cardIds: cardIdsFromCycle(cycle),
      status: 'created',
      createdAt,
      lookupEvents: [],
    }
  }

  startReading(session: ReadingSession, at = this.clock()): ReadingSession {
    assertCanTransition(session, 'created', 'reading')
    assertDate(at, 'start time')
    const snapshot = cloneReadingSession(session)
    return { ...snapshot, status: 'reading', startedAt: copyDate(at) }
  }

  transitionToQuiz(session: ReadingSession, at = this.clock()): ReadingSession {
    assertCanTransition(session, 'reading', 'quiz')
    assertDate(at, 'quiz start time')
    const snapshot = cloneReadingSession(session)
    return { ...snapshot, status: 'quiz', quizStartedAt: copyDate(at) }
  }

  complete(session: ReadingSession, at = this.clock()): ReadingSession {
    assertCanTransition(session, 'quiz', 'completed')
    assertDate(at, 'completion time')
    const snapshot = cloneReadingSession(session)
    return { ...snapshot, status: 'completed', completedAt: copyDate(at) }
  }

  abandon(session: ReadingSession, at = this.clock()): ReadingSession {
    if (session.status === 'completed' || session.status === 'abandoned') {
      throw new SessionTransitionError(`Cannot abandon a ${session.status} session`)
    }
    assertDate(at, 'abandon time')
    const snapshot = cloneReadingSession(session)
    return { ...snapshot, status: 'abandoned', abandonedAt: copyDate(at) }
  }

  recordLookup(session: ReadingSession, input: RecordLookupInput): ReadingSession {
    assertReading(session)
    validateLookupInput(input)
    const word = input.word.trim()
    const timestamp = copyDate(input.timestamp ?? this.clock())
    assertDate(timestamp, 'lookup timestamp')

    const event: LookupEvent = {
      id: this.idFactory('lookup'),
      word,
      source: input.source,
      position: copyPosition(input.position),
      timestamp,
      inSrs: input.inSrs,
    }
    const snapshot = cloneReadingSession(session)
    return { ...snapshot, lookupEvents: [...snapshot.lookupEvents, event] }
  }

  /** Return one candidate per normalized unregistered word, in first-seen order. */
  getUnregisteredLookups(session: ReadingSession): UnregisteredLookup[] {
    const candidates = new Map<string, UnregisteredLookup>()
    for (const event of session.lookupEvents) {
      if (event.inSrs) continue
      const normalizedWord = normalizeWord(event.word)
      if (normalizedWord.length === 0) continue
      const existing = candidates.get(normalizedWord)
      if (existing === undefined) {
        candidates.set(normalizedWord, { word: event.word, lookupCount: 1 })
      } else {
        existing.lookupCount += 1
      }
    }
    return [...candidates.values()]
  }
}
