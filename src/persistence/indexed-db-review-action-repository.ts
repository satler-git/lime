import type { CardId } from '../domain/card'
import type { ReviewAction, ReviewActionRepository } from '../review/types'
import {
  deserializeReviewAction,
  openObjectStore,
  requestResult,
  serializeReviewAction,
  transactionDone,
  namespaceDatabaseName,
  type PersistedReviewAction,
} from './indexed-db-persistence-helpers'

/**
 * `dbName` is the base database name. It remains unchanged when `userId` is
 * omitted; when supplied, an unambiguous length-prefixed user namespace is
 * appended. A custom `dbName` + `storeName` pair is dedicated to this adapter;
 * it is not a supported arbitrary cross-adapter sharing mechanism, even when
 * another adapter requests the same store name.
 */
export type IndexedDbReviewActionRepositoryOptions = {
  dbName?: string
  userId?: string
  storeName?: string
  indexedDB?: IDBFactory
}

/**
 * IndexedDB adapter for review actions and their card snapshots.
 *
 * Review actions have a separate default database from cards and sessions.
 * This intentionally keeps all three version-1 adapters from racing to add
 * stores to one database, where opening an already-created version would not
 * run another adapter's upgrade callback. An explicit custom `dbName` is used
 * as the base name and is also namespaced when `userId` is supplied; the
 * resulting `dbName` + `storeName` pair is dedicated to this adapter rather
 * than a general same-store cross-adapter sharing contract.
 */
export class IndexedDbReviewActionRepository implements ReviewActionRepository {
  private readonly dbName: string
  private readonly storeName: string
  private readonly indexedDB: IDBFactory
  private database?: Promise<IDBDatabase>

  constructor(options: IndexedDbReviewActionRepositoryOptions = {}) {
    this.dbName = namespaceDatabaseName(options.dbName ?? 'lime-review-actions', options.userId)
    this.storeName = options.storeName ?? 'review-actions'
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

  async save(action: ReviewAction): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put(serializeReviewAction(action))
    await transactionDone(transaction)
  }

  async load(id: string): Promise<ReviewAction | null> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .get(id)
    const record = await requestResult<PersistedReviewAction | undefined>(request)
    return record === undefined ? null : deserializeReviewAction(record)
  }

  async loadAll(): Promise<ReviewAction[]> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .getAll()
    const records = await requestResult<PersistedReviewAction[]>(request)
    return records.map(deserializeReviewAction)
  }

  async findLatestNonUndone(sessionId: string, cardId: CardId): Promise<ReviewAction | null> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .getAll()
    const records = await requestResult<PersistedReviewAction[]>(request)

    let latest: PersistedReviewAction | undefined
    let latestTimestamp = Number.NEGATIVE_INFINITY
    for (const action of records) {
      if (action.sessionId !== sessionId || action.cardId !== cardId || action.undone) {
        continue
      }

      // getAll is keyed by ID, not insertion order. Compare parsed timestamp
      // values first, then use the ID only as a deterministic tie-breaker.
      const actionTimestamp = Date.parse(action.timestamp)
      if (
        latest === undefined
        || actionTimestamp > latestTimestamp
        || (actionTimestamp === latestTimestamp && action.id > latest.id)
      ) {
        latest = action
        latestTimestamp = actionTimestamp
      }
    }

    return latest === undefined ? null : deserializeReviewAction(latest)
  }

  async close(): Promise<void> {
    const cachedDatabase = this.database
    const database = await cachedDatabase?.catch(() => undefined)
    database?.close()
    if (this.database === cachedDatabase) this.database = undefined
  }
}
