import { normalizeWord } from '../domain/word'
import type { DictionaryEntry, DictionaryParseError, DictionaryParseResult } from './types'

export const uniqueNonEmpty = (values: readonly unknown[]): string[] => {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (typeof value !== 'string') continue
    const normalized = value.trim()
    if (normalized.length > 0 && !seen.has(normalized)) {
      seen.add(normalized)
      result.push(normalized)
    }
  }
  return result
}

export const makeEntry = (input: {
  sourceId: string
  word: string
  definitions?: readonly unknown[]
  examples?: readonly unknown[]
  pronunciation?: string
  partOfSpeech?: string
}): DictionaryEntry => {
  const word = input.word.trim()
  const sourceId = input.sourceId.trim()
  if (sourceId.length === 0 || word.length === 0 || normalizeWord(word).length === 0) {
    throw new TypeError('Dictionary entries require a source and word')
  }
  return {
    word,
    normalizedWord: normalizeWord(word),
    sourceId,
    definitions: uniqueNonEmpty(input.definitions ?? []),
    examples: uniqueNonEmpty(input.examples ?? []),
    ...(typeof input.pronunciation === 'string' && input.pronunciation.trim()
      ? { pronunciation: input.pronunciation.trim() }
      : {}),
    ...(typeof input.partOfSpeech === 'string' && input.partOfSpeech.trim()
      ? { partOfSpeech: input.partOfSpeech.trim() }
      : {}),
  }
}

/** Parse independent records without allowing one malformed line to abort an import. */
export const parseLines = (
  text: string,
  parseLine: (line: string, lineNumber: number) => DictionaryEntry | undefined,
  invalidMessage: () => string,
): DictionaryParseResult => {
  const entries: DictionaryEntry[] = []
  const errors: DictionaryParseError[] = []
  let skipped = 0
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)

  lines.forEach((line, index) => {
    if (line.trim().length === 0) return
    try {
      const entry = parseLine(line, index + 1)
      if (entry === undefined) {
        skipped += 1
        errors.push({ line: index + 1, message: invalidMessage() })
      } else {
        entries.push(entry)
      }
    } catch {
      skipped += 1
      errors.push({ line: index + 1, message: invalidMessage() })
    }
  })

  return { entries, skipped, errors }
}
