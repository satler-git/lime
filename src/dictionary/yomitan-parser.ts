import { AsyncUnzipInflate, Unzip, UnzipPassThrough, strFromU8 } from 'fflate'
import type { UnzipFile } from 'fflate'
import { normalizeWord } from '../domain/word'
import { makeEntry, uniqueNonEmpty } from './parsers'
import type {
  DictionaryEntry,
  DictionaryFileParseResult,
  DictionaryFileParser,
  DictionaryParseError,
  DictionarySource,
} from './types'

/**
 * A parser for Yomitan-format ZIP dictionaries, such as those produced by
 * wiktionary-to-yomitan. It streams the archive to keep memory bounded and
 * extracts word/definition/example records from the term bank JSON files.
 */

const INDEX_FILE = 'index.json'
const TERM_BANK_PREFIX = 'term_bank_'
const TAG_BANK_PREFIX = 'tag_bank_'

const GLOSS_LIST_MARKER = 'glosses'
const EXAMPLE_DETAILS_MARKER = 'details-entry-examples'
const EXAMPLE_SENTENCE_A_MARKER = 'example-sentence-a'
const EXAMPLE_SENTENCE_B_MARKER = 'example-sentence-b'
const EXAMPLE_SENTENCE_C_MARKER = 'example-sentence-c'
const TAGS_MARKER = 'tags'
const EXTRA_INFO_MARKER = 'extra-info'

const BLOCKED_CONTENT: readonly string[] = [
  'preamble',
  'backlink',
  'synonyms',
  'antonyms',
  'derived-terms',
  'related-terms',
  'descendants',
  'references',
  'see-also',
  'translations',
  'etymology',
  'grammar',
  'pronunciation',
  'subentries',
]

const BLOCKED_CONTENT_PREFIXES: readonly string[] = ['details-entry-']

type StructuredContentNode =
  | string
  | readonly StructuredContentNode[]
  | {
      tag?: string
      content?: StructuredContentNode | StructuredContentNode[]
      data?: { content?: string; [key: string]: string | undefined }
      [key: string]: unknown
    }

type StructuredContentObject = Exclude<StructuredContentNode, string | readonly StructuredContentNode[]>

type YomitanGlossary =
  | string
  | { type: 'text'; text: string }
  | { type: 'structured-content'; content: StructuredContentNode }
  | { type: 'image'; path: string; [key: string]: unknown }
  | [string, string[]]

type YomitanTermRecord = readonly unknown[]

type Gloss = {
  definition: string
  examples: string[]
  partOfSpeech?: string
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isStructuredContentObject = (value: unknown): value is StructuredContentObject =>
  isRecord(value)

const isStructuredContentNode = (value: unknown): value is StructuredContentNode =>
  typeof value === 'string'
  || Array.isArray(value)
  || isStructuredContentObject(value)

const contentData = (node: StructuredContentNode | undefined): string | undefined => {
  if (!isStructuredContentObject(node)) return undefined
  return typeof node.data?.content === 'string' ? node.data.content : undefined
}

const isBlockedContent = (node: StructuredContentNode | undefined): boolean => {
  const data = contentData(node)
  if (data === undefined) return false
  if (data === EXAMPLE_DETAILS_MARKER) return false
  if (BLOCKED_CONTENT.includes(data)) return true
  return BLOCKED_CONTENT_PREFIXES.some((prefix) => data.startsWith(prefix))
}

const isExampleDetails = (node: StructuredContentNode | undefined): boolean => {
  if (!isStructuredContentObject(node)) return false
  if (node.tag !== 'details') return false
  const data = contentData(node)
  return data === EXAMPLE_DETAILS_MARKER || /example/i.test(summaryText(node))
}

const summaryText = (node: StructuredContentNode | undefined): string => {
  if (!isStructuredContentObject(node) || node.tag !== 'details') return ''
  const children = asArray(node.content)
  const summary = children.find((child) => isStructuredContentObject(child) && child.tag === 'summary')
  return summary === undefined ? '' : plainText(summary).toLowerCase()
}

const asArray = (node: StructuredContentNode | undefined): readonly StructuredContentNode[] => {
  if (node === undefined) return []
  return Array.isArray(node) ? node : [node]
}

const normalizeWhitespace = (value: string): string => value.replace(/\s+/g, ' ').trim()

const plainText = (
  node: StructuredContentNode | undefined,
  options: { skipDetails?: boolean; skipTags?: boolean; skipExtraInfo?: boolean } = {},
): string => {
  if (node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) {
    return node.map((child) => plainText(child, options)).join(' ')
  }
  if (!isStructuredContentObject(node)) return ''

  if (node.tag === 'img') return ''
  if (node.tag === 'br') return ' '
  if (options.skipDetails && node.tag === 'details' && isExampleDetails(node)) return ''
  if (options.skipTags && contentData(node) === TAGS_MARKER) return ''
  if (options.skipExtraInfo && contentData(node) === EXTRA_INFO_MARKER) return ''
  if (isBlockedContent(node)) return ''

  return plainText(node.content, options)
}

const extractExampleText = (node: StructuredContentNode | undefined): string => {
  if (node === undefined) return ''
  if (typeof node === 'string') return node
  if (Array.isArray(node)) {
    return normalizeWhitespace(node.map((child) => extractExampleText(child)).join(' '))
  }
  if (!isStructuredContentObject(node)) return ''

  if (node.tag === 'img') return ''
  const data = contentData(node)
  if (data === EXAMPLE_SENTENCE_C_MARKER) return ''
  if (data === EXAMPLE_SENTENCE_B_MARKER) return ''

  return extractExampleText(node.content)
}

const findExampleNodes = (
  node: StructuredContentNode | undefined,
  result: StructuredContentNode[],
): void => {
  if (typeof node === 'string' || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) findExampleNodes(child, result)
    return
  }
  if (!isStructuredContentObject(node)) return

  const data = contentData(node)
  if (node.tag === 'div' && data === EXAMPLE_SENTENCE_A_MARKER) {
    result.push(node)
    return
  }
  if (node.tag === 'div' && data === 'example-sentence') {
    result.push(node)
    return
  }

  findExampleNodes(node.content, result)
}

const extractExamples = (node: StructuredContentNode | undefined): string[] => {
  const examples: StructuredContentNode[] = []
  findExampleNodes(node, examples)
  return uniqueNonEmpty(examples.map((example) => extractExampleText(example)))
}

const derivePartOfSpeech = (
  tags: string[],
  tagCategories: ReadonlyMap<string, string>,
): string | undefined => {
  const posTags = tagCategories.size === 0
    ? tags
    : tags.filter((tag) => !tagCategories.has(tag) || tagCategories.get(tag) === 'partOfSpeech')
  const joined = uniqueNonEmpty(posTags).join(', ')
  return joined.length > 0 ? joined : undefined
}

const findPartOfSpeechTags = (
  node: StructuredContentNode | undefined,
  result: string[],
): void => {
  if (typeof node === 'string' || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) findPartOfSpeechTags(child, result)
    return
  }
  if (!isStructuredContentObject(node)) return
  if (typeof node.data?.category === 'string' && node.data.category === 'partOfSpeech') {
    const text = normalizeWhitespace(plainText(node.content))
    if (text.length > 0) result.push(text)
    return
  }
  findPartOfSpeechTags(node.content, result)
}

const partOfSpeechFromTagList = derivePartOfSpeech

const extractGlossLi = (
  node: StructuredContentNode | undefined,
  tagCategories: ReadonlyMap<string, string>,
  recordPartOfSpeech: string | undefined,
): Gloss | undefined => {
  if (!isStructuredContentObject(node) || node.tag !== 'li') return undefined

  const definition = normalizeWhitespace(
    plainText(node.content, { skipDetails: true, skipTags: true, skipExtraInfo: true }),
  )
  const examples = extractExamples(node.content)

  if (definition.length === 0 && examples.length === 0) return undefined

  const posTags: string[] = []
  findPartOfSpeechTags(node.content, posTags)
  const partOfSpeech = partOfSpeechFromTagList(posTags, tagCategories) ?? recordPartOfSpeech

  return { definition, examples, partOfSpeech }
}

const extractGlosses = (
  node: StructuredContentNode | undefined,
  tagCategories: ReadonlyMap<string, string>,
  recordPartOfSpeech?: string,
): Gloss[] => {
  if (node === undefined) return []
  if (typeof node === 'string') return node.trim().length > 0 ? [{ definition: node.trim(), examples: [] }] : []
  if (Array.isArray(node)) {
    const glosses: Gloss[] = []
    for (const child of node) glosses.push(...extractGlosses(child, tagCategories, recordPartOfSpeech))
    return glosses
  }
  if (!isStructuredContentObject(node)) return []

  if (isBlockedContent(node)) return []
  if (node.tag === 'img') return []

  if ((node.tag === 'ol' || node.tag === 'ul') && contentData(node) === GLOSS_LIST_MARKER && hasLiChild(node)) {
    const children = asArray(node.content)
    const glosses: Gloss[] = []
    for (const child of children) {
      const gloss = extractGlossLi(child, tagCategories, recordPartOfSpeech)
      if (gloss !== undefined) glosses.push(gloss)
    }
    return glosses
  }

  if (node.tag === 'details' && isExampleDetails(node)) {
    const examples = extractExamples(node.content)
    return examples.length > 0 ? [{ definition: '', examples }] : []
  }

  return extractGlosses(node.content, tagCategories, recordPartOfSpeech)
}

const glossaryToGlosses = (
  item: YomitanGlossary,
  tagCategories: ReadonlyMap<string, string>,
  recordPartOfSpeech?: string,
): Gloss[] => {
  if (typeof item === 'string') {
    return item.trim().length > 0
      ? [{ definition: item.trim(), examples: [] }]
      : []
  }
  if (Array.isArray(item)) {
    // Deinflection records are not definitions.
    return []
  }
  if (item === null || typeof item !== 'object') return []

  switch (item.type) {
    case 'text':
      return typeof item.text === 'string' && item.text.trim().length > 0
        ? [{ definition: item.text.trim(), examples: [] }]
        : []
    case 'structured-content': {
      if (!isStructuredContentNode(item.content)) return []
      const list = findGlossList(item.content)
      if (list !== undefined) {
        return extractGlosses(list, tagCategories, recordPartOfSpeech)
      }
      const text = normalizeWhitespace(
        plainText(item.content, { skipDetails: true, skipTags: true, skipExtraInfo: true }),
      )
      const examples = extractExamples(item.content)
      if (text.length === 0 && examples.length === 0) return []
      return [{ definition: text, examples, partOfSpeech: recordPartOfSpeech }]
    }
    case 'image': {
      const description = typeof (item as { description?: string }).description === 'string'
        ? (item as { description?: string }).description?.trim()
        : undefined
      if (description !== undefined && description.length > 0) {
        return [{ definition: description, examples: [], partOfSpeech: recordPartOfSpeech }]
      }
      return []
    }
    default:
      return []
  }
}

const partOfSpeechFromRecordTags = (
  defTags: string | null,
  rules: string | null,
  termTags: string | null,
  tagCategories: ReadonlyMap<string, string>,
): string | undefined => {
  if (typeof defTags === 'string' && defTags.trim().length > 0) {
    return derivePartOfSpeech(defTags.trim().split(/\s+/), tagCategories)
  }
  if (typeof rules === 'string' && rules.trim().length > 0) {
    return derivePartOfSpeech(rules.trim().split(/\s+/), tagCategories)
  }
  if (tagCategories.size === 0) return undefined
  if (typeof termTags === 'string' && termTags.trim().length > 0) {
    return derivePartOfSpeech(termTags.trim().split(/\s+/), tagCategories)
  }
  return undefined
}

const sanitizeSourceId = (title: string, fallback: string): string => {
  const safe = title
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^-+|--+|-+$/g, '')
  return safe.length > 0 ? safe : fallback
}

const parseIndex = (data: Uint8Array, fallbackSourceId: string): DictionarySource => {
  const text = strFromU8(data)
  const parsed: unknown = JSON.parse(text)
  if (!isRecord(parsed)) throw new TypeError('Yomitan index.json is invalid')

  const title = typeof parsed.title === 'string' && parsed.title.trim().length > 0
    ? parsed.title.trim()
    : 'Yomitan'
  const revision = typeof parsed.revision === 'string' ? parsed.revision : ''
  const sourceId = `yomitan-${sanitizeSourceId(title, fallbackSourceId)}`
  const name = revision.length > 0 ? `${title} (${revision})` : title

  return { id: sourceId, name, format: 'yomitan-zip' }
}

const parseTagBank = (data: Uint8Array): Map<string, string> => {
  const categories = new Map<string, string>()
  try {
    const text = strFromU8(data)
    const parsed: unknown = JSON.parse(text)
    if (!Array.isArray(parsed)) return categories
    for (const record of parsed) {
      if (!Array.isArray(record) || record.length < 2) continue
      const [name, category] = record
      if (typeof name === 'string' && typeof category === 'string') {
        categories.set(name, category)
      }
    }
  } catch {
    // A missing or malformed tag bank should not abort the import.
  }
  return categories
}

const collectV1Glossary = (record: YomitanTermRecord): YomitanGlossary[] => {
  const glossary: YomitanGlossary[] = []
  for (let index = 5; index < record.length; index += 1) {
    const item = record[index]
    if (typeof item === 'string') glossary.push(item)
    else break
  }
  return glossary
}

const isDeinflectionOrImage = (item: unknown): boolean =>
  Array.isArray(item) || (isRecord(item) && (item as { type?: string }).type === 'image')

const hasLiChild = (node: StructuredContentObject): boolean =>
  asArray(node.content).some((child) => isStructuredContentObject(child) && child.tag === 'li')

const findGlossList = (node: StructuredContentNode | undefined): StructuredContentNode | undefined => {
  if (!isStructuredContentObject(node)) return undefined
  if (isBlockedContent(node)) return undefined
  if ((node.tag === 'ol' || node.tag === 'ul') && contentData(node) === GLOSS_LIST_MARKER && hasLiChild(node)) return node
  for (const child of asArray(node.content)) {
    const found = findGlossList(child)
    if (found !== undefined) return found
  }
  return undefined
}

const extractTermRecord = (
  record: YomitanTermRecord,
  sourceId: string,
  tagCategories: ReadonlyMap<string, string>,
  recordNumber: number,
): { entries: DictionaryEntry[]; skipped: number; errors: DictionaryParseError[] } => {
  if (!Array.isArray(record) || record.length < 6) {
    return { entries: [], skipped: 1, errors: [{ line: recordNumber, message: 'Malformed Yomitan term record' }] }
  }

  const expression = record[0]
  const reading = record[1]
  const defTags = record[2]
  const rules = record[3]
  const glossary = record[5]
  const termTags = record[7]

  if (typeof expression !== 'string' || expression.trim().length === 0) {
    return { entries: [], skipped: 1, errors: [{ line: recordNumber, message: 'Malformed Yomitan term record' }] }
  }

  const word = expression.trim()
  const recordPartOfSpeech = partOfSpeechFromRecordTags(
    typeof defTags === 'string' ? defTags : null,
    typeof rules === 'string' ? rules : null,
    typeof termTags === 'string' ? termTags : null,
    tagCategories,
  )

  const pronunciation = typeof reading === 'string'
    && reading.trim().length > 0
    && normalizeWord(reading) !== normalizeWord(word)
    ? reading.trim()
    : undefined

  const glossaryItems: YomitanGlossary[] = Array.isArray(glossary)
    ? (glossary as YomitanGlossary[])
    : typeof glossary === 'string'
      ? collectV1Glossary(record)
      : []

  if (glossaryItems.length === 0) {
    return { entries: [], skipped: 1, errors: [{ line: recordNumber, message: 'Malformed Yomitan term record' }] }
  }

  // Non-lemma cross-references only contain deinflections or images; these
  // cannot be turned into usable dictionary entries, so skip them silently.
  if (glossaryItems.every(isDeinflectionOrImage)) {
    return { entries: [], skipped: 0, errors: [] }
  }

  const recordEntries: DictionaryEntry[] = []
  for (const item of glossaryItems) {
    const glosses = glossaryToGlosses(item as YomitanGlossary, tagCategories, recordPartOfSpeech)
    for (const gloss of glosses) {
      if (gloss.definition.length === 0) continue
      try {
        const entry = makeEntry({
          sourceId,
          word,
          definitions: [gloss.definition],
          examples: gloss.examples,
          pronunciation,
          partOfSpeech: gloss.partOfSpeech ?? recordPartOfSpeech,
        })
        recordEntries.push(entry)
      } catch {
        return { entries: [], skipped: 1, errors: [{ line: recordNumber, message: 'Malformed Yomitan term record' }] }
      }
    }
  }

  return { entries: recordEntries, skipped: 0, errors: [] }
}

const parseTermBank = (
  data: Uint8Array,
  sourceId: string,
  tagCategories: ReadonlyMap<string, string>,
): { entries: DictionaryEntry[]; skipped: number; errors: DictionaryParseError[] } => {
  const entries: DictionaryEntry[] = []
  const errors: DictionaryParseError[] = []
  let skipped = 0

  let records: unknown
  try {
    const text = strFromU8(data)
    records = JSON.parse(text)
  } catch {
    return { entries, skipped: 1, errors: [{ line: 1, message: 'Malformed Yomitan term bank' }] }
  }

  if (!Array.isArray(records)) {
    return { entries, skipped: 1, errors: [{ line: 1, message: 'Malformed Yomitan term bank' }] }
  }

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (!Array.isArray(record) || record.length < 6) {
      skipped += 1
      errors.push({ line: index + 1, message: 'Malformed Yomitan term record' })
      continue
    }

    try {
      const { entries: recordEntries, skipped: recordSkipped, errors: recordErrors } = extractTermRecord(
        record as YomitanTermRecord,
        sourceId,
        tagCategories,
        index + 1,
      )
      entries.push(...recordEntries)
      skipped += recordSkipped
      errors.push(...recordErrors)
    } catch {
      skipped += 1
      errors.push({ line: index + 1, message: 'Malformed Yomitan term record' })
    }
  }

  return { entries, skipped, errors }
}

const collectFile = (
  file: UnzipFile,
  onComplete: (data: Uint8Array) => void,
  onError: (error: Error) => void,
): void => {
  const chunks: Uint8Array[] = []
  let total = 0
  file.ondata = (err, data, final) => {
    if (err !== null) {
      file.terminate()
      onError(err instanceof Error ? err : new TypeError('Yomitan archive decompression failed'))
      return
    }
    if (data !== null && data.length > 0) {
      chunks.push(data)
      total += data.length
    }
    if (final) {
      const combined = new Uint8Array(total)
      let offset = 0
      for (const chunk of chunks) {
        combined.set(chunk, offset)
        offset += chunk.length
      }
      onComplete(combined)
    }
  }
  file.start()
}

const discardFile = (file: UnzipFile): void => {
  // Start the stream with a no-op handler so fflate consumes and discards the
  // compressed data instead of buffering it for skipped files.
  file.ondata = () => undefined
  file.start()
  file.terminate()
}

export class YomitanZipParser implements DictionaryFileParser {
  parse(): never {
    throw new TypeError('Yomitan dictionaries must be imported as a .zip file')
  }

  async parseFile(file: File, sourceId?: string): Promise<DictionaryFileParseResult> {
    return parseYomitanZip(file, sourceId ?? 'yomitan')
  }
}

async function parseYomitanZip(file: File, fallbackSourceId: string): Promise<DictionaryFileParseResult> {
  let source: DictionarySource | undefined
  const tagCategories = new Map<string, string>()
  const entries: DictionaryEntry[] = []
  const errors: DictionaryParseError[] = []
  let skipped = 0
  const pendingTermBanks: Uint8Array[] = []

  const processPendingTermBanks = (): void => {
    if (source === undefined) return
    for (const data of pendingTermBanks) {
      const { entries: bankEntries, skipped: bankSkipped, errors: bankErrors } = parseTermBank(
        data,
        source.id,
        tagCategories,
      )
      entries.push(...bankEntries)
      skipped += bankSkipped
      errors.push(...bankErrors)
    }
    pendingTermBanks.length = 0
  }

  const parseZip = (): Promise<void> => new Promise((resolve, reject) => {
    let activeFiles = 0
    let streamDone = false
    let parseError: Error | undefined

    const maybeDone = (): void => {
      if (streamDone && activeFiles === 0) {
        if (parseError !== undefined) {
          reject(parseError)
        } else {
          resolve()
        }
      }
    }

    const handleFileError = (name: string, _error: Error): void => {
      activeFiles -= 1
      if (parseError === undefined) {
        parseError = new TypeError(`Yomitan archive member could not be decompressed: ${name}`)
      }
      maybeDone()
    }

    const unzip = new Unzip((zipFile) => {
      if (zipFile.name === INDEX_FILE) {
        activeFiles += 1
        collectFile(
          zipFile,
          (data) => {
            activeFiles -= 1
            if (parseError !== undefined) {
              maybeDone()
              return
            }
            try {
              source = parseIndex(data, fallbackSourceId)
              processPendingTermBanks()
            } catch (cause) {
              if (parseError === undefined) {
                parseError = new TypeError('Yomitan index.json is invalid')
              }
            }
            maybeDone()
          },
          (error) => handleFileError(INDEX_FILE, error),
        )
        return
      }

      if (zipFile.name.startsWith(TAG_BANK_PREFIX) && zipFile.name.endsWith('.json')) {
        activeFiles += 1
        collectFile(
          zipFile,
          (data) => {
            activeFiles -= 1
            if (parseError !== undefined) {
              maybeDone()
              return
            }
            const categories = parseTagBank(data)
            for (const [tag, category] of categories) tagCategories.set(tag, category)
            maybeDone()
          },
          (error) => handleFileError(zipFile.name, error),
        )
        return
      }

      if (zipFile.name.startsWith(TERM_BANK_PREFIX) && zipFile.name.endsWith('.json')) {
        activeFiles += 1
        collectFile(
          zipFile,
          (data) => {
            activeFiles -= 1
            if (parseError !== undefined) {
              maybeDone()
              return
            }
            if (source === undefined) {
              pendingTermBanks.push(data)
            } else {
              const { entries: bankEntries, skipped: bankSkipped, errors: bankErrors } = parseTermBank(
                data,
                source.id,
                tagCategories,
              )
              entries.push(...bankEntries)
              skipped += bankSkipped
              errors.push(...bankErrors)
            }
            maybeDone()
          },
          (error) => handleFileError(zipFile.name, error),
        )
        return
      }

      discardFile(zipFile)
    })

    unzip.register(AsyncUnzipInflate)
    unzip.register(UnzipPassThrough)

    const pushAll = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
      const reader = stream.getReader()
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) {
            unzip.push(new Uint8Array(0), true)
            return
          }
          if (parseError !== undefined) {
            await reader.cancel()
            return
          }
          unzip.push(value, false)
        }
      } finally {
        reader.releaseLock()
      }
    }

    const pushBuffer = async (buffer: ArrayBuffer): Promise<void> => {
      unzip.push(new Uint8Array(buffer), true)
    }

    if (typeof file.stream === 'function') {
      pushAll(file.stream())
        .then(() => { streamDone = true; maybeDone() })
        .catch((error) => {
          if (parseError === undefined) parseError = error
          maybeDone()
        })
    } else {
      file.arrayBuffer()
        .then((buffer) => {
          pushBuffer(buffer)
            .then(() => { streamDone = true; maybeDone() })
            .catch((error) => {
              if (parseError === undefined) parseError = error
              maybeDone()
            })
        })
        .catch((error) => {
          if (parseError === undefined) parseError = error
          maybeDone()
        })
    }
  })

  try {
    await parseZip()
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Yomitan archive could not be parsed'
    errors.push({ line: 1, message })
    skipped += 1
  }

  if (source === undefined) {
    if (errors.length === 0) {
      errors.push({ line: 1, message: 'Yomitan archive is missing index.json' })
      skipped += 1
    }
    return { entries: [], skipped, errors }
  }

  processPendingTermBanks()

  const result: DictionaryFileParseResult = {
    entries,
    skipped,
    errors,
    source,
  }

  return result
}

export const yomitanZipParser = new YomitanZipParser()
