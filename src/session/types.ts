import type { Card, CardId } from '../domain/card'

/** The lifecycle states of a reading session. */
export type SessionStatus = 'created' | 'reading' | 'quiz' | 'completed' | 'abandoned'

/** Where a dictionary lookup was initiated. */
export type LookupSource = 'article' | 'example'

export type TextPosition = {
  paragraph: number
  character: number
}

/** A single dictionary-open event captured during a reading session. */
export type LookupEvent = {
  id: string
  word: string
  source: LookupSource
  position: TextPosition
  timestamp: Date
  inSrs: boolean
}

/** A deduplicated word that can be offered for a later SRS add operation. */
export type UnregisteredLookup = {
  word: string
  lookupCount: number
}

/** The immutable state snapshot passed between session transitions. */
export type ReadingSession = {
  id: string
  cardIds: readonly CardId[]
  status: SessionStatus
  createdAt: Date
  startedAt?: Date
  quizStartedAt?: Date
  completedAt?: Date
  abandonedAt?: Date
  lookupEvents: readonly LookupEvent[]
}

/** Inputs accepted when making a session snapshot from a planned cycle. */
export type SessionCycle = readonly Card[] | readonly CardId[]

export type SessionClock = () => Date
export type SessionIdFactory = (kind?: string) => string

export type ReadingSessionServiceOptions = {
  clock?: SessionClock
  idFactory?: SessionIdFactory
}
