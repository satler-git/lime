import {
  DictionaryService,
  EijiroSource,
  IndexedDbDictionaryRepository,
  WiktionarySource,
  YomitanSource,
  eijiroParser,
  wiktionaryJsonlParser,
  yomitanZipParser,
} from './dictionary'
import type { DictionaryEntry, DictionaryImportSummary, DictionarySource } from './dictionary/types'

export type DictionaryManagementApplication = {
  lookup: (word: string) => Promise<DictionaryEntry[]>
  importText: (sourceId: string, text: string) => Promise<DictionaryImportSummary>
  importFile: (sourceId: string, file: File) => Promise<DictionaryImportSummary>
  listSources: () => Promise<DictionarySource[]>
  updateSource: (source: DictionarySource) => Promise<void>
  removeSource: (sourceId: string) => Promise<void>
}

/** @deprecated Use DictionaryManagementApplication. */
export type DictionaryImportApplication = DictionaryManagementApplication

export function createDictionaryImportService(userId?: string): DictionaryManagementApplication | undefined {
  if (typeof globalThis.indexedDB === 'undefined') {
    return undefined
  }
  // Empty strings are rejected by the namespacing helper, so only pass a real user ID.
  const repositoryOptions = userId !== undefined && userId.length > 0 ? { userId } : undefined
  const repository = new IndexedDbDictionaryRepository(repositoryOptions)
  const service = new DictionaryService(repository, [
    { source: EijiroSource, parser: eijiroParser },
    { source: WiktionarySource, parser: wiktionaryJsonlParser },
    { source: YomitanSource, parser: yomitanZipParser },
  ])
  return {
    lookup: service.lookup.bind(service),
    importText: service.importText.bind(service),
    importFile: service.importFile.bind(service),
    listSources: service.listSources.bind(service),
    updateSource: service.updateSource.bind(service),
    removeSource: service.removeSource.bind(service),
  }
}
