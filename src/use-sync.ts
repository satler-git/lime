import { useEffect, useState } from 'react'
import { workerBaseUrl } from './config'
import type { CardRepository } from './repositories/card-repository'
import { IndexedDbReadingSessionRepository } from './persistence/indexed-db-reading-session-repository'
import { IndexedDbReviewActionRepository } from './persistence/indexed-db-review-action-repository'
import { createSyncClient, type SyncClient } from './sync/client'
import {
  deserializeCard,
  deserializeReadingSession,
  deserializeReviewAction,
  serializeCard,
  serializeReadingSession,
  serializeReviewAction,
  type SyncRequest,
} from './sync/types'

const PUSH_INTERVAL_MS = 30_000
const PULL_INTERVAL_MS = 300_000

const newerDate = (...dates: (Date | undefined)[]): Date => {
  const defined = dates.filter((date): date is Date => date !== undefined)
  return defined.reduce<Date>(
    (latest, date) => (date > latest ? date : latest),
    defined[0] ?? new Date(0),
  )
}

export type UseSyncOptions = {
  userId?: string
  cardRepository?: CardRepository
}

export type UseSyncResult = {
  isLoading: boolean
  lastPushedAt?: Date
  lastPulledAt?: Date
  error?: string
}

export function useSync({ userId, cardRepository }: UseSyncOptions): UseSyncResult {
  const [isLoading, setIsLoading] = useState(false)
  const [lastPushedAt, setLastPushedAt] = useState<Date | undefined>(undefined)
  const [lastPulledAt, setLastPulledAt] = useState<Date | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    setIsLoading(false)
    setError(undefined)
    setLastPushedAt(undefined)
    setLastPulledAt(undefined)

    if (
      globalThis.indexedDB == null ||
      typeof globalThis.fetch !== 'function' ||
      userId === undefined ||
      userId.length === 0 ||
      cardRepository === undefined
    ) {
      return
    }

    setIsLoading(true)

    const reviewActionRepository = new IndexedDbReviewActionRepository({ userId })
    const readingSessionRepository = new IndexedDbReadingSessionRepository({ userId })
    const controller = new AbortController()

    let cancelled = false
    let pushInterval: ReturnType<typeof setInterval> | undefined
    let pullInterval: ReturnType<typeof setInterval> | undefined
    let isBusy = false
    let client: SyncClient | undefined

    const buildSyncRequest = async (): Promise<SyncRequest> => {
      const [cards, reviewActions, sessions] = await Promise.all([
        cardRepository.loadAll(),
        reviewActionRepository.loadAll(),
        readingSessionRepository.loadAll(),
      ])
      return {
        cards: cards.map((card) => ({
          updatedAt: card.lastReview?.toISOString() ?? card.createdAt.toISOString(),
          card: serializeCard(card),
        })),
        reviewActions: reviewActions.map((action) => ({
          updatedAt: action.undoneAt === undefined
            ? action.timestamp.toISOString()
            : newerDate(action.timestamp, action.undoneAt).toISOString(),
          action: serializeReviewAction(action),
        })),
        sessions: sessions.map((session) => ({
          updatedAt: newerDate(
            session.completedAt,
            session.abandonedAt,
            session.quizStartedAt,
            session.startedAt,
            session.createdAt,
            ...session.lookupEvents.map((e) => e.timestamp),
          ).toISOString(),
          session: serializeReadingSession(session),
        })),
      }
    }

    const push = async (): Promise<void> => {
      if (cancelled || isBusy || client === undefined) return
      isBusy = true
      try {
        const request = await buildSyncRequest()
        if (cancelled) return
        await client.push(request, controller.signal)
        if (!cancelled) {
          setError(undefined)
          setLastPushedAt(new Date())
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        isBusy = false
      }
    }

    const pull = async (): Promise<void> => {
      if (cancelled || isBusy || client === undefined) return
      isBusy = true
      try {
        const response = await client.pull(controller.signal)
        if (cancelled) return
        for (const { card } of response.cards) {
          await cardRepository.save(deserializeCard(card))
        }
        for (const { action } of response.reviewActions) {
          await reviewActionRepository.save(deserializeReviewAction(action))
        }
        for (const { session } of response.sessions) {
          await readingSessionRepository.save(deserializeReadingSession(session))
        }
        if (!cancelled) {
          setError(undefined)
          setLastPulledAt(new Date())
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      } finally {
        isBusy = false
      }
    }

    const initial = async (): Promise<void> => {
      try {
        client = createSyncClient({ baseUrl: workerBaseUrl })
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setIsLoading(false)
        }
        return
      }

      await push()
      if (!cancelled) {
        await pull()
      }
      if (!cancelled) {
        setIsLoading(false)
        pushInterval = setInterval(() => { void push() }, PUSH_INTERVAL_MS)
        pullInterval = setInterval(() => { void pull() }, PULL_INTERVAL_MS)
      }
    }

    void initial()

    return () => {
      cancelled = true
      controller.abort()
      if (pushInterval !== undefined) {
        clearInterval(pushInterval)
      }
      if (pullInterval !== undefined) {
        clearInterval(pullInterval)
      }
      // Repository close() returns a Promise, but React effect cleanup must be
      // synchronous so we deliberately do not await it.
      void reviewActionRepository.close()
      void readingSessionRepository.close()
    }
  }, [userId, cardRepository])

  return { isLoading, lastPushedAt, lastPulledAt, error }
}
