import type { CardService } from '../application/card-service'
import { cloneCard, type CardId, type Rating } from '../domain/card'
import type { ReadingSession } from '../session/types'
import { cloneReviewAction } from './repository'
import type {
  CardReviewService,
  ReviewAction,
  ReviewActionRepository,
  ReviewActionResult,
  ReviewClock,
  ReviewIdFactory,
  ReviewServiceOptions,
  UndoReviewInput,
} from './types'

const ratings: readonly Rating[] = ['again', 'hard', 'good', 'easy']

const defaultClock: ReviewClock = () => new Date()

const defaultIdFactory: ReviewIdFactory = (kind = 'id') => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `${kind}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

const copyDate = (date: Date): Date => new Date(date.getTime())

const assertDate = (date: Date, name: string): void => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be a valid Date`)
  }
}

/** Invalid session/card/rating input at the review application boundary. */
export class ReviewValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewValidationError'
  }
}

/** A review cannot be undone because it is stale, missing, or already undone. */
export class ReviewUndoError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ReviewUndoError'
  }
}

/**
 * Coordinates a session-scoped review with the existing CardService boundary.
 * The service does not know about React, persistence details, or the scheduler
 * implementation; CardService applies its configured CardScheduler (FSRS by
 * default), while this service owns action history and undo rules.
 */
export class ReviewService {
  private readonly cardService: CardReviewService
  private readonly actionRepository: ReviewActionRepository
  private readonly clock: ReviewClock
  private readonly idFactory: ReviewIdFactory

  constructor(options: ReviewServiceOptions)
  constructor(
    cardService: CardReviewService | CardService,
    actionRepository: ReviewActionRepository,
    options?: Omit<ReviewServiceOptions, 'cardService' | 'actionRepository'>,
  )
  constructor(
    optionsOrCardService: ReviewServiceOptions | CardReviewService | CardService,
    actionRepository?: ReviewActionRepository,
    options: Omit<ReviewServiceOptions, 'cardService' | 'actionRepository'> = {},
  ) {
    if (actionRepository === undefined) {
      const configured = optionsOrCardService as ReviewServiceOptions
      this.cardService = configured.cardService
      this.actionRepository = configured.actionRepository
      this.clock = configured.clock ?? defaultClock
      this.idFactory = configured.idFactory ?? defaultIdFactory
      return
    }

    this.cardService = optionsOrCardService as CardReviewService
    this.actionRepository = actionRepository
    this.clock = options.clock ?? defaultClock
    this.idFactory = options.idFactory ?? defaultIdFactory
  }

  /** Apply one explicit FSRS rating and persist its reversible action. */
  async review(
    session: ReadingSession,
    cardId: CardId,
    rating: Rating,
    at = this.clock(),
  ): Promise<ReviewActionResult> {
    this.assertReviewable(session, cardId, rating)
    assertDate(at, 'review timestamp')

    const latest = await this.actionRepository.findLatestNonUndone(session.id, cardId)
    if (latest !== null) {
      throw new ReviewValidationError(`Card ${cardId} already has an active review in session ${session.id}`)
    }

    // CardService delegates scheduling to its CardScheduler, so this boundary
    // remains independent of the concrete FSRS adapter.
    const result = await this.cardService.review(cardId, rating, copyDate(at))
    const action: ReviewAction = {
      id: this.idFactory('review'),
      sessionId: session.id,
      cardId,
      rating,
      timestamp: copyDate(at),
      previousState: cloneCard(result.previous),
      nextState: cloneCard(result.next),
      undone: false,
    }

    await this.actionRepository.save(action)
    return {
      previous: cloneCard(action.previousState),
      next: cloneCard(action.nextState),
      action: cloneReviewAction(action),
    }
  }

  reviewCard(session: ReadingSession, cardId: CardId, rating: Rating, at?: Date): Promise<ReviewActionResult> {
    return this.review(session, cardId, rating, at)
  }

  recordReview(session: ReadingSession, cardId: CardId, rating: Rating, at?: Date): Promise<ReviewActionResult> {
    return this.review(session, cardId, rating, at)
  }

  /**
   * Undo the latest non-undone action for a card in a session. Passing an
   * action ID is optional, but when supplied it prevents undoing a stale action.
   * A session object additionally lets undo enforce the active-session rules.
   */
  async undo(session: ReadingSession, cardId: CardId, actionId?: string, at?: Date): Promise<ReviewActionResult>
  async undo(sessionId: string, cardId: CardId, actionId?: string, at?: Date): Promise<ReviewActionResult>
  async undo(input: UndoReviewInput, at?: Date): Promise<ReviewActionResult>
  async undo(
    sessionOrInput: ReadingSession | string | UndoReviewInput,
    cardIdOrAt?: CardId | Date,
    actionIdOrAt?: string | Date,
    undoAt?: Date,
  ): Promise<ReviewActionResult> {
    const input = this.normalizeUndoInput(sessionOrInput, cardIdOrAt, actionIdOrAt)
    const at = undoAt ?? (actionIdOrAt instanceof Date ? actionIdOrAt : cardIdOrAt instanceof Date ? cardIdOrAt : this.clock())
    assertDate(at, 'undo timestamp')

    if (input.session !== undefined) {
      this.assertReviewableSession(input.session)
      if (!input.session.cardIds.includes(input.cardId)) {
        throw new ReviewValidationError(`Card ${input.cardId} is not included in session ${input.session.id}`)
      }
    }

    const latest = await this.actionRepository.findLatestNonUndone(input.sessionId, input.cardId)
    if (latest === null) {
      throw new ReviewUndoError(`No active review action exists for card ${input.cardId} in session ${input.sessionId}`)
    }
    if (input.actionId !== undefined && input.actionId !== latest.id) {
      throw new ReviewUndoError(`Review action ${input.actionId} is not the latest active action for card ${input.cardId}`)
    }
    if (latest.undone) {
      // Repositories should not return this, but retaining this guard makes the
      // invariant explicit for custom repository implementations.
      throw new ReviewUndoError(`Review action ${latest.id} has already been undone`)
    }

    await this.cardService.restore(latest.previousState)
    const undoneAction: ReviewAction = {
      ...latest,
      undone: true,
      undoneAt: copyDate(at),
    }
    await this.actionRepository.save(undoneAction)

    return {
      previous: cloneCard(undoneAction.nextState),
      next: cloneCard(undoneAction.previousState),
      action: cloneReviewAction(undoneAction),
    }
  }

  undoReview(session: ReadingSession, cardId: CardId, actionId?: string, at?: Date): Promise<ReviewActionResult>
  undoReview(sessionId: string, cardId: CardId, actionId?: string, at?: Date): Promise<ReviewActionResult>
  undoReview(input: UndoReviewInput, at?: Date): Promise<ReviewActionResult>
  undoReview(
    sessionOrInput: ReadingSession | string | UndoReviewInput,
    cardIdOrAt?: CardId | Date,
    actionIdOrAt?: string | Date,
    undoAt?: Date,
  ): Promise<ReviewActionResult> {
    return this.undo(sessionOrInput as never, cardIdOrAt as never, actionIdOrAt as never, undoAt)
  }

  private assertReviewable(session: ReadingSession, cardId: CardId, rating: Rating): void {
    this.assertReviewableSession(session)
    if (!session.cardIds.includes(cardId)) {
      throw new ReviewValidationError(`Card ${cardId} is not included in session ${session.id}`)
    }
    if (!ratings.includes(rating)) {
      throw new ReviewValidationError(`Invalid rating: ${String(rating)}`)
    }
  }

  private assertReviewableSession(session: ReadingSession): void {
    if (session.status !== 'reading') {
      throw new ReviewValidationError(`Cannot review cards in a ${session.status} session; session must be reading`)
    }
  }

  private normalizeUndoInput(
    sessionOrInput: ReadingSession | string | UndoReviewInput,
    cardIdOrAt?: CardId | Date,
    actionIdOrAt?: string | Date,
  ): { sessionId: string; cardId: CardId; actionId?: string; session?: ReadingSession } {
    if (typeof sessionOrInput === 'object') {
      if ('status' in sessionOrInput) {
        if (typeof cardIdOrAt !== 'string') {
          throw new ReviewUndoError('A card ID is required to undo a review')
        }
        return {
          sessionId: sessionOrInput.id,
          cardId: cardIdOrAt,
          actionId: typeof actionIdOrAt === 'string' ? actionIdOrAt : undefined,
          session: sessionOrInput,
        }
      }

      return {
        sessionId: sessionOrInput.sessionId,
        cardId: sessionOrInput.cardId,
        actionId: sessionOrInput.actionId,
      }
    }

    if (typeof cardIdOrAt !== 'string') {
      throw new ReviewUndoError('A card ID is required to undo a review')
    }

    return {
      sessionId: sessionOrInput,
      cardId: cardIdOrAt,
      actionId: typeof actionIdOrAt === 'string' ? actionIdOrAt : undefined,
    }
  }
}

/** More explicit name for callers that organize services by session behavior. */
export const SessionReviewService = ReviewService

/** Factory-friendly alias matching the action-oriented language of the API. */
export const ReviewActionService = ReviewService