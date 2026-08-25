import type { ReactNode } from 'react'
import type { LimeRoute } from '../routes'

type AppShellProps = {
  onNavigate: (route: LimeRoute) => void
  children: ReactNode
}

export function AppShell({ onNavigate, children }: AppShellProps) {
  return (
    <div className="min-h-screen bg-background text-text">
      <header
        className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-background px-5"
        aria-label="アプリヘッダー"
      >
        <button
          className="inline-flex h-11 items-center justify-center rounded-lg bg-transparent px-2 text-sm font-semibold tracking-[.12em] text-accent transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96]"
          type="button"
          aria-label="ホームに戻る"
          onClick={() => onNavigate('today')}
        >
          lime
        </button>
      </header>

      <div className="relative">{children}</div>
    </div>
  )
}
