import { normalizeWord } from '../domain/word'
import {
  namespaceDatabaseName,
  requestResult,
  transactionDone,
} from '../persistence/indexed-db-persistence-helpers'
import { normalizeDictionarySource, normalizeDictionarySourceId } from './types'
import type { DictionaryEntry, DictionaryRepository, DictionarySource } from './types'
import { uniqueNonEmpty } from './parsers'

const cloneEntry = (entry: DictionaryEntry): DictionaryEntry => ({
  ...entry,
  definitions: [...entry.definitions],
  examples: [...entry.examples],
})

const cloneSource = (source: DictionarySource): DictionarySource => ({ ...source })

const mergeSource = (previous: DictionarySource | undefined, next: DictionarySource): DictionarySource => ({
  ...previous,
  ...next,
  ...(next.priority === undefined && previous?.priority !== undefined ? { priority: previous.priority } : {}),
  ...(next.enabled === undefined && previous?.enabled !== undefined ? { enabled: previous.enabled } : {}),
})

/** Split metadata written by an earlier merge before deduplicating it again. */
const splitJoinedMetadata = (value: string | undefined, separator: RegExp): string[] =>
  value === undefined ? [] : value.split(separator)

/** Merge records with the same normalized headword from one source. */
export const mergeDictionaryEntry = (existing: DictionaryEntry, incoming: DictionaryEntry): DictionaryEntry => ({
  ...existing,
  definitions: uniqueNonEmpty([...existing.definitions, ...incoming.definitions]),
  examples: uniqueNonEmpty([...existing.examples, ...incoming.examples]),
  ...(existing.pronunciation || incoming.pronunciation
    ? {
      pronunciation: uniqueNonEmpty([
        ...splitJoinedMetadata(existing.pronunciation, /\s+\/\s+/),
        ...splitJoinedMetadata(incoming.pronunciation, /\s+\/\s+/),
      ]).join(' / '),
    }
    : {}),
  ...(existing.partOfSpeech || incoming.partOfSpeech
    ? {
      partOfSpeech: uniqueNonEmpty([
        ...splitJoinedMetadata(existing.partOfSpeech, /\s*,\s*/),
        ...splitJoinedMetadata(incoming.partOfSpeech, /\s*,\s*/),
      ]).join(', '),
    }
    : {}),
})

const checkedSource = (source: DictionarySource): DictionarySource => normalizeDictionarySource(source)

const assertSourceOwnership = (entries: readonly DictionaryEntry[], source: DictionarySource | undefined): void => {
  if (source === undefined) return
  if (entries.some((entry) => entry.sourceId !== source.id)) {
    throw new TypeError('Dictionary entries must belong to the supplied dictionary source')
  }
}

const fallbackSource = (sourceId: string): DictionarySource => {
  const id = normalizeDictionarySourceId(sourceId)
  return { id, name: id, format: 'unknown' }
}

const checkedStringList = (value: unknown, field: string): string[] => {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`Dictionary entry ${field} must contain strings`)
  }
  return uniqueNonEmpty(value)
}

const normalizeEntry = (entry: DictionaryEntry): DictionaryEntry => {
  if (!entry) throw new TypeError('Dictionary entry is required')
  const sourceId = normalizeDictionarySourceId(entry.sourceId)
  if (typeof entry.word !== 'string' || normalizeWord(entry.word).length === 0) {
    throw new TypeError('Dictionary entry word must be non-empty')
  }
  const word = entry.word.trim()
  const normalizedWord = normalizeWord(word)
  if (typeof entry.normalizedWord !== 'string' && entry.normalizedWord !== undefined) {
    throw new TypeError('Dictionary entry normalizedWord must be a string')
  }
  return {
    word,
    normalizedWord,
    sourceId,
    definitions: checkedStringList(entry.definitions, 'definitions'),
    examples: checkedStringList(entry.examples, 'examples'),
    ...(typeof entry.pronunciation === 'string' && entry.pronunciation.trim()
      ? { pronunciation: entry.pronunciation.trim() }
      : {}),
    ...(typeof entry.partOfSpeech === 'string' && entry.partOfSpeech.trim()
      ? { partOfSpeech: entry.partOfSpeech.trim() }
      : {}),
  }
}

const sourcePriority = (source: DictionarySource | undefined): number => source?.priority ?? Number.POSITIVE_INFINITY

/** Lookup order is priority ascending; equal priorities retain import order. */
const compareSources = (
  left: { source: DictionarySource; order: number },
  right: { source: DictionarySource; order: number },
): number => sourcePriority(left.source) - sourcePriority(right.source) || left.order - right.order

/** In-memory repository used by tests and applications that do not need persistence. */
export class InMemoryDictionaryRepository implements DictionaryRepository {
  private readonly entries = new Map<string, DictionaryEntry>()
  private readonly sources = new Map<string, { source: DictionarySource; order: number }>()
  private nextSourceOrder = 0

  async saveMany(entries: readonly DictionaryEntry[], source?: DictionarySource): Promise<void> {
    const metadata = source === undefined ? undefined : checkedSource(source)
    const normalizedEntries = entries.map(normalizeEntry)
    assertSourceOwnership(normalizedEntries, metadata)
    if (metadata !== undefined) this.addSource(metadata)
    for (const entry of normalizedEntries) {
      this.addSource(metadata?.id === entry.sourceId ? metadata : fallbackSource(entry.sourceId))
      const key = entryKey(entry.sourceId, entry.normalizedWord)
      const previous = this.entries.get(key)
      this.entries.set(key, previous === undefined ? cloneEntry(entry) : mergeDictionaryEntry(previous, entry))
    }
  }

  async lookup(word: string): Promise<DictionaryEntry[]> {
    const normalized = normalizeWord(word)
    const sourceIds = [...this.sources.entries()]
      .filter(([, { source }]) => source.enabled !== false)
      .sort(([, left], [, right]) => compareSources(left, right))
      .map(([sourceId]) => sourceId)
    return sourceIds.flatMap((sourceId) => [...this.entries.values()]
      .filter((entry) => entry.sourceId === sourceId && entry.normalizedWord === normalized)
      .map(cloneEntry))
  }

  async listSources(): Promise<DictionarySource[]> {
    return [...this.sources.values()]
      .sort((left, right) => compareSources(left, right))
      .map(({ source }) => cloneSource(source))
  }

  async updateSource(source: DictionarySource): Promise<void> {
    const metadata = checkedSource(source)
    const previous = this.sources.get(metadata.id)
    if (previous === undefined) {
      throw new TypeError(`Dictionary source is not found: ${metadata.id}`)
    }
    this.sources.set(metadata.id, { source: cloneSource(mergeSource(previous.source, metadata)), order: previous.order })
  }

  async clearSource(sourceId: string): Promise<void> {
    const normalizedSourceId = normalizeDictionarySourceId(sourceId)
    for (const [key, entry] of this.entries) {
      if (entry.sourceId === normalizedSourceId) this.entries.delete(key)
    }
    this.sources.delete(normalizedSourceId)
  }

  private addSource(source: DictionarySource): void {
    const previous = this.sources.get(source.id)
    this.sources.set(source.id, {
      source: cloneSource(mergeSource(previous?.source, source)),
      order: previous?.order ?? this.nextSourceOrder++,
    })
  }
}

type PersistedEntry = {
  id: string
  kind: 'entry'
  word: string
  normalizedWord: string
  sourceId: string
  definitions: string[]
  examples: string[]
  pronunciation?: string
  partOfSpeech?: string
  order: number
}

type PersistedSource = {
  id: string
  kind: 'source'
  sourceId: string
  name: string
  format: string
  priority?: number
  enabled?: boolean
  /** Largest entry order used by this source; keeps new entries from colliding with existing ones. */
  maxEntryOrder?: number
  order: number
}

type PersistedMigration = {
  id: string
  kind: 'migration'
  version: number
}

type PersistedRecord = PersistedEntry | PersistedSource | PersistedMigration

const normalizedHeadwordIndex = 'normalizedHeadword'
const dictionarySchemaVersion = 2
const normalizedHeadwordMigrationId = 'migration:normalized-headword-v2'
const entryKey = (sourceId: string, normalizedWord: string): string => JSON.stringify([sourceId, normalizedWord])
const sourceKey = (sourceId: string): string => `source:${sourceId}`

const serializeEntry = (entry: DictionaryEntry, id: string, order: number): PersistedEntry => ({
  id,
  kind: 'entry',
  word: entry.word,
  normalizedWord: entry.normalizedWord,
  sourceId: entry.sourceId,
  definitions: [...entry.definitions],
  examples: [...entry.examples],
  ...(entry.pronunciation === undefined ? {} : { pronunciation: entry.pronunciation }),
  ...(entry.partOfSpeech === undefined ? {} : { partOfSpeech: entry.partOfSpeech }),
  order,
})

const persistedEntry = (record: PersistedEntry): DictionaryEntry => ({
  word: record.word,
  normalizedWord: record.normalizedWord,
  sourceId: record.sourceId,
  definitions: [...record.definitions],
  examples: [...record.examples],
  ...(record.pronunciation === undefined ? {} : { pronunciation: record.pronunciation }),
  ...(record.partOfSpeech === undefined ? {} : { partOfSpeech: record.partOfSpeech }),
})

const persistedSource = (record: PersistedSource): DictionarySource => ({
  id: record.sourceId,
  name: record.name,
  format: record.format,
  ...(record.priority === undefined ? {} : { priority: record.priority }),
  ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
})

const usableHeadwordIndex = (store: IDBObjectStore): boolean => {
  if (!store.indexNames.contains(normalizedHeadwordIndex)) return false
  const index = store.index(normalizedHeadwordIndex)
  return index.keyPath === 'normalizedWord' && index.unique === false && index.multiEntry === false
}

/** Keep legacy records deterministic when their IDs normalize to the same key. */
const persistedRecordOrder = (record: PersistedRecord): number => {
  const order = record.kind === 'migration' ? undefined : record.order
  return typeof order === 'number' && Number.isSafeInteger(order) && order >= 0 ? order : Number.MAX_SAFE_INTEGER
}

const compareLegacyRecords = (left: PersistedRecord, right: PersistedRecord): number =>
  persistedRecordOrder(left) - persistedRecordOrder(right) || left.id.localeCompare(right.id)

const legacyEntry = (record: PersistedEntry, sourceId: string, normalizedWord: string): DictionaryEntry => ({
  word: record.word,
  normalizedWord,
  sourceId,
  definitions: checkedStringList(record.definitions, 'definitions'),
  examples: checkedStringList(record.examples, 'examples'),
  ...(typeof record.pronunciation === 'string' && record.pronunciation.trim()
    ? { pronunciation: record.pronunciation.trim() }
    : {}),
  ...(typeof record.partOfSpeech === 'string' && record.partOfSpeech.trim()
    ? { partOfSpeech: record.partOfSpeech.trim() }
    : {}),
})

/** Normalize legacy IDs and recompute indexed fields inside the upgrade transaction. */
const repairDictionaryRecords = (store: IDBObjectStore, records: readonly PersistedRecord[]): void => {
  const entryRecords = records
    .filter((record): record is PersistedEntry => record.kind === 'entry')
    .filter((record) => typeof record.word === 'string'
      && typeof record.sourceId === 'string'
      && record.sourceId.trim().length > 0
      && normalizeWord(record.word).length > 0)
    .sort(compareLegacyRecords)
  const entriesByKey = new Map<string, { entry: DictionaryEntry; order: number }>()

  for (const record of entryRecords) {
    const sourceId = record.sourceId.trim()
    const normalizedWord = normalizeWord(record.word)
    const id = entryKey(sourceId, normalizedWord)
    const entry = legacyEntry(record, sourceId, normalizedWord)
    const previous = entriesByKey.get(id)
    entriesByKey.set(id, previous === undefined
      ? { entry, order: persistedRecordOrder(record) }
      : { entry: mergeDictionaryEntry(previous.entry, entry), order: previous.order })
    store.delete(record.id)
  }
  for (const [id, value] of entriesByKey) {
    store.put(serializeEntry(value.entry, id, value.order))
  }

  const sourceRecords = records
    .filter((record): record is PersistedSource => record.kind === 'source')
    .filter((record) => typeof record.sourceId === 'string' && record.sourceId.trim().length > 0)
    .sort(compareLegacyRecords)
  const sourcesById = new Map<string, PersistedSource>()
  for (const record of sourceRecords) {
    const sourceId = record.sourceId.trim()
    const id = sourceKey(sourceId)
    if (!sourcesById.has(sourceId)) {
      sourcesById.set(sourceId, { ...record, id, sourceId })
    }
    store.delete(record.id)
  }
  for (const record of sourcesById.values()) store.put(record)

  store.put({ id: normalizedHeadwordMigrationId, kind: 'migration', version: dictionarySchemaVersion })
}

const ensureDictionaryStore = (database: IDBDatabase, transaction: IDBTransaction | null, storeName: string): void => {
  const store = database.objectStoreNames.contains(storeName)
    ? transaction?.objectStore(storeName)
    : database.createObjectStore(storeName, { keyPath: 'id' })
  if (store === undefined) throw new Error('Could not create dictionary object store')

  if (!usableHeadwordIndex(store)) {
    if (store.indexNames.contains(normalizedHeadwordIndex)) store.deleteIndex(normalizedHeadwordIndex)
    store.createIndex(normalizedHeadwordIndex, 'normalizedWord', { unique: false, multiEntry: false })
  }

  // This runs for schema version 2, including databases whose old index shape
  // happened to be valid. It intentionally recomputes rather than trusting the
  // persisted field, so missing/stale index keys cannot hide existing entries.
  const recordsRequest = store.getAll()
  recordsRequest.onsuccess = () => repairDictionaryRecords(store, recordsRequest.result as PersistedRecord[])
}

type OpenDictionaryStoreOptions = {
  onVersionChange?: () => void
}

const repairOnOpenIfNeeded = (database: IDBDatabase, storeName: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const checkTransaction = database.transaction(storeName, 'readonly')
    const checkStore = checkTransaction.objectStore(storeName)
    const markerRequest = checkStore.get(normalizedHeadwordMigrationId)
    markerRequest.onsuccess = () => {
      const marker = markerRequest.result as PersistedMigration | undefined
      if (marker?.kind === 'migration' && marker.version >= dictionarySchemaVersion) {
        resolve()
        return
      }
      const transaction = database.transaction(storeName, 'readwrite')
      const store = transaction.objectStore(storeName)
      const completion = transactionDone(transaction)
      const recordsRequest = store.getAll()
      recordsRequest.onsuccess = () => repairDictionaryRecords(store, recordsRequest.result as PersistedRecord[])
      recordsRequest.onerror = () => reject(recordsRequest.error ?? new Error('Could not scan dictionary records'))
      completion.then(resolve, reject)
    }
    markerRequest.onerror = () => reject(markerRequest.error ?? new Error('Could not inspect dictionary migration state'))
  })

/** Open the namespaced store and migrate older partial stores to the headword index. */
const openDictionaryStore = (
  indexedDB: IDBFactory,
  dbName: string,
  storeName: string,
  options: OpenDictionaryStoreOptions = {},
): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const upgrade = (version?: number): void => {
      const request = version === undefined ? indexedDB.open(dbName) : indexedDB.open(dbName, version)
      request.onupgradeneeded = () => ensureDictionaryStore(request.result, request.transaction, storeName)
      request.onsuccess = () => {
        const database = request.result
        // Install this immediately after opening, before any integrity scan or
        // repair transaction starts. An upgrade in another context must be able
        // to close this connection while it is still preparing the database.
        let superseded = false
        database.onversionchange = () => {
          superseded = true
          database.close()
          options.onVersionChange?.()
        }
        if (database.version < dictionarySchemaVersion) {
          database.close()
          upgrade(dictionarySchemaVersion)
          return
        }
        if (!database.objectStoreNames.contains(storeName)) {
          database.close()
          reject(new Error(`Dictionary object store "${storeName}" is unavailable`))
          return
        }
        const check = database.transaction(storeName, 'readonly').objectStore(storeName)
        const indexIsUsable = usableHeadwordIndex(check)
        const finish = (): void => {
          if (superseded) {
            // The connection that performed the scan is no longer usable. Reopen
            // after the external upgrade so callers never receive a closed DB.
            upgrade()
          } else {
            resolve(database)
          }
        }
        if (indexIsUsable) {
          repairOnOpenIfNeeded(database, storeName).then(finish, (error) => {
            if (superseded) {
              upgrade()
            } else {
              database.close()
              reject(error)
            }
          })
          return
        }
        const nextVersion = database.version + 1
        database.close()
        upgrade(nextVersion)
      }
      request.onerror = () => {
        // Another context may have advanced the version between the initial
        // open and this explicit schema upgrade. Reopen at the current version
        // rather than surfacing a transient VersionError to callers.
        if (version !== undefined && request.error?.name === 'VersionError') {
          upgrade()
          return
        }
        reject(request.error ?? new Error('Could not open dictionary IndexedDB'))
      }
      request.onblocked = () => reject(new Error('Dictionary IndexedDB upgrade is blocked'))
    }
    upgrade()
  })

export type IndexedDbDictionaryRepositoryOptions = {
  dbName?: string
  userId?: string
  storeName?: string
  indexedDB?: IDBFactory
}

/** IndexedDB adapter stores only explicit JSON-compatible dictionary records. */
export class IndexedDbDictionaryRepository implements DictionaryRepository {
  private readonly dbName: string
  private readonly storeName: string
  private readonly indexedDB: IDBFactory
  private database?: Promise<IDBDatabase>

  constructor(options: IndexedDbDictionaryRepositoryOptions = {}) {
    this.dbName = namespaceDatabaseName(options.dbName ?? 'lime-dictionary', options.userId)
    this.storeName = options.storeName ?? 'dictionary'
    this.indexedDB = options.indexedDB ?? globalThis.indexedDB
    if (!this.indexedDB) throw new Error('IndexedDB is not available')
  }

  private open(): Promise<IDBDatabase> {
    if (this.database === undefined) {
      const opening = openDictionaryStore(this.indexedDB, this.dbName, this.storeName, {
        onVersionChange: () => {
          this.database = undefined
        },
      })
      this.database = opening
      opening.catch(() => { if (this.database === opening) this.database = undefined })
    }
    return this.database
  }

  async saveMany(entries: readonly DictionaryEntry[], source?: DictionarySource): Promise<void> {
    const metadata = source === undefined ? undefined : checkedSource(source)
    const normalizedEntries = entries.map(normalizeEntry)
    assertSourceOwnership(normalizedEntries, metadata)
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    const store = transaction.objectStore(this.storeName)
    const completion = transactionDone(transaction)
    try {
      const sourceIds = new Set<string>()
      if (metadata !== undefined) sourceIds.add(metadata.id)
      for (const entry of normalizedEntries) sourceIds.add(entry.sourceId)

      // Fetch only the source records we will touch, and the entries we might merge.
      const sourceById = new Map<string, PersistedSource>()
      await Promise.all([...sourceIds].map(async (sourceId) => {
        const record = await requestResult<PersistedRecord | undefined>(store.get(sourceKey(sourceId)))
        if (record !== undefined && record.kind === 'source') sourceById.set(sourceId, record)
      }))

      let nextSourceOrder = 0
      for (const record of sourceById.values()) {
        nextSourceOrder = Math.max(nextSourceOrder, record.order + 1)
      }

      const newSourceIds = new Set([...sourceIds].filter((sourceId) => !sourceById.has(sourceId)))
      const entriesByKey = new Map<string, PersistedEntry>()
      if (newSourceIds.size !== sourceIds.size) {
        await Promise.all(normalizedEntries.map(async (entry) => {
          if (newSourceIds.has(entry.sourceId)) return
          const id = entryKey(entry.sourceId, entry.normalizedWord)
          const record = await requestResult<PersistedRecord | undefined>(store.get(id))
          if (record !== undefined && record.kind === 'entry') entriesByKey.set(id, record)
        }))
      }

      // Track the next order for each source so new entries stay after existing ones.
      const nextEntryOrderBySource = new Map<string, number>()
      for (const [sourceId, previous] of sourceById) {
        nextEntryOrderBySource.set(sourceId, (previous.maxEntryOrder ?? previous.order ?? 0) + 1)
      }

      // Persist source metadata first (merge previously stored priority/enabled/order).
      for (const sourceId of sourceIds) {
        const previous = sourceById.get(sourceId)
        const nextSource = metadata?.id === sourceId ? metadata : (previous === undefined ? fallbackSource(sourceId) : undefined)
        if (nextSource !== undefined) {
          const priority = nextSource.priority !== undefined ? nextSource.priority : previous?.priority
          const enabled = nextSource.enabled !== undefined ? nextSource.enabled : previous?.enabled
          const record: PersistedSource = {
            id: sourceKey(sourceId),
            kind: 'source',
            sourceId,
            name: nextSource.name,
            format: nextSource.format,
            ...(priority === undefined ? {} : { priority }),
            ...(enabled === undefined ? {} : { enabled }),
            maxEntryOrder: previous?.maxEntryOrder,
            order: previous?.order ?? nextSourceOrder++,
          }
          store.put(record)
          sourceById.set(sourceId, record)
        }
      }

      // Persist entries, updating each source's max entry order as we go.
      for (const entry of normalizedEntries) {
        const id = entryKey(entry.sourceId, entry.normalizedWord)
        const previous = entriesByKey.get(id)
        const merged = previous === undefined
          ? entry
          : mergeDictionaryEntry(persistedEntry(previous), entry)
        const nextEntryOrder = nextEntryOrderBySource.get(entry.sourceId) ?? 0
        const order = previous?.order ?? nextEntryOrder
        if (previous === undefined) nextEntryOrderBySource.set(entry.sourceId, nextEntryOrder + 1)
        const record = serializeEntry(merged, id, order)
        store.put(record)
        entriesByKey.set(id, record)
        const previousSource = sourceById.get(entry.sourceId)
        if (previousSource !== undefined) {
          previousSource.maxEntryOrder = Math.max(previousSource.maxEntryOrder ?? -1, order)
        }
      }

      // Write the updated max entry order back into each source record.
      for (const [sourceId, record] of sourceById) {
        if (record.maxEntryOrder !== undefined) {
          store.put(record)
        }
      }

      await completion
    } catch (error) {
      await completion.catch(() => undefined)
      throw error
    }
  }

  async lookup(word: string): Promise<DictionaryEntry[]> {
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readonly')
    const store = transaction.objectStore(this.storeName)
    const entryRequest = store.index(normalizedHeadwordIndex).getAll(normalizeWord(word))
    const sourceRequest = store.getAll()
    const [entries, records] = await Promise.all([
      requestResult<PersistedEntry[]>(entryRequest),
      requestResult<PersistedRecord[]>(sourceRequest),
    ])
    const disabledSourceIds = new Set<string>()
    const sourceRanks = new Map<string, { source: DictionarySource; order: number }>()
    for (const record of records) {
      if (record.kind === 'source') {
        const source = persistedSource(record)
        if (source.enabled === false) {
          disabledSourceIds.add(record.sourceId)
        } else {
          sourceRanks.set(record.sourceId, { source, order: record.order })
        }
      }
    }
    return entries
      .filter((entry) => !disabledSourceIds.has(entry.sourceId))
      .sort((left, right) => {
        const leftRank = sourceRanks.get(left.sourceId) ?? { source: fallbackSource(left.sourceId), order: Number.MAX_SAFE_INTEGER }
        const rightRank = sourceRanks.get(right.sourceId) ?? { source: fallbackSource(right.sourceId), order: Number.MAX_SAFE_INTEGER }
        return compareSources(leftRank, rightRank) || left.order - right.order || left.id.localeCompare(right.id)
      })
      .map(persistedEntry)
  }

  async listSources(): Promise<DictionarySource[]> {
    const database = await this.open()
    const records = await requestResult<PersistedRecord[]>(
      database.transaction(this.storeName, 'readonly').objectStore(this.storeName).getAll(),
    )
    return records
      .filter((record): record is PersistedSource => record.kind === 'source')
      .sort((left, right) => compareSources(
        { source: persistedSource(left), order: left.order },
        { source: persistedSource(right), order: right.order },
      ))
      .map(persistedSource)
  }

  async updateSource(source: DictionarySource): Promise<void> {
    const metadata = checkedSource(source)
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    const store = transaction.objectStore(this.storeName)
    const completion = transactionDone(transaction)
    try {
      const previous = await requestResult<PersistedRecord | undefined>(store.get(sourceKey(metadata.id)))
      if (previous === undefined || previous.kind !== 'source') {
        throw new TypeError(`Dictionary source is not found: ${metadata.id}`)
      }
      const record: PersistedSource = {
        ...previous,
        name: metadata.name,
        format: metadata.format,
        ...(metadata.priority === undefined ? {} : { priority: metadata.priority }),
        ...(metadata.enabled === undefined ? {} : { enabled: metadata.enabled }),
      }
      store.put(record)
      await completion
    } catch (error) {
      await completion.catch(() => undefined)
      throw error
    }
  }

  async clearSource(sourceId: string): Promise<void> {
    const normalizedSourceId = normalizeDictionarySourceId(sourceId)
    const database = await this.open()
    const transaction = database.transaction(this.storeName, 'readwrite')
    const store = transaction.objectStore(this.storeName)
    const completion = transactionDone(transaction)
    try {
      const records = await requestResult<PersistedRecord[]>(store.getAll())
      for (const record of records) {
        if ((record.kind === 'source' && record.sourceId === normalizedSourceId)
          || (record.kind === 'entry' && record.sourceId === normalizedSourceId)) store.delete(record.id)
      }
      await completion
    } catch (error) {
      await completion.catch(() => undefined)
      throw error
    }
  }

  async close(): Promise<void> {
    const cached = this.database
    const database = await cached?.catch(() => undefined)
    database?.close()
    if (this.database === cached) this.database = undefined
  }
}
