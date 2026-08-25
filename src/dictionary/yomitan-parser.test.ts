import { describe, expect, it } from 'vitest'
import { strToU8, zipSync } from 'fflate'
import { InMemoryDictionaryRepository } from './repository'
import { DictionaryService, YomitanSource } from './service'
import { YomitanZipParser } from './yomitan-parser'

const makeZipFile = (files: Record<string, string>): File => {
  const zipped: Record<string, Uint8Array> = {}
  for (const [name, content] of Object.entries(files)) {
    zipped[name] = strToU8(content)
  }
  const archive = zipSync(zipped)
  return new File([archive], 'test.zip', { type: 'application/zip' })
}

describe('YomitanZipParser', () => {
  it('extracts plain text, text-typed, and structured-content definitions with examples', async () => {
    const index = {
      title: 'Test Yomitan',
      format: 3,
      revision: '1',
      sourceLanguage: 'en',
      targetLanguage: 'en',
    }

    const tagBank = [
      ['n', 'partOfSpeech', 0, 'noun', 0],
      ['v', 'partOfSpeech', 0, 'verb', 0],
    ]

    const termBank = [
      ['apple', '', 'n', 'n', 0, ['A round fruit.'], 1, ''],
      ['run', '', 'v', 'v', 0, [{ type: 'text', text: 'To move quickly on foot.' }], 2, ''],
      ['free', '', 'adj', 'adj', 0, [{
        type: 'structured-content',
        content: {
          tag: 'ol',
          data: { content: 'glosses' },
          content: [
            {
              tag: 'li',
              content: [
                'Not under the control of another.',
                {
                  tag: 'details',
                  data: { content: 'details-entry-examples' },
                  content: [
                    { tag: 'summary', content: '1 example' },
                    {
                      tag: 'div',
                      data: { content: 'example-sentence' },
                      content: [
                        {
                          tag: 'div',
                          data: { content: 'example-sentence-a' },
                          content: 'The prisoner was finally free.',
                        },
                        {
                          tag: 'div',
                          data: { content: 'example-sentence-c' },
                          content: 'citation',
                        },
                      ],
                    },
                  ],
                },
              ],
            },
            {
              tag: 'li',
              content: 'Available without cost.',
            },
          ],
        },
      }], 3, ''],
    ]

    const file = makeZipFile({
      'index.json': JSON.stringify(index),
      'tag_bank_1.json': JSON.stringify(tagBank),
      'term_bank_1.json': JSON.stringify(termBank),
    })

    const result = await new YomitanZipParser().parseFile(file)

    expect(result.source).toEqual({
      id: 'yomitan-test-yomitan',
      name: 'Test Yomitan (1)',
      format: 'yomitan-zip',
    })
    expect(result.skipped).toBe(0)
    expect(result.errors).toEqual([])

    const entries = result.entries.filter((entry) => entry.sourceId === 'yomitan-test-yomitan')
    expect(entries).toHaveLength(4)

    expect(entries).toContainEqual(expect.objectContaining({
      word: 'apple',
      sourceId: 'yomitan-test-yomitan',
      partOfSpeech: 'n',
      definitions: ['A round fruit.'],
      examples: [],
    }))

    expect(entries).toContainEqual(expect.objectContaining({
      word: 'run',
      sourceId: 'yomitan-test-yomitan',
      partOfSpeech: 'v',
      definitions: ['To move quickly on foot.'],
      examples: [],
    }))

    const free = entries.filter((entry) => entry.word === 'free')
    expect(free).toHaveLength(2)
    expect(free[0]).toMatchObject({
      word: 'free',
      sourceId: 'yomitan-test-yomitan',
      partOfSpeech: 'adj',
      definitions: ['Not under the control of another.'],
      examples: ['The prisoner was finally free.'],
    })
    expect(free[1]).toMatchObject({
      word: 'free',
      sourceId: 'yomitan-test-yomitan',
      partOfSpeech: 'adj',
      definitions: ['Available without cost.'],
      examples: [],
    })
  })

  it('stores readings as pronunciation when they differ from the word', async () => {
    const index = { title: 'Test', format: 3, revision: '1' }
    const termBank = [
      ['打', 'だ', 'n', 'n', 0, ['da definition'], 1, ''],
    ]

    const file = makeZipFile({
      'index.json': JSON.stringify(index),
      'term_bank_1.json': JSON.stringify(termBank),
    })

    const result = await new YomitanZipParser().parseFile(file)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      word: '打',
      sourceId: 'yomitan-test',
      pronunciation: 'だ',
      definitions: ['da definition'],
    })
  })

  it('reports errors for malformed records and continues', async () => {
    const index = { title: 'Test', format: 3, revision: '1' }
    const termBank = [
      [],
      ['valid', '', 'n', 'n', 0, ['ok'], 1, ''],
    ]

    const file = makeZipFile({
      'index.json': JSON.stringify(index),
      'term_bank_1.json': JSON.stringify(termBank),
    })

    const result = await new YomitanZipParser().parseFile(file)
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.word).toBe('valid')
    expect(result.skipped).toBe(1)
    expect(result.errors).toHaveLength(1)
  })

  it('fails cleanly when index.json is malformed', async () => {
    const file = makeZipFile({
      'index.json': 'not valid json',
      'term_bank_1.json': JSON.stringify([['word', '', 'n', 'n', 0, ['def'], 1, '']]),
    })

    const result = await new YomitanZipParser().parseFile(file)
    expect(result.entries).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.skipped).toBe(1)
    expect(result.source).toBeUndefined()
  })

  it('fails cleanly when index.json is missing', async () => {
    const file = makeZipFile({
      'term_bank_1.json': JSON.stringify([['word', '', 'n', 'n', 0, ['def'], 1, '']]),
    })

    const result = await new YomitanZipParser().parseFile(file)
    expect(result.entries).toEqual([])
    expect(result.errors).toHaveLength(1)
    expect(result.skipped).toBe(1)
  })

  it('integrates with DictionaryService.importFile', async () => {
    const index = { title: 'Service Test', format: 3, revision: '1' }
    const termBank = [
      ['hello', '', 'n', 'n', 0, ['A greeting.'], 1, ''],
    ]

    const file = makeZipFile({
      'index.json': JSON.stringify(index),
      'term_bank_1.json': JSON.stringify(termBank),
    })

    const repository = new InMemoryDictionaryRepository()
    const service = new DictionaryService(repository, [
      { source: YomitanSource, parser: new YomitanZipParser() },
    ])
    const summary = await service.importFile('yomitan', file)

    expect(summary).toMatchObject({ imported: 1, skipped: 0, errorCount: 0 })
    await expect(repository.lookup('hello')).resolves.toMatchObject([{
      sourceId: 'yomitan-service-test',
      word: 'hello',
      definitions: ['A greeting.'],
    }])
    await expect(repository.listSources()).resolves.toMatchObject([{
      id: 'yomitan-service-test',
      name: 'Service Test (1)',
      format: 'yomitan-zip',
    }])
  })

  it('registers derived Yomitan source ids so they can be updated and removed', async () => {
    const index = { title: 'Dynamic Test', format: 3, revision: '1' }
    const termBank = [
      ['hello', '', 'n', 'n', 0, ['A greeting.'], 1, ''],
    ]

    const file = makeZipFile({
      'index.json': JSON.stringify(index),
      'term_bank_1.json': JSON.stringify(termBank),
    })

    const repository = new InMemoryDictionaryRepository()
    const service = new DictionaryService(repository, [
      { source: YomitanSource, parser: new YomitanZipParser() },
    ])
    await service.importFile('yomitan', file)

    await service.updateSource({ id: 'yomitan-dynamic-test', name: 'Dynamic Updated', format: 'yomitan-zip', enabled: false })
    await expect(repository.listSources()).resolves.toMatchObject([{
      id: 'yomitan-dynamic-test',
      name: 'Dynamic Updated',
      enabled: false,
    }])
    await expect(repository.lookup('hello')).resolves.toEqual([])

    await service.removeSource('yomitan-dynamic-test')
    await expect(repository.listSources()).resolves.toEqual([])
    await expect(repository.lookup('hello')).resolves.toEqual([])
  })
})
