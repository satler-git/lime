import { cloneQuizState } from './quiz-service'
import type { QuizState } from './types'
import type { QuizStateRepository } from './repository'

/** Test/local repository that isolates both writes and reads from stored state. */
export class InMemoryQuizStateRepository implements QuizStateRepository {
  private readonly states = new Map<string, QuizState>()

  async save(sessionId: string, state: QuizState): Promise<void> {
    this.states.set(sessionId, cloneQuizState(state))
  }

  async load(sessionId: string): Promise<QuizState | null> {
    const state = this.states.get(sessionId)
    return state === undefined ? null : cloneQuizState(state)
  }

  async delete(sessionId: string): Promise<void> {
    this.states.delete(sessionId)
  }

  clear(): void {
    this.states.clear()
  }
}
