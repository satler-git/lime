import type { Card, CardId, CardState } from '../domain/card'
import type { CardRepository } from '../repositories/card-repository'

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

export type IndexedDbCardRepositoryOptions = {
  dbName?: string
  storeName?: string
  indexedDB?: IDBFactory
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
})

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
})

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
    this.dbName = options.dbName ?? 'lime'
    this.storeName = options.storeName ?? 'cards'
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB

    if (!this.indexedDB) {
      throw new Error('IndexedDB is not available')
    }
  }

  private open(): Promise<IDBDatabase> {
    this.database ??= new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.dbName, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(this.storeName)) {
          request.result.createObjectStore(this.storeName, { keyPath: 'id' })
        }
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
    })

    return this.database
  }

  async save(card: Card): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put(serialize(card))
    await transactionDone(transaction)
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
    const database = await this.database
    database?.close()
    this.database = undefined
  }
}
