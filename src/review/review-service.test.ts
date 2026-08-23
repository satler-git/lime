import { describe, expect, it } from 'vitest'
import { CardService } from '../application/card-service'
import { cloneCard, createCard, type Card, type CardId } from '../domain/card'
import type { CardRepository } from '../repositories/card-repository'
import { FsrsScheduler } from '../scheduling/fsrs-scheduler'
import type { ReadingSession } from '../session/types'
import { InMemoryReviewActionRepository } from './repository'
import { ReviewService, ReviewUndoError, ReviewValidationError } from './review-service'

const initialTime = new Date('2025-01-01T00:00:00.000Z')
const reviewTime = new Date('2025-01-01T00:01:00.000Z')

class TestCardRepository implements CardRepository {
  private readonly cards = new Map<CardId, Card>()

  async save(card: Card): Promise<void> {
    this.cards.set(card.id, cloneCard(card))
  }

  async load(id: CardId): Promise<Card | null> {
    const card = this.cards.get(id)
    return card === undefined ? null : cloneCard(card)
  }

  async loadAll(): Promise<Card[]> {
    return [...this.cards.values()].map(cloneCard)
  }

  async getDue(now: Date): Promise<Card[]> {
    return (await this.loadAll()).filter((card) => card.due.getTime() <= now.getTime())
  }

  async restore(card: Card): Promise<void> {
    await this.save(card)
  }
}

const makeSession = (status: ReadingSession['status'] = 'reading'): ReadingSession => ({
  id: 'session-1',
  cardIds: ['card-1'],
  status,
  createdAt: initialTime,
  startedAt: initialTime,
  lookupEvents: [],
})

const makeReviewService = async () => {
  const cardRepository = new TestCardRepository()
  const cardService = new CardService(cardRepository, new FsrsScheduler())
  const card = await cardService.create({ id: 'card-1', word: 'review', now: initialTime })
  let nextId = 0
  const actionRepository = new InMemoryReviewActionRepository()
  const reviewService = new ReviewService({
    cardService,
    actionRepository,
    clock: () => reviewTime,
    idFactory: (kind = 'id') => `${kind}-${nextId++}`,
  })
  return { cardRepository, actionRepository, card, reviewService }
}

describe('ReviewService', () => {
  it('applies an explicit FSRS rating and records reversible card states', async () => {
    const { card, reviewService, actionRepository } = await makeReviewService()

    const result = await reviewService.review(makeSession(), card.id, 'good', reviewTime)

    expect(result.previous).toEqual(card)
    expect(result.next.state).toBe('learning')
    expect(result.next.reps).toBe(1)
    expect(result.action).toMatchObject({
      id: 'review-0',
      sessionId: 'session-1',
      cardId: card.id,
      rating: 'good',
      timestamp: reviewTime,
      undone: false,
    })
    expect(result.action.previousState).toEqual(result.previous)
    expect(result.action.nextState).toEqual(result.next)
    await expect(actionRepository.load(result.action.id)).resolves.toEqual(result.action)
  })

  it('rejects cards outside the session, non-reading sessions, and invalid ratings', async () => {
    const { reviewService } = await makeReviewService()

    await expect(reviewService.review(makeSession(), 'other-card', 'good')).rejects.toThrowError(ReviewValidationError)
    await expect(reviewService.review(makeSession('created'), 'card-1', 'good')).rejects.toThrowError(ReviewValidationError)
    await expect(reviewService.review(makeSession(), 'card-1', 'unknown' as never)).rejects.toThrowError(ReviewValidationError)
  })

  it('rejects a second active review for the same session and card', async () => {
    const { card, cardRepository, actionRepository, reviewService } = await makeReviewService()
    const session = makeSession()
    const first = await reviewService.review(session, card.id, 'good', reviewTime)

    await expect(reviewService.review(session, card.id, 'easy', new Date('2025-01-01T00:02:00.000Z')))
      .rejects.toThrowError(ReviewValidationError)
    await expect(cardRepository.load(card.id)).resolves.toEqual(first.next)
    await expect(actionRepository.loadAll()).resolves.toHaveLength(1)
  })

  it('allows a new review after the active review is undone', async () => {
    const { card, reviewService, actionRepository } = await makeReviewService()
    const session = makeSession()
    const first = await reviewService.review(session, card.id, 'good', reviewTime)

    await reviewService.undo(session, card.id, first.action.id, new Date('2025-01-01T00:02:00.000Z'))
    const second = await reviewService.review(session, card.id, 'easy', new Date('2025-01-01T00:03:00.000Z'))

    expect(second.previous).toEqual(card)
    expect(second.action.id).toBe('review-1')
    await expect(actionRepository.findLatestNonUndone(session.id, card.id)).resolves.toMatchObject({ id: second.action.id })
  })

  it('selects the greatest timestamp and uses insertion order to break ties', async () => {
    const { card, actionRepository, reviewService } = await makeReviewService()
    const first = await reviewService.review(makeSession(), card.id, 'good', reviewTime)
    const earlier = new Date('2025-01-01T00:01:30.000Z')
    const later = new Date('2025-01-01T00:02:00.000Z')

    actionRepository.clear()
    await actionRepository.save({ ...first.action, id: 'saved-later-first', timestamp: later })
    await actionRepository.save({ ...first.action, id: 'saved-earlier-second', timestamp: earlier })

    await expect(actionRepository.findLatestNonUndone('session-1', card.id)).resolves.toMatchObject({ id: 'saved-later-first' })

    const tie = new Date('2025-01-01T00:03:00.000Z')
    actionRepository.clear()
    await actionRepository.save({ ...first.action, id: 'tie-first', timestamp: tie })
    await actionRepository.save({ ...first.action, id: 'tie-second', timestamp: tie })

    await expect(actionRepository.findLatestNonUndone('session-1', card.id)).resolves.toMatchObject({ id: 'tie-second' })
  })

  it('undoes only the latest action and restores its previous card state', async () => {
    const { card, cardRepository, reviewService, actionRepository } = await makeReviewService()
    const session = makeSession()
    const reviewed = await reviewService.review(session, card.id, 'good', reviewTime)

    const undone = await reviewService.undo(session, card.id, reviewed.action.id, new Date('2025-01-01T00:02:00.000Z'))

    expect(undone.previous).toEqual(reviewed.next)
    expect(undone.next).toEqual(card)
    expect(undone.action).toMatchObject({ id: reviewed.action.id, undone: true })
    expect(undone.action.undoneAt).toEqual(new Date('2025-01-01T00:02:00.000Z'))
    await expect(cardRepository.load(card.id)).resolves.toEqual(card)
    await expect(actionRepository.load(reviewed.action.id)).resolves.toMatchObject({ undone: true })
  })

  it('rejects stale, invalid, and duplicate undo requests without changing the card', async () => {
    const { card, cardRepository, reviewService } = await makeReviewService()
    const session = makeSession()
    const reviewed = await reviewService.review(session, card.id, 'good', reviewTime)

    await expect(reviewService.undo(session, card.id, 'not-the-action')).rejects.toThrowError(ReviewUndoError)
    await expect(cardRepository.load(card.id)).resolves.toEqual(reviewed.next)

    await reviewService.undo(session, card.id)
    await expect(reviewService.undo(session, card.id)).rejects.toThrowError(ReviewUndoError)
    await expect(reviewService.undo({ sessionId: session.id, cardId: card.id, actionId: reviewed.action.id }))
      .rejects.toThrowError(ReviewUndoError)
  })
})
