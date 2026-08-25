import { Settings } from 'lucide-react'

export function SettingsScreen() {
  return (
    <main className="mx-auto w-full max-w-[720px] px-5 py-8 sm:px-8 sm:py-12" aria-labelledby="settings-title">
      <div className="flex items-center gap-2 text-xs font-semibold tracking-[.08em] text-text-muted">
        <Settings size={16} strokeWidth={1.8} aria-hidden="true" />
        <span>設定</span>
      </div>
      <h1 id="settings-title" className="m-0 mt-2 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">
        設定
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-text-muted">
        設定画面は UI Unit 3 で実装予定です。
      </p>
    </main>
  )
}
