import { describe, expect, it } from 'vitest'
import {
  QuizAnswerError,
  QuizService,
  QuizValidationError,
  answerQuestion,
  createQuizState,
  getQuizProgress,
  getQuizScore,
  getWrongQuestionRelatedWords,
} from './index'
import type { QuizQuestion } from './types'

const makeQuestions = (): QuizQuestion[] => Array.from({ length: 5 }, (_, index) => ({
  id: `question-${index + 1}`,
  prompt: `Prompt ${index + 1}`,
  options: [
    { id: 'a', text: 'A' },
    { id: 'b', text: 'B' },
    { id: 'c', text: 'C' },
    { id: 'd', text: 'D' },
  ],
  correctOptionId: index % 2 === 0 ? 'a' : 'b',
  relatedWords: [`word-${index + 1}`, ...(index === 2 ? ['shared-word'] : [])],
}))

const initialTime = new Date('2025-04-01T12:00:00.000Z')
const answerTime = new Date('2025-04-01T12:01:00.000Z')

describe('quiz validation and progress', () => {
  it('requires exactly five valid questions with exactly four options', () => {
    expect(() => createQuizState(makeQuestions().slice(0, 4), { clock: () => initialTime }))
      .toThrowError(QuizValidationError)

    const invalid = makeQuestions()
    invalid[0].options = invalid[0].options.slice(0, 3)
    expect(() => createQuizState(invalid, { clock: () => initialTime }))
      .toThrowError('exactly 4 options')
  })

  it('requires relatedWords to be non-empty', () => {
    const invalid = makeQuestions()
    invalid[0].relatedWords = []

    expect(() => createQuizState(invalid, { clock: () => initialTime }))
      .toThrowError('relatedWords must be a non-empty array of strings')
  })

  it('starts at zero progress and advances one question immutably', () => {
    const questions = makeQuestions()
    const state = createQuizState(questions, { clock: () => initialTime })
    const next = answerQuestion(state, 'question-1', 'a', answerTime)

    expect(getQuizProgress(state)).toMatchObject({
      answered: 0,
      total: 5,
      remaining: 5,
      currentQuestionIndex: 0,
      currentQuestionNumber: 1,
      completed: false,
    })
    expect(getQuizProgress(next)).toMatchObject({
      answered: 1,
      total: 5,
      remaining: 4,
      currentQuestionIndex: 1,
      currentQuestionNumber: 2,
      completed: false,
    })
    expect(state.answers).toHaveLength(0)
    expect(next.answers[0]).toMatchObject({ questionId: 'question-1', optionId: 'a', correct: true, answeredAt: answerTime })
    expect(next.startedAt).not.toBe(initialTime)
  })

  it('rejects invalid IDs, duplicate/out-of-order answers, and answers after completion', () => {
    const service = new QuizService({ clock: () => answerTime })
    const state = service.create(makeQuestions())

    expect(() => service.answer(state, 'missing', 'a')).toThrowError(QuizAnswerError)
    expect(() => service.answer(state, 'question-1', 'missing')).toThrowError(QuizAnswerError)
    const answered = service.answer(state, 'question-1', 'a')
    expect(() => service.answer(answered, 'question-1', 'a')).toThrowError(QuizAnswerError)
    expect(() => service.answer(answered, 'question-3', 'a')).toThrowError('current question')

    let completed = answered
    for (let index = 1; index < 5; index += 1) {
      completed = service.answer(completed, `question-${index + 1}`, 'a')
    }
    expect(completed.completed).toBe(true)
    expect(() => service.answer(completed, 'question-5', 'a')).toThrowError(QuizAnswerError)
  })
})

describe('quiz score and wrong related words', () => {
  it('calculates score and returns related words for wrong questions', () => {
    const service = new QuizService({ clock: () => initialTime })
    let state = service.create(makeQuestions())
    state = service.answer(state, 'question-1', 'b')
    state = service.answer(state, 'question-2', 'b')
    state = service.answer(state, 'question-3', 'b')
    state = service.answer(state, 'question-4', 'a')
    state = service.answer(state, 'question-5', 'a')

    expect(getQuizScore(state)).toBe(2)
    expect(state.score).toBe(2)
    expect(getWrongQuestionRelatedWords(state)).toEqual(['word-1', 'word-3', 'shared-word', 'word-4'])
    expect(getQuizProgress(state)).toMatchObject({ answered: 5, remaining: 0, currentQuestionIndex: 5, completed: true })
    expect(state.completedAt).toEqual(initialTime)
  })
})
