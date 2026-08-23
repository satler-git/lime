import type { Card, Rating } from '../domain/card'

export type ReviewResult = {
  previous: Card
  next: Card
}

/** Scheduling is deliberately independent of persistence. */
export interface CardScheduler {
  review(card: Card, rating: Rating, now: Date): ReviewResult
}
