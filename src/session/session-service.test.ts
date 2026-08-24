import { describe, expect, it } from 'vitest'
import { createCard } from '../domain/card'
import { normalizeWord } from '../domain/word'
import {
  InMemoryReadingSessionRepository,
  ReadingSessionService,
  SessionTransitionError,
} from './index'

const initialTime = new Date('2025-01-01T00:00:00.000Z')
const readingTime = new Date('2025-01-01T00:01:00.000Z')
const quizTime = new Date('2025-01-01T00:03:00.000Z')
const completeTime = new Date('2025-01-01T00:04:00.000Z')

const makeService = () => {
  let nextId = 0
  return new ReadingSessionService({
    clock: () => initialTime,
    idFactory: (kind = 'id') => `${kind}-${nextId++}`,
  })
}

describe('ReadingSessionService transitions', () => {
  it('creates a snapshot from cards and follows the reading lifecycle', () => {
    const service = makeService()
    const cards = [
      createCard({ id: 'card-a', word: 'alpha', now: initialTime }),
      createCard({ id: 'card-b', word: 'beta', now: initialTime }),
    ]

    const created = service.createSnapshot(cards)
    const reading = service.startReading(created, readingTime)
    const quiz = service.transitionToQuiz(reading, quizTime)
    const completed = service.complete(quiz, completeTime)

    expect(created).toMatchObject({ id: 'session-0', cardIds: ['card-a', 'card-b'], status: 'created' })
    expect(reading).toMatchObject({ status: 'reading', startedAt: readingTime })
    expect(quiz).toMatchObject({ status: 'quiz', quizStartedAt: quizTime })
    expect(completed).toMatchObject({ status: 'completed', completedAt: completeTime })
  })

  it('rejects invalid transitions and permits abandonment from an active state', () => {
    const service = makeService()
    const created = service.createSnapshot(['card-a'])

    expect(() => service.transitionToQuiz(created)).toThrowError(SessionTransitionError)
    expect(() => service.complete(created)).toThrowError(SessionTransitionError)

    const abandoned = service.abandon(created, readingTime)
    expect(abandoned).toMatchObject({ status: 'abandoned', abandonedAt: readingTime })
    expect(() => service.startReading(abandoned)).toThrowError(SessionTransitionError)
    expect(() => service.abandon(abandoned)).toThrowError(SessionTransitionError)
  })

  it('does not mutate prior snapshots or the source cycle', () => {
    const service = makeService()
    const cards = ['card-a', 'card-b']
    const created = service.createSnapshot(cards)
    const reading = service.startReading(created, readingTime)

    cards.push('card-c')

    expect(created.status).toBe('created')
    expect(created.cardIds).toEqual(['card-a', 'card-b'])
    expect(reading.status).toBe('reading')
    expect(reading.cardIds).toEqual(['card-a', 'card-b'])
    expect(reading.cardIds).not.toBe(created.cardIds)
    expect(reading.createdAt).not.toBe(created.createdAt)
  })
})

describe('dictionary lookup events', () => {
  it('records source, position, timestamp, and SRS membership immutably', () => {
    const service = makeService()
    const created = service.createSnapshot(['card-a'])
    const reading = service.startReading(created, readingTime)
    const position = { paragraph: 2, character: 17 }
    const timestamp = new Date('2025-01-01T00:02:00.000Z')
    const recorded = service.recordLookup(reading, {
      word: "can't",
      source: 'article',
      position,
      timestamp,
      inSrs: false,
    })

    position.character = 99
    timestamp.setUTCMinutes(55)

    expect(created.lookupEvents).toEqual([])
    expect(recorded.lookupEvents).toHaveLength(1)
    expect(recorded.lookupEvents[0]).toMatchObject({
      id: 'lookup-1',
      word: "can't",
      source: 'article',
      position: { paragraph: 2, character: 17 },
      timestamp: new Date('2025-01-01T00:02:00.000Z'),
      inSrs: false,
    })
    expect(() => service.recordLookup(recorded, { word: 'after', source: 'example', position, inSrs: true })).not.toThrow()
    const complete = service.complete(service.transitionToQuiz(service.startReading(created)), completeTime)
    expect(() => service.recordLookup(complete, { word: 'late', source: 'article', position, inSrs: false })).toThrowError(SessionTransitionError)
  })

  it('rejects lookups outside reading and accepts them while reading', () => {
    const service = makeService()
    const input = {
      word: 'word',
      source: 'article' as const,
      position: { paragraph: 0, character: 0 },
      inSrs: false,
    }
    const created = service.createSnapshot(['card-a'])
    const reading = service.startReading(created, readingTime)
    const quiz = service.transitionToQuiz(reading, quizTime)
    const completed = service.complete(quiz, completeTime)
    const abandoned = service.abandon(created, completeTime)

    expect(() => service.recordLookup(created, input)).toThrowError(SessionTransitionError)
    expect(() => service.recordLookup(quiz, input)).toThrowError(SessionTransitionError)
    expect(() => service.recordLookup(completed, input)).toThrowError(SessionTransitionError)
    expect(() => service.recordLookup(abandoned, input)).toThrowError(SessionTransitionError)
    expect(() => service.recordLookup(created, input)).toThrowError(
      'Cannot record a lookup in a created session; session must be reading',
    )
    expect(service.recordLookup(reading, input).lookupEvents).toHaveLength(1)
  })

  it('normalizes prime punctuation through the shared rule', () => {
    for (const punctuation of ['\u2033', '\u2034', '\u2057']) {
      expect(normalizeWord(`Don${punctuation}t`)).toBe("don't")
    }
  })

  it('returns unique unregistered candidates with case and apostrophe normalization', () => {
    const service = makeService()
    let session = service.startReading(service.createSnapshot(['card-a']), readingTime)
    const lookup = (word: string, inSrs = false) => {
      session = service.recordLookup(session, { word, source: 'article', position: { paragraph: 0, character: 0 }, inSrs })
    }

    lookup("Don't")
    lookup('don’t')
    lookup("DON'T")
    lookup('Already known', true)
    lookup('already known', false)
    lookup('unique')

    expect(service.getUnregisteredLookups(session)).toEqual([
      { word: "Don't", lookupCount: 3 },
      { word: 'already known', lookupCount: 1 },
      { word: 'unique', lookupCount: 1 },
    ])
  })
})

describe('InMemoryReadingSessionRepository', () => {
  it('isolates stored snapshots from callers', async () => {
    const repository = new InMemoryReadingSessionRepository()
    const session = new ReadingSessionService({
      clock: () => initialTime,
      idFactory: () => 'session-fixed',
    }).createSnapshot(['card-a'])

    await repository.save(session)
    const loaded = await repository.load(session.id)
    ;(loaded?.cardIds as string[] | undefined)?.push('mutated-copy')

    expect(await repository.load(session.id)).toEqual(session)
  })
})
