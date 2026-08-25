import {
  DictionaryService,
  EijiroSource,
  IndexedDbDictionaryRepository,
  WiktionarySource,
  eijiroParser,
  wiktionaryJsonlParser,
} from './dictionary'
import type { DictionaryImportSummary, DictionarySource } from './dictionary/types'

export type DictionaryImportApplication = {
  importText: (sourceId: string, text: string) => Promise<DictionaryImportSummary>
  listSources: () => Promise<DictionarySource[]>
}

export function createDictionaryImportService(userId?: string): DictionaryImportApplication | undefined {
  if (typeof globalThis.indexedDB === 'undefined') {
    return undefined
  }
  // Empty strings are rejected by the namespacing helper, so only pass a real user ID.
  const repositoryOptions = userId !== undefined && userId.length > 0 ? { userId } : undefined
  const repository = new IndexedDbDictionaryRepository(repositoryOptions)
  const service = new DictionaryService(repository, [
    { source: EijiroSource, parser: eijiroParser },
    { source: WiktionarySource, parser: wiktionaryJsonlParser },
  ])
  return {
    importText: service.importText.bind(service),
    listSources: service.listSources.bind(service),
  }
}
