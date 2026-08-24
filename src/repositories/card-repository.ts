import type { Card, CardId, NewCard } from '../domain/card'

/** Narrow read-only port used when a session only needs to rehydrate cards. */
export interface CardLoader {
  load(id: CardId): Promise<Card | null>
}

/** Storage port; implementations may use IndexedDB, D1, or another database. */
export interface CardRepository extends CardLoader {
  save(card: Card): Promise<void>
  load(id: CardId): Promise<Card | null>
  loadAll(): Promise<Card[]>
  getDue(now: Date): Promise<Card[]>
  restore(card: Card): Promise<void>
  /** Optional atomic lookup-and-create operation for adapters that support it. */
  createIfAbsent?: (input: NewCard) => Promise<Card>
}
