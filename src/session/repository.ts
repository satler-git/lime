import type { ReadingSession } from './types'

/** Storage port for reading-session snapshots. */
export interface ReadingSessionRepository {
  save(session: ReadingSession): Promise<void>
  load(id: string): Promise<ReadingSession | null>
  loadAll(): Promise<ReadingSession[]>
}
