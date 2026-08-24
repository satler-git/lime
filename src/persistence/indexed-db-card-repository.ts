import { createCard, type Card, type CardId, type CardState, type NewCard } from '../domain/card'
import { normalizeWord } from '../domain/word'
import type { CardRepository } from '../repositories/card-repository'
import {
  namespaceDatabaseName,
  openObjectStore,
  requestResult,
  transactionDone,
} from './indexed-db-persistence-helpers'

type PersistedCard = {
  id: CardId
  word: string
  createdAt: string
  due: string
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: CardState
  lastReview: string | null
}

/**
 * `dbName` is the base database name. It remains unchanged when `userId` is
 * omitted; when supplied, an unambiguous length-prefixed user namespace is
 * appended. A custom `dbName` + `storeName` pair is dedicated to this adapter;
 * it is not a supported arbitrary cross-adapter sharing mechanism, even when
 * another adapter requests the same store name.
 */
export type IndexedDbCardRepositoryOptions = {
  dbName?: string
  userId?: string
  storeName?: string
  indexedDB?: IDBFactory
}

const serialize = (card: Card): PersistedCard => {
  const { createdAt, due, lastReview, ...values } = card
  return {
    ...values,
    createdAt: createdAt.toISOString(),
    due: due.toISOString(),
    lastReview: lastReview?.toISOString() ?? null,
  }
}

const deserialize = (record: PersistedCard): Card => {
  const { createdAt, due, lastReview, ...values } = record
  return {
    ...values,
    createdAt: new Date(createdAt),
    due: new Date(due),
    ...(lastReview === null ? {} : { lastReview: new Date(lastReview) }),
  }
}

export class IndexedDbCardRepository implements CardRepository {
  private readonly dbName: string
  private readonly storeName: string
  private readonly indexedDB: IDBFactory
  private database?: Promise<IDBDatabase>

  constructor(options: IndexedDbCardRepositoryOptions = {}) {
    this.dbName = namespaceDatabaseName(options.dbName ?? 'lime', options.userId)
    this.storeName = options.storeName ?? 'cards'
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB

    if (!this.indexedDB) {
      throw new Error('IndexedDB is not available')
    }
  }

  private open(): Promise<IDBDatabase> {
    if (this.database === undefined) {
      const opening = openObjectStore(this.indexedDB, this.dbName, this.storeName, {
        onVersionChange: () => {
          this.database = undefined
        },
      })
      this.database = opening
      opening.catch(() => {
        if (this.database === opening) this.database = undefined
      })
    }

    return this.database
  }

  async save(card: Card): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put(serialize(card))
    await transactionDone(transaction)
  }

  /**
   * Find or insert a card in one readwrite transaction. Keeping the scan and
   * add in the same transaction lets IndexedDB serialize competing tabs that
   * are adding the same normalized word.
   */
  async createIfAbsent(input: NewCard): Promise<Card> {
    const normalizedWord = normalizeWord(input.word)
    if (normalizedWord.length === 0) {
      throw new Error('A card word is required')
    }

    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    const store = transaction.objectStore(this.storeName)
    const completion = transactionDone(transaction)

    try {
      const records = await requestResult<PersistedCard[]>(store.getAll())
      const existing = records.find((record) => normalizeWord(record.word) === normalizedWord)
      if (existing !== undefined) {
        await completion
        return deserialize(existing)
      }

      const card = createCard(input)
      store.add(serialize(card))
      await completion
      return card
    } catch (error) {
      // Consume a possible transaction rejection when a request fails first.
      await completion.catch(() => undefined)
      throw error
    }
  }

  async load(id: CardId): Promise<Card | null> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .get(id)
    const record = await requestResult<PersistedCard | undefined>(request)
    return record === undefined ? null : deserialize(record)
  }

  async loadAll(): Promise<Card[]> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .getAll()
    const records = await requestResult<PersistedCard[]>(request)
    return records.map(deserialize)
  }

  async getDue(now: Date): Promise<Card[]> {
    const cards = await this.loadAll()
    return cards
      .filter((card) => card.due.getTime() <= now.getTime())
      .sort((a, b) => a.due.getTime() - b.due.getTime())
  }

  restore(card: Card): Promise<void> {
    return this.save(card)
  }

  async close(): Promise<void> {
    const cachedDatabase = this.database
    const database = await cachedDatabase?.catch(() => undefined)
    database?.close()
    if (this.database === cachedDatabase) this.database = undefined
  }
}
