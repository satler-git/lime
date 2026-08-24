import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeWord } from '../domain/word'
import { namespaceDatabaseName } from '../persistence/indexed-db-persistence-helpers'
import { EijiroParser } from './eijiro-parser'
import { InMemoryDictionaryRepository, IndexedDbDictionaryRepository, mergeDictionaryEntry } from './repository'
import { DictionaryService } from './service'
import type { DictionaryEntry, DictionarySource } from './types'
import { WiktionaryJsonlParser } from './wiktionary-parser'

const eijiroSource: DictionarySource = { id: 'eijiro', name: 'Eijiro', format: 'eijiro-text' }
const wiktionarySource: DictionarySource = { id: 'wiktionary', name: 'Wiktionary', format: 'wiktextract-jsonl' }
const makeEntry = (sourceId: string, word: string, definition: string): DictionaryEntry => ({
  sourceId,
  word,
  normalizedWord: normalizeWord(word),
  definitions: [definition],
  examples: [],
})

let databases: string[] = []
afterEach(async () => {
  for (const name of databases) {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    })
  }
  databases = []
})

describe('EijiroParser', () => {
  it('parses documented records, metadata, and ■・ examples', () => {
    const result = new EijiroParser().parse([
      '■adopt : 【レベル】3、【発音】эdα\'pt/эdo\'pt、【＠】アダプト、アドプト',
      '■tree {名-1} : 木',
      '■let off {句動-1} : ～を発射する■・It is not allowed to let off fireworks. 花火をしてはいけません。',
    ].join('\n'), 'eijiro')

    expect(result.skipped).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.entries).toMatchObject([
      { word: 'adopt', pronunciation: "эdα'pt/эdo'pt", definitions: [] },
      { word: 'tree', partOfSpeech: '名-1', definitions: ['木'] },
      { word: 'let off', partOfSpeech: '句動-1', definitions: ['～を発射する'], examples: ['It is not allowed to let off fireworks. 花火をしてはいけません。'] },
    ])
  })

  it('reports malformed records and continues', () => {
    const result = new EijiroParser().parse('not a record\n■valid : 定義\n■missing separator', 'eijiro')
    expect(result.entries.map((entry) => entry.word)).toEqual(['valid'])
    expect(result.skipped).toBe(2)
    expect(result.errors.map((error) => error.line)).toEqual([1, 3])
    expect(result.errors[0]?.message).not.toContain('not a record')
  })
})

describe('WiktionaryJsonlParser', () => {
  it('extracts the documented English Wiktextract WordData shape', () => {
    const result = new WiktionaryJsonlParser().parse([
      JSON.stringify({
        lang_code: 'en', lang: 'English', word: 'walk', pos: 'verb', sounds: [{ ipa: '/wɔːk/' }],
        senses: [{ glosses: ['To move on foot.'], examples: [{ text: 'I walk to work.' }] }],
      }),
      '{not json}',
      JSON.stringify({ lang_code: 'en', lang: 'English', word: 'walk', pos: 'noun', senses: [{ glosses: ['A journey on foot.'] }] }),
    ].join('\n'), 'wiktionary')

    expect(result.entries).toMatchObject([
      { word: 'walk', partOfSpeech: 'verb', pronunciation: '/wɔːk/', definitions: ['To move on foot.'], examples: ['I walk to work.'] },
      { word: 'walk', partOfSpeech: 'noun', definitions: ['A journey on foot.'] },
    ])
    expect(result.skipped).toBe(1)
    expect(result.errors[0]?.message).not.toContain('not json')
  })

  it('skips and reports records outside the configured language', () => {
    const result = new WiktionaryJsonlParser().parse(JSON.stringify({
      lang_code: 'fr', lang: 'French', word: 'marche', senses: [{ glosses: ['walk'] }],
    }))
    expect(result.entries).toEqual([])
    expect(result.skipped).toBe(1)
    expect(result.errors).toEqual([{ line: 1, message: 'Unsupported or malformed Wiktextract language record' }])
  })

  it('supports a configured language code and name', () => {
    const result = new WiktionaryJsonlParser({ languageCode: 'fr', language: 'French' }).parse(
      JSON.stringify({ lang_code: 'fr', lang: 'French', word: 'marche', senses: [{ glosses: ['walk'] }] }),
      'wiktionary',
    )
    expect(result.entries).toMatchObject([{ word: 'marche', definitions: ['walk'] }])
  })
})

describe('dictionary repositories and service', () => {
  it('merges duplicate headwords within a source but keeps sources separate and ordered', async () => {
    const repository = new InMemoryDictionaryRepository()
    await repository.saveMany([
      makeEntry('first', ' Word ', 'one'),
      makeEntry('first', 'word', 'two'),
    ], { id: 'first', name: 'First', format: 'test' })
    await repository.saveMany([makeEntry('second', 'WORD', 'other')], { id: 'second', name: 'Second', format: 'test' })

    await expect(repository.lookup('  WoＲd ')).resolves.toEqual([
      expect.objectContaining({ sourceId: 'first', definitions: ['one', 'two'] }),
      expect.objectContaining({ sourceId: 'second', definitions: ['other'] }),
    ])
    await expect(repository.listSources()).resolves.toEqual([
      { id: 'first', name: 'First', format: 'test' },
      { id: 'second', name: 'Second', format: 'test' },
    ])
  })

  it('merges repeated pronunciation and part-of-speech metadata idempotently', async () => {
    const repository = new InMemoryDictionaryRepository()
    const source = { id: 'metadata', name: 'Metadata', format: 'test' }
    const first = makeEntry('metadata', 'word', 'definition')
    const second = { ...first, pronunciation: 'wɜːd', partOfSpeech: 'noun' }
    const repeated = { ...first, pronunciation: 'wɜːd', partOfSpeech: 'noun' }

    await repository.saveMany([second], source)
    await repository.saveMany([repeated], source)
    await repository.saveMany([{ ...first, pronunciation: 'wɜːd / wɝːd', partOfSpeech: 'noun, verb' }], source)
    await expect(repository.lookup('word')).resolves.toMatchObject([{
      pronunciation: 'wɜːd / wɝːd',
      partOfSpeech: 'noun, verb',
    }])
  })

  it('orders sources by priority, then first import order', async () => {
    const repository = new InMemoryDictionaryRepository()
    await repository.saveMany([makeEntry('later', 'order', 'later')], { id: 'later', name: 'Later', format: 'test' })
    await repository.saveMany([makeEntry('priority', 'order', 'priority')], { id: 'priority', name: 'Priority', format: 'test', priority: 1 })
    await repository.saveMany([makeEntry('same-priority', 'order', 'same priority')], { id: 'same-priority', name: 'Same priority', format: 'test', priority: 1 })
    await repository.saveMany([makeEntry('highest', 'order', 'highest')], { id: 'highest', name: 'Highest', format: 'test', priority: 0 })

    await expect(repository.lookup('order')).resolves.toMatchObject([
      { sourceId: 'highest' },
      { sourceId: 'priority' },
      { sourceId: 'same-priority' },
      { sourceId: 'later' },
    ])
  })

  it('orders IndexedDB sources by priority, then first import order', async () => {
    const dbName = `dictionary-indexed-order-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const repository = new IndexedDbDictionaryRepository({ dbName })
    await repository.saveMany([makeEntry('later', 'order', 'later')], { id: 'later', name: 'Later', format: 'test' })
    await repository.saveMany([makeEntry('priority', 'order', 'priority')], { id: 'priority', name: 'Priority', format: 'test', priority: 1 })
    await repository.saveMany([makeEntry('same-priority', 'order', 'same priority')], { id: 'same-priority', name: 'Same priority', format: 'test', priority: 1 })
    await repository.saveMany([makeEntry('highest', 'order', 'highest')], { id: 'highest', name: 'Highest', format: 'test', priority: 0 })

    await expect(repository.lookup('order')).resolves.toMatchObject([
      { sourceId: 'highest' },
      { sourceId: 'priority' },
      { sourceId: 'same-priority' },
      { sourceId: 'later' },
    ])
    await expect(repository.listSources()).resolves.toMatchObject([
      { id: 'later' },
      { id: 'priority' },
      { id: 'same-priority' },
      { id: 'highest' },
    ])
    await repository.close()
  })

  it('merges repeated IndexedDB metadata idempotently', async () => {
    const dbName = `dictionary-indexed-metadata-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const repository = new IndexedDbDictionaryRepository({ dbName })
    const source = { id: 'metadata', name: 'Metadata', format: 'test' }
    const first = makeEntry('metadata', 'word', 'definition')

    await repository.saveMany([{ ...first, pronunciation: 'wɜːd', partOfSpeech: 'noun' }], source)
    await repository.saveMany([{ ...first, pronunciation: 'wɜːd', partOfSpeech: 'noun' }], source)
    await repository.saveMany([{ ...first, pronunciation: 'wɜːd / wɝːd', partOfSpeech: 'noun, verb' }], source)

    await expect(repository.lookup('word')).resolves.toMatchObject([{
      definitions: ['definition'],
      pronunciation: 'wɜːd / wɝːd',
      partOfSpeech: 'noun, verb',
    }])
    await repository.close()
  })

  it('rejects mixed-source batches when source metadata is supplied', async () => {
    const entries = [makeEntry('first', 'word', 'one'), makeEntry('second', 'word', 'two')]
    await expect(new InMemoryDictionaryRepository().saveMany(entries, {
      id: 'first', name: 'First', format: 'test',
    })).rejects.toThrow('belong to the supplied')

    const dbName = `dictionary-ownership-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const repository = new IndexedDbDictionaryRepository({ dbName })
    await expect(repository.saveMany(entries, {
      id: 'first', name: 'First', format: 'test',
    })).rejects.toThrow('belong to the supplied')
    await expect(repository.lookup('word')).resolves.toEqual([])
    await repository.close()
  })

  it('rejects blank source metadata and malformed parser results without saving input', async () => {
    const repository = new InMemoryDictionaryRepository()
    expect(() => new DictionaryService(repository, [{
      source: { id: 'source', name: ' ', format: 'test' },
      parser: new EijiroParser(),
    }])).toThrow('Invalid dictionary source registration')

    const parser = {
      parse: () => ({ entries: [{ sourceId: 'source', word: 'word', normalizedWord: 'wrong', definitions: [], examples: [] }], skipped: -1, errors: [] }),
    }
    const service = new DictionaryService(repository, [{
      source: { id: 'source', name: 'Source', format: 'test' }, parser,
    }])
    await expect(service.importText('source', 'sensitive input')).rejects.toThrow('invalid result')
    await expect(repository.lookup('word')).resolves.toEqual([])
  })

  it('rejects custom parser results with inconsistent skipped and error counts', async () => {
    const parser = {
      parse: () => ({ entries: [], skipped: 0, errors: [{ line: 1, message: 'input leaked' }] }),
    }
    const service = new DictionaryService(new InMemoryDictionaryRepository(), [{
      source: { id: 'source', name: 'Source', format: 'test' }, parser,
    }])

    await expect(service.importText('source', 'sensitive input')).rejects.toThrow('invalid result')
    await expect(service.lookup('word')).resolves.toEqual([])
  })

  it('normalizes source IDs, rejects duplicate registrations, and rejects cross-source parser output', async () => {
    const repository = new InMemoryDictionaryRepository()
    const parser = {
      parse: () => ({ entries: [makeEntry('other', 'word', 'wrong source')], skipped: 0, errors: [] }),
    }
    const service = new DictionaryService(repository, [{
      source: { id: ' source ', name: 'Source', format: 'test' },
      parser,
    }])

    expect(() => service.register({ source: eijiroSource, parser })).not.toThrow()
    expect(() => service.register({ source: { ...eijiroSource, id: ' eijiro ' }, parser })).toThrow('already registered')
    await expect(service.importText(' source ', 'input')).rejects.toThrow('source source')
    await expect(repository.lookup('word')).resolves.toEqual([])
  })

  it('returns import summaries, rejects unknown sources, and supports source-scoped clear', async () => {
    const service = new DictionaryService(new InMemoryDictionaryRepository(), [
      { source: eijiroSource, parser: new EijiroParser() },
      { source: wiktionarySource, parser: new WiktionaryJsonlParser() },
    ])
    await expect(service.importText('missing', 'secret input')).rejects.toThrow('Dictionary source is not registered: missing')
    await expect(service.importText(' eijiro ', '■word : meaning\ninvalid')).resolves.toMatchObject({ imported: 1, skipped: 1, errorCount: 1 })
    await service.importText('wiktionary', JSON.stringify({ lang_code: 'en', lang: 'English', word: 'word', senses: [{ glosses: ['gloss'] }] }))
    await service.clearSource(' eijiro ')
    await expect(service.lookup('word')).resolves.toMatchObject([{ sourceId: 'wiktionary' }])
  })

  it('repairs a misconfigured index and backfills normalizedWord during migration', async () => {
    const dbName = `dictionary-migration-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('dictionary', { keyPath: 'id' })
        store.createIndex('normalizedHeadword', 'word', { unique: true })
        store.put({
          id: '["legacy", "word"]', kind: 'entry', word: ' Word ', normalizedWord: 'stale', sourceId: 'legacy',
          definitions: ['meaning'], examples: [], order: 0,
        })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()

    const repository = new IndexedDbDictionaryRepository({ dbName })
    await expect(repository.lookup('word')).resolves.toMatchObject([{ normalizedWord: 'word' }])
    const repaired = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const store = repaired.transaction('dictionary', 'readonly').objectStore('dictionary')
    const index = store.index('normalizedHeadword')
    expect(index.keyPath).toBe('normalizedWord')
    expect(index.unique).toBe(false)
    repaired.close()
    await repository.close()
  })

  it('merges duplicate legacy records deterministically during IndexedDB repair', async () => {
    const dbName = `dictionary-duplicate-migration-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('dictionary', { keyPath: 'id' })
        store.createIndex('normalizedHeadword', 'normalizedWord', { unique: false })
        store.put({
          id: 'legacy-entry-second', kind: 'entry', word: 'word', normalizedWord: 'stale', sourceId: ' legacy ',
          definitions: ['second definition'], examples: ['second example'], pronunciation: 'wɝːd',
          partOfSpeech: 'verb', order: 2,
        })
        store.put({
          id: 'legacy-entry-first', kind: 'entry', word: ' Word ', sourceId: 'legacy',
          definitions: ['first definition'], examples: ['first example'], pronunciation: 'wɜːd',
          partOfSpeech: 'noun', order: 4,
        })
        store.put({
          id: 'source:legacy', kind: 'source', sourceId: 'legacy', name: 'Legacy', format: 'test', order: 0,
        })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()

    const repository = new IndexedDbDictionaryRepository({ dbName })
    await expect(repository.lookup('word')).resolves.toEqual([{
      word: 'word',
      normalizedWord: 'word',
      sourceId: 'legacy',
      definitions: ['second definition', 'first definition'],
      examples: ['second example', 'first example'],
      pronunciation: 'wɝːd / wɜːd',
      partOfSpeech: 'verb, noun',
    }])
    await expect(repository.listSources()).resolves.toEqual([
      { id: 'legacy', name: 'Legacy', format: 'test' },
    ])

    const repaired = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const request = repaired.transaction('dictionary', 'readonly').objectStore('dictionary').getAll()
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(records.filter((record) => (record as { kind?: string }).kind === 'entry')).toHaveLength(1)
    expect((records.find((record) => (record as { kind?: string }).kind === 'entry') as { order: number }).order).toBe(2)
    repaired.close()
    await repository.close()
  })

  it('repairs stale and missing normalizedWord values even when the legacy index shape is valid', async () => {
    const dbName = `dictionary-valid-index-migration-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 1)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('dictionary', { keyPath: 'id' })
        store.createIndex('normalizedHeadword', 'normalizedWord', { unique: false })
        store.put({
          id: '["legacy", "stale"]', kind: 'entry', word: ' Stale ', normalizedWord: 'wrong', sourceId: ' legacy ',
          definitions: ['meaning'], examples: [], order: 0,
        })
        store.put({
          id: '["legacy", "missing"]', kind: 'entry', word: 'Missing', sourceId: ' legacy ',
          definitions: ['another meaning'], examples: [], order: 1,
        })
        store.put({
          id: 'source: legacy ', kind: 'source', sourceId: ' legacy ', name: 'Legacy', format: 'test', order: 0,
        })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()

    const repository = new IndexedDbDictionaryRepository({ dbName })
    await expect(repository.lookup('stale')).resolves.toMatchObject([{ word: ' Stale ', normalizedWord: 'stale', sourceId: 'legacy' }])
    await expect(repository.lookup('missing')).resolves.toMatchObject([{ word: 'Missing', normalizedWord: 'missing', sourceId: 'legacy' }])
    await expect(repository.listSources()).resolves.toEqual([{ id: 'legacy', name: 'Legacy', format: 'test' }])
    await repository.clearSource(' legacy ')
    await expect(repository.lookup('stale')).resolves.toEqual([])
    await repository.close()
  })

  it('invalidates its cache on an external version change and reopens safely', async () => {
    const dbName = `dictionary-version-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const repository = new IndexedDbDictionaryRepository({ dbName })
    await repository.saveMany([makeEntry('source', 'word', 'meaning')], { id: 'source', name: 'Source', format: 'test' })

    const current = await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(dbName)
      request.onsuccess = () => {
        const version = request.result.version
        request.result.close()
        resolve(version)
      }
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(dbName, current + 1)
      request.onupgradeneeded = () => undefined
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    await expect(repository.lookup('word')).resolves.toMatchObject([{ sourceId: 'source' }])
    await repository.close()
  })

  it('reopens safely if a legacy repair connection is externally upgraded', async () => {
    const dbName = `dictionary-repair-version-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(dbName, 2)
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore('dictionary', { keyPath: 'id' })
        store.createIndex('normalizedHeadword', 'normalizedWord', { unique: false })
        store.put({
          id: 'legacy-entry', kind: 'entry', word: 'word', sourceId: 'source',
          definitions: ['meaning'], examples: [], order: 0,
        })
        store.put({ id: 'source:source', kind: 'source', sourceId: 'source', name: 'Source', format: 'test', order: 0 })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    database.close()

    const repository = new IndexedDbDictionaryRepository({ dbName })
    const lookup = repository.lookup('word')
    const externalUpgrade = new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(dbName, 3)
      request.onupgradeneeded = () => undefined
      request.onsuccess = () => {
        request.result.close()
        resolve()
      }
      request.onerror = () => reject(request.error)
    })

    await expect(lookup).resolves.toMatchObject([{ sourceId: 'source', definitions: ['meaning'] }])
    await externalUpgrade
    await expect(repository.lookup('word')).resolves.toMatchObject([{ sourceId: 'source' }])
    await repository.close()
  })

  it('recovers after close before the next operation', async () => {
    const dbName = `dictionary-close-test-${Date.now()}-${Math.random()}`
    databases.push(dbName)
    const repository = new IndexedDbDictionaryRepository({ dbName })
    await repository.saveMany([makeEntry('source', 'word', 'meaning')], { id: 'source', name: 'Source', format: 'test' })
    await repository.close()
    await expect(repository.lookup('word')).resolves.toMatchObject([{ sourceId: 'source' }])
    await repository.close()
  })

  it('round trips through the normalized-headword index, isolates users, and clears one source', async () => {
    const dbName = `dictionary-test-${Date.now()}-${Math.random()}`
    const alice = new IndexedDbDictionaryRepository({ dbName, userId: 'alice' })
    const bob = new IndexedDbDictionaryRepository({ dbName, userId: 'bob' })
    const secondSource: DictionarySource = { id: 'second', name: 'Second', format: 'test' }
    const firstSource: DictionarySource = { id: 'first', name: 'First', format: 'test' }
    await alice.saveMany([makeEntry('first', 'Persist', 'stored')], firstSource)
    await alice.saveMany([makeEntry('second', 'persist', 'other')], secondSource)
    await expect(alice.lookup('  PERSIST ')).resolves.toMatchObject([
      { sourceId: 'first', definitions: ['stored'] },
      { sourceId: 'second', definitions: ['other'] },
    ])
    await expect(alice.listSources()).resolves.toEqual([firstSource, secondSource])
    await expect(bob.lookup('persist')).resolves.toEqual([])

    const databaseName = namespaceDatabaseName(dbName, 'alice')
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    expect(database.transaction('dictionary', 'readonly').objectStore('dictionary').indexNames.contains('normalizedHeadword')).toBe(true)
    database.close()

    await alice.clearSource('first')
    await expect(alice.lookup('persist')).resolves.toMatchObject([{ sourceId: 'second' }])
    await alice.close()
    await bob.close()
    // Namespace names are intentionally derived by the shared helper; remove both databases.
    databases.push(databaseName)
    databases.push(namespaceDatabaseName(dbName, 'bob'))
  })
})
