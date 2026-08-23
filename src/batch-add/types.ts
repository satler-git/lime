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
  candidates: readonly BatchCandidate[]
  selectedWords: readonly string[]
}

/** A deliberately small port implemented by CardService and test doubles. */
export interface CardCreator {
  create(input: NewCard): Promise<Card>
}

export type BatchAddResult = {
  createdCards: Card[]
  selectedWords: string[]
}
