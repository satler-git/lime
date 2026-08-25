export type LimeRoute = 'today' | 'reading' | 'settings'

export const LIME_ROUTES: readonly LimeRoute[] = ['today', 'reading', 'settings']

export function isLimeRoute(value: unknown): value is LimeRoute {
  return typeof value === 'string' && (LIME_ROUTES as readonly string[]).includes(value)
}
