import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it } from 'vitest'
import type { QuizQuestion, QuizState } from '../quiz'
import { IndexedDbQuizStateRepository } from './indexed-db-quiz-state-repository'

const baseTime = new Date('2025-01-01T00:00:00.000Z')
const databaseNames = new Set<string>()
const repositories: IndexedDbQuizStateRepository[] = []

const questions = (): QuizQuestion[] => Array.from({ length: 5 }, (_, index) => ({
  id: `question-${index}`,
  prompt: `Prompt ${index}`,
  options: [
    { id: 'correct', text: 'Correct' },
    { id: 'wrong-1', text: 'Wrong 1' },
    { id: 'wrong-2', text: 'Wrong 2' },
    { id: 'wrong-3', text: 'Wrong 3' },
  ],
  correctOptionId: 'correct',
  relatedWords: [`word-${index}`],
}))

const state = (): QuizState => ({
  questions: questions(),
  answers: [{ questionId: 'question-0', optionId: 'correct', correct: true, answeredAt: new Date(baseTime) }],
  currentQuestionIndex: 1,
  score: 1,
  completed: false,
  startedAt: new Date(baseTime),
})

const removeDatabase = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.deleteDatabase(name)
  request.onsuccess = () => resolve()
  request.onerror = () => reject(request.error)
  request.onblocked = () => resolve()
})

afterEach(async () => {
  for (const repository of repositories.splice(0)) await repository.close()
  for (const name of databaseNames) await removeDatabase(name)
  databaseNames.clear()
})

describe('IndexedDbQuizStateRepository', () => {
  it('round trips dates and nested quiz values defensively and deletes by session', async () => {
    const dbName = `lime-quiz-test-${Date.now()}-${Math.random()}`
    databaseNames.add(dbName)
    const repository = new IndexedDbQuizStateRepository({ dbName })
    repositories.push(repository)
    const original = state()

    await repository.save('session-1', original)
    const loaded = await repository.load('session-1')

    expect(loaded).toEqual(original)
    expect(loaded?.startedAt).not.toBe(original.startedAt)
    expect(loaded?.questions[0].options).not.toBe(original.questions[0].options)
    expect(loaded?.answers[0].answeredAt).not.toBe(original.answers[0].answeredAt)
    if (loaded === null) throw new Error('Expected quiz state')
    loaded.startedAt.setUTCDate(3)
    loaded.questions[0].relatedWords.push('mutated')
    loaded.answers[0].answeredAt.setUTCDate(4)
    await expect(repository.load('session-1')).resolves.toEqual(original)

    await repository.delete('session-1')
    await expect(repository.load('session-1')).resolves.toBeNull()
  })
})
