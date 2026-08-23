export type CardId = string

export type CardState = 'new' | 'learning' | 'review' | 'relearning'

export type Rating = 'again' | 'hard' | 'good' | 'easy'

/** The application-owned representation of a card's FSRS memory. */
export type Card = {
  id: CardId
  word: string
  createdAt: Date
  due: Date
  stability: number
  difficulty: number
  elapsedDays: number
  scheduledDays: number
  learningSteps: number
  reps: number
  lapses: number
  state: CardState
  lastReview?: Date
}

export type NewCard = {
  word: string
  id?: CardId
  now?: Date
}

const createId = (): CardId => {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID()
  }

  return `card-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Create an unreviewed card without introducing any scheduling dependency. */
export function createCard(input: NewCard): Card
export function createCard(word: string, id?: CardId, now?: Date): Card
export function createCard(
  inputOrWord: NewCard | string,
  id?: CardId,
  now: Date = new Date(),
): Card {
  const input = typeof inputOrWord === 'string'
    ? { word: inputOrWord, id, now }
    : inputOrWord
  const createdAt = new Date(input.now?.getTime() ?? Date.now())

  if (input.word.trim().length === 0) {
    throw new Error('A card word is required')
  }

  return {
    id: input.id ?? createId(),
    word: input.word,
    createdAt,
    due: new Date(createdAt),
    stability: 0,
    difficulty: 0,
    elapsedDays: 0,
    scheduledDays: 0,
    learningSteps: 0,
    reps: 0,
    lapses: 0,
    state: 'new',
  }
}

/** Copy dates as well as scalar properties so review results are safe to undo. */
export function cloneCard(card: Card): Card {
  return {
    ...card,
    createdAt: new Date(card.createdAt),
    due: new Date(card.due),
    ...(card.lastReview === undefined ? {} : { lastReview: new Date(card.lastReview) }),
  }
}
