import type { QuizState } from '../quiz/types'
import type { QuizStateRepository } from '../quiz/repository'
import {
  deserializeQuizState,
  namespaceDatabaseName,
  openObjectStore,
  requestResult,
  serializeQuizState,
  transactionDone,
  type PersistedQuizState,
} from './indexed-db-persistence-helpers'

type PersistedQuizStateRecord = PersistedQuizState & { id: string }

export type IndexedDbQuizStateRepositoryOptions = {
  dbName?: string
  userId?: string
  storeName?: string
  indexedDB?: IDBFactory
}

/** IndexedDB adapter for quiz snapshots, isolated by optional user namespace. */
export class IndexedDbQuizStateRepository implements QuizStateRepository {
  private readonly dbName: string
  private readonly storeName: string
  private readonly indexedDB: IDBFactory
  private database?: Promise<IDBDatabase>

  constructor(options: IndexedDbQuizStateRepositoryOptions = {}) {
    this.dbName = namespaceDatabaseName(options.dbName ?? 'lime-quiz', options.userId)
    this.storeName = options.storeName ?? 'quiz-states'
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

  async save(sessionId: string, state: QuizState): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).put({ id: sessionId, ...serializeQuizState(state) })
    await transactionDone(transaction)
  }

  async load(sessionId: string): Promise<QuizState | null> {
    const database = await this.open()
    const request = database.transaction(this.storeName, 'readonly')
      .objectStore(this.storeName)
      .get(sessionId)
    const record = await requestResult<PersistedQuizStateRecord | undefined>(request)
    if (record === undefined) return null
    const { id: _id, ...state } = record
    return deserializeQuizState(state)
  }

  async delete(sessionId: string): Promise<void> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    transaction.objectStore(this.storeName).delete(sessionId)
    await transactionDone(transaction)
  }

  async close(): Promise<void> {
    const cachedDatabase = this.database
    const database = await cachedDatabase?.catch(() => undefined)
    database?.close()
    if (this.database === cachedDatabase) this.database = undefined
  }
}
