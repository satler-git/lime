import { BookOpen } from 'lucide-react'
import type { TodayPlan } from '../planning/today-plan'
import type { ContentProvider } from '../application/learning-session-service'
import type { CardService } from '../application/card-service'
import type { CardRepository } from '../repositories/card-repository'
import type { TelemetryTransport } from '../telemetry/client'
import { useLearningSession } from '../use-learning-session'
import { ReadingFlow, type ReadingFlowCompleteResult } from './ReadingFlow'
import { dictionaryAdapter } from './dictionary-adapter'

type ReadingScreenProps = {
  todayPlan: TodayPlan
  contentProvider?: ContentProvider
  cardService?: CardService
  cardRepository?: CardRepository
  userId?: string
  telemetry?: TelemetryTransport
  cycleIndex?: number
  onSessionComplete?: (result: ReadingFlowCompleteResult) => void
}

function Placeholder() {
  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="reading-title">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <BookOpen size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>読解</span>
      </div>
      <h1 id="reading-title" className="m-0 mt-4 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
        読解を始める
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-muted">
        読解セッションを準備しています…
      </p>
    </main>
  )
}

function ErrorState({ error }: { error: string }) {
  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="reading-title">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <BookOpen size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>読解</span>
      </div>
      <h1 id="reading-title" className="m-0 mt-4 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
        読解を始める
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-muted" role="alert">
        読解を開始できませんでした: {error}
      </p>
    </main>
  )
}

export function ReadingScreen({
  todayPlan,
  contentProvider,
  cardService,
  cardRepository,
  userId,
  telemetry,
  cycleIndex = 0,
  onSessionComplete,
}: ReadingScreenProps) {
  const {
    session,
    content,
    application,
    isLoading,
    error,
    isWordInSrs,
    cardIdForWord,
    targetWords,
  } = useLearningSession({
    userId,
    todayPlan,
    contentProvider,
    cardService,
    cardRepository,
    cycleIndex,
  })

  if (error !== undefined) {
    return <ErrorState error={error} />
  }

  if (isLoading) {
    return <Placeholder />
  }

  if (session !== undefined && content !== undefined && application !== undefined) {
    return (
      <ReadingFlow
        session={session}
        content={content}
        title="読解"
        application={application}
        cycle={cycleIndex + 1}
        totalCycles={todayPlan.cycles.length}
        targetWords={targetWords}
        dictionaryAdapter={dictionaryAdapter}
        isWordInSrs={isWordInSrs}
        cardIdForWord={cardIdForWord}
        telemetry={telemetry}
        onSessionComplete={onSessionComplete}
      />
    )
  }

  return <Placeholder />
}
