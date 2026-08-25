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

type AppProps = {
  initialRoute?: LimeRoute
}

const DEFAULT_REVIEW_LIMIT = 50
const DEFAULT_NEW_LIMIT = 20
const DEFAULT_LLM_CONFIG: LlmConfig = { endpoint: '', model: '', apiKey: '' }

const DEMO_REVIEW_POOL_SIZE = 72
const DEMO_NEW_POOL_SIZE = 28
const DEMO_BASE_TIME = new Date('2025-01-01T00:00:00.000Z')

function generateDemoCards(count: number, state: Card['state'], idPrefix: string): Card[] {
  const oneDay = 24 * 60 * 60 * 1000

  return Array.from({ length: count }, (_, index) => {
    const due = state === 'new'
      ? new Date(DEMO_BASE_TIME)
      : new Date(DEMO_BASE_TIME.getTime() + index * oneDay)

    return {
      id: `${idPrefix}${index}`,
      word: `${state}-${index}`,
      createdAt: new Date(DEMO_BASE_TIME),
      due,
      stability: 0,
      difficulty: 0,
      elapsedDays: 0,
      scheduledDays: 0,
      learningSteps: 0,
      reps: state === 'new' ? 0 : 1,
      lapses: 0,
      state,
    }
  })
}

export default function App({ initialRoute = 'today' }: AppProps) {
  const [route, setRoute] = useState<LimeRoute>(() => (isLimeRoute(initialRoute) ? initialRoute : 'today'))
  const [reviewLimit, setReviewLimit] = useState(DEFAULT_REVIEW_LIMIT)
  const [newLimit, setNewLimit] = useState(DEFAULT_NEW_LIMIT)
  const [llmConfig, setLlmConfig] = useState<LlmConfig>(DEFAULT_LLM_CONFIG)
  const navigate = useCallback((next: LimeRoute) => {
    if (isLimeRoute(next)) {
      setRoute(next)
    }
  }, [])

  const importApplication = useMemo(() => createDictionaryImportService(), [])

  useEffect(() => {
    const loaded = loadSettings()
    if (loaded === undefined) return

    if (loaded.reviewLimit !== undefined) {
      setReviewLimit(loaded.reviewLimit)
    }
    if (loaded.newLimit !== undefined) {
      setNewLimit(loaded.newLimit)
    }
    if (loaded.llmConfig !== undefined) {
      setLlmConfig(loaded.llmConfig)
    }
  }, [])

  useEffect(() => {
    saveSettings({ reviewLimit, newLimit, llmConfig })
  }, [reviewLimit, newLimit, llmConfig])

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

  const todayPlan = useMemo<TodayPlan>(() => {
    const dueCards = generateDemoCards(DEMO_REVIEW_POOL_SIZE, 'review', 'review-')
    const newCards = generateDemoCards(DEMO_NEW_POOL_SIZE, 'new', 'new-')

    return createTodayPlan({ dueCards, newCards, newLimit, reviewLimit })
  }, [newLimit, reviewLimit])

  const reviewCount = todayPlan.selectedCards.filter((card) => card.state !== 'new').length
  const newCount = todayPlan.selectedCards.filter((card) => card.state === 'new').length

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
        />
      )}
      {route === 'reading' && (
        <ReadingScreen
          client={client}
          contentProvider={contentProvider}
          todayPlan={todayPlan}
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
