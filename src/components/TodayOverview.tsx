import { Settings2 } from 'lucide-react'
import { ReadingProgress } from './ReadingProgress'
import { StartReadingButton } from './StartReadingButton'
import { WordCountSummary } from './WordCountSummary'

type RecentSession = {
  cycle: number
  title: string
  words: number
  score?: string
}

type TodayOverviewProps = {
  todayTarget?: number
  todayCompleted?: number
  cycle?: number
  totalCycles?: number
  reviewCount?: number
  newCount?: number
  reviewLimit?: number
  newLimit?: number
  recentSessions?: RecentSession[]
  isStartButtonDisabled?: boolean
  onStartReading?: () => void
  onOpenSettings?: () => void
  onReviewLimitChange?: (limit: number) => void
  onNewLimitChange?: (limit: number) => void
}

const defaultRecentSessions: RecentSession[] = [
  { cycle: 1, title: 'A city built around water', words: 15, score: '4 / 5' },
]

export function TodayOverview({
  todayTarget = 100,
  todayCompleted = 42,
  cycle = 2,
  totalCycles = 7,
  reviewCount = 72,
  newCount = 28,
  reviewLimit,
  newLimit,
  recentSessions = defaultRecentSessions,
  isStartButtonDisabled = false,
  onStartReading,
  onOpenSettings,
  onReviewLimitChange,
  onNewLimitChange,
}: TodayOverviewProps) {
  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="today-overview-title">
      <header className="flex items-start justify-between gap-4">
        <div>
          <p className="m-0 text-xs font-semibold tracking-[.1em] text-accent">LIME</p>
          <h1 id="today-overview-title" className="m-0 mt-2 font-serif text-[clamp(36px,8vw,52px)] font-normal leading-none tracking-[-.04em]">今日の学習</h1>
        </div>
        <button className="inline-flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-text-muted transition-[background-color,transform] duration-120 hover:bg-surface-hover hover:text-text active:scale-[.96]" type="button" aria-label="設定を開く" onClick={onOpenSettings}><Settings2 size={19} strokeWidth={1.8} aria-hidden="true" /></button>
      </header>
      <div className="mt-9 grid gap-6">
        <ReadingProgress cycle={cycle} totalCycles={totalCycles} todayTarget={todayTarget} todayCompleted={todayCompleted} />
        <WordCountSummary
          reviewCount={reviewCount}
          newCount={newCount}
          reviewLimit={reviewLimit}
          newLimit={newLimit}
          onReviewLimitChange={onReviewLimitChange}
          onNewLimitChange={onNewLimitChange}
        />
        <StartReadingButton onClick={onStartReading} disabled={isStartButtonDisabled} />
        <section aria-labelledby="recent-sessions-title">
          <div className="flex items-center justify-between"><h2 id="recent-sessions-title" className="m-0 text-xs font-semibold tracking-[.08em] text-text-muted">最近の学習</h2><span className="text-xs text-text-faint">今日</span></div>
          <div className="mt-3 divide-y divide-line border-y border-line">
            {recentSessions.map((session) => <div className="flex items-center justify-between gap-4 py-3 text-sm" key={session.cycle}><div className="min-w-0"><p className="m-0 truncate text-text">{session.title}</p><p className="m-0 mt-1 text-xs text-text-faint">{session.cycle}セット目 · {session.words}語</p></div>{session.score && <span className="shrink-0 tabular-nums text-xs text-text-muted">{session.score}</span>}</div>)}
          </div>
        </section>
      </div>
    </main>
  )
}
