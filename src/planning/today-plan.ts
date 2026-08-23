import type { Card } from '../domain/card'
import { selectWords } from './word-selection'

export type TodayPlanInput = {
  dueCards: readonly Card[]
  newCards: readonly Card[]
  newLimit: number
  wordsPerCycle?: number
}

export type TodayPlan = {
  selectedCards: Card[]
  cycles: Card[][]
}

const DEFAULT_WORDS_PER_CYCLE = 15

const assertPositiveInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`)
  }
}

/** Partition cards into contiguous cycles without changing their order. */
export function partitionIntoCycles(cards: readonly Card[], wordsPerCycle = DEFAULT_WORDS_PER_CYCLE): Card[][] {
  assertPositiveInteger(wordsPerCycle, 'wordsPerCycle')

  const cycles: Card[][] = []
  for (let start = 0; start < cards.length; start += wordsPerCycle) {
    cycles.push(cards.slice(start, start + wordsPerCycle))
  }
  return cycles
}

/** Build a deterministic plan from already-classified due and new card pools. */
export function createTodayPlan({
  dueCards,
  newCards,
  newLimit,
  wordsPerCycle = DEFAULT_WORDS_PER_CYCLE,
}: TodayPlanInput): TodayPlan {
  const selectedCards = selectWords({ dueCards, newCards, newLimit })
  return {
    selectedCards,
    cycles: partitionIntoCycles(selectedCards, wordsPerCycle),
  }
}
