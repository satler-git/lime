import { describe, expect, it } from 'vitest'
import { createCard } from '../domain/card'
import { normalizeWord } from '../domain/word'
import {
  BatchSelectionError,
  EmptyBatchSelectionError,
  addSelectedWords,
  createBatchSelection,
  deriveBatchCandidates,
  getBatchCandidateFingerprint,
  toggleBatchSelection,
} from './index'
import type { Card } from '../domain/card'
import type { BatchSelectionState, CardCreator } from './types'

const lookupEvents = (words: Array<{ word: string; inSrs?: boolean }>) => words.map((item, index) => ({
  id: `lookup-${index}`,
  word: item.word,
  source: 'article' as const,
  position: { paragraph: 0, character: index },
  timestamp: new Date('2025-04-01T12:00:00.000Z'),
  inSrs: item.inSrs ?? false,
}))

describe('batch candidate derivation and selection', () => {
  it('deduplicates supplied candidates, preserves first spelling/order, and sums counts', () => {
    expect(deriveBatchCandidates([
      { word: ' First ', lookupCount: 2 },
      { word: 'first', lookupCount: 3 },
      { word: 'Second', lookupCount: 1 },
    ])).toEqual([
      { word: 'First', normalizedWord: 'first', lookupCount: 5 },
      { word: 'Second', normalizedWord: 'second', lookupCount: 1 },
    ])
  })

  it('derives only unregistered session lookups in first-seen order', () => {
    const session = {
      id: 'session-1',
      cardIds: [],
      status: 'completed' as const,
      createdAt: new Date('2025-04-01T12:00:00.000Z'),
      lookupEvents: lookupEvents([
        { word: "Don't" },
        { word: 'don’t' },
        { word: 'Known', inSrs: true },
        { word: 'new word' },
      ]),
    }

    expect(deriveBatchCandidates(session)).toEqual([
      { word: "Don't", normalizedWord: "don't", lookupCount: 2 },
      { word: 'new word', normalizedWord: 'new word', lookupCount: 1 },
    ])
  })

  it('selects and deselects by normalized word without mutating the prior state', () => {
    const state = createBatchSelection('session-1', deriveBatchCandidates([
      { word: 'Apple', lookupCount: 1 },
      { word: 'Berry', lookupCount: 1 },
    ]))
    const selected = toggleBatchSelection(state, ' apple ')
    const deselected = toggleBatchSelection(selected, 'APPLE')

    expect(state.selectedWords).toEqual([])
    expect(selected.selectedWords).toEqual(['apple'])
    expect(deselected.selectedWords).toEqual([])
  })

  it('creates a session-bound selection with a candidate fingerprint', () => {
    const selection = createBatchSelection('session-1', [
      { word: 'First', normalizedWord: 'first', lookupCount: 1 },
    ])

    expect(selection).toEqual({
      sessionId: 'session-1',
      candidateFingerprint: '[{"word":"First","normalizedWord":"first","lookupCount":1}]',
      candidates: [{ word: 'First', normalizedWord: 'first', lookupCount: 1 }],
      selectedWords: [],
    })
  })

  it('strictly validates and preserves canonical candidate payloads', () => {
    const candidates = [
      { word: 'First', normalizedWord: 'first', lookupCount: 1 },
      { word: 'SECOND', normalizedWord: 'second', lookupCount: 2 },
    ]
    const selection = createBatchSelection('session-1', candidates)

    expect(selection.candidates).toEqual(candidates)
    expect(selection.candidates).not.toBe(candidates)
    expect(() => createBatchSelection('session-1', [
      { word: ' First', normalizedWord: 'first', lookupCount: 1 },
    ])).toThrowError('word must be trimmed')
    expect(() => createBatchSelection('session-1', [
      { word: 'First', normalizedWord: 'not-first', lookupCount: 1 },
    ])).toThrowError('normalizedWord must match')
    expect(() => createBatchSelection('session-1', [
      { word: '   ', normalizedWord: '', lookupCount: 1 },
    ])).toThrowError('word must be nonempty')
    expect(() => createBatchSelection('session-1', [
      { word: 'First', normalizedWord: 'first', lookupCount: 0 },
    ])).toThrowError('lookupCount must be a positive integer')
    expect(() => createBatchSelection('session-1', [
      { word: 'First', normalizedWord: 'first', lookupCount: 1 },
      { word: 'FIRST', normalizedWord: 'first', lookupCount: 1 },
    ])).toThrowError('unique normalized words')
  })

  it('rejects duplicate selected words in an otherwise canonical state', () => {
    const selection = createBatchSelection('session-1', [
      { word: 'First', normalizedWord: 'first', lookupCount: 1 },
    ])
    const invalid = { ...selection, selectedWords: ['first', 'first'] }

    expect(() => toggleBatchSelection(invalid, 'first')).toThrowError('Selected word is duplicated')
  })

  it('rejects malformed candidate payloads with BatchSelectionError before fingerprinting', () => {
    const selection = createBatchSelection('session-1', [
      { word: 'First', normalizedWord: 'first', lookupCount: 1 },
    ])
    const invalid = { ...selection, candidates: [null] } as unknown as BatchSelectionState

    expect(() => toggleBatchSelection(invalid, 'first')).toThrowError(BatchSelectionError)
  })
})

describe('batch card creation', () => {
  it('creates each selected unique word once in candidate order', async () => {
    const state = toggleBatchSelection(
      toggleBatchSelection(
        createBatchSelection('session-1', deriveBatchCandidates([
          { word: 'First', lookupCount: 2 },
          { word: 'first', lookupCount: 1 },
          { word: 'Second', lookupCount: 1 },
        ])),
        'SECOND',
      ),
      'first',
    )
    const createdInputs: string[] = []
    const creator: CardCreator = {
      findByWord: async () => null,
      create: async ({ word, now }) => {
        createdInputs.push(word)
        return createCard({ word, now })
      },
      createIfAbsent: async ({ word, now }) => {
        createdInputs.push(word)
        return createCard({ word, now })
      },
    }

    const cards = await addSelectedWords(state, creator, {
      clock: () => new Date('2025-04-01T12:00:00.000Z'),
    })

    expect(createdInputs).toEqual(['First', 'Second'])
    expect(cards).toHaveLength(2)
    expect(cards.map((card: Card) => card.word)).toEqual(['First', 'Second'])
    expect(cards[0].createdAt).toEqual(new Date('2025-04-01T12:00:00.000Z'))
  })

  it('reuses existing cards when a batch is added repeatedly', async () => {
    const cards = new Map<string, Card>()
    const creator: CardCreator = {
      findByWord: async (word) => cards.get(normalizeWord(word)) ?? null,
      create: async ({ word }) => {
        const card = createCard(word)
        cards.set(normalizeWord(word), card)
        return card
      },
      createIfAbsent: async ({ word }) => {
        const existing = cards.get(normalizeWord(word))
        if (existing !== undefined) return existing
        const card = createCard(word)
        cards.set(normalizeWord(word), card)
        return card
      },
    }
    const state = toggleBatchSelection(
      toggleBatchSelection(createBatchSelection('session-1', deriveBatchCandidates([
        { word: 'First', lookupCount: 1 },
        { word: 'Second', lookupCount: 1 },
      ])), 'second'),
      'first',
    )

    const first = await addSelectedWords(state, creator)
    const second = await addSelectedWords(state, creator)

    expect(first.map((card) => card.id)).toEqual(second.map((card) => card.id))
    expect(cards).toHaveLength(2)
  })

  it('stops on creator failure and leaves earlier successful cards available for retry', async () => {
    const createdInputs: string[] = []
    const failure = new Error('creator failed')
    const cards = new Map<string, Card>()
    let failSecond = true
    const creator: CardCreator = {
      findByWord: async (word) => cards.get(normalizeWord(word)) ?? null,
      create: async ({ word }) => {
        createdInputs.push(word)
        const card = createCard(word)
        cards.set(normalizeWord(word), card)
        return card
      },
      createIfAbsent: async ({ word }) => {
        const existing = cards.get(normalizeWord(word))
        if (existing !== undefined) return existing
        createdInputs.push(word)
        if (word === 'Second' && failSecond) {
          failSecond = false
          throw failure
        }
        const card = createCard(word)
        cards.set(normalizeWord(word), card)
        return card
      },
    }
    const state = toggleBatchSelection(
      toggleBatchSelection(createBatchSelection('session-1', deriveBatchCandidates([
        { word: 'First', lookupCount: 1 },
        { word: 'Second', lookupCount: 1 },
        { word: 'Third', lookupCount: 1 },
      ])), 'third'),
      'second',
    )
    const selected = toggleBatchSelection(state, 'first')

    await expect(addSelectedWords(selected, creator)).rejects.toBe(failure)
    expect(createdInputs).toEqual(['First', 'Second'])
    expect(cards.has('first')).toBe(true)
    expect(cards.has('third')).toBe(false)

    const retried = await addSelectedWords(selected, creator)
    expect(createdInputs).toEqual(['First', 'Second', 'Second', 'Third'])
    expect(retried.map((card) => card.word)).toEqual(['First', 'Second', 'Third'])
  })

  it('uses and reuses the required atomic createIfAbsent operation', async () => {
    const cards = new Map<string, Card>()
    let atomicCalls = 0
    const creator: CardCreator = {
      create: async () => { throw new Error('create should not be called directly') },
      findByWord: async () => { throw new Error('findByWord should not be called directly') },
      createIfAbsent: async ({ word }) => {
        atomicCalls += 1
        const normalized = normalizeWord(word)
        const existing = cards.get(normalized)
        if (existing !== undefined) return existing
        const card = createCard(word)
        cards.set(normalized, card)
        return card
      },
    }
    let state = createBatchSelection('session-1', deriveBatchCandidates([
      { word: 'First', lookupCount: 1 },
    ]))
    state = toggleBatchSelection(state, 'first')

    const first = await addSelectedWords(state, creator)
    const second = await addSelectedWords(state, creator)

    expect(atomicCalls).toBe(2)
    expect(second[0].id).toBe(first[0].id)
  })

  it('rejects a selection whose candidate payload was mutated', async () => {
    let state = createBatchSelection('session-1', deriveBatchCandidates([
      { word: 'First', lookupCount: 1 },
    ]))
    state = toggleBatchSelection(state, 'first')
    ;(state.candidates as unknown as Array<{ word: string }>)[0].word = 'Changed'
    const creator: CardCreator = {
      create: async ({ word }) => createCard(word),
      findByWord: async () => null,
      createIfAbsent: async ({ word }) => createCard(word),
    }

    await expect(addSelectedWords(state, creator)).rejects.toThrowError(BatchSelectionError)
  })

  it('rejects selected words that are not normalized candidates', async () => {
    const candidates = deriveBatchCandidates([{ word: 'First', lookupCount: 1 }])
    const state = {
      ...createBatchSelection('session-1', candidates),
      selectedWords: ['FIRST'],
    }
    const creator: CardCreator = {
      create: async ({ word }) => createCard(word),
      findByWord: async () => null,
      createIfAbsent: async ({ word }) => createCard(word),
    }

    await expect(addSelectedWords(state, creator)).rejects.toThrowError('not a normalized candidate')
  })

  it('exports a fingerprint that reflects candidate order and payload', () => {
    const candidates = deriveBatchCandidates([
      { word: 'First', lookupCount: 1 },
      { word: 'Second', lookupCount: 2 },
    ])
    expect(getBatchCandidateFingerprint(candidates)).toBe(
      '[{"word":"First","normalizedWord":"first","lookupCount":1},{"word":"Second","normalizedWord":"second","lookupCount":2}]',
    )
  })

  it('prevents creation with no selected words', async () => {
    const creator: CardCreator = {
      create: async ({ word }) => createCard(word),
      findByWord: async () => null,
      createIfAbsent: async ({ word }) => createCard(word),
    }
    const state = createBatchSelection('session-1', [{ word: 'word', normalizedWord: normalizeWord('word'), lookupCount: 1 }])

    await expect(addSelectedWords(state, creator)).rejects.toThrowError(EmptyBatchSelectionError)
  })
})
