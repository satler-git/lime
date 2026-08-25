import { useEffect, useState } from 'react'
import type { Card, CardId } from './domain/card'
import { normalizeWord } from './domain/word'
import type { TodayPlan } from './planning/today-plan'
import type { ReadingSession } from './session/types'
import type { CycleContent } from './content/types'
import { LearningSessionService, type ContentProvider } from './application/learning-session-service'
import type { CardService } from './application/card-service'
import type { CardRepository } from './repositories/card-repository'
import { ReviewService } from './review/review-service'
import { DictionaryService } from './dictionary/service'
import { IndexedDbReadingSessionRepository } from './persistence/indexed-db-reading-session-repository'
import { IndexedDbReviewActionRepository } from './persistence/indexed-db-review-action-repository'
import { IndexedDbQuizStateRepository } from './persistence/indexed-db-quiz-state-repository'
import { IndexedDbDictionaryRepository } from './dictionary/repository'
import type { WordKind } from './components/types'

export type UseLearningSessionOptions = {
  userId?: string
  todayPlan: TodayPlan
  contentProvider?: ContentProvider
  cardService?: CardService
  cardRepository?: CardRepository
  cycleIndex?: number
}

export type UseLearningSessionResult = {
  session?: ReadingSession
  content?: CycleContent
  application?: LearningSessionService
  isLoading: boolean
  error?: string
  isWordInSrs?: (word: string) => boolean
  cardIdForWord?: (word: string) => CardId | undefined
  targetWords?: Record<string, WordKind>
}

export function useLearningSession(options: UseLearningSessionOptions): UseLearningSessionResult {
  const { userId, todayPlan, contentProvider, cardService, cardRepository, cycleIndex = 0 } = options

  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [session, setSession] = useState<ReadingSession | undefined>(undefined)
  const [content, setContent] = useState<CycleContent | undefined>(undefined)
  const [application, setApplication] = useState<LearningSessionService | undefined>(undefined)
  const [isWordInSrs, setIsWordInSrs] = useState<((word: string) => boolean) | undefined>(undefined)
  const [cardIdForWord, setCardIdForWord] = useState<((word: string) => CardId | undefined) | undefined>(undefined)
  const [targetWords, setTargetWords] = useState<Record<string, WordKind> | undefined>(undefined)

  useEffect(() => {
    let cancelled = false

    setError(undefined)
    setSession(undefined)
    setContent(undefined)
    setApplication(undefined)
    setIsWordInSrs(undefined)
    setCardIdForWord(undefined)
    setTargetWords(undefined)

    if (globalThis.indexedDB == null) {
      setIsLoading(false)
      return
    }

    if (
      contentProvider === undefined ||
      cardService === undefined ||
      cardRepository === undefined
    ) {
      setIsLoading(false)
      return
    }

    if (todayPlan.cycles.length === 0) {
      setIsLoading(false)
      return
    }

    if (cycleIndex < 0 || cycleIndex >= todayPlan.cycles.length) {
      setError('指定されたサイクルが見つかりません')
      setIsLoading(false)
      return
    }

    setIsLoading(true)

    const initialize = async (): Promise<void> => {
      try {
        const readingSessionRepository = new IndexedDbReadingSessionRepository({ userId })
        const reviewActionRepository = new IndexedDbReviewActionRepository({ userId })
        const quizStateRepository = new IndexedDbQuizStateRepository({ userId })
        const dictionaryRepository = new IndexedDbDictionaryRepository({ userId })
        const dictionaryService = new DictionaryService(dictionaryRepository)
        const reviewService = new ReviewService(cardService, reviewActionRepository)

        const learningApp = new LearningSessionService({
          readingSessionRepository,
          reviewService,
          cardCreator: cardService,
          cardLoader: cardRepository,
          todayPlan,
          contentProvider,
          dictionaryResolver: dictionaryService,
          quizStateRepository,
        })

        const [startedSession, allCards] = await Promise.all([
          learningApp.startPlannedCycle(cycleIndex),
          cardRepository.loadAll(),
        ])

        if (cancelled) return

        const cycleContent = await learningApp.getContent(startedSession.id)

        if (cancelled) return

        const srsCardMap = new Map<string, Card>()
        for (const card of allCards) {
          const key = normalizeWord(card.word)
          if (!srsCardMap.has(key)) {
            srsCardMap.set(key, card)
          }
        }

        const cycleCards = todayPlan.cycles[cycleIndex]
        const sessionCardMap = new Map<string, Card>()
        const targetWordsRecord: Record<string, WordKind> = {}
        if (cycleCards !== undefined) {
          for (const card of cycleCards) {
            const key = normalizeWord(card.word)
            if (!sessionCardMap.has(key)) {
              sessionCardMap.set(key, card)
            }
            targetWordsRecord[key] = card.state === 'new' ? 'new' : 'review'
          }
        }

        if (!cancelled) {
          setApplication(learningApp)
          setSession(startedSession)
          setContent(cycleContent)
          setIsWordInSrs(() => (word: string) => srsCardMap.has(normalizeWord(word)))
          setCardIdForWord(() => (word: string) => sessionCardMap.get(normalizeWord(word))?.id)
          setTargetWords(targetWordsRecord)
          setIsLoading(false)
        }
      } catch (err: unknown) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
          setIsLoading(false)
        }
      }
    }

    void initialize()

    return () => {
      cancelled = true
    }
  }, [userId, todayPlan, contentProvider, cardService, cardRepository, cycleIndex])

  return {
    session,
    content,
    application,
    isLoading,
    error,
    isWordInSrs,
    cardIdForWord,
    targetWords,
  }
}
