import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CardService } from './application/card-service'
import { cloneCard, createCard, type Card } from './domain/card'
import { IndexedDbCardRepository } from './persistence/indexed-db-card-repository'
import type { CardRepository } from './repositories/card-repository'
import { FsrsScheduler } from './scheduling/fsrs-scheduler'

const baseTime = new Date('2025-01-01T00:00:00.000Z')
let repository: IndexedDbCardRepository | undefined
let databaseName: string | undefined

const makeRepository = (): IndexedDbCardRepository => {
  databaseName = `lime-test-${Date.now()}-${Math.random()}`
  repository = new IndexedDbCardRepository({ dbName: databaseName })
  return repository
}

afterEach(async () => {
  await repository?.close()
  if (databaseName !== undefined) {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase(databaseName as string)
      request.onsuccess = () => resolve()
      request.onerror = () => reject(request.error)
      request.onblocked = () => resolve()
    })
  }
  repository = undefined
  databaseName = undefined
})

describe('card domain', () => {
  it('rejects cards without a word', () => {
    expect(() => createCard({ word: '   ', now: baseTime })).toThrowError('A card word is required')
  })

  it('applies default values and uses the requested date', () => {
    const card = createCard({ id: 'defaults', word: 'default', now: baseTime })

    expect(card).toMatchObject({
      id: 'defaults',
      word: 'default',
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: 0,
      lapses: 0,
      state: 'new',
    })
    expect(card.lastReview).toBeUndefined()
    expect(card.createdAt).toEqual(baseTime)
    expect(card.due).toEqual(baseTime)
    expect(card.createdAt).not.toBe(baseTime)
    expect(card.due).not.toBe(card.createdAt)
  })

  it('clones date fields defensively', () => {
    const card: Card = {
      ...createCard({ id: 'clone', word: 'clone', now: baseTime }),
      due: new Date('2025-01-03T00:00:00.000Z'),
      lastReview: new Date('2025-01-02T00:00:00.000Z'),
    }

    const cloned = cloneCard(card)

    expect(cloned).toEqual(card)
    expect(cloned).not.toBe(card)
    expect(cloned.createdAt).not.toBe(card.createdAt)
    expect(cloned.due).not.toBe(card.due)
    expect(cloned.lastReview).not.toBe(card.lastReview)

    cloned.createdAt.setUTCDate(4)
    cloned.due.setUTCDate(5)
    cloned.lastReview?.setUTCDate(6)

    expect(card.createdAt).toEqual(baseTime)
    expect(card.due).toEqual(new Date('2025-01-03T00:00:00.000Z'))
    expect(card.lastReview).toEqual(new Date('2025-01-02T00:00:00.000Z'))
  })
})

describe('CardService', () => {
  it('delegates due-card lookup to the repository', async () => {
    const now = new Date('2025-01-02T00:00:00.000Z')
    const dueCards = [createCard({ id: 'due', word: 'due', now })]
    const getDue = vi.fn(async (requestedNow: Date) => {
      expect(requestedNow).toBe(now)
      return dueCards
    })
    const cardRepository: CardRepository = {
      save: async () => {},
      load: async () => null,
      loadAll: async () => [],
      getDue,
      restore: async () => {},
    }

    const service = new CardService(cardRepository)

    await expect(service.getDueCards(now)).resolves.toBe(dueCards)
    expect(getDue).toHaveBeenCalledTimes(1)
    expect(getDue).toHaveBeenCalledWith(now)
  })
})

describe('FSRS scheduling adapter', () => {
  it('schedules the first good review through FSRS', () => {
    const card = createCard({ id: 'first-review', word: 'schedule', now: baseTime })
    const result = new FsrsScheduler().review(card, 'good', baseTime)

    expect(result.previous).toEqual(card)
    expect(result.next.state).toBe('learning')
    expect(result.next.due).toEqual(new Date('2025-01-01T00:10:00.000Z'))
    expect(result.next.reps).toBe(1)
    expect(result.next.lastReview).toEqual(baseTime)
  })
})

describe('IndexedDB card repository', () => {
  it('round trips a card with dates and FSRS state intact', async () => {
    const card: Card = {
      ...createCard({ id: 'round-trip', word: 'persist', now: baseTime }),
      due: new Date('2025-01-03T00:00:00.000Z'),
      stability: 2.5,
      difficulty: 4,
      elapsedDays: 2,
      scheduledDays: 2,
      learningSteps: 1,
      reps: 3,
      lapses: 1,
      state: 'review',
      lastReview: new Date('2025-01-02T00:00:00.000Z'),
    }
    const cardRepository = makeRepository()

    await cardRepository.save(card)

    await expect(cardRepository.load(card.id)).resolves.toEqual(card)
  })

  it('returns only cards due at the requested time, ordered by due date', async () => {
    const cardRepository = makeRepository()
    const dueLater = { ...createCard({ id: 'later', word: 'later', now: baseTime }), due: new Date('2025-01-01T12:00:00.000Z') }
    const dueNow = { ...createCard({ id: 'now', word: 'now', now: baseTime }), due: baseTime }
    const overdue = { ...createCard({ id: 'overdue', word: 'overdue', now: baseTime }), due: new Date('2024-12-31T23:00:00.000Z') }

    await Promise.all([cardRepository.save(dueLater), cardRepository.save(dueNow), cardRepository.save(overdue)])

    await expect(cardRepository.getDue(new Date('2025-01-01T00:00:00.000Z')))
      .resolves.toEqual([overdue, dueNow])
  })
})

describe('card review and restore', () => {
  it('restores the previous card state after a review', async () => {
    const cardRepository = makeRepository()
    const service = new CardService(cardRepository, new FsrsScheduler())
    const card = await service.create({ id: 'undo', word: 'restore', now: baseTime })

    const result = await service.review(card.id, 'good', baseTime)
    expect(await cardRepository.load(card.id)).toEqual(result.next)

    await service.restore(result.previous)

    await expect(cardRepository.load(card.id)).resolves.toEqual(result.previous)
  })
})
