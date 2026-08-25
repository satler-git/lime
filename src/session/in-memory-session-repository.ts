import { cloneReadingSession } from './session-service'
import type { ReadingSession } from './types'
import type { ReadingSessionRepository } from './repository'

/**
 * Small repository adapter for tests and local consumers. It clones on both
 * write and read so callers cannot mutate the stored snapshot by reference.
 */
export class InMemoryReadingSessionRepository implements ReadingSessionRepository {
  private readonly sessions = new Map<string, ReadingSession>()

  async save(session: ReadingSession): Promise<void> {
    this.sessions.set(session.id, cloneReadingSession(session))
  }

  async load(id: string): Promise<ReadingSession | null> {
    const session = this.sessions.get(id)
    return session === undefined ? null : cloneReadingSession(session)
  }

  async loadAll(): Promise<ReadingSession[]> {
    return [...this.sessions.values()].map(cloneReadingSession)
  }

  async delete(id: string): Promise<void> {
    this.sessions.delete(id)
  }

  clear(): void {
    this.sessions.clear()
  }
}
