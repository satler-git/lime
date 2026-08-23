import { cloneCard } from '../domain/card'
import type { ReviewAction, ReviewActionRepository } from './types'

/** Clone action snapshots so an action remains safe to use for undo. */
export function cloneReviewAction(action: ReviewAction): ReviewAction {
  return {
    ...action,
    timestamp: new Date(action.timestamp),
    previousState: cloneCard(action.previousState),
    nextState: cloneCard(action.nextState),
    ...(action.undoneAt === undefined ? {} : { undoneAt: new Date(action.undoneAt) }),
  }
}

/** In-memory action store for local use and tests. */
export class InMemoryReviewActionRepository implements ReviewActionRepository {
  private readonly actions = new Map<string, ReviewAction>()

  async save(action: ReviewAction): Promise<void> {
    this.actions.set(action.id, cloneReviewAction(action))
  }

  async load(id: string): Promise<ReviewAction | null> {
    const action = this.actions.get(id)
    return action === undefined ? null : cloneReviewAction(action)
  }

  async findLatestNonUndone(sessionId: string, cardId: string): Promise<ReviewAction | null> {
    let latest: ReviewAction | undefined

    for (const action of this.actions.values()) {
      if (action.sessionId !== sessionId || action.cardId !== cardId || action.undone) {
        continue
      }

      // Select by timestamp first, then use the action ID so all repository
      // implementations make the same deterministic choice on a tie.
      if (
        latest === undefined
        || action.timestamp.getTime() > latest.timestamp.getTime()
        || (action.timestamp.getTime() === latest.timestamp.getTime() && action.id > latest.id)
      ) {
        latest = action
      }
    }

    return latest === undefined ? null : cloneReviewAction(latest)
  }

  /** Useful for inspecting action history without exposing stored references. */
  async loadAll(): Promise<ReviewAction[]> {
    return [...this.actions.values()].map(cloneReviewAction)
  }

  clear(): void {
    this.actions.clear()
  }
}
