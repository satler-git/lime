import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import App from './App'
import { AuthProvider } from './auth'
import { isLimeRoute, LIME_ROUTES } from './routes'

describe('App routing', () => {
  it('starts on the today overview', () => {
    const html = renderToStaticMarkup(<AuthProvider><App /></AuthProvider>)
    expect(html).toContain('今日の学習')
    expect(html).toContain('読解を始める')
  })

  it('renders the AppShell with a home button', () => {
    const html = renderToStaticMarkup(<AuthProvider><App /></AuthProvider>)
    expect(html).toContain('lime')
    expect(html).toContain('aria-label="ホームに戻る"')
    expect(html).not.toContain('aria-label="タブナビゲーション"')
  })

  it.each(['today' as const, 'reading' as const, 'settings' as const, 'cards' as const])('renders the %s route', (route) => {
    const html = renderToStaticMarkup(<AuthProvider><App initialRoute={route} /></AuthProvider>)
    if (route === 'today') {
      expect(html).toContain('今日の学習')
      expect(html).toContain('読解を始める')
    } else if (route === 'reading') {
      expect(html).toContain('読解')
      expect(html).toContain('ReadingFlow')
      expect(html).toContain('aria-label="ホームに戻る"')
    } else if (route === 'cards') {
      expect(html).toContain('カードを追加・管理')
      expect(html).toContain('カード管理')
      expect(html).toContain('aria-label="ホームに戻る"')
    } else {
      expect(html).toContain('設定')
      expect(html).toContain('Import')
      expect(html).toContain('aria-label="ホームに戻る"')
    }
  })

  it('falls back to today for an unknown initial route', () => {
    const html = renderToStaticMarkup(<AuthProvider><App initialRoute={'invalid' as unknown as 'today'} /></AuthProvider>)
    expect(html).toContain('今日の学習')
    expect(html).toContain('lime')
  })
})

describe('routes', () => {
  it('exposes the valid routes', () => {
    expect(LIME_ROUTES).toEqual(['today', 'reading', 'settings', 'cards'])
  })

  it('validates known and unknown route values', () => {
    expect(isLimeRoute('today')).toBe(true)
    expect(isLimeRoute('reading')).toBe(true)
    expect(isLimeRoute('settings')).toBe(true)
    expect(isLimeRoute('cards')).toBe(true)
    expect(isLimeRoute('home')).toBe(false)
    expect(isLimeRoute(42)).toBe(false)
    expect(isLimeRoute(undefined)).toBe(false)
  })
})
