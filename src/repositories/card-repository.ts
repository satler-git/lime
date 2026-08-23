import type { Card, CardId } from '../domain/card'

/** Storage port; implementations may use IndexedDB, D1, or another database. */
export interface CardRepository {
  save(card: Card): Promise<void>
  load(id: CardId): Promise<Card | null>
  loadAll(): Promise<Card[]>
  getDue(now: Date): Promise<Card[]>
  restore(card: Card): Promise<void>
}
