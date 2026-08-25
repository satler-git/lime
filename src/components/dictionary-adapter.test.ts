import { describe, expect, it } from 'vitest'
import type { DictionaryEntry } from '../dictionary/types'
import { dictionaryAdapter } from './dictionary-adapter'

describe('dictionaryAdapter', () => {
  it('returns undefined for an empty or non-array result', () => {
    expect(dictionaryAdapter([], 'word')).toBeUndefined()
    expect(dictionaryAdapter(undefined, 'word')).toBeUndefined()
    expect(dictionaryAdapter({}, 'word')).toBeUndefined()
  })

  it('returns undefined when no entry matches the dictionary shape', () => {
    expect(dictionaryAdapter([{ word: 'word' }], 'word')).toBeUndefined()
  })

  it('adapts a single entry without sub-entries', () => {
    const entry: DictionaryEntry = {
      word: 'resilient',
      normalizedWord: 'resilient',
      sourceId: 'wiktionary',
      definitions: ['Able to recover quickly.'],
      examples: ['Small communities are resilient.'],
      pronunciation: '/rɪˈzɪliənt/',
      partOfSpeech: 'adjective',
    }

    const adapted = dictionaryAdapter([entry], 'resilient')

    expect(adapted).toMatchObject({
      word: 'resilient',
      pronunciation: '/rɪˈzɪliənt/',
      partOfSpeech: 'adjective',
      definition: 'Able to recover quickly.',
      examples: ['Small communities are resilient.'],
      inSrs: false,
    })
    expect(adapted?.entries).toBeUndefined()
  })

  it('adapts multiple entries into sub-entries', () => {
    const first: DictionaryEntry = {
      word: 'resilient',
      normalizedWord: 'resilient',
      sourceId: 'eijiro',
      definitions: ['回復力のある'],
      examples: ['She is resilient.'],
      pronunciation: '/rɪˈzɪliənt/',
      partOfSpeech: '形容詞',
    }
    const second: DictionaryEntry = {
      word: 'resilient',
      normalizedWord: 'resilient',
      sourceId: 'wiktionary',
      definitions: ['Able to recover quickly.', 'Strong and flexible.'],
      examples: ['The material is resilient.'],
      partOfSpeech: 'adjective',
    }

    const adapted = dictionaryAdapter([first, second], 'resilient')

    expect(adapted).toMatchObject({
      word: 'resilient',
      pronunciation: '/rɪˈzɪliənt/',
      partOfSpeech: '形容詞',
      definition: '回復力のある',
      examples: ['She is resilient.'],
      inSrs: false,
    })
    expect(adapted?.entries).toHaveLength(1)
    expect(adapted?.entries?.[0]).toMatchObject({
      pronunciation: '',
      partOfSpeech: 'adjective',
      definition: 'Able to recover quickly.; Strong and flexible.',
      examples: ['The material is resilient.'],
    })
  })

  it('exposes source identifiers from entries but keeps source names out of display data', () => {
    const first: DictionaryEntry = {
      word: 'run',
      normalizedWord: 'run',
      sourceId: 'eijiro',
      definitions: ['走る'],
      examples: [],
    }
    const second: DictionaryEntry = {
      word: 'run',
      normalizedWord: 'run',
      sourceId: 'wiktionary',
      definitions: ['To move quickly on foot.'],
      examples: [],
    }

    const adapted = dictionaryAdapter([first, second], 'run')

    expect(adapted).toBeDefined()
    expect(adapted?.entries).toHaveLength(1)
    expect(adapted).not.toHaveProperty('source')
    expect(adapted?.entries?.[0]).not.toHaveProperty('source')
    expect(adapted?.entries?.[0]).not.toHaveProperty('sourceId')
  })
})
