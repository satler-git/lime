import type { Card, CardId, Rating } from '../domain/card'
import type { CycleContent } from '../content/types'
import {
  assertBatchSelectionMatches,
  BatchAddService,
} from '../batch-add/batch-add-service'
import type {
  BatchCandidate,
  BatchSelectionState,
  CardCreator,
} from '../batch-add/types'
import type { TodayPlan } from '../planning/today-plan'
import { cloneQuizState, QuizService } from '../quiz/quiz-service'
import type { QuizQuestion, QuizProgress, QuizState } from '../quiz/types'
import type { QuizStateRepository } from '../quiz/repository'
import type { ReviewActionResult } from '../review/types'
import { ReadingSessionService } from '../session/session-service'
import type { RecordLookupInput } from '../session/session-service'
import type { ReadingSessionRepository } from '../session/repository'
import type {
  ReadingSession,
  ReadingSessionServiceOptions,
  SessionCycle,
  UnregisteredLookup,
} from '../session/types'
import { cloneCard } from '../domain/card'
import type { CardLoader } from '../repositories/card-repository'
import { validateLookupInput } from '../session/session-service'

/** Provider for the article and quiz content belonging to a planned cycle. */
export interface ContentProvider {
  getContent(cycle: readonly Card[]): Promise<CycleContent>
}

/** Result returned by an injected dictionary resolver. */
export type DictionaryResolverResult = unknown

/** Provider-neutral dictionary resolver port used by the session boundary. */
export interface DictionaryResolver {
  lookup(word: string): Promise<DictionaryResolverResult>
}

/** The session-state operations needed by this application boundary. */
export interface ReadingSessionServicePort {
  createSnapshot(cycle: SessionCycle): ReadingSession
  startReading(session: ReadingSession, at?: Date): ReadingSession
  transitionToQuiz(session: ReadingSession, at?: Date): ReadingSession
  complete(session: ReadingSession, at?: Date): ReadingSession
  abandon(session: ReadingSession, at?: Date): ReadingSession
  recordLookup(session: ReadingSession, input: RecordLookupInput): ReadingSession
  getUnregisteredLookups(session: ReadingSession): UnregisteredLookup[]
}

/** The session-scoped review operations needed by this application boundary. */
export interface ReviewServicePort {
  review(session: ReadingSession, cardId: CardId, rating: Rating, at?: Date): Promise<ReviewActionResult>
  undo(session: ReadingSession, cardId: CardId, actionId?: string, at?: Date): Promise<ReviewActionResult>
}

/** The quiz operations needed by this application boundary. */
export interface QuizServicePort {
  create(questions: readonly QuizQuestion[]): QuizState
  answer(state: QuizState, questionId: string, optionId: string): QuizState
  progress(state: QuizState): QuizProgress
  isComplete(state: QuizState): boolean
}

/** The batch-add operations needed by this application boundary. */
export interface BatchAddServicePort {
  candidates(source: ReadingSession): BatchCandidate[]
  createSelection(sessionId: string, candidates: readonly BatchCandidate[]): BatchSelectionState
  toggle(state: BatchSelectionState, word: string): BatchSelectionState
  add(state: BatchSelectionState, creator: CardCreator): Promise<Card[]>
}

/** Describes all application collaborators. Domain services remain injectable. */
export type LearningSessionServiceOptions = {
  readingSessionRepository: ReadingSessionRepository
  reviewService: ReviewServicePort
  cardCreator?: CardCreator
  readingSessionService?: ReadingSessionServicePort
  quizService?: QuizServicePort
  batchAddService?: BatchAddServicePort
  cardLoader?: CardLoader
  todayPlan?: TodayPlan
  contentProvider?: ContentProvider
  dictionaryResolver?: DictionaryResolver
  sessionServiceOptions?: ReadingSessionServiceOptions
  /** A quiz-state repository must be explicitly supplied to the application boundary. */
  quizStateRepository: QuizStateRepository
}

export type QuizSessionSnapshot = {
  session: ReadingSession
  quiz: QuizState
}

export type DictionaryResolverSnapshot = {
  session: ReadingSession
  result: DictionaryResolverResult
}

/** Error raised when an application operation references a missing session. */
export class SessionNotFoundError extends Error {
  constructor(sessionId: string) {
    super(`Reading session not found: ${sessionId}`)
    this.name = 'SessionNotFoundError'
  }
}

/** Error raised for an operation that does not match the session lifecycle. */
export class SessionOrchestrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SessionOrchestrationError'
  }
}

const isCycleContent = (content: CycleContent | readonly QuizQuestion[]): content is CycleContent =>
  !Array.isArray(content)

/**
 * Client-side application boundary for one planned reading cycle.
 *
 * Every ReadingSession returned by ReadingSessionService is explicitly saved
 * here. The underlying domain services remain pure or focused on their own
 * repositories; this class is the only place that coordinates the session
 * repository and the resumable quiz-state repository.
 */
export class LearningSessionService {
  private readonly sessions: ReadingSessionRepository
  private readonly readingSessions: ReadingSessionServicePort
  private readonly reviews: ReviewServicePort
  private readonly quizzes: QuizServicePort
  private readonly quizStateRepository: QuizStateRepository
  private readonly batchAdds: BatchAddServicePort
  private readonly creator?: CardCreator
  private readonly cardLoader?: CardLoader
  private readonly content?: ContentProvider
  private readonly dictionary?: DictionaryResolver
  private readonly plannedCycle?: TodayPlan
  private readonly cycles = new Map<string, Card[]>()
  private readonly sessionMutations = new Map<string, Promise<unknown>>()

  constructor(options: LearningSessionServiceOptions) {
    this.sessions = options.readingSessionRepository
    this.readingSessions = options.readingSessionService ?? new ReadingSessionService(options.sessionServiceOptions)
    this.reviews = options.reviewService
    this.quizzes = options.quizService ?? new QuizService()
    this.quizStateRepository = options.quizStateRepository
    this.batchAdds = options.batchAddService ?? new BatchAddService()
    this.creator = options.cardCreator
    this.cardLoader = options.cardLoader
    this.content = options.contentProvider
    this.dictionary = options.dictionaryResolver
    this.plannedCycle = options.todayPlan
  }

  /** Persist a created snapshot, then persist its transition into reading. */
  async startCycle(cycleIndex: number): Promise<ReadingSession>
  async startCycle(cycle: SessionCycle): Promise<ReadingSession>
  async startCycle(cycleOrIndex: SessionCycle | number): Promise<ReadingSession> {
    if (typeof cycleOrIndex === 'number') {
      if (this.plannedCycle === undefined) {
        throw new SessionOrchestrationError('A TodayPlan is required when starting by cycle index')
      }
      return this.startPlannedCycle(this.plannedCycle, cycleOrIndex)
    }
    const cards = await this.resolveCycleCards(cycleOrIndex)
    if (cards.length === 0) {
      throw new SessionOrchestrationError('Cannot start an empty reading cycle')
    }

    const created = this.readingSessions.createSnapshot(cards)
    await this.sessions.save(created)
    const reading = this.readingSessions.startReading(created)
    await this.sessions.save(reading)
    this.cycles.set(reading.id, cards.map(cloneCard))
    return reading
  }

  /** Start one of the contiguous cycles produced by TodayPlan. */
  async startPlannedCycle(plan: TodayPlan, cycleIndex = 0): Promise<ReadingSession> {
    if (!Number.isInteger(cycleIndex) || cycleIndex < 0 || cycleIndex >= plan.cycles.length) {
      throw new SessionOrchestrationError(`No planned cycle exists at index ${cycleIndex}`)
    }
    return this.startCycle(plan.cycles[cycleIndex])
  }

  async loadSession(sessionId: string): Promise<ReadingSession> {
    const session = await this.sessions.load(sessionId)
    if (session === null) throw new SessionNotFoundError(sessionId)
    return session
  }

  /** Record an already-resolved lookup and persist the new session snapshot. */
  recordLookup(sessionId: string, input: RecordLookupInput): Promise<ReadingSession> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatusOneOf(session, ['reading', 'quiz'], 'record a dictionary lookup')
      const next = this.readingSessions.recordLookup(session, input)
      await this.sessions.save(next)
      return next
    })
  }

  /** Resolve a word and then record its article/example lookup in the session. */
  lookup(sessionId: string, input: RecordLookupInput): Promise<DictionaryResolverSnapshot> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatusOneOf(session, ['reading', 'quiz'], 'look up a dictionary word')
      validateLookupInput(input)
      if (this.dictionary === undefined) {
        throw new SessionOrchestrationError('A DictionaryResolver provider is required for lookup')
      }
      const result = await this.dictionary.lookup(input.word.trim())
      const next = this.readingSessions.recordLookup(session, input)
      await this.sessions.save(next)
      return { session: next, result }
    })
  }

  reviewCard(sessionId: string, cardId: CardId, rating: Rating, at?: Date): Promise<ReviewActionResult> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatus(session, 'reading', 'review a card')
      return this.reviews.review(session, cardId, rating, at)
    })
  }

  undoReview(sessionId: string, cardId: CardId, actionId?: string, at?: Date): Promise<ReviewActionResult> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatus(session, 'reading', 'undo a card review')
      return this.reviews.undo(session, cardId, actionId, at)
    })
  }

  /** Fetch content through the injected provider for a started cycle. */
  async getContent(sessionId: string): Promise<CycleContent> {
    const session = await this.loadSession(sessionId)
    this.assertStatus(session, 'reading', 'fetch cycle content')
    const cycle = await this.loadCycleCards(session)
    if (this.content === undefined) {
      throw new SessionOrchestrationError('A ContentProvider is required to fetch cycle content')
    }
    return this.content.getContent(cycle.map(cloneCard))
  }

  /** Move a reading session to quiz after durably creating its quiz state. */
  async transitionToQuiz(
    sessionId: string,
    content?: CycleContent | readonly QuizQuestion[],
  ): Promise<QuizSessionSnapshot> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatus(session, 'reading', 'transition to quiz')
      const supplied = content ?? await this.getContent(sessionId)
      const questions = isCycleContent(supplied) ? supplied.questions : supplied
      const quiz = this.quizzes.create(questions)
      const next = this.readingSessions.transitionToQuiz(session)

      // Save the state first so a successful session transition can never leave
      // a persisted quiz session without its resumable quiz state. If saving the
      // session fails, remove the state and preserve the original failure.
      await this.quizStateRepository.save(sessionId, quiz)
      try {
        await this.sessions.save(next)
      } catch (error) {
        await this.compensateQuizState(sessionId, null)
        throw error
      }
      return { session: next, quiz: cloneQuizState(quiz) }
    })
  }

  async getQuizState(sessionId: string): Promise<QuizState> {
    const session = await this.loadSession(sessionId)
    this.assertStatus(session, 'quiz', 'read quiz state')
    const quiz = await this.loadQuizState(sessionId)
    return cloneQuizState(quiz)
  }

  answerQuestion(sessionId: string, questionId: string, optionId: string): Promise<QuizSessionSnapshot> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatus(session, 'quiz', 'answer a quiz question')
      const previous = await this.loadQuizState(sessionId)
      const quiz = this.quizzes.answer(previous, questionId, optionId)
      await this.quizStateRepository.save(sessionId, quiz)
      return { session, quiz: cloneQuizState(quiz) }
    })
  }

  quizProgress(sessionId: string): Promise<QuizProgress> {
    return this.getQuizState(sessionId).then((quiz) => this.quizzes.progress(quiz))
  }

  /** Complete only after all five quiz questions have been answered. */
  completeSession(sessionId: string, at?: Date): Promise<ReadingSession> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      this.assertStatus(session, 'quiz', 'complete the session')
      const quiz = await this.loadQuizState(sessionId)
      if (!this.quizzes.isComplete(quiz)) {
        throw new SessionOrchestrationError('Cannot complete the session until the quiz is complete')
      }
      const next = this.readingSessions.complete(session, at)

      // Remove quiz state first. If the session save fails, restore the state so
      // the original quiz session remains resumable.
      await this.quizStateRepository.delete(sessionId)
      try {
        await this.sessions.save(next)
      } catch (error) {
        await this.compensateQuizState(sessionId, quiz)
        throw error
      }
      this.cycles.delete(sessionId)
      return next
    })
  }

  abandonSession(sessionId: string, at?: Date): Promise<ReadingSession> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      if (session.status === 'completed' || session.status === 'abandoned') {
        throw new SessionOrchestrationError(`Cannot abandon a ${session.status} session`)
      }
      const quiz = await this.quizStateRepository.load(sessionId)
      const next = this.readingSessions.abandon(session, at)

      // Deleting first means a successful abandonment cannot retain resumable
      // quiz state. Restore the prior state if the session save fails.
      await this.quizStateRepository.delete(sessionId)
      try {
        await this.sessions.save(next)
      } catch (error) {
        await this.compensateQuizState(sessionId, quiz)
        throw error
      }
      this.cycles.delete(sessionId)
      return next
    })
  }

  getUnregisteredLookups(session: ReadingSession): UnregisteredLookup[] {
    return this.readingSessions.getUnregisteredLookups(session)
  }

  async getCandidates(sessionId: string): Promise<BatchCandidate[]> {
    const session = await this.loadSession(sessionId)
    return this.batchAdds.candidates(session)
  }

  async createBatchSelection(sessionId: string): Promise<BatchSelectionState> {
    const session = await this.loadSession(sessionId)
    const candidates = this.batchAdds.candidates(session)
    const selection = this.batchAdds.createSelection(sessionId, candidates)
    assertBatchSelectionMatches(selection, sessionId, candidates)
    return selection
  }

  toggleBatchSelection(state: BatchSelectionState, word: string): BatchSelectionState {
    return this.batchAdds.toggle(state, word)
  }

  addSelectedCandidates(
    sessionId: string,
    selection: BatchSelectionState,
    creator?: CardCreator,
  ): Promise<Card[]> {
    return this.enqueueSessionMutation(sessionId, async () => {
      const session = await this.loadSession(sessionId)
      if (session.status === 'abandoned') {
        throw new SessionOrchestrationError('Cannot add lookup candidates from an abandoned session')
      }
      assertBatchSelectionMatches(selection, sessionId, this.batchAdds.candidates(session))
      const selectedCreator = creator ?? this.creator
      if (selectedCreator === undefined) {
        throw new SessionOrchestrationError('A CardCreator is required to batch-add candidates')
      }
      return this.batchAdds.add(selection, selectedCreator)
    })
  }

  private assertStatus(session: ReadingSession, expected: ReadingSession['status'], operation: string): void {
    if (session.status !== expected) {
      throw new SessionOrchestrationError(
        `Cannot ${operation} in a ${session.status} session; session must be ${expected}`,
      )
    }
  }

  private assertStatusOneOf(
    session: ReadingSession,
    expected: readonly ReadingSession['status'][],
    operation: string,
  ): void {
    if (!expected.includes(session.status)) {
      throw new SessionOrchestrationError(
        `Cannot ${operation} in a ${session.status} session; session must be ${expected.join(' or ')}`,
      )
    }
  }

  private async resolveCycleCards(cycle: SessionCycle): Promise<Card[]> {
    if (cycle.some((item) => typeof item === 'string')) {
      if (this.cardLoader === undefined) {
        throw new SessionOrchestrationError(
          'A CardLoader is required to start an ID-only reading cycle',
        )
      }
      const cards = await Promise.all(cycle.map(async (item) => {
        if (typeof item !== 'string') return cloneCard(item)
        const card = await this.cardLoader?.load(item)
        if (card === null || card === undefined) {
          throw new SessionOrchestrationError(`Card not found for reading cycle: ${item}`)
        }
        return cloneCard(card)
      }))
      return cards
    }
    return [...cycle].map((item) => cloneCard(item as Card))
  }

  private async loadCycleCards(session: ReadingSession): Promise<Card[]> {
    const cached = this.cycles.get(session.id)
    if (cached !== undefined) return cached.map(cloneCard)
    if (this.cardLoader === undefined) {
      throw new SessionOrchestrationError(
        `A CardLoader is required to rehydrate content for session ${session.id}`,
      )
    }
    const cards = await Promise.all(session.cardIds.map(async (id) => {
      const card = await this.cardLoader?.load(id)
      if (card === null || card === undefined) {
        throw new SessionOrchestrationError(`Card not found for reading cycle: ${id}`)
      }
      return cloneCard(card)
    }))
    this.cycles.set(session.id, cards.map(cloneCard))
    return cards
  }

  private async loadQuizState(sessionId: string): Promise<QuizState> {
    const quiz = await this.quizStateRepository.load(sessionId)
    if (quiz === null) {
      throw new SessionOrchestrationError(`Quiz state is unavailable for session ${sessionId}`)
    }
    return cloneQuizState(quiz)
  }

  /**
   * Best-effort rollback for a failed cross-repository operation. The caller's
   * operation error is authoritative; a rollback failure is intentionally not
   * allowed to hide it because these repository ports have no transaction API.
   */
  private async compensateQuizState(sessionId: string, state: QuizState | null): Promise<void> {
    try {
      if (state === null) {
        await this.quizStateRepository.delete(sessionId)
      } else {
        await this.quizStateRepository.save(sessionId, state)
      }
    } catch {
      // The original persistence error is rethrown by the caller. A failed
      // compensation leaves the repositories potentially out of sync.
    }
  }

  private enqueueSessionMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.sessionMutations.get(sessionId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.sessionMutations.set(sessionId, current)
    return current.finally(() => {
      if (this.sessionMutations.get(sessionId) === current) this.sessionMutations.delete(sessionId)
    })
  }
}
