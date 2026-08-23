import { createCard, type Card, type CardId, type NewCard, type Rating } from '../domain/card'
import type { CardScheduler, ReviewResult } from '../scheduling/card-scheduler'
import { FsrsScheduler } from '../scheduling/fsrs-scheduler'
import type { CardRepository } from '../repositories/card-repository'

/** Coordinates the storage port and scheduler without coupling either implementation. */
export class CardService {
  constructor(
    private readonly repository: CardRepository,
    private readonly scheduler: CardScheduler = new FsrsScheduler(),
  ) {}

  async create(input: NewCard): Promise<Card> {
    const card = createCard(input)
    await this.repository.save(card)
    return card
  }

  getDueCards(now: Date): Promise<Card[]> {
    return this.repository.getDue(now)
  }

  async review(id: CardId, rating: Rating, now: Date): Promise<ReviewResult> {
    const card = await this.repository.load(id)
    if (card === null) {
      throw new Error(`Card not found: ${id}`)
    }

    const result = this.scheduler.review(card, rating, now)
    await this.repository.save(result.next)
    return result
  }

  async restore(previous: Card): Promise<Card> {
    await this.repository.restore(previous)
    return previous
  }
}
