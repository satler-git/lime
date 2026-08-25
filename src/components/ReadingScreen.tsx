import { BookOpen } from 'lucide-react'

export function ReadingScreen() {
  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="reading-title">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <BookOpen size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>読解</span>
      </div>
      <h1 id="reading-title" className="m-0 mt-2 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
        読解を始める
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-muted">
        この画面には後ほど <strong className="text-text">ReadingFlow</strong> が組み込まれます。
      </p>
    </main>
  )
}
