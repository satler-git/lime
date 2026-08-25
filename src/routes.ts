export type LimeRoute = 'today' | 'reading' | 'settings' | 'cards'

export const LIME_ROUTES: readonly LimeRoute[] = ['today', 'reading', 'settings', 'cards']

export const LIME_ROUTE_PATHS: Record<LimeRoute, `/${string}`> = {
  today: '/today',
  reading: '/reading',
  settings: '/settings',
  cards: '/cards',
}

export function isLimeRoute(value: unknown): value is LimeRoute {
  return typeof value === 'string' && (LIME_ROUTES as readonly string[]).includes(value)
}

export function limeRouteToPath(route: LimeRoute): `/${string}` {
  return LIME_ROUTE_PATHS[route]
}

export function pathToLimeRoute(path: string): LimeRoute | undefined {
  if (path === '') return undefined
  const normalized = path.replace(/\/+$/, '') || '/'
  if (normalized === '/') return 'today'
  for (const route of LIME_ROUTES) {
    if (LIME_ROUTE_PATHS[route] === normalized) {
      return route
    }
  }
  return undefined
}
