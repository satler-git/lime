export type LimeRoute = 'today' | 'reading' | 'settings' | 'cards'

export const LIME_ROUTES: readonly LimeRoute[] = ['today', 'reading', 'settings', 'cards']

export function isLimeRoute(value: unknown): value is LimeRoute {
  return typeof value === 'string' && (LIME_ROUTES as readonly string[]).includes(value)
}
