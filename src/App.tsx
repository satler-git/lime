import { useCallback, useState } from 'react'
import { AppShell } from './components/AppShell'
import { ReadingScreen } from './components/ReadingScreen'
import { SettingsScreen } from './components/SettingsScreen'
import { TodayOverview } from './components/TodayOverview'
import { isLimeRoute, type LimeRoute } from './routes'

type AppProps = {
  initialRoute?: LimeRoute
}

export default function App({ initialRoute = 'today' }: AppProps) {
  const [route, setRoute] = useState<LimeRoute>(() => (isLimeRoute(initialRoute) ? initialRoute : 'today'))
  const navigate = useCallback((next: LimeRoute) => {
    if (isLimeRoute(next)) {
      setRoute(next)
    }
  }, [])

  return (
    <AppShell route={route} onNavigate={navigate}>
      {route === 'today' && (
        <TodayOverview
          onStartReading={() => navigate('reading')}
          onOpenSettings={() => navigate('settings')}
        />
      )}
      {route === 'reading' && <ReadingScreen />}
      {route === 'settings' && <SettingsScreen />}
    </AppShell>
  )
}
