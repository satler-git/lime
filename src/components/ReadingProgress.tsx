import { BookOpen } from 'lucide-react'

type ReadingProgressProps = {
  cycle?: number
  totalCycles?: number
  todayTarget?: number
  todayCompleted?: number
}

export function ReadingProgress({ cycle = 2, totalCycles = 7, todayTarget = 100, todayCompleted = 42 }: ReadingProgressProps) {
  const progress = Math.min(100, Math.round((todayCompleted / todayTarget) * 100))

  return (
    <section className="relative max-w-[420px] rounded-[10px] border border-line bg-surface p-4" aria-labelledby="reading-progress-title">
      <div className="flex items-center gap-2 text-xs text-text-muted"><BookOpen size={16} strokeWidth={1.8} aria-hidden="true" /><span id="reading-progress-title">今日の読解</span></div>
      <div className="mt-2.5 flex items-baseline gap-3"><strong className="text-lg font-semibold text-text">{todayCompleted} / {todayTarget}語</strong><span className="text-xs text-text-muted">{cycle} / {totalCycles}セット</span></div>
      <div className="mt-[13px] block h-[5px] w-full overflow-hidden rounded-full bg-line" role="progressbar" aria-valuenow={todayCompleted} aria-valuemin={0} aria-valuemax={todayTarget} aria-label={`今日の読解 ${todayCompleted} / ${todayTarget}語`}><span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${progress}%` }} /></div>
    </section>
  )
}
