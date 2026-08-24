import type { DictionaryEntry, DictionaryParseResult, DictionaryParser } from './types'
import { makeEntry, parseLines } from './parsers'

/**
 * Parser for the supported Eijiro BOOTH text shape (already decoded to a JS
 * string): one record per line, beginning with `■`, with ` : ` separating the
 * headword and body; `■・` starts an example in the body. BOOTH's download is
 * Shift-JIS, so decoding bytes is intentionally outside this parser.
 */
export class EijiroParser implements DictionaryParser {
  parse(text: string, sourceId = 'eijiro'): DictionaryParseResult {
    return parseLines(
      text,
      (line) => this.parseLine(line, sourceId),
      () => 'Malformed Eijiro record',
    )
  }

  private parseLine(input: string, sourceId: string): DictionaryEntry | undefined {
    const line = input.replace(/\r$/, '')
    if (!line.startsWith('■')) return undefined
    const separator = line.indexOf(' : ')
    if (separator < 2) return undefined

    const header = line.slice(1, separator).trim()
    const body = line.slice(separator + 3).trim()
    if (header.length === 0 || body.length === 0) return undefined

    const partOfSpeech = [...header.matchAll(/\{([^{}]+)\}/g)]
      .map((match) => match[1].trim())
      .filter(Boolean)
      .join(', ')
    const word = header.replace(/\s*\{[^{}]+\}/g, '').trim()
    if (word.length === 0) return undefined

    const chunks = body.split('■・')
    const definitionText = stripMetadata(chunks.shift() ?? '').trim()
    const examples = chunks.map((example) => example.trim()).filter(Boolean)
    const pronunciation = body.match(/【発音!?】\s*([^【■◆]+?)(?=、|【|$)/)?.[1]?.trim()

    return makeEntry({
      sourceId,
      word,
      definitions: definitionText ? [definitionText] : [],
      examples,
      pronunciation,
      partOfSpeech,
    })
  }
}

const stripMetadata = (value: string): string => value
  // These labels describe the headword record rather than its translation.
  // Keep lexical labels such as 【名】 and 【医】 in definitions.
  .replace(/【(?:レベル|発音!?|＠|変化|分節|大学入試|英検|TOEIC|音声)】[^【■◆]*(?=【|$)/g, '')
  .replace(/^\s*[、,]\s*/, '')
  .replace(/[、,]\s*$/, '')
  .trim()

export const eijiroParser = new EijiroParser()
