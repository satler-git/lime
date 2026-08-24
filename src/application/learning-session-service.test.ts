import { describe, expect, it, vi } from 'vitest'
import { CardService } from './card-service'
import {
  LearningSessionService,
  SessionOrchestrationError,
  type BatchAddServicePort,
} from './learning-session-service'
import { BatchAddService, BatchSelectionError } from '../batch-add'
import { createCard, type Card } from '../domain/card'
import { InMemoryReviewActionRepository, ReviewService } from '../review'
import { InMemoryReadingSessionRepository } from '../session'
import { InMemoryQuizStateRepository } from '../quiz'
import { FsrsScheduler } from '../scheduling/fsrs-scheduler'
import type { CardRepository } from '../repositories/card-repository'
import type { CycleContent } from '../content'
import type { QuizQuestion, QuizState, QuizStateRepository } from '../quiz'
import type { ReadingSession } from '../session'
import type { ReadingSessionRepository } from '../session/repository'

class InMemoryCards implements CardRepository {
  private readonly cards = new Map<string, Card>()

  async save(card: Card): Promise<void> {
    this.cards.set(card.id, card)
  }

  async load(id: string): Promise<Card | null> {
    return this.cards.get(id) ?? null
  }

  async loadAll(): Promise<Card[]> {
    return [...this.cards.values()]
  }

  async getDue(): Promise<Card[]> {
    return this.loadAll()
  }

  async restore(card: Card): Promise<void> {
    return this.save(card)
  }
}

class FaultInjectingSessionRepository implements ReadingSessionRepository {
  failNextSaveWith?: Error

  constructor(private readonly delegate: ReadingSessionRepository) {}

  async save(session: ReadingSession): Promise<void> {
    const error = this.failNextSaveWith
    this.failNextSaveWith = undefined
    if (error !== undefined) throw error
    return this.delegate.save(session)
  }

  load(id: string): Promise<ReadingSession | null> {
    return this.delegate.load(id)
  }
}

class FaultInjectingQuizStateRepository implements QuizStateRepository {
  failNextSaveWith?: Error
  failNextDeleteWith?: Error

  constructor(private readonly delegate: QuizStateRepository) {}

  async save(sessionId: string, state: QuizState): Promise<void> {
    const error = this.failNextSaveWith
    this.failNextSaveWith = undefined
    if (error !== undefined) throw error
    return this.delegate.save(sessionId, state)
  }

  load(sessionId: string): Promise<QuizState | null> {
    return this.delegate.load(sessionId)
  }

  async delete(sessionId: string): Promise<void> {
    const error = this.failNextDeleteWith
    this.failNextDeleteWith = undefined
    if (error !== undefined) throw error
    return this.delegate.delete(sessionId)
  }
}

const time = new Date('2025-01-01T00:00:00.000Z')
const makeQuestions = (): QuizQuestion[] => Array.from({ length: 5 }, (_, index) => ({
  id: `question-${index}`,
  prompt: `Prompt ${index}`,
  options: [
    { id: 'correct', text: 'Correct' },
    { id: 'wrong-1', text: 'Wrong 1' },
    { id: 'wrong-2', text: 'Wrong 2' },
    { id: 'wrong-3', text: 'Wrong 3' },
  ],
  correctOptionId: 'correct',
  relatedWords: [`related-${index}`],
}))

const makeApplication = (
  withLoader = false,
  repositories: {
    sessionRepository?: ReadingSessionRepository
    quizStateRepository?: QuizStateRepository
    batchAddService?: BatchAddServicePort
  } = {},
) => {
  const cardRepository = new InMemoryCards()
  const cardService = new CardService(cardRepository, new FsrsScheduler())
  const sessionRepository = repositories.sessionRepository ?? new InMemoryReadingSessionRepository()
  const quizStateRepository = repositories.quizStateRepository ?? new InMemoryQuizStateRepository()
  let sessionNumber = 0
  const reviewService = new ReviewService({
    cardService,
    actionRepository: new InMemoryReviewActionRepository(),
    clock: () => time,
    idFactory: (kind = 'id') => `${kind}-1`,
  })
  const lookedUp: string[] = []
  const content: CycleContent = { article: 'An article', questions: makeQuestions() }
  const app = new LearningSessionService({
    readingSessionRepository: sessionRepository,
    reviewService,
    cardCreator: cardService,
    cardLoader: withLoader ? cardRepository : undefined,
    quizStateRepository,
    sessionServiceOptions: {
      clock: () => time,
      idFactory: (kind = 'id') => kind === 'session' ? `session-${++sessionNumber}` : `${kind}-1`,
    },
    quizService: undefined,
    batchAddService: repositories.batchAddService,
    contentProvider: {
      async getContent(): Promise<CycleContent> {
        return content
      },
    },
    dictionaryResolver: {
      async lookup(word: string): Promise<{ word: string }> {
        lookedUp.push(word)
        return { word }
      },
    },
  })
  return { app, cardService, cardRepository, sessionRepository, quizStateRepository, reviewService, lookedUp }
}

describe('LearningSessionService', () => {
  it('starts and persists a planned cycle, records lookup, and reviews with undo', async () => {
    const { app, cardService, sessionRepository, lookedUp } = makeApplication()
    const first = await cardService.create({ id: 'one', word: 'one', now: time })
    const second = await cardService.create({ id: 'two', word: 'two', now: time })

    const session = await app.startCycle([first, second])
    expect(session.status).toBe('reading')
    expect((await sessionRepository.load(session.id))?.status).toBe('reading')

    const lookedUpSession = await app.lookup(session.id, {
      word: '  New Word ',
      source: 'article',
      position: { paragraph: 0, character: 4 },
      inSrs: false,
    })
    await app.recordLookup(session.id, {
      word: 'one',
      source: 'example',
      position: { paragraph: 1, character: 2 },
      inSrs: true,
    })
    expect(lookedUp).toEqual(['New Word'])
    expect(lookedUpSession.session.lookupEvents).toHaveLength(1)
    expect((await sessionRepository.load(session.id))?.lookupEvents).toHaveLength(2)

    const reviewed = await app.reviewCard(session.id, first.id, 'good')
    expect(reviewed.action.sessionId).toBe(session.id)
    expect((await cardService.getDueCards(new Date('2030-01-01'))).find((card) => card.id === first.id)?.reps).toBe(1)
    await app.undoReview(session.id, first.id, reviewed.action.id)
    expect((await cardService.getDueCards(new Date('2030-01-01'))).find((card) => card.id === first.id)?.reps).toBe(0)
  })

  it('progresses through a five-question quiz, completes, and blocks later actions', async () => {
    const { app, cardService, quizStateRepository } = makeApplication()
    const card = await cardService.create({ id: 'one', word: 'one', now: time })
    const session = await app.startPlannedCycle({ selectedCards: [card], cycles: [[card]] })
    const quiz = await app.transitionToQuiz(session.id)
    expect(quiz.session.status).toBe('quiz')

    let current = quiz
    for (const question of makeQuestions()) {
      current = await app.answerQuestion(session.id, question.id, question.correctOptionId)
    }
    expect(current.quiz.completed).toBe(true)
    const completed = await app.completeSession(session.id)
    expect(completed.status).toBe('completed')
    await expect(quizStateRepository.load(session.id)).resolves.toBeNull()
    await expect(app.answerQuestion(session.id, 'question-0', 'correct'))
      .rejects.toThrowError('session must be quiz')
    await expect(app.completeSession(session.id)).rejects.toThrowError(SessionOrchestrationError)

    const abandoned = await app.startCycle([card])
    await app.transitionToQuiz(abandoned.id, makeQuestions())
    await app.abandonSession(abandoned.id)
    await expect(quizStateRepository.load(abandoned.id)).resolves.toBeNull()
    await expect(app.recordLookup(abandoned.id, {
      word: 'after', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })).rejects.toThrowError('session must be reading')
  })

  it('compensates quiz creation when the session transition save fails', async () => {
    const sessionStore = new InMemoryReadingSessionRepository()
    const quizStore = new InMemoryQuizStateRepository()
    const sessionRepository = new FaultInjectingSessionRepository(sessionStore)
    const quizStateRepository = new FaultInjectingQuizStateRepository(quizStore)
    const { app, cardService } = makeApplication(false, { sessionRepository, quizStateRepository })
    const card = await cardService.create({ id: 'transition-failure', word: 'transition-failure', now: time })
    const session = await app.startCycle([card])
    const failure = new Error('session save failed')
    sessionRepository.failNextSaveWith = failure

    await expect(app.transitionToQuiz(session.id, makeQuestions())).rejects.toBe(failure)
    expect((await sessionStore.load(session.id))?.status).toBe('reading')
    await expect(quizStore.load(session.id)).resolves.toBeNull()
  })

  it('preserves the transition error when quiz-state compensation fails', async () => {
    const sessionStore = new InMemoryReadingSessionRepository()
    const quizStore = new InMemoryQuizStateRepository()
    const sessionRepository = new FaultInjectingSessionRepository(sessionStore)
    const quizStateRepository = new FaultInjectingQuizStateRepository(quizStore)
    const { app, cardService } = makeApplication(false, { sessionRepository, quizStateRepository })
    const card = await cardService.create({ id: 'transition-compensation', word: 'transition-compensation', now: time })
    const session = await app.startCycle([card])
    const failure = new Error('session save failed')
    sessionRepository.failNextSaveWith = failure
    quizStateRepository.failNextDeleteWith = new Error('cleanup failed')

    await expect(app.transitionToQuiz(session.id, makeQuestions())).rejects.toBe(failure)
    expect((await sessionStore.load(session.id))?.status).toBe('reading')
    await expect(quizStore.load(session.id)).resolves.not.toBeNull()
  })

  it('does not complete when quiz-state deletion fails', async () => {
    const sessionStore = new InMemoryReadingSessionRepository()
    const quizStore = new InMemoryQuizStateRepository()
    const sessionRepository = new FaultInjectingSessionRepository(sessionStore)
    const quizStateRepository = new FaultInjectingQuizStateRepository(quizStore)
    const { app, cardService } = makeApplication(false, { sessionRepository, quizStateRepository })
    const card = await cardService.create({ id: 'complete-delete', word: 'complete-delete', now: time })
    const session = await app.startCycle([card])
    await app.transitionToQuiz(session.id, makeQuestions())
    for (const question of makeQuestions()) {
      await app.answerQuestion(session.id, question.id, question.correctOptionId)
    }
    const failure = new Error('quiz delete failed')
    quizStateRepository.failNextDeleteWith = failure

    await expect(app.completeSession(session.id)).rejects.toBe(failure)
    expect((await sessionStore.load(session.id))?.status).toBe('quiz')
    await expect(quizStore.load(session.id)).resolves.not.toBeNull()
  })

  it('restores quiz state when completion session save fails', async () => {
    const sessionStore = new InMemoryReadingSessionRepository()
    const quizStore = new InMemoryQuizStateRepository()
    const sessionRepository = new FaultInjectingSessionRepository(sessionStore)
    const quizStateRepository = new FaultInjectingQuizStateRepository(quizStore)
    const { app, cardService } = makeApplication(false, { sessionRepository, quizStateRepository })
    const card = await cardService.create({ id: 'complete-save', word: 'complete-save', now: time })
    const session = await app.startCycle([card])
    await app.transitionToQuiz(session.id, makeQuestions())
    for (const question of makeQuestions()) {
      await app.answerQuestion(session.id, question.id, question.correctOptionId)
    }
    const failure = new Error('session save failed')
    sessionRepository.failNextSaveWith = failure

    await expect(app.completeSession(session.id)).rejects.toBe(failure)
    expect((await sessionStore.load(session.id))?.status).toBe('quiz')
    await expect(quizStore.load(session.id)).resolves.not.toBeNull()
  })

  it('restores quiz state when abandonment session save fails', async () => {
    const sessionStore = new InMemoryReadingSessionRepository()
    const quizStore = new InMemoryQuizStateRepository()
    const sessionRepository = new FaultInjectingSessionRepository(sessionStore)
    const quizStateRepository = new FaultInjectingQuizStateRepository(quizStore)
    const { app, cardService } = makeApplication(false, { sessionRepository, quizStateRepository })
    const card = await cardService.create({ id: 'abandon-save', word: 'abandon-save', now: time })
    const session = await app.startCycle([card])
    await app.transitionToQuiz(session.id, makeQuestions())
    const failure = new Error('session save failed')
    sessionRepository.failNextSaveWith = failure

    await expect(app.abandonSession(session.id)).rejects.toBe(failure)
    expect((await sessionStore.load(session.id))?.status).toBe('quiz')
    await expect(quizStore.load(session.id)).resolves.not.toBeNull()
  })

  it('does not abandon when quiz-state deletion fails', async () => {
    const sessionStore = new InMemoryReadingSessionRepository()
    const quizStore = new InMemoryQuizStateRepository()
    const sessionRepository = new FaultInjectingSessionRepository(sessionStore)
    const quizStateRepository = new FaultInjectingQuizStateRepository(quizStore)
    const { app, cardService } = makeApplication(false, { sessionRepository, quizStateRepository })
    const card = await cardService.create({ id: 'abandon-delete', word: 'abandon-delete', now: time })
    const session = await app.startCycle([card])
    await app.transitionToQuiz(session.id, makeQuestions())
    const failure = new Error('quiz delete failed')
    quizStateRepository.failNextDeleteWith = failure

    await expect(app.abandonSession(session.id)).rejects.toBe(failure)
    expect((await sessionStore.load(session.id))?.status).toBe('quiz')
    await expect(quizStore.load(session.id)).resolves.not.toBeNull()
  })

  it('exposes candidates and adds selected words using the injected creator', async () => {
    const { app, cardService } = makeApplication()
    const card = await cardService.create({ id: 'one', word: 'one', now: time })
    const session = await app.startCycle([card])
    await app.recordLookup(session.id, {
      word: 'Learn', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })
    await app.recordLookup(session.id, {
      word: ' learn ', source: 'example', position: { paragraph: 0, character: 1 }, inSrs: false,
    })
    const candidates = await app.getCandidates(session.id)
    expect(candidates).toMatchObject([{ word: 'Learn', normalizedWord: 'learn', lookupCount: 2 }])

    let selection = await app.createBatchSelection(session.id)
    expect(selection.sessionId).toBe(session.id)
    expect(selection.candidateFingerprint).toBeTruthy()
    selection = app.toggleBatchSelection(selection, 'LEARN')
    const created = await app.addSelectedCandidates(session.id, selection)
    expect(created).toHaveLength(1)
    expect(created[0].word).toBe('Learn')

    const repeated = await app.addSelectedCandidates(session.id, selection)
    expect(repeated.map((card) => card.id)).toEqual(created.map((card) => card.id))
    expect(await cardService.findByWord('learn')).toMatchObject({ id: created[0].id })
  })

  it('passes session metadata directly to injected batch services', async () => {
    const delegate = new BatchAddService()
    const createSelection = vi.fn((sessionId: Parameters<BatchAddServicePort['createSelection']>[0], candidates: Parameters<BatchAddServicePort['createSelection']>[1]) =>
      delegate.createSelection(sessionId, candidates))
    const batchAddService: BatchAddServicePort = {
      candidates: (session) => delegate.candidates(session),
      createSelection,
      toggle: (state, word) => delegate.toggle(state, word),
      add: (state, creator) => delegate.add(state, creator),
    }
    const { app, cardService } = makeApplication(false, { batchAddService })
    const card = await cardService.create({ id: 'injected-batch-port', word: 'injected-batch-port', now: time })
    const session = await app.startCycle([card])
    await app.recordLookup(session.id, {
      word: 'Learn', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })

    const selection = await app.createBatchSelection(session.id)

    expect(createSelection).toHaveBeenCalledWith(session.id, [
      { word: 'Learn', normalizedWord: 'learn', lookupCount: 1 },
    ])
    expect(selection.sessionId).toBe(session.id)
    expect(selection.candidateFingerprint).toBeTruthy()
  })

  it('preserves binding metadata through the injected batch service', async () => {
    const delegate = new BatchAddService()
    const batchAddService: BatchAddServicePort = {
      candidates: (session) => delegate.candidates(session),
      createSelection: (sessionId, candidates) => delegate.createSelection(sessionId, candidates),
      toggle: (state, word) => delegate.toggle(state, word),
      add: (state, creator) => delegate.add(state, creator),
    }
    const { app, cardService } = makeApplication(false, { batchAddService })
    const card = await cardService.create({ id: 'injected-toggle', word: 'injected-toggle', now: time })
    const first = await app.startCycle([card])
    await app.recordLookup(first.id, {
      word: 'First', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })

    const original = await app.createBatchSelection(first.id)
    const selection = app.toggleBatchSelection(original, 'FIRST')
    expect(selection).toMatchObject({
      sessionId: first.id,
      candidateFingerprint: original.candidateFingerprint,
      selectedWords: ['first'],
    })
    await expect(app.addSelectedCandidates(first.id, selection)).resolves.toHaveLength(1)

    const second = await app.startCycle([card])
    await expect(app.addSelectedCandidates(second.id, selection)).rejects.toThrowError('belongs to session')

    await app.recordLookup(first.id, {
      word: 'Second', source: 'article', position: { paragraph: 0, character: 1 }, inSrs: false,
    })
    await expect(app.addSelectedCandidates(first.id, selection)).rejects.toThrowError('selection is stale')
  })

  it('rejects a batch selection used with another reading session', async () => {
    const { app, cardService } = makeApplication()
    const card = await cardService.create({ id: 'cross-session', word: 'cross-session', now: time })
    const first = await app.startCycle([card])
    await app.recordLookup(first.id, {
      word: 'First', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })
    const selection = await app.createBatchSelection(first.id)

    const second = await app.startCycle([card])
    await expect(app.addSelectedCandidates(second.id, selection)).rejects.toThrowError('belongs to session')
  })

  it('rejects a batch selection after its session candidate snapshot changes', async () => {
    const { app, cardService } = makeApplication()
    const card = await cardService.create({ id: 'stale-selection', word: 'stale-selection', now: time })
    const session = await app.startCycle([card])
    await app.recordLookup(session.id, {
      word: 'First', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })
    const selection = await app.createBatchSelection(session.id)
    await app.recordLookup(session.id, {
      word: 'Second', source: 'article', position: { paragraph: 0, character: 1 }, inSrs: false,
    })

    await expect(app.addSelectedCandidates(session.id, selection)).rejects.toThrowError('selection is stale')
  })

  it('rejects a batch selection whose candidate payload is mutated before adding', async () => {
    const { app, cardService } = makeApplication()
    const card = await cardService.create({ id: 'mutated-selection', word: 'mutated-selection', now: time })
    const session = await app.startCycle([card])
    await app.recordLookup(session.id, {
      word: 'First', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })
    const selection = await app.createBatchSelection(session.id)
    selection.selectedWords = ['first']
    ;(selection.candidates as unknown as Array<{ word: string }>)[0].word = 'Changed'

    await expect(app.addSelectedCandidates(session.id, selection)).rejects.toThrowError(BatchSelectionError)
  })

  it('rejects selected words that do not exactly match normalized candidates', async () => {
    const { app, cardService } = makeApplication()
    const card = await cardService.create({ id: 'invalid-selected-word', word: 'invalid-selected-word', now: time })
    const session = await app.startCycle([card])
    await app.recordLookup(session.id, {
      word: 'First', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })
    const selection = await app.createBatchSelection(session.id)
    selection.selectedWords = ['FIRST']

    await expect(app.addSelectedCandidates(session.id, selection)).rejects.toThrowError('not a normalized candidate')
  })

  it('reloads quiz state in a new service and isolates quiz snapshots', async () => {
    const first = makeApplication(true)
    const card = await first.cardService.create({ id: 'reload', word: 'reload', now: time })
    const session = await first.app.startCycle([card])
    const started = await first.app.transitionToQuiz(session.id, makeQuestions())
    started.quiz.questions[0].options[0].text = 'mutated'
    started.quiz.startedAt.setUTCDate(9)
    const answered = await first.app.answerQuestion(session.id, 'question-0', 'correct')
    answered.quiz.answers[0].answeredAt.setUTCDate(9)

    const second = new LearningSessionService({
      readingSessionRepository: first.sessionRepository,
      reviewService: first.reviewService,
      cardLoader: first.cardRepository,
      quizStateRepository: first.quizStateRepository,
    })
    const reloaded = await second.getQuizState(session.id)
    expect(reloaded.answers).toHaveLength(1)
    expect(reloaded.questions[0].options[0].text).toBe('Correct')
    expect(reloaded.answers[0].answeredAt).toBeInstanceOf(Date)

    await second.answerQuestion(session.id, 'question-1', 'correct')
    expect((await first.app.getQuizState(session.id)).answers).toHaveLength(2)
  })

  it('resolves ID-only cycles with a loader and rejects them without one', async () => {
    const withLoader = makeApplication(true)
    const card = await withLoader.cardService.create({ id: 'id-only', word: 'loaded', now: time })
    const session = await withLoader.app.startCycle(['id-only'])
    await expect(withLoader.app.getContent(session.id)).resolves.toMatchObject({ article: 'An article' })
    const rehydrated = new LearningSessionService({
      readingSessionRepository: withLoader.sessionRepository,
      reviewService: withLoader.reviewService,
      cardLoader: withLoader.cardRepository,
      quizStateRepository: withLoader.quizStateRepository,
      contentProvider: {
        async getContent(cycle): Promise<CycleContent> {
          expect(cycle[0].word).toBe('loaded')
          return { article: 'Rehydrated', questions: makeQuestions() }
        },
      },
    })
    await expect(rehydrated.getContent(session.id)).resolves.toMatchObject({ article: 'Rehydrated' })

    const withoutLoader = makeApplication()
    await expect(withoutLoader.app.startCycle(['id-only']))
      .rejects.toThrowError('A CardLoader is required to start an ID-only reading cycle')
  })

  it('validates lookup input before calling the dictionary provider', async () => {
    const { app, cardService, lookedUp } = makeApplication()
    const card = await cardService.create({ id: 'lookup', word: 'lookup', now: time })
    const session = await app.startCycle([card])

    await expect(app.lookup(session.id, {
      word: ' ', source: 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })).rejects.toThrowError('A lookup word is required')
    await expect(app.lookup(session.id, {
      word: 'valid', source: 'invalid' as 'article', position: { paragraph: 0, character: 0 }, inSrs: false,
    })).rejects.toThrowError('Lookup source must be article or example')
    expect(lookedUp).toEqual([])
  })
})
