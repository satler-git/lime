import type { DictionaryEntry, DictionaryParseResult, DictionaryParser } from './types'
import { makeEntry, parseLines, uniqueNonEmpty } from './parsers'

type UnknownRecord = Record<string, unknown>

export type WiktionaryJsonlParserOptions = {
  /** Wiktextract `lang_code`, for example `en`. */
  languageCode?: string
  /** Wiktextract `lang`, for example `English`. */
  language?: string
}

/**
 * Parser for Wiktextract JSONL WordData records, not raw Wiktionary wikitext
 * or a whole JSON array. The supported fields are `lang_code` and/or `lang`,
 * `word`, `pos`, `sounds[].ipa`, and `senses[].glosses` /
 * `senses[].examples[].text`. Records must identify the configured language.
 */
export class WiktionaryJsonlParser implements DictionaryParser {
  private readonly languageCode?: string
  private readonly language?: string

  constructor(options: WiktionaryJsonlParserOptions = {}) {
    const defaultEnglish = options.languageCode === undefined && options.language === undefined
    this.languageCode = options.languageCode?.trim() || (defaultEnglish ? 'en' : undefined)
    this.language = options.language?.trim() || (defaultEnglish ? 'English' : undefined)
  }

  parse(text: string, sourceId = 'wiktionary'): DictionaryParseResult {
    return parseLines(
      text,
      (line) => this.parseLine(line, sourceId),
      () => 'Unsupported or malformed Wiktextract language record',
    )
  }

  private parseLine(line: string, sourceId: string): DictionaryEntry | undefined {
    const value: unknown = JSON.parse(line)
    if (!isRecord(value) || typeof value.word !== 'string' || value.word.trim().length === 0) {
      return undefined
    }
    const matchesCode = this.languageCode !== undefined && value.lang_code === this.languageCode
    const matchesLanguage = this.language !== undefined && value.lang === this.language
    const hasLanguageMarker = value.lang_code !== undefined || value.lang !== undefined
    const hasConflictingCode = this.languageCode !== undefined && value.lang_code !== undefined && !matchesCode
    const hasConflictingLanguage = this.language !== undefined && value.lang !== undefined && !matchesLanguage
    if (!hasLanguageMarker || hasConflictingCode || hasConflictingLanguage || (!matchesCode && !matchesLanguage)) {
      return undefined
    }

    const definitions: unknown[] = []
    const examples: unknown[] = []
    if (Array.isArray(value.senses)) {
      for (const sense of value.senses) {
        if (!isRecord(sense)) continue
        if (Array.isArray(sense.glosses)) definitions.push(...sense.glosses)
        if (Array.isArray(sense.examples)) {
          for (const example of sense.examples) {
            if (isRecord(example)) examples.push(example.text)
          }
        }
      }
    }

    const pronunciations: unknown[] = []
    if (Array.isArray(value.sounds)) {
      for (const sound of value.sounds) {
        if (isRecord(sound)) pronunciations.push(sound.ipa)
      }
    }

    return makeEntry({
      sourceId,
      word: value.word,
      definitions: uniqueNonEmpty(definitions),
      examples: uniqueNonEmpty(examples),
      pronunciation: uniqueNonEmpty(pronunciations).join(' / '),
      partOfSpeech: typeof value.pos === 'string' ? value.pos : undefined,
    })
  }
}

const isRecord = (value: unknown): value is UnknownRecord =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Built-in Wiktionary import is intentionally English-only. */
export const wiktionaryJsonlParser = new WiktionaryJsonlParser({ languageCode: 'en', language: 'English' })
