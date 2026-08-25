import { useCallback, useEffect, useMemo, useState } from 'react'
import { Route, Routes, useNavigate } from 'react-router-dom'
import { AppShell } from './components/AppShell'
import { CardManagerView } from './components/CardManagerView'
import { ReadingScreen } from './components/ReadingScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { TodayOverview, type RecentSession } from './components/TodayOverview'
import { type ReadingFlowCompleteResult } from './components/ReadingFlow'
import {
  createCycleContentProvider,
  createGenerationSpecFactory,
  createOpenAICompatibleClient,
  type CycleContentProvider,
  type TextGenerationClient,
} from './content'
import { createDictionaryImportService } from './import-service'
import type { Card } from './domain/card'
import { createTodayPlan, type TodayPlan } from './planning/today-plan'
import { isLimeRoute, limeRouteToPath, type LimeRoute } from './routes'
import { loadSettings, saveSettings, type LlmConfig } from './settings-storage'
import { useAuth } from './auth'
import { useCardService } from './use-card-service'
import { useLimits } from './use-limits'
import { useSync } from './use-sync'
import { useTelemetryQueue } from './use-telemetry-queue'

const DEFAULT_LLM_CONFIG: LlmConfig = { endpoint: '', model: '', apiKey: '' }
const PLAN_PROGRESS_KEY = 'lime-today-progress'

type StoredProgress = {
  planKey: string
  currentCycleIndex: number
  completedSessions: RecentSession[]
}

function planKey(plan: TodayPlan): string {
  return `${plan.selectedCards.map((card) => card.id).sort().join(',')}:${plan.cycles.length}`
}

function loadStoredProgress(): StoredProgress | undefined {
  try {
    const raw = localStorage.getItem(PLAN_PROGRESS_KEY)
    if (raw === null) return undefined
    const parsed = JSON.parse(raw) as unknown
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const candidate = parsed as Partial<StoredProgress>
    if (
      typeof candidate.planKey !== 'string' ||
      typeof candidate.currentCycleIndex !== 'number' ||
      !Array.isArray(candidate.completedSessions)
    ) {
      return undefined
    }
    return {
      planKey: candidate.planKey,
      currentCycleIndex: candidate.currentCycleIndex,
      completedSessions: candidate.completedSessions as RecentSession[],
    }
  } catch {
    return undefined
  }
}

function saveStoredProgress(progress: StoredProgress): void {
  try {
    localStorage.setItem(PLAN_PROGRESS_KEY, JSON.stringify(progress))
  } catch {
    // Ignore private-browsing / storage quota errors.
  }
}

function useLimeNavigate(): (route: LimeRoute) => void {
  const navigate = useNavigate()
  return useCallback((route: LimeRoute) => {
    if (isLimeRoute(route)) {
      navigate(limeRouteToPath(route))
    }
  }, [navigate])
}

function useNavigateBack(fallback = '/today'): () => void {
  const navigate = useNavigate()
  return useCallback(() => {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      navigate(-1)
    } else {
      navigate(fallback)
    }
  }, [navigate, fallback])
}

export default function App() {
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG)
  const limeNavigate = useLimeNavigate()
  const navigateBack = useNavigateBack()

  const { user, isLoading: isAuthLoading } = useAuth()
  const { reviewLimit, newLimit, setReviewLimit, setNewLimit, isLoading: isLimitsLoading } = useLimits(user, isAuthLoading)
  const userId = user?.id
  const { cardService, repository: cardRepository, isLoading: isCardLoading } = useCardService(userId)
  const { error: syncError } = useSync({ userId, cardRepository })
  const { queue: telemetry, error: telemetryError } = useTelemetryQueue(userId)
  const importApplication = useMemo(() => createDictionaryImportService(userId), [userId])

  const [dueCards, setDueCards] = useState<Card[]>([])
  const [newCards, setNewCards] = useState<Card[]>([])
  const [currentCycleIndex, setCurrentCycleIndex] = useState(0)
  const [completedSessions, setCompletedSessions] = useState<RecentSession[]>([])

  useEffect(() => {
    const loaded = loadSettings()
    if (loaded?.llmConfig !== undefined) {
      setLlmConfig(loaded.llmConfig)
    }
  }, [])

  useEffect(() => {
    saveSettings({ reviewLimit, newLimit, llmConfig })
  }, [reviewLimit, newLimit, llmConfig])

  const loadCards = useCallback(async (signal?: AbortSignal): Promise<void> => {
    if (cardService === undefined || cardRepository === undefined) {
      setDueCards([])
      setNewCards([])
      return
    }

    try {
      const now = new Date()
      const all = await cardRepository.loadAll()
      if (signal?.aborted) return
      setDueCards(
        all
          .filter((card) => card.due.getTime() <= now.getTime())
          .sort((a, b) => a.due.getTime() - b.due.getTime()),
      )
      setNewCards(all.filter((card) => card.state === 'new'))
    } catch {
      if (signal?.aborted) return
      setDueCards([])
      setNewCards([])
    }
  }, [cardService, cardRepository])

  useEffect(() => {
    setDueCards([])
    setNewCards([])
    if (cardService === undefined || cardRepository === undefined) return
    const controller = new AbortController()
    void loadCards(controller.signal)
    return () => { controller.abort() }
  }, [cardService, cardRepository, loadCards])

  const client = useMemo<TextGenerationClient | undefined>(() => {
    if (
      llmConfig.endpoint.trim().length > 0 &&
      llmConfig.model.trim().length > 0 &&
      llmConfig.apiKey.length > 0
    ) {
      return createOpenAICompatibleClient(llmConfig)
    }
    return undefined
  }, [llmConfig])

  const contentProvider = useMemo<CycleContentProvider | undefined>(() => {
    if (client === undefined) return undefined

    const specFactory = createGenerationSpecFactory({
      context: {
        theme: 'daily life',
        style: 'clear magazine prose',
        articleWordTarget: 500,
      },
    })

    return createCycleContentProvider(client, specFactory)
  }, [client])

  const todayPlan = useMemo<TodayPlan>(() => (
    createTodayPlan({ dueCards, newCards, newLimit, reviewLimit })
  ), [dueCards, newCards, newLimit, reviewLimit])

  useEffect(() => {
    if (todayPlan.selectedCards.length === 0) {
      setCurrentCycleIndex(0)
      setCompletedSessions([])
      return
    }
    const stored = loadStoredProgress()
    const key = planKey(todayPlan)
    if (stored?.planKey === key) {
      setCurrentCycleIndex(Math.min(stored.currentCycleIndex, todayPlan.cycles.length))
      setCompletedSessions(stored.completedSessions)
    } else {
      setCurrentCycleIndex(0)
      setCompletedSessions([])
    }
  }, [todayPlan])

  useEffect(() => {
    if (todayPlan.selectedCards.length === 0) return
    saveStoredProgress({
      planKey: planKey(todayPlan),
      currentCycleIndex,
      completedSessions,
    })
  }, [todayPlan, currentCycleIndex, completedSessions])

  const handleSessionComplete = useCallback((result: ReadingFlowCompleteResult) => {
    setCompletedSessions((prev) => [
      ...prev,
      {
        cycle: result.cycle,
        title: result.title,
        words: result.words,
        score: result.score === undefined ? undefined : `${result.score} / ${result.totalQuestions ?? 5}問 正解`,
      },
    ])
    if (result.cycle < todayPlan.cycles.length) {
      setCurrentCycleIndex(result.cycle)
    } else {
      setCurrentCycleIndex(todayPlan.cycles.length)
      limeNavigate('today')
    }
  }, [todayPlan, limeNavigate])

  const reviewCount = todayPlan.selectedCards.filter((card) => card.state !== 'new').length
  const newCount = todayPlan.selectedCards.filter((card) => card.state === 'new').length
  const isStartButtonDisabled = isCardLoading || isLimitsLoading || todayPlan.selectedCards.length === 0 || contentProvider === undefined || currentCycleIndex >= todayPlan.cycles.length

  const todayCompleted = useMemo(() => {
    const completed = completedSessions.reduce((sum, session) => sum + session.words, 0)
    return Math.min(completed, Math.max(1, todayPlan.selectedCards.length))
  }, [completedSessions, todayPlan.selectedCards.length])

  const recentSessions = useMemo(() => completedSessions, [completedSessions])
  const totalCycles = Math.max(1, todayPlan.cycles.length)
  const cycle = Math.min(currentCycleIndex + 1, totalCycles)

  const todayOverview = (
    <TodayOverview
      reviewCount={reviewCount}
      newCount={newCount}
      reviewLimit={reviewLimit}
      newLimit={newLimit}
      todayTarget={Math.max(1, todayPlan.selectedCards.length)}
      todayCompleted={todayCompleted}
      cycle={cycle}
      totalCycles={totalCycles}
      recentSessions={recentSessions}
      isLoading={isLimitsLoading}
      isStartButtonDisabled={isStartButtonDisabled}
      syncError={syncError}
      telemetryError={telemetryError?.message}
      onReviewLimitChange={setReviewLimit}
      onNewLimitChange={setNewLimit}
      onStartReading={() => limeNavigate('reading')}
      onOpenSettings={() => limeNavigate('settings')}
      onOpenCards={() => limeNavigate('cards')}
      cardService={cardService}
    />
  )

  const readingScreen = (
    <ReadingScreen
      todayPlan={todayPlan}
      contentProvider={contentProvider}
      cardService={cardService}
      cardRepository={cardRepository}
      userId={userId}
      telemetry={telemetry}
      cycleIndex={currentCycleIndex}
      onSessionComplete={handleSessionComplete}
    />
  )

  const settingsScreen = (
    <SettingsScreen
      reviewLimit={reviewLimit}
      newLimit={newLimit}
      onReviewLimitChange={setReviewLimit}
      onNewLimitChange={setNewLimit}
      llmConfig={llmConfig}
      onLlmConfigChange={setLlmConfig}
      importApplication={importApplication}
      onBack={navigateBack}
    />
  )

  const cardsScreen = (
    <CardManagerView
      cardService={cardService}
      dictionaryApplication={importApplication}
      onBack={navigateBack}
      onCardsChanged={() => { void loadCards() }}
    />
  )

  return (
    <AppShell onNavigate={limeNavigate}>
      <Routes>
        <Route path="/" element={todayOverview} />
        <Route path={limeRouteToPath('today')} element={todayOverview} />
        <Route path={limeRouteToPath('reading')} element={readingScreen} />
        <Route path={limeRouteToPath('settings')} element={settingsScreen} />
        <Route path={limeRouteToPath('cards')} element={cardsScreen} />
        <Route path="*" element={todayOverview} />
      </Routes>
    </AppShell>
  )
}
