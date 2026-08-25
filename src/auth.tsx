import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AuthClientError, createAuthClient, type AuthClient, type AuthUser } from './worker/auth/client'
import { workerBaseUrl } from './config'

type AuthState = {
  user: AuthUser | null
  isLoading: boolean
  error: Error | null
  login: () => void
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | undefined>(undefined)

const isAbortError = (value: unknown): boolean => {
  if (value instanceof AuthClientError && value.kind === 'aborted') return true
  if (value instanceof DOMException && value.name === 'AbortError') return true
  return false
}

const createClient = (): AuthClient => createAuthClient({ baseUrl: workerBaseUrl })

export function AuthProvider({ children }: { children: ReactNode }) {
  const clientRef = useRef<AuthClient | null>(null)
  const logoutControllerRef = useRef<AbortController | null>(null)
  const getClient = useCallback((): AuthClient => {
    if (clientRef.current === null) {
      clientRef.current = createClient()
    }
    return clientRef.current
  }, [])

  const [user, setUser] = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    let cancelled = false

    const run = async () => {
      try {
        const currentUser = await getClient().getCurrentUser(controller.signal)
        if (cancelled) return
        setUser(currentUser)
        setError(null)
      } catch (err: unknown) {
        if (cancelled || isAbortError(err)) return
        setError(err instanceof Error ? err : new Error(String(err)))
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    run()

    return () => {
      cancelled = true
      controller.abort()
      logoutControllerRef.current?.abort()
    }
  }, [getClient])

  const login = useCallback(() => {
    setError(null)
    try {
      getClient().login()
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error(String(err)))
    }
  }, [getClient])

  const logout = useCallback(async () => {
    setError(null)
    setIsLoading(true)
    const controller = new AbortController()
    logoutControllerRef.current = controller
    try {
      const client = getClient()
      await client.logout(controller.signal)
      setUser(null)
    } catch (err: unknown) {
      if (!isAbortError(err)) {
        setError(err instanceof Error ? err : new Error(String(err)))
      }
    } finally {
      if (logoutControllerRef.current === controller) {
        logoutControllerRef.current = null
      }
      setIsLoading(false)
    }
  }, [getClient])

  const value = useMemo<AuthState>(
    () => ({ user, isLoading, error, login, logout }),
    [user, isLoading, error, login, logout],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthState {
  const context = useContext(AuthContext)
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider')
  }
  return context
}

type MockAuthProviderProps = {
  children: ReactNode
  user?: AuthUser | null
  isLoading?: boolean
  error?: Error | null
}

/** Provider for tests and Storybook that skips the live auth handshake. */
export function MockAuthProvider({
  children,
  user = null,
  isLoading = false,
  error = null,
}: MockAuthProviderProps) {
  const value = useMemo<AuthState>(
    () => ({
      user,
      isLoading,
      error,
      login: () => {},
      logout: async () => {},
    }),
    [user, isLoading, error],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
