import { normalizeDictionarySource, normalizeDictionarySourceId } from './types'
import { normalizeWord } from '../domain/word'
import type {
  DictionaryEntry,
  DictionaryFileParseResult,
  DictionaryFileParser,
  DictionaryImportSummary,
  DictionaryParseResult,
  DictionaryParser,
  DictionaryRepository,
  DictionaryServicePort,
  DictionarySource,
  DictionarySourceRegistration,
  DictionaryParseError,
} from './types'

export class DictionarySourceNotFoundError extends Error {
  constructor(sourceId: string) {
    super(`Dictionary source is not registered: ${sourceId}`)
    this.name = 'DictionarySourceNotFoundError'
  }
}

export class DictionarySourceAlreadyRegisteredError extends Error {
  constructor(sourceId: string) {
    super(`Dictionary source is already registered: ${sourceId}`)
    this.name = 'DictionarySourceAlreadyRegisteredError'
  }
}

export class DictionaryEntrySourceMismatchError extends Error {
  constructor(sourceId: string) {
    super(`Dictionary parser returned an entry for source ${sourceId}`)
    this.name = 'DictionaryEntrySourceMismatchError'
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const everyArrayItem = <T>(items: T[], predicate: (item: T) => boolean): boolean => {
  for (let index = 0; index < items.length; index += 1) {
    if (!(index in items) || !predicate(items[index]!)) return false
  }
  return true
}

const isValidEntry = (value: unknown): value is DictionaryEntry => {
  if (!isRecord(value)
    || typeof value.sourceId !== 'string'
    || typeof value.word !== 'string'
    || value.word.trim().length === 0
    || typeof value.normalizedWord !== 'string'
    || value.normalizedWord !== normalizeWord(value.word)
    || !Array.isArray(value.definitions)
    || !everyArrayItem(value.definitions, (item) => typeof item === 'string')
    || !Array.isArray(value.examples)
    || !everyArrayItem(value.examples, (item) => typeof item === 'string')) return false
  return (value.pronunciation === undefined || typeof value.pronunciation === 'string')
    && (value.partOfSpeech === undefined || typeof value.partOfSpeech === 'string')
}

const checkedParseResult = (value: unknown): DictionaryParseResult => {
  if (!isRecord(value)
    || !Array.isArray(value.entries)
    || !Array.isArray(value.errors)
    // Built-in parsers emit one diagnostic for every skipped record. Custom
    // parsers use the same contract so summaries cannot report contradictory
    // counts, and safe integers prevent precision loss at this boundary.
    || typeof value.skipped !== 'number'
    || !Number.isSafeInteger(value.skipped)
    || value.skipped < 0
    || value.skipped !== value.errors.length
    || !everyArrayItem(value.entries, (entry) => isValidEntry(entry))
    || !everyArrayItem(value.errors, (error) => isRecord(error)
      && typeof error.line === 'number'
      && Number.isInteger(error.line)
      && error.line >= 1
      && typeof error.message === 'string'
      && error.message.trim().length > 0)) {
    throw new TypeError('Dictionary parser returned an invalid result')
  }
  return value as DictionaryParseResult
}

/** Application-facing orchestration over explicitly registered parsers and replaceable repositories. */
export class DictionaryService implements DictionaryServicePort {
  private readonly registrations = new Map<string, DictionarySourceRegistration>()

  constructor(
    private readonly repository: DictionaryRepository,
    registrations: readonly DictionarySourceRegistration[] = [],
  ) {
    for (const registration of registrations) this.register(registration)
  }

  /** Registration is explicit: source IDs are never guessed from input text. */
  register(registration: DictionarySourceRegistration): void {
    if (registration?.parser === undefined || typeof registration.parser.parse !== 'function') {
      throw new TypeError('Invalid dictionary source parser')
    }
    let source: DictionarySource
    try {
      source = normalizeDictionarySource(registration.source)
    } catch {
      throw new TypeError('Invalid dictionary source registration')
    }
    if (this.registrations.has(source.id)) throw new DictionarySourceAlreadyRegisteredError(source.id)
    this.registrations.set(source.id, { source, parser: registration.parser })
  }

  private registration(sourceId: unknown): DictionarySourceRegistration {
    const normalizedSourceId = normalizeDictionarySourceId(sourceId)
    const registration = this.registrations.get(normalizedSourceId)
    if (registration === undefined) throw new DictionarySourceNotFoundError(normalizedSourceId)
    return registration
  }

  lookup(word: string): Promise<DictionaryEntry[]> {
    return this.repository.lookup(word)
  }

  private isFileParser(parser: DictionaryParser | DictionaryFileParser): parser is DictionaryFileParser {
    return 'parseFile' in parser && typeof (parser as DictionaryFileParser).parseFile === 'function'
  }

  private async importData(
    sourceId: string,
    data: string | File,
  ): Promise<DictionaryImportSummary> {
    const registration = this.registration(sourceId)

    let result: DictionaryFileParseResult | undefined
    try {
      if (data instanceof File) {
        if (!this.isFileParser(registration.parser)) {
          throw new TypeError('Dictionary parser does not support file import')
        }
        result = await registration.parser.parseFile(data, registration.source.id)
      } else {
        result = registration.parser.parse(data, registration.source.id)
      }
    } catch {
      const inputHasData = data instanceof File ? data.size > 0 : data.trim().length > 0
      const errors: DictionaryParseError[] = inputHasData
        ? [{ line: 1, message: 'Dictionary parser failed' }]
        : []
      return { imported: 0, skipped: errors.length, errorCount: errors.length, errors }
    }

    const checkedResult = checkedParseResult(result)
    const source = (result as DictionaryFileParseResult).source ?? registration.source
    // Keep a distinct error for a well-formed entry owned by another source;
    // malformed entries use the generic boundary error above and never echo data.
    for (const entry of checkedResult.entries) {
      if (entry.sourceId !== source.id) {
        throw new DictionaryEntrySourceMismatchError(source.id)
      }
    }

    await this.repository.saveMany(checkedResult.entries, source)
    return {
      imported: checkedResult.entries.length,
      skipped: checkedResult.skipped,
      errorCount: checkedResult.errors.length,
      // Keep parser diagnostics data-free even when an application supplies a custom parser.
      errors: checkedResult.errors.map((error) => ({
        line: error.line,
        message: 'Malformed dictionary record',
      })),
    }
  }

  async importText(sourceId: string, text: string): Promise<DictionaryImportSummary> {
    if (typeof text !== 'string') throw new TypeError('Dictionary input must be text')
    return this.importData(sourceId, text)
  }

  async importFile(sourceId: string, file: File): Promise<DictionaryImportSummary> {
    if (!(file instanceof File)) throw new TypeError('Dictionary input must be a file')
    return this.importData(sourceId, file)
  }

  listSources(): Promise<DictionarySource[]> {
    return this.repository.listSources()
  }

  clearSource(sourceId: string): Promise<void> {
    return this.repository.clearSource(normalizeDictionarySourceId(sourceId))
  }
}

export const EijiroSource: DictionarySource = {
  id: 'eijiro',
  name: 'Eijiro',
  format: 'eijiro-text',
}

export const WiktionarySource: DictionarySource = {
  id: 'wiktionary',
  name: 'Wiktionary (Wiktextract)',
  format: 'wiktextract-jsonl',
}

export const YomitanSource: DictionarySource = {
  id: 'yomitan',
  name: 'Yomitan',
  format: 'yomitan-zip',
}
