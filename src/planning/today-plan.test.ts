import { describe, expect, it } from 'vitest'
import { createCard, type Card } from '../domain/card'
import { createTodayPlan, partitionIntoCycles } from './today-plan'
import { selectWords } from './word-selection'

const baseTime = new Date('2025-01-01T00:00:00.000Z')

const card = (id: string, due = baseTime): Card => ({
  ...createCard({ id, word: id, now: baseTime }),
  due: new Date(due),
})

describe('selectWords', () => {
  it('orders due cards by due time before adding new cards', () => {
    const dueCards = [
      card('due-late', new Date('2025-01-02T00:00:00.000Z')),
      card('due-early', new Date('2024-12-31T00:00:00.000Z')),
    ]
    const newCards = [card('new-first'), card('new-second')]

    expect(selectWords({ dueCards, newCards, newLimit: 2 }).map(({ id }) => id))
      .toEqual(['due-early', 'due-late', 'new-first', 'new-second'])
  })

  it('enforces the new-card limit while preserving new-card order', () => {
    const newCards = [card('new-first'), card('new-second'), card('new-third')]

    expect(selectWords({ dueCards: [], newCards, newLimit: 2 }).map(({ id }) => id))
      .toEqual(['new-first', 'new-second'])
  })

  it('removes duplicate IDs deterministically, with due cards taking precedence', () => {
    const dueCards = [
      card('shared', new Date('2025-01-03T00:00:00.000Z')),
      card('shared', new Date('2025-01-01T00:00:00.000Z')),
      card('due'),
    ]
    const newCards = [card('shared'), card('new-first'), card('new-first'), card('new-second')]

    expect(selectWords({ dueCards, newCards, newLimit: 3 }).map(({ id, due }) => [id, due.getTime()]))
      .toEqual([
        ['shared', new Date('2025-01-01T00:00:00.000Z').getTime()],
        ['due', baseTime.getTime()],
        ['new-first', baseTime.getTime()],
        ['new-second', baseTime.getTime()],
      ])
  })
})

describe('createTodayPlan', () => {
  it('partitions selected cards into contiguous cycles and defaults to 15 words', () => {
    const dueCards = Array.from({ length: 16 }, (_, index) => card(`due-${index}`))
    const newCards = [card('new-0')]
    const plan = createTodayPlan({ dueCards, newCards, newLimit: 1 })

    expect(plan.selectedCards.map(({ id }) => id)).toEqual([
      ...Array.from({ length: 16 }, (_, index) => `due-${index}`),
      'new-0',
    ])
    expect(plan.cycles.map((cycle) => cycle.length)).toEqual([15, 2])
    expect(plan.cycles.flat().map(({ id }) => id)).toEqual(plan.selectedCards.map(({ id }) => id))
  })

  it('returns empty selections and cycles for empty inputs', () => {
    expect(createTodayPlan({ dueCards: [], newCards: [], newLimit: 4 }))
      .toEqual({ selectedCards: [], cycles: [] })
  })

  it('does not mutate input arrays or cards', () => {
    const dueCards = [card('due-late', new Date('2025-01-02T00:00:00.000Z')), card('due-early')]
    const newCards = [card('new-first'), card('new-second')]
    const before = structuredClone({ dueCards, newCards })

    createTodayPlan({ dueCards, newCards, newLimit: 1, wordsPerCycle: 1 })

    expect({ dueCards, newCards }).toEqual(before)
  })
})

describe('partitionIntoCycles', () => {
  it('keeps the selected order with the configured cycle size', () => {
    const cards = [card('one'), card('two'), card('three'), card('four'), card('five')]

    expect(partitionIntoCycles(cards, 2).map((cycle) => cycle.map(({ id }) => id)))
      .toEqual([['one', 'two'], ['three', 'four'], ['five']])
  })
})
