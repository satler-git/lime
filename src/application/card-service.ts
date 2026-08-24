import { cloneCard, createCard, type Card, type CardId, type NewCard, type Rating } from '../domain/card'
import { normalizeWord } from '../domain/word'
import type { CardScheduler, ReviewResult } from '../scheduling/card-scheduler'
import { FsrsScheduler } from '../scheduling/fsrs-scheduler'
import type { CardRepository } from '../repositories/card-repository'
import type { CardCreator } from '../batch-add/types'

/** Coordinates the storage port and scheduler without coupling either implementation. */
export class CardService implements CardCreator {
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

  async findByWord(word: string): Promise<Card | null> {
    const normalized = normalizeWord(word)
    const cards = await this.repository.loadAll()
    const card = cards.find((candidate) => normalizeWord(candidate.word) === normalized)
    return card === undefined ? null : cloneCard(card)
  }

  /**
   * Delegate to an adapter's atomic operation when available. Adapters without
   * native atomic storage use the find-then-create fallback, which is not safe
   * against concurrent creators.
   */
  async createIfAbsent(input: NewCard): Promise<Card> {
    if (this.repository.createIfAbsent !== undefined) {
      return this.repository.createIfAbsent(input)
    }
    const existing = await this.findByWord(input.word)
    return existing ?? this.create(input)
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
