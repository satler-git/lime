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

export function createDictionaryImportService(): DictionaryImportApplication | undefined {
  if (typeof globalThis.indexedDB === 'undefined') {
    return undefined
  }
  const repository = new IndexedDbDictionaryRepository()
  const service = new DictionaryService(repository, [
    { source: EijiroSource, parser: eijiroParser },
    { source: WiktionarySource, parser: wiktionaryJsonlParser },
  ])
  return {
    importText: service.importText.bind(service),
    listSources: service.listSources.bind(service),
  }
}
