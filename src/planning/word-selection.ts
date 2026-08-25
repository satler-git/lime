import type { Card } from '../domain/card'

export type WordSelectionInput = {
  dueCards: readonly Card[]
  newCards: readonly Card[]
  newLimit: number
  reviewLimit?: number
}

const assertNonNegativeInteger = (value: number, name: string): void => {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`)
  }
}

/**
 * Select due cards first, followed by new cards in their supplied order.
 * The first occurrence of a card ID wins, including when a new card also
 * appears in the due-card list.
 */
export function selectWords({ dueCards, newCards, newLimit, reviewLimit }: WordSelectionInput): Card[] {
  assertNonNegativeInteger(newLimit, 'newLimit')

  if (reviewLimit !== undefined) {
    assertNonNegativeInteger(reviewLimit, 'reviewLimit')
  }

  const orderedDueCards = dueCards
    .map((card, index) => ({ card, index }))
    .sort((a, b) => a.card.due.getTime() - b.card.due.getTime() || a.index - b.index)

  const selected: Card[] = []
  const selectedIds = new Set<string>()

  for (const { card } of orderedDueCards) {
    if (reviewLimit !== undefined && selected.length >= reviewLimit) {
      break
    }
    if (!selectedIds.has(card.id)) {
      selectedIds.add(card.id)
      selected.push(card)
    }
  }

  let selectedNewCount = 0
  for (const card of newCards) {
    if (selectedNewCount >= newLimit) {
      break
    }
    if (selectedIds.has(card.id)) {
      continue
    }

    selectedIds.add(card.id)
    selected.push(card)
    selectedNewCount += 1
  }

  return selected
}
