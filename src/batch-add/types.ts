import type { Card, NewCard } from '../domain/card'
import type { ReadingSession, UnregisteredLookup } from '../session/types'

export type BatchCandidate = {
  /** The first-seen spelling shown to the learner. */
  word: string
  /** The value used for matching and selection. */
  normalizedWord: string
  lookupCount: number
}

export type BatchCandidateSource = readonly UnregisteredLookup[] | ReadingSession

export type BatchSelectionState = {
  /** The reading session from which this selection was created. */
  sessionId: string
  /** A deterministic snapshot of the candidate order, spelling, and counts. */
  candidateFingerprint: string
  candidates: readonly BatchCandidate[]
  selectedWords: readonly string[]
}

/** Card creation and lookup operations required by the batch-add boundary. */
export interface CardCreator {
  create(input: NewCard): Promise<Card>
  findByWord(word: string): Promise<Card | null>
  createIfAbsent(input: NewCard): Promise<Card>
}

export type BatchAddResult = {
  createdCards: Card[]
  selectedWords: string[]
}
