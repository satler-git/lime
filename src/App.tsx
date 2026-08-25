import { useCallback, useEffect, useMemo, useState } from 'react'
import { AppShell } from './components/AppShell'
import { ReadingScreen } from './components/ReadingScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { TodayOverview } from './components/TodayOverview'
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
import { isLimeRoute, type LimeRoute } from './routes'
import { loadSettings, saveSettings, type LlmConfig } from './settings-storage'
import { useAuth } from './auth'
import { useCardService } from './use-card-service'
import { useLimits } from './use-limits'
import { useSync } from './use-sync'
import { useTelemetryQueue } from './use-telemetry-queue'

export type AppProps = {
  initialRoute?: LimeRoute
}

const DEFAULT_LLM_CONFIG: LlmConfig = { endpoint: '', model: '', apiKey: '' }

export default function App({ initialRoute = 'today' }: AppProps) {
  const [route, setRoute] = useState<LimeRoute>(() => (isLimeRoute(initialRoute) ? initialRoute : 'today'))
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG)
  const navigate = useCallback((next: LimeRoute) => {
    if (isLimeRoute(next)) {
      setRoute(next)
    }
  }, [])

  const { user, isLoading: isAuthLoading } = useAuth()
  const { reviewLimit, newLimit, setReviewLimit, setNewLimit } = useLimits(user, isAuthLoading)
  const userId = user?.id
  const { cardService, repository: cardRepository, isLoading: isCardLoading } = useCardService(userId)
  useSync({ userId, cardRepository })
  const telemetry = useTelemetryQueue(userId)
  const importApplication = useMemo(() => createDictionaryImportService(userId), [userId])

  const [dueCards, setDueCards] = useState<Card[]>([])
  const [newCards, setNewCards] = useState<Card[]>([])

  useEffect(() => {
    const loaded = loadSettings()
    if (loaded?.llmConfig !== undefined) {
      setLlmConfig(loaded.llmConfig)
    }
  }, [])

  useEffect(() => {
    saveSettings({ reviewLimit, newLimit, llmConfig })
  }, [reviewLimit, newLimit, llmConfig])

  useEffect(() => {
    setDueCards([])
    setNewCards([])

    if (cardService === undefined || cardRepository === undefined) {
      return
    }

    let cancelled = false
    const loadCards = async (): Promise<void> => {
      try {
        const now = new Date()
        const all = await cardRepository.loadAll()
        if (cancelled) return
        setDueCards(
          all
            .filter((card) => card.due.getTime() <= now.getTime())
            .sort((a, b) => a.due.getTime() - b.due.getTime()),
        )
        setNewCards(all.filter((card) => card.state === 'new'))
      } catch {
        if (!cancelled) {
          setDueCards([])
          setNewCards([])
        }
      }
    }

    void loadCards()
    return () => { cancelled = true }
  }, [cardService, cardRepository])

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

  const reviewCount = todayPlan.selectedCards.filter((card) => card.state !== 'new').length
  const newCount = todayPlan.selectedCards.filter((card) => card.state === 'new').length
  const isStartButtonDisabled = isCardLoading || todayPlan.selectedCards.length === 0 || contentProvider === undefined

  return (
    <AppShell route={route} onNavigate={navigate}>
      {route === 'today' && (
        <TodayOverview
          reviewCount={reviewCount}
          newCount={newCount}
          reviewLimit={reviewLimit}
          newLimit={newLimit}
          todayTarget={Math.max(1, todayPlan.selectedCards.length)}
          todayCompleted={0}
          cycle={todayPlan.cycles.length > 0 ? 1 : 0}
          totalCycles={Math.max(1, todayPlan.cycles.length)}
          onReviewLimitChange={setReviewLimit}
          onNewLimitChange={setNewLimit}
          onStartReading={() => navigate('reading')}
          onOpenSettings={() => navigate('settings')}
          isStartButtonDisabled={isStartButtonDisabled}
        />
      )}
      {route === 'reading' && (
        <ReadingScreen
          todayPlan={todayPlan}
          contentProvider={contentProvider}
          cardService={cardService}
          cardRepository={cardRepository}
          userId={userId}
          telemetry={telemetry}
        />
      )}
      {route === 'settings' && (
        <SettingsScreen
          reviewLimit={reviewLimit}
          newLimit={newLimit}
          onReviewLimitChange={setReviewLimit}
          onNewLimitChange={setNewLimit}
          llmConfig={llmConfig}
          onLlmConfigChange={setLlmConfig}
          importApplication={importApplication}
        />
      )}
    </AppShell>
  )
}
