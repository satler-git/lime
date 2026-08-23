import {
  fsrs,
  Rating as FsrsRating,
  State as FsrsState,
  type Card as FsrsCard,
  type Grade as FsrsGrade,
} from 'ts-fsrs'
import { cloneCard, type Card, type CardState, type Rating } from '../domain/card'
import type { CardScheduler, ReviewResult } from './card-scheduler'

const ratings: Record<Rating, FsrsGrade> = {
  again: FsrsRating.Again,
  hard: FsrsRating.Hard,
  good: FsrsRating.Good,
  easy: FsrsRating.Easy,
}

const states: Record<FsrsState, CardState> = {
  [FsrsState.New]: 'new',
  [FsrsState.Learning]: 'learning',
  [FsrsState.Review]: 'review',
  [FsrsState.Relearning]: 'relearning',
}

const fsrsStates: Record<CardState, FsrsState> = {
  new: FsrsState.New,
  learning: FsrsState.Learning,
  review: FsrsState.Review,
  relearning: FsrsState.Relearning,
}

const toFsrsCard = (card: Card): FsrsCard => ({
  due: new Date(card.due),
  stability: card.stability,
  difficulty: card.difficulty,
  elapsed_days: card.elapsedDays,
  scheduled_days: card.scheduledDays,
  learning_steps: card.learningSteps,
  reps: card.reps,
  lapses: card.lapses,
  state: fsrsStates[card.state],
  ...(card.lastReview === undefined ? {} : { last_review: new Date(card.lastReview) }),
})

const fromFsrsCard = (source: FsrsCard, original: Card): Card => ({
  ...original,
  due: new Date(source.due),
  stability: source.stability,
  difficulty: source.difficulty,
  elapsedDays: source.elapsed_days,
  scheduledDays: source.scheduled_days,
  learningSteps: source.learning_steps,
  reps: source.reps,
  lapses: source.lapses,
  state: states[source.state],
  ...(source.last_review === undefined
    ? {}
    : { lastReview: new Date(source.last_review) }),
})

export type FsrsSchedulerOptions = Parameters<typeof fsrs>[0]

/** Thin adapter translating the domain model to and from ts-fsrs. */
export class FsrsScheduler implements CardScheduler {
  private readonly scheduler: ReturnType<typeof fsrs>

  constructor(options: FsrsSchedulerOptions = { enable_fuzz: false }) {
    this.scheduler = fsrs(options)
  }

  review(card: Card, rating: Rating, now: Date): ReviewResult {
    const previous = cloneCard(card)
    const result = this.scheduler.next(toFsrsCard(card), now, ratings[rating])

    return {
      previous,
      next: fromFsrsCard(result.card, card),
    }
  }
}
