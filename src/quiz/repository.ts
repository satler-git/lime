import type { QuizState } from './types'

/** Storage port for resumable quiz snapshots. */
export interface QuizStateRepository {
  save(sessionId: string, state: QuizState): Promise<void>
  load(sessionId: string): Promise<QuizState | null>
  delete(sessionId: string): Promise<void>
}
