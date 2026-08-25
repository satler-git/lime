import type { DictionaryEntry } from '../dictionary/types'
import type { TargetWordData, TargetWordSubEntry } from './types'

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item): item is string => typeof item === 'string')
}

function isDictionaryEntry(value: unknown): value is DictionaryEntry {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Record<keyof DictionaryEntry, unknown>
  return (
    typeof candidate.word === 'string' &&
    typeof candidate.normalizedWord === 'string' &&
    typeof candidate.sourceId === 'string' &&
    isStringArray(candidate.definitions) &&
    isStringArray(candidate.examples)
  )
}

function entryToSubEntry(entry: DictionaryEntry): TargetWordSubEntry {
  return {
    pronunciation: entry.pronunciation ?? '',
    partOfSpeech: entry.partOfSpeech ?? '',
    definition: entry.definitions.join('; '),
    examples: entry.examples.map((example) => example),
  }
}

export function dictionaryAdapter(result: unknown, _requestedWord: string): TargetWordData | undefined {
  if (!Array.isArray(result) || result.length === 0) return undefined

  const entries = result.filter(isDictionaryEntry)
  if (entries.length === 0) return undefined

  const [first, ...rest] = entries
  const subEntries = rest.map(entryToSubEntry)

  return {
    word: _requestedWord,
    pronunciation: first.pronunciation ?? '',
    partOfSpeech: first.partOfSpeech ?? '',
    definition: first.definitions.join('; '),
    examples: first.examples.map((example) => example),
    inSrs: false,
    ...(subEntries.length > 0 ? { entries: subEntries } : {}),
  }
}
