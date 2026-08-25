/** Normalize the identifier used to register, import, and clear a dictionary source. */
export const normalizeDictionarySourceId = (sourceId: unknown): string => {
  if (typeof sourceId !== 'string' || sourceId.trim().length === 0) {
    throw new TypeError('Dictionary source id must be a non-empty string')
  }
  return sourceId.trim()
}

/** Metadata for an imported dictionary source. */
export type DictionarySource = {
  id: string
  name: string
  format: string
  /** Lower values are returned first; ties retain first import order. */
  priority?: number
}

/** Validate and normalize metadata before it crosses a registration or persistence boundary. */
export const normalizeDictionarySource = (source: unknown): DictionarySource => {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('Dictionary source metadata is invalid')
  }
  const candidate = source as Partial<DictionarySource>
  const id = normalizeDictionarySourceId(candidate.id)
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0
    || typeof candidate.format !== 'string' || candidate.format.trim().length === 0) {
    throw new TypeError('Dictionary source metadata is invalid')
  }
  if (candidate.priority !== undefined && !Number.isFinite(candidate.priority)) {
    throw new TypeError('Dictionary source priority must be a finite number')
  }
  return {
    id,
    name: candidate.name.trim(),
    format: candidate.format.trim(),
    ...(candidate.priority === undefined ? {} : { priority: candidate.priority }),
  }
}

export type DictionaryEntry = {
  /** The source spelling, retained for display. */
  word: string
  /** The shared domain matching key. */
  normalizedWord: string
  /** Identifies which imported source owns this entry. */
  sourceId: string
  definitions: string[]
  examples: string[]
  pronunciation?: string
  partOfSpeech?: string
}

export type DictionaryParseError = {
  /** One-based input line number. */
  line: number
  /** A safe diagnostic; implementations must not include the input line. */
  message: string
}

/**
 * Parser output at the service boundary. Every skipped record must have one
 * corresponding error, so `skipped` is always equal to `errors.length`.
 */
export type DictionaryParseResult = {
  entries: DictionaryEntry[]
  skipped: number
  errors: DictionaryParseError[]
}

/** A parser handles one explicitly registered source format. */
export interface DictionaryParser {
  parse(text: string, sourceId?: string): DictionaryParseResult
}

/** Result from a parser that can inspect the file (e.g. a ZIP archive) to derive source metadata. */
export type DictionaryFileParseResult = DictionaryParseResult & {
  source?: DictionarySource
}

/** A parser that supports binary file import in addition to plain text. */
export interface DictionaryFileParser extends DictionaryParser {
  parseFile(file: File, sourceId?: string): Promise<DictionaryFileParseResult>
}

/** Replaceable persistence boundary for dictionary data. */
export interface DictionaryRepository {
  saveMany(entries: readonly DictionaryEntry[], source?: DictionarySource): Promise<void>
  lookup(word: string): Promise<DictionaryEntry[]>
  listSources(): Promise<DictionarySource[]>
  clearSource(sourceId: string): Promise<void>
}

export type DictionarySourceRegistration = {
  source: DictionarySource
  parser: DictionaryParser | DictionaryFileParser
}

export type DictionaryImportSummary = {
  imported: number
  skipped: number
  errorCount: number
  errors: DictionaryParseError[]
}

/** Structural application lookup port; it intentionally does not import application implementation types. */
export interface DictionaryLookup {
  lookup(word: string): Promise<DictionaryEntry[]>
}

export interface DictionaryServicePort extends DictionaryLookup {
  importText(sourceId: string, text: string): Promise<DictionaryImportSummary>
  importFile(sourceId: string, file: File): Promise<DictionaryImportSummary>
  listSources(): Promise<DictionarySource[]>
  clearSource(sourceId: string): Promise<void>
}
