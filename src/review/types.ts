import type { Card, CardId, Rating } from '../domain/card'

/** A durable record of one FSRS rating made during a reading session. */
export type ReviewAction = {
  id: string
  sessionId: string
  cardId: CardId
  rating: Rating
  timestamp: Date
  previousState: Card
  nextState: Card
  undone: boolean
  undoneAt?: Date
}

/** The card snapshots returned from a review or its undo operation. */
export type ReviewActionResult = {
  previous: Card
  next: Card
  action: ReviewAction
}

export type ReviewClock = () => Date
export type ReviewIdFactory = (kind?: string) => string

export type ReviewServiceOptions = {
  cardService: CardReviewService
  actionRepository: ReviewActionRepository
  clock?: ReviewClock
  idFactory?: ReviewIdFactory
}

/** The CardService methods needed by the review boundary. */
export interface CardReviewService {
  review(id: CardId, rating: Rating, now: Date): Promise<{ previous: Card; next: Card }>
  restore(previous: Card): Promise<Card>
}

/** Storage port for session-scoped review actions. */
export interface ReviewActionRepository {
  save(action: ReviewAction): Promise<void>
  load(id: string): Promise<ReviewAction | null>
  loadAll(): Promise<ReviewAction[]>
  findLatestNonUndone(sessionId: string, cardId: CardId): Promise<ReviewAction | null>
}

export type UndoReviewInput = {
  sessionId: string
  cardId: CardId
  actionId?: string
}
