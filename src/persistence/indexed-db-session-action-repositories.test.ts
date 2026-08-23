import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import { createCard, type Card } from '../domain/card'
import type { ReadingSession } from '../session/types'
import { IndexedDbCardRepository } from './indexed-db-card-repository'
import { IndexedDbReadingSessionRepository } from './indexed-db-reading-session-repository'
import { IndexedDbReviewActionRepository } from './indexed-db-review-action-repository'
import { namespaceDatabaseName } from './indexed-db-persistence-helpers'
import type { ReviewAction } from '../review/types'

const baseTime = new Date('2025-01-01T00:00:00.000Z')
const openedRepositories: Array<{ close: () => Promise<void> }> = []
const databaseNames = new Set<string>()

const uniqueDatabaseName = (kind: string): string => {
  const name = `lime-${kind}-test-${Date.now()}-${Math.random()}`
  databaseNames.add(name)
  return name
}

const removeDatabase = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name)
  request.onsuccess = () => resolve()
  request.onerror = () => reject(request.error)
  request.onblocked = () => resolve()
})

const upgradeDatabase = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.open(name, 2)
  request.onupgradeneeded = () => {}
  request.onsuccess = () => {
    request.result.close()
    resolve()
  }
  request.onerror = () => reject(request.error)
  request.onblocked = () => reject(new Error('IndexedDB upgrade was blocked'))
})

// Simulate a legacy/non-canonical persisted timestamp. The public save path
// intentionally canonicalizes dates, so this exercises the repository's read
// ordering against data that may already exist in IndexedDB.
const rewritePersistedTimestamp = (name: string, id: string, timestamp: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.open(name)
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const database = request.result
    const transaction = database.transaction('review-actions', 'readwrite')
    const store = transaction.objectStore('review-actions')
    const lookup = store.get(id)
    lookup.onsuccess = () => {
      if (lookup.result === undefined) {
        database.close()
        reject(new Error(`Could not find action ${id}`))
        return
      }
      lookup.result.timestamp = timestamp
      store.put(lookup.result)
    }
    lookup.onerror = () => reject(lookup.error)
    transaction.oncomplete = () => {
      database.close()
      resolve()
    }
    transaction.onerror = () => {
      database.close()
      reject(transaction.error)
    }
    transaction.onabort = () => {
      database.close()
      reject(transaction.error ?? new Error('Timestamp rewrite aborted'))
    }
  }
})

afterEach(async () => {
  for (const repository of openedRepositories.splice(0)) {
    await repository.close()
  }
  for (const name of databaseNames) {
    await removeDatabase(name)
  }
  databaseNames.clear()
})

const makeSession = (): ReadingSession => ({
  id: 'session-round-trip',
  cardIds: ['card-a', 'card-b'],
  status: 'completed',
  createdAt: new Date(baseTime),
  startedAt: new Date('2025-01-01T00:01:00.000Z'),
  quizStartedAt: new Date('2025-01-01T00:03:00.000Z'),
  completedAt: new Date('2025-01-01T00:04:00.000Z'),
  abandonedAt: undefined,
  lookupEvents: [
    {
      id: 'lookup-a',
      word: 'alpha',
      source: 'article',
      position: { paragraph: 1, character: 2 },
      timestamp: new Date('2025-01-01T00:02:00.000Z'),
      inSrs: false,
    },
    {
      id: 'lookup-b',
      word: 'beta',
      source: 'example',
      position: { paragraph: 3, character: 4 },
      timestamp: new Date('2025-01-01T00:02:30.000Z'),
      inSrs: true,
    },
  ],
})

const makeCard = (id: string, word: string, now: Date): Card => ({
  ...createCard({ id, word, now }),
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
})

const makeAction = (
  id: string,
  timestamp: Date,
  options: { sessionId?: string; cardId?: string; undone?: boolean } = {},
): ReviewAction => ({
  id,
  sessionId: options.sessionId ?? 'session-1',
  cardId: options.cardId ?? 'card-1',
  rating: 'good',
  timestamp: new Date(timestamp),
  previousState: makeCard(`${id}-previous`, 'before', baseTime),
  nextState: makeCard(`${id}-next`, 'after', baseTime),
  undone: options.undone ?? false,
  ...(options.undone ? { undoneAt: new Date('2025-01-01T00:10:00.000Z') } : {}),
})

describe('IndexedDbReadingSessionRepository', () => {
  it('round trips every session date and lookup event', async () => {
    const repository = new IndexedDbReadingSessionRepository({ dbName: uniqueDatabaseName('sessions') })
    openedRepositories.push(repository)
    const session = makeSession()

    await repository.save(session)
    const loaded = await repository.load(session.id)

    expect(loaded).toEqual(session)
    expect(loaded?.createdAt).toBeInstanceOf(Date)
    expect(loaded?.startedAt).toBeInstanceOf(Date)
    expect(loaded?.quizStartedAt).toBeInstanceOf(Date)
    expect(loaded?.completedAt).toBeInstanceOf(Date)
    expect(loaded?.abandonedAt).toBeUndefined()
    expect(loaded?.lookupEvents[0].timestamp).toBeInstanceOf(Date)
  })

  it('isolates lookup event dates and positions from each other and from later loads', async () => {
    const repository = new IndexedDbReadingSessionRepository({ dbName: uniqueDatabaseName('lookup') })
    openedRepositories.push(repository)
    const sharedDate = new Date(baseTime)
    const session: ReadingSession = {
      ...makeSession(),
      createdAt: sharedDate,
      lookupEvents: makeSession().lookupEvents.map((event) => ({ ...event, timestamp: sharedDate })),
    }

    await repository.save(session)
    const loaded = await repository.load(session.id)
    expect(loaded).not.toBeNull()
    expect(loaded?.createdAt).not.toBe(loaded?.lookupEvents[0].timestamp)
    expect(loaded?.lookupEvents[0].timestamp).not.toBe(loaded?.lookupEvents[1].timestamp)
    expect(loaded?.lookupEvents[0].position).not.toBe(loaded?.lookupEvents[1].position)

    if (loaded === null) throw new Error('Expected a stored session')
    loaded.lookupEvents[0].timestamp.setUTCDate(9)
    loaded.lookupEvents[0].position.character = 99

    await expect(repository.load(session.id)).resolves.toEqual(session)
  })
})

describe('IndexedDbReviewActionRepository', () => {
  it('round trips action dates and nested card snapshot dates independently', async () => {
    const repository = new IndexedDbReviewActionRepository({ dbName: uniqueDatabaseName('actions') })
    openedRepositories.push(repository)
    const action = makeAction('action-round-trip', new Date('2025-01-01T00:05:00.000Z'))

    await repository.save(action)
    const loaded = await repository.load(action.id)

    expect(loaded).toEqual(action)
    expect(loaded?.timestamp).toBeInstanceOf(Date)
    expect(loaded?.previousState.createdAt).toBeInstanceOf(Date)
    expect(loaded?.previousState.due).toBeInstanceOf(Date)
    expect(loaded?.previousState.lastReview).toBeInstanceOf(Date)
    expect(loaded?.nextState.createdAt).toBeInstanceOf(Date)
    expect(loaded?.undoneAt).toBeUndefined()
    expect(loaded?.previousState.createdAt).not.toBe(loaded?.nextState.createdAt)

    loaded?.previousState.due.setUTCDate(9)
    loaded?.timestamp.setUTCDate(9)
    await expect(repository.load(action.id)).resolves.toEqual(action)
  })

  it('finds the latest timestamp and ignores undone actions', async () => {
    const repository = new IndexedDbReviewActionRepository({ dbName: uniqueDatabaseName('latest') })
    openedRepositories.push(repository)
    const latest = makeAction('action-latest', new Date('2025-01-01T00:03:00.000Z'))
    const middle = makeAction('action-middle', new Date('2025-01-01T00:02:00.000Z'))
    const undone = makeAction('action-undone', new Date('2025-01-01T00:04:00.000Z'), { undone: true })
    const otherCard = makeAction('action-other-card', new Date('2025-01-01T00:10:00.000Z'), { cardId: 'card-other' })

    // Deliberately save out of timestamp order; lookup must not use key order.
    await repository.save(latest)
    await repository.save(undone)
    await repository.save(middle)
    await repository.save(otherCard)

    await expect(repository.findLatestNonUndone('session-1', 'card-1')).resolves.toEqual(latest)
    await expect(repository.findLatestNonUndone('session-missing', 'card-1')).resolves.toBeNull()

    await repository.save({ ...latest, undone: true, undoneAt: new Date('2025-01-01T00:05:00.000Z') })
    await expect(repository.findLatestNonUndone('session-1', 'card-1')).resolves.toEqual(middle)
  })

  it('uses action ID ordering for equal timestamps', async () => {
    const repository = new IndexedDbReviewActionRepository({ dbName: uniqueDatabaseName('equal-timestamp') })
    openedRepositories.push(repository)
    const timestamp = new Date('2025-01-01T00:05:00.000Z')
    const higherId = makeAction('action-z', timestamp)
    const lowerId = makeAction('action-a', timestamp)

    // Save in reverse ID order to prove insertion order is not the tie-breaker.
    await repository.save(higherId)
    await repository.save(lowerId)

    await expect(repository.findLatestNonUndone('session-1', 'card-1')).resolves.toEqual(higherId)
  })

  it('orders non-canonical persisted timestamps by parsed time', async () => {
    const dbName = uniqueDatabaseName('parsed-timestamp')
    const repository = new IndexedDbReviewActionRepository({ dbName })
    openedRepositories.push(repository)
    const earlier = makeAction('action-earlier', new Date('2025-01-01T00:00:00.000Z'))
    const later = makeAction('action-later', new Date('2025-01-01T00:30:00.000Z'))

    await repository.save(earlier)
    await repository.save(later)
    // This represents the same instant as the earlier action but sorts after
    // the later action as a string. Date.parse must choose the later instant.
    await rewritePersistedTimestamp(dbName, earlier.id, '2025-01-01T01:00:00+01:00')

    await expect(repository.findLatestNonUndone('session-1', 'card-1')).resolves.toMatchObject({ id: later.id })
  })
})

describe('IndexedDB database naming', () => {
  it('keeps omitted-user names unchanged and avoids delimiter collisions', () => {
    expect(namespaceDatabaseName('lime')).toBe('lime')
    expect(namespaceDatabaseName('base--user-a', 'b'))
      .not.toBe(namespaceDatabaseName('base', 'a--user-b'))
    expect(namespaceDatabaseName('base:a', 'b:c'))
      .not.toBe(namespaceDatabaseName('base', 'a:b:c'))
  })

  it('reserves the generated prefix to prevent namespaced/omitted-user collisions', () => {
    const namespacedName = namespaceDatabaseName('base', 'user')

    expect(() => namespaceDatabaseName(namespacedName)).toThrowError(
      'Unscoped database name cannot start with reserved prefix',
    )
  })

  it('rejects an explicitly empty user ID', () => {
    expect(() => namespaceDatabaseName('lime', '')).toThrowError('userId must be a non-empty string')
  })
})

describe('user-namespaced IndexedDB repositories', () => {
  it('isolates records with the same IDs for two users', async () => {
    const userIds = ['google-user-a', 'google-user-b'] as const
    const cardDbName = uniqueDatabaseName('user-cards')
    const sessionDbName = uniqueDatabaseName('user-sessions')
    const actionDbName = uniqueDatabaseName('user-actions')
    for (const userId of userIds) {
      databaseNames.add(namespaceDatabaseName(cardDbName, userId))
      databaseNames.add(namespaceDatabaseName(sessionDbName, userId))
      databaseNames.add(namespaceDatabaseName(actionDbName, userId))
    }

    const cards = userIds.map((userId) => new IndexedDbCardRepository({ dbName: cardDbName, userId }))
    const sessions = userIds.map((userId) => new IndexedDbReadingSessionRepository({ dbName: sessionDbName, userId }))
    const actions = userIds.map((userId) => new IndexedDbReviewActionRepository({ dbName: actionDbName, userId }))
    openedRepositories.push(...cards, ...sessions, ...actions)

    const cardA = createCard({ id: 'shared-id', word: 'user-a-card', now: baseTime })
    const cardB = createCard({ id: 'shared-id', word: 'user-b-card', now: baseTime })
    const sessionA = { ...makeSession(), status: 'reading' as const }
    const sessionB = { ...makeSession(), status: 'quiz' as const }
    const actionA = makeAction('shared-id', baseTime, { cardId: 'shared-card' })
    const actionB = { ...makeAction('shared-id', baseTime, { cardId: 'shared-card' }), rating: 'easy' as const }

    await Promise.all([
      cards[0].save(cardA), cards[1].save(cardB),
      sessions[0].save(sessionA), sessions[1].save(sessionB),
      actions[0].save(actionA), actions[1].save(actionB),
    ])

    await expect(cards[0].load('shared-id')).resolves.toEqual(cardA)
    await expect(cards[1].load('shared-id')).resolves.toEqual(cardB)
    await expect(sessions[0].load(sessionA.id)).resolves.toEqual(sessionA)
    await expect(sessions[1].load(sessionB.id)).resolves.toEqual(sessionB)
    await expect(actions[0].load('shared-id')).resolves.toEqual(actionA)
    await expect(actions[1].load('shared-id')).resolves.toEqual(actionB)
  })
})

describe('version-1 custom database validation', () => {
  it('rejects a second repository that needs a different store', async () => {
    // Custom dbName + storeName pairs are dedicated to one adapter; this test
    // covers the explicit different-store failure, not a sharing contract.
    const dbName = uniqueDatabaseName('shared-custom')
    const cards = new IndexedDbCardRepository({ dbName })
    const sessions = new IndexedDbReadingSessionRepository({ dbName })
    openedRepositories.push(cards, sessions)

    await cards.save(createCard({ id: 'card', word: 'card', now: baseTime }))

    await expect(sessions.save(makeSession())).rejects.toThrowError(
      'Sharing a custom dbName across repositories with different stores is unsupported',
    )
  })
})

describe('IndexedDB connection lifecycle', () => {
  it('reopens every adapter after an external version upgrade', async () => {
    const cardDbName = uniqueDatabaseName('version-card')
    const sessionDbName = uniqueDatabaseName('version-session')
    const actionDbName = uniqueDatabaseName('version-action')
    const cards = new IndexedDbCardRepository({ dbName: cardDbName })
    const sessions = new IndexedDbReadingSessionRepository({ dbName: sessionDbName })
    const actions = new IndexedDbReviewActionRepository({ dbName: actionDbName })
    openedRepositories.push(cards, sessions, actions)

    const card = createCard({ id: 'version-card', word: 'card', now: baseTime })
    const session = makeSession()
    const action = makeAction('version-action', baseTime)
    await Promise.all([cards.save(card), sessions.save(session), actions.save(action)])

    await Promise.all([
      upgradeDatabase(cardDbName),
      upgradeDatabase(sessionDbName),
      upgradeDatabase(actionDbName),
    ])

    await expect(cards.load(card.id)).resolves.toEqual(card)
    await expect(sessions.load(session.id)).resolves.toEqual(session)
    await expect(actions.load(action.id)).resolves.toEqual(action)
  })
})

describe('default IndexedDB repository isolation', () => {
  it('opens cards, sessions, and actions independently at version 1', async () => {
    const cards = new IndexedDbCardRepository()
    const sessions = new IndexedDbReadingSessionRepository()
    const actions = new IndexedDbReviewActionRepository()
    openedRepositories.push(cards, sessions, actions)
    databaseNames.add('lime')
    databaseNames.add('lime-sessions')
    databaseNames.add('lime-review-actions')

    const card = createCard({ id: 'shared-id', word: 'card', now: baseTime })
    const session = makeSession()
    const action = makeAction('shared-id', baseTime)

    await Promise.all([cards.save(card), sessions.save(session), actions.save(action)])

    await expect(cards.load(card.id)).resolves.toEqual(card)
    await expect(sessions.load(session.id)).resolves.toEqual(session)
    await expect(actions.load(action.id)).resolves.toEqual(action)
  })
})
