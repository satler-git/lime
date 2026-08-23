import type { Card } from '../domain/card'
import type { ReviewAction } from '../review/types'
import type { LookupEvent, ReadingSession } from '../session/types'

export type PersistedCard = Omit<Card, 'createdAt' | 'due' | 'lastReview'> & {
  createdAt: string
  due: string
  lastReview: string | null
}

export type PersistedReviewAction = Omit<ReviewAction, 'timestamp' | 'previousState' | 'nextState' | 'undoneAt'> & {
  timestamp: string
  previousState: PersistedCard
  nextState: PersistedCard
  undoneAt: string | null
}

export type PersistedLookupEvent = Omit<LookupEvent, 'timestamp'> & { timestamp: string }

export type PersistedReadingSession = Omit<ReadingSession, 'createdAt' | 'startedAt' | 'quizStartedAt' | 'completedAt' | 'abandonedAt' | 'lookupEvents'> & {
  cardIds: string[]
  createdAt: string
  startedAt: string | null
  quizStartedAt: string | null
  completedAt: string | null
  abandonedAt: string | null
  lookupEvents: PersistedLookupEvent[]
}

/** Convert dates to strings before IndexedDB sees a value, rejecting invalid dates. */
export const serializeDate = (date: Date, field: string): string => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${field} must be a valid Date`)
  }
  return date.toISOString()
}

/** Make a new Date on every read rather than returning a reference to persisted data. */
export const deserializeDate = (value: string, field: string): Date => {
  if (typeof value !== 'string') {
    throw new TypeError(`Persisted ${field} must be a date string`)
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`Persisted ${field} must be a valid date`)
  }
  return date
}

const serializeCard = (card: Card): PersistedCard => ({
  ...card,
  createdAt: serializeDate(card.createdAt, 'card.createdAt'),
  due: serializeDate(card.due, 'card.due'),
  lastReview: card.lastReview === undefined ? null : serializeDate(card.lastReview, 'card.lastReview'),
})

const deserializeCard = (card: PersistedCard): Card => {
  const { createdAt, due, lastReview, ...values } = card
  return {
    ...values,
    createdAt: deserializeDate(createdAt, 'card.createdAt'),
    due: deserializeDate(due, 'card.due'),
    ...(lastReview === null || lastReview === undefined
      ? {}
      : { lastReview: deserializeDate(lastReview, 'card.lastReview') }),
  }
}

export const serializeReviewAction = (action: ReviewAction): PersistedReviewAction => ({
  ...action,
  timestamp: serializeDate(action.timestamp, 'review action timestamp'),
  previousState: serializeCard(action.previousState),
  nextState: serializeCard(action.nextState),
  undoneAt: action.undoneAt === undefined ? null : serializeDate(action.undoneAt, 'review action undoneAt'),
})

export const deserializeReviewAction = (action: PersistedReviewAction): ReviewAction => {
  const { timestamp, previousState, nextState, undoneAt, ...values } = action
  return {
    ...values,
    timestamp: deserializeDate(timestamp, 'review action timestamp'),
    previousState: deserializeCard(previousState),
    nextState: deserializeCard(nextState),
    ...(undoneAt === null || undoneAt === undefined
      ? {}
      : { undoneAt: deserializeDate(undoneAt, 'review action undoneAt') }),
  }
}

export const serializeReadingSession = (session: ReadingSession): PersistedReadingSession => ({
  ...session,
  cardIds: [...session.cardIds],
  createdAt: serializeDate(session.createdAt, 'reading session createdAt'),
  startedAt: session.startedAt === undefined ? null : serializeDate(session.startedAt, 'reading session startedAt'),
  quizStartedAt: session.quizStartedAt === undefined ? null : serializeDate(session.quizStartedAt, 'reading session quizStartedAt'),
  completedAt: session.completedAt === undefined ? null : serializeDate(session.completedAt, 'reading session completedAt'),
  abandonedAt: session.abandonedAt === undefined ? null : serializeDate(session.abandonedAt, 'reading session abandonedAt'),
  lookupEvents: session.lookupEvents.map((event) => ({
    ...event,
    position: { ...event.position },
    timestamp: serializeDate(event.timestamp, `lookup event ${event.id} timestamp`),
  })),
})

export const deserializeReadingSession = (session: PersistedReadingSession): ReadingSession => {
  const {
    cardIds, createdAt, startedAt, quizStartedAt, completedAt, abandonedAt, lookupEvents, ...values
  } = session
  return {
    ...values,
    cardIds: [...cardIds],
    createdAt: deserializeDate(createdAt, 'reading session createdAt'),
    ...(startedAt === null || startedAt === undefined
      ? {}
      : { startedAt: deserializeDate(startedAt, 'reading session startedAt') }),
    ...(quizStartedAt === null || quizStartedAt === undefined
      ? {}
      : { quizStartedAt: deserializeDate(quizStartedAt, 'reading session quizStartedAt') }),
    ...(completedAt === null || completedAt === undefined
      ? {}
      : { completedAt: deserializeDate(completedAt, 'reading session completedAt') }),
    ...(abandonedAt === null || abandonedAt === undefined
      ? {}
      : { abandonedAt: deserializeDate(abandonedAt, 'reading session abandonedAt') }),
    lookupEvents: lookupEvents.map((event) => ({
      ...event,
      position: { ...event.position },
      timestamp: deserializeDate(event.timestamp, `lookup event ${event.id} timestamp`),
    })),
  }
}

export const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
})

export const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
})

const namespacedDatabasePrefix = 'lime-user-'

/**
 * Derive an unambiguous per-user database name without changing the legacy
 * database name when no user namespace is requested. Length prefixes make
 * both components unambiguous even when either component contains separators.
 * The generated prefix is reserved so an unscoped custom name cannot alias a
 * namespaced database.
 */
export const namespaceDatabaseName = (baseDbName: string, userId?: string): string => {
  if (userId === undefined) {
    if (baseDbName.startsWith(namespacedDatabasePrefix)) {
      throw new TypeError(`Unscoped database name cannot start with reserved prefix "${namespacedDatabasePrefix}"`)
    }
    return baseDbName
  }
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new TypeError('userId must be a non-empty string when provided')
  }
  return `${namespacedDatabasePrefix}${baseDbName.length}:${baseDbName}${userId.length}:${userId}`
}

export type OpenObjectStoreOptions = {
  onVersionChange?: () => void
}

/**
 * Open a version-1 repository database and require its store to exist.
 *
 * An open at the current database version only runs its upgrade callback
 * when the database is new (or is being upgraded by another caller).
 * Consequently, a custom `dbName` + `storeName` pair is dedicated to one
 * adapter rather than a general cross-adapter sharing contract. Independently
 * opening a second repository against the same custom database cannot safely
 * add a different store. Rejecting a missing store makes that unsupported
 * combination explicit instead of allowing a later transaction to fail with a
 * misleading missing-store error; matching store names do not establish
 * arbitrary cross-adapter compatibility either.
 */
export const openObjectStore = (
  indexedDB: IDBFactory,
  dbName: string,
  storeName: string,
  options: OpenObjectStoreOptions = {},
): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  // Omitting the version permits a reopened adapter to connect after an
  // external upgrade rather than failing with VersionError.
  const request = indexedDB.open(dbName)
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(storeName)) {
      request.result.createObjectStore(storeName, { keyPath: 'id' })
    }
  }
  request.onsuccess = () => {
    const database = request.result
    if (!database.objectStoreNames.contains(storeName)) {
      database.close()
      reject(new Error(
        `IndexedDB database "${dbName}" does not contain object store "${storeName}". `
        + 'Sharing a custom dbName across repositories with different stores is unsupported; use a dedicated dbName per repository.',
      ))
      return
    }
    database.onversionchange = () => {
      database.close()
      options.onVersionChange?.()
    }
    resolve(database)
  }
  request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB'))
})
