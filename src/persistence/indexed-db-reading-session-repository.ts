import type { ReadingSession } from '../session/types'
import type { ReadingSessionRepository } from '../session/repository'
import {
  deserializeReadingSession,
  openObjectStore,
  requestResult,
  serializeReadingSession,
  transactionDone,
  namespaceDatabaseName,
  type PersistedReadingSession,
} from './indexed-db-persistence-helpers'

/**
 * `dbName` is the base database name. It remains unchanged when `userId` is
 * omitted; when supplied, an unambiguous length-prefixed user namespace is
 * appended. A custom `dbName` + `storeName` pair is dedicated to this adapter;
 * it is not a supported arbitrary cross-adapter sharing mechanism, even when
 * another adapter requests the same store name.
 */
export type IndexedDbReadingSessionRepositoryOptions = {
  dbName?: string
  userId?: string
  storeName?: string
  indexedDB?: IDBFactory
}

/**
 * IndexedDB adapter for reading-session snapshots.
 *
 * Sessions use their own database by default rather than sharing the card
 * database. The existing card adapter opens version 1, so separate defaults
 * prevent one adapter's store creation from requiring a version upgrade in
 * another adapter. An explicit custom `dbName` is used as the base name and
 * is also namespaced when `userId` is supplied; the resulting `dbName` +
 * `storeName` pair is dedicated to this adapter rather than a general
 * same-store cross-adapter sharing contract.
 */
export class IndexedDbReadingSessionRepository implements ReadingSessionRepository {
  private readonly dbName: string
  private readonly storeName: string
  private readonly indexedDB: IDBFactory
  private database?: Promise<IDBDatabase>

  constructor(options: IndexedDbReadingSessionRepositoryOptions = {}) {
    this.dbName = namespaceDatabaseName(options.dbName ?? 'lime-sessions', options.userId)
    this.storeName = options.storeName ?? 'reading-sessions'
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

  async save(session: ReadingSession): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put(serializeReadingSession(session))
    await transactionDone(transaction)
  }

  async load(id: string): Promise<ReadingSession | null> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .get(id)
    const record = await requestResult<PersistedReadingSession | undefined>(request)
    return record === undefined ? null : deserializeReadingSession(record)
  }

  async loadAll(): Promise<ReadingSession[]> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .getAll()
    const records = await requestResult<PersistedReadingSession[]>(request)
    return records.map(deserializeReadingSession)
  }

  async close(): Promise<void> {
    const cachedDatabase = this.database
    const database = await cachedDatabase?.catch(() => undefined)
    database?.close()
    if (this.database === cachedDatabase) this.database = undefined
  }
}
