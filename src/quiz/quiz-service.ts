import type {
  QuizAnswer,
  QuizClock,
  QuizProgress,
  QuizQuestion,
  QuizServiceOptions,
  QuizState,
} from './types'

export class QuizValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuizValidationError'
  }
}

export class QuizAnswerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QuizAnswerError'
  }
}

const QUESTION_COUNT = 5
const OPTION_COUNT = 4
const defaultClock: QuizClock = () => new Date()

const copyDate = (date: Date): Date => new Date(date.getTime())

const assertDate = (date: Date, name: string): void => {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be a valid Date`)
  }
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new QuizValidationError(`${name} must be a non-empty string`)
  }
}

const validateQuestion = (question: QuizQuestion, index: number): QuizQuestion => {
  if (question === null || typeof question !== 'object') {
    throw new QuizValidationError(`Question ${index + 1} must be an object`)
  }
  assertText(question.id, `Question ${index + 1} id`)
  assertText(question.prompt, `Question ${index + 1} prompt`)
  if (!Array.isArray(question.options) || question.options.length !== OPTION_COUNT) {
    throw new QuizValidationError(`Question ${question.id} must have exactly ${OPTION_COUNT} options`)
  }

  const optionIds = new Set<string>()
  for (const [optionIndex, option] of question.options.entries()) {
    if (option === null || typeof option !== 'object') {
      throw new QuizValidationError(`Question ${question.id} option ${optionIndex + 1} must be an object`)
    }
    assertText(option.id, `Question ${question.id} option ${optionIndex + 1} id`)
    assertText(option.text, `Question ${question.id} option ${optionIndex + 1} text`)
    if (optionIds.has(option.id)) {
      throw new QuizValidationError(`Question ${question.id} option IDs must be unique`)
    }
    optionIds.add(option.id)
  }

  assertText(question.correctOptionId, `Question ${question.id} correctOptionId`)
  if (!optionIds.has(question.correctOptionId)) {
    throw new QuizValidationError(`Question ${question.id} correctOptionId must identify one option`)
  }
  if (
    !Array.isArray(question.relatedWords)
    || question.relatedWords.length === 0
    || question.relatedWords.some((word) => typeof word !== 'string')
  ) {
    throw new QuizValidationError(`Question ${question.id} relatedWords must be a non-empty array of strings`)
  }

  return {
    id: question.id,
    prompt: question.prompt,
    options: question.options.map((option) => ({ id: option.id, text: option.text })),
    correctOptionId: question.correctOptionId,
    relatedWords: [...question.relatedWords],
  }
}

const validateQuestions = (questions: readonly QuizQuestion[]): QuizQuestion[] => {
  if (!Array.isArray(questions) || questions.length !== QUESTION_COUNT) {
    throw new QuizValidationError(`A quiz must contain exactly ${QUESTION_COUNT} questions`)
  }
  const ids = new Set<string>()
  return questions.map((question, index) => {
    const validated = validateQuestion(question, index)
    if (ids.has(validated.id)) {
      throw new QuizValidationError(`Question IDs must be unique: ${validated.id}`)
    }
    ids.add(validated.id)
    return validated
  })
}

const copyAnswer = (answer: QuizAnswer): QuizAnswer => ({
  ...answer,
  answeredAt: copyDate(answer.answeredAt),
})

const copyState = (state: QuizState): QuizState => ({
  ...state,
  questions: state.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
    relatedWords: [...question.relatedWords],
  })),
  answers: state.answers.map(copyAnswer),
  startedAt: copyDate(state.startedAt),
  ...(state.completedAt === undefined ? {} : { completedAt: copyDate(state.completedAt) }),
})

/** Create an immutable snapshot for a five-question quiz. */
export function createQuizState(
  questions: readonly QuizQuestion[],
  options: QuizServiceOptions = {},
): QuizState {
  const validatedQuestions = validateQuestions(questions)
  const startedAt = copyDate((options.clock ?? defaultClock)())
  assertDate(startedAt, 'quiz start time')

  return {
    questions: validatedQuestions,
    answers: [],
    currentQuestionIndex: 0,
    score: 0,
    completed: false,
    startedAt,
  }
}

export const createQuiz = createQuizState

/** Answer only the current question and return a new quiz snapshot. */
export function answerQuestion(
  state: QuizState,
  questionId: string,
  optionId: string,
  at: Date = new Date(),
): QuizState {
  if (state.completed) {
    throw new QuizAnswerError('Cannot answer a completed quiz')
  }
  const question = state.questions.find((candidate) => candidate.id === questionId)
  if (question === undefined) {
    throw new QuizAnswerError(`Question not found: ${questionId}`)
  }
  const alreadyAnswered = state.answers.some((answer) => answer.questionId === questionId)
  if (alreadyAnswered) {
    throw new QuizAnswerError(`Question has already been answered: ${questionId}`)
  }
  const currentQuestion = state.questions[state.currentQuestionIndex]
  if (currentQuestion?.id !== questionId) {
    throw new QuizAnswerError(`Question is not the current question: ${questionId}`)
  }
  if (!question.options.some((option) => option.id === optionId)) {
    throw new QuizAnswerError(`Option not found for question ${questionId}: ${optionId}`)
  }
  assertDate(at, 'answer time')

  const correct = question.correctOptionId === optionId
  const answer: QuizAnswer = {
    questionId,
    optionId,
    correct,
    answeredAt: copyDate(at),
  }
  const nextIndex = state.currentQuestionIndex + 1
  const completed = nextIndex === state.questions.length
  const snapshot = copyState(state)

  return {
    ...snapshot,
    answers: [...snapshot.answers, answer],
    currentQuestionIndex: nextIndex,
    score: snapshot.score + (correct ? 1 : 0),
    completed,
    ...(completed ? { completedAt: copyDate(at) } : {}),
  }
}

export const answerQuizQuestion = answerQuestion

export function getQuizProgress(state: QuizState): QuizProgress {
  const total = state.questions.length
  const answered = state.answers.length
  return {
    answered,
    total,
    remaining: Math.max(total - answered, 0),
    currentQuestionIndex: state.currentQuestionIndex,
    currentQuestionNumber: state.completed ? total : state.currentQuestionIndex + 1,
    completed: state.completed,
  }
}

export const quizProgress = getQuizProgress

export function getQuizScore(state: QuizState): number {
  return state.score
}

export const quizScore = getQuizScore

export function isQuizComplete(state: QuizState): boolean {
  return state.completed
}

export const isQuizCompleted = isQuizComplete

/** Return each related word once, in the order wrong questions were answered. */
export function getWrongQuestionRelatedWords(state: QuizState): string[] {
  const questionsById = new Map(state.questions.map((question) => [question.id, question]))
  const words: string[] = []
  const seen = new Set<string>()
  for (const answer of state.answers) {
    if (answer.correct) continue
    for (const word of questionsById.get(answer.questionId)?.relatedWords ?? []) {
      if (!seen.has(word)) {
        seen.add(word)
        words.push(word)
      }
    }
  }
  return words
}

export const wrongQuestionRelatedWords = getWrongQuestionRelatedWords

/** Injectable application service facade for callers that do not want to pass times. */
export class QuizService {
  private readonly clock: QuizClock

  constructor(options: QuizServiceOptions = {}) {
    this.clock = options.clock ?? defaultClock
  }

  create(questions: readonly QuizQuestion[]): QuizState {
    return createQuizState(questions, { clock: this.clock })
  }

  createState(questions: readonly QuizQuestion[]): QuizState {
    return this.create(questions)
  }

  answer(state: QuizState, questionId: string, optionId: string): QuizState {
    return answerQuestion(state, questionId, optionId, this.clock())
  }

  progress(state: QuizState): QuizProgress {
    return getQuizProgress(state)
  }

  score(state: QuizState): number {
    return getQuizScore(state)
  }

  isComplete(state: QuizState): boolean {
    return isQuizComplete(state)
  }

  wrongQuestionRelatedWords(state: QuizState): string[] {
    return getWrongQuestionRelatedWords(state)
  }
}
