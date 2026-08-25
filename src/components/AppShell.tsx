import { ArrowLeft, BookOpen, Settings } from 'lucide-react'
import type { ReactNode } from 'react'
import type { LimeRoute } from '../routes'

type AppShellProps = {
  route: LimeRoute
  onNavigate: (route: LimeRoute) => void
  children: ReactNode
}

type TabItem = {
  route: Extract<LimeRoute, 'today' | 'settings'>
  label: string
  icon: typeof BookOpen
}

const tabs: TabItem[] = [
  { route: 'today', label: '今日', icon: BookOpen },
  { route: 'settings', label: '設定', icon: Settings },
]

export function AppShell({ route, onNavigate, children }: AppShellProps) {
  const canGoBack = route !== 'today'

  return (
    <div className="min-h-screen bg-background text-text">
      <header
        className="sticky top-0 z-10 flex h-14 items-center justify-between border-b border-line bg-background px-5"
        aria-label="アプリヘッダー"
      >
        <span className="text-sm font-semibold tracking-[.12em] text-accent">lime</span>
        {canGoBack && (
          <button
            className="inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent text-text-muted transition-[background-color,color,transform] duration-120 hover:bg-surface-hover hover:text-text active:scale-[.96]"
            type="button"
            aria-label="今日の学習に戻る"
            onClick={() => onNavigate('today')}
          >
            <ArrowLeft size={20} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </header>

      <div className="relative pb-20">{children}</div>

      <nav
        className="fixed bottom-0 left-0 right-0 z-10 h-16 border-t border-line bg-background px-6"
        aria-label="タブナビゲーション"
      >
        <div className="mx-auto flex h-full max-w-[720px]">
          {tabs.map((tab) => {
            const active = route === tab.route
            const Icon = tab.icon
            return (
              <button
                key={tab.route}
                className={`flex h-full w-full flex-1 cursor-pointer items-center justify-center gap-2 rounded-none border-0 bg-transparent text-sm font-medium transition-[background-color,color,transform] duration-120 active:scale-[.98] ${active ? 'bg-surface-raised text-accent' : 'text-text-muted hover:bg-surface-hover hover:text-text'}`}
                type="button"
                aria-label={tab.label}
                aria-current={active ? 'page' : undefined}
                onClick={() => onNavigate(tab.route)}
              >
                <Icon size={18} strokeWidth={1.8} aria-hidden="true" />
                <span>{tab.label}</span>
              </button>
            )
          })}
        </div>
      </nav>
    </div>
  )
}
