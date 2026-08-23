import { Brain, Sparkles } from 'lucide-react'

type WordCountSummaryProps = {
  reviewCount?: number
  newCount?: number
}

export function WordCountSummary({ reviewCount = 72, newCount = 28 }: WordCountSummaryProps) {
  return (
    <section aria-labelledby="word-count-title">
      <h2 id="word-count-title" className="m-0 text-xs font-semibold tracking-[.08em] text-text-muted">今日の単語</h2>
      <div className="mt-3 grid grid-cols-2 gap-3">
        <div className="rounded-[10px] border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-xs text-text-muted"><Brain size={16} strokeWidth={1.8} aria-hidden="true" />復習</div>
          <strong className="mt-3 block text-2xl font-semibold text-text">{reviewCount}<span className="ml-1 text-xs font-normal text-text-faint">語</span></strong>
        </div>
        <div className="rounded-[10px] border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-xs text-text-muted"><Sparkles size={16} strokeWidth={1.8} aria-hidden="true" />新出</div>
          <strong className="mt-3 block text-2xl font-semibold text-text">{newCount}<span className="ml-1 text-xs font-normal text-text-faint">語</span></strong>
        </div>
      </div>
    </section>
  )
}
