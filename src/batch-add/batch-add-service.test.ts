import { describe, expect, it } from 'vitest'
import { createCard } from '../domain/card'
import {
  EmptyBatchSelectionError,
  addSelectedWords,
  createBatchSelection,
  deriveBatchCandidates,
  normalizeBatchWord,
  toggleBatchSelection,
} from './index'
import type { Card } from '../domain/card'
import type { CardCreator } from './types'

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
    const state = createBatchSelection(deriveBatchCandidates([
      { word: 'Apple', lookupCount: 1 },
      { word: 'Berry', lookupCount: 1 },
    ]))
    const selected = toggleBatchSelection(state, ' apple ')
    const deselected = toggleBatchSelection(selected, 'APPLE')

    expect(state.selectedWords).toEqual([])
    expect(selected.selectedWords).toEqual(['apple'])
    expect(deselected.selectedWords).toEqual([])
  })
})

describe('batch card creation', () => {
  it('creates each selected unique word once in candidate order', async () => {
    const state = toggleBatchSelection(
      toggleBatchSelection(
        createBatchSelection(deriveBatchCandidates([
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
      create: async ({ word, now }) => {
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

  it('prevents creation with no selected words', async () => {
    const creator: CardCreator = { create: async ({ word }) => createCard(word) }
    const state = createBatchSelection([{ word: 'word', normalizedWord: normalizeBatchWord('word'), lookupCount: 1 }])

    await expect(addSelectedWords(state, creator)).rejects.toThrowError(EmptyBatchSelectionError)
  })
})
