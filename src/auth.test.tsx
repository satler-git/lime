// @vitest-environment jsdom
;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useEffect } from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { AuthProvider, useAuth } from './auth'
import { AuthClient, AuthClientError, createAuthClient } from './worker/auth/client'
import type { AuthClient as AuthClientType, AuthUser } from './worker/auth/client'

vi.mock('./worker/auth/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./worker/auth/client')>()
  return {
    ...actual,
    createAuthClient: vi.fn<typeof createAuthClient>(),
  }
})

const testUser: AuthUser = {
  id: 'user-1',
  email: 'reader@example.test',
  name: 'Reader',
  picture: null,
}

const StateView = () => {
  const { user, isLoading, error } = useAuth()
  if (isLoading) return <div data-testid="auth-state">loading</div>
  if (error) return <div data-testid="auth-state">error:{error.message}</div>
  if (user) return <div data-testid="auth-state">user:{user.email}</div>
  return <div data-testid="auth-state">logged-out</div>
}

type LogoutRef = {
  current: (() => Promise<void>) | null
}

const AuthHarness = ({ onLogoutRef }: { onLogoutRef?: LogoutRef }) => {
  const state = useAuth()
  useEffect(() => {
    if (onLogoutRef) onLogoutRef.current = state.logout
  }, [state.logout, onLogoutRef])
  return <StateView />
}

const createMockClient = (overrides: Partial<AuthClientType> = {}): AuthClientType => {
  const client = new AuthClient({
    baseUrl: '',
    fetch: vi.fn(),
    redirect: vi.fn(),
    location: { origin: 'https://app.example.test' },
  })
  vi.spyOn(client, 'getCurrentUser').mockResolvedValue(null)
  vi.spyOn(client, 'logout').mockResolvedValue(undefined)
  vi.spyOn(client, 'login').mockReturnValue(undefined)
  if (overrides.getCurrentUser) {
    vi.spyOn(client, 'getCurrentUser').mockImplementation(overrides.getCurrentUser)
  }
  if (overrides.logout) {
    vi.spyOn(client, 'logout').mockImplementation(overrides.logout)
  }
  if (overrides.login) {
    vi.spyOn(client, 'login').mockImplementation(overrides.login)
  }
  return client
}

const setupProvider = (client: AuthClientType) => {
  vi.mocked(createAuthClient).mockReturnValue(client)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const cleanup = async () => {
    await act(() => { root.unmount() })
    container.remove()
  }
  return { container, root, cleanup }
}

const MAX_POLLS = 100

const waitFor = async (
  container: HTMLElement,
  expected: string[],
  setup: () => void = () => {},
): Promise<string> => {
  await act(async () => {
    setup()
    await Promise.resolve()
  })

  for (let attempt = 0; attempt < MAX_POLLS; attempt++) {
    const text = container.textContent ?? ''
    if (expected.includes(text)) return text
    await act(async () => { await Promise.resolve() })
  }

  const text = container.textContent ?? ''
  throw new Error(`Timeout waiting for auth state. Expected one of ${expected.join(', ')}; got: ${text}`)
}

describe('AuthProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts in the loading state', async () => {
    const client = createMockClient({
      getCurrentUser: vi.fn<AuthClientType['getCurrentUser']>().mockImplementation(
        () => new Promise<AuthUser | null>(() => {}),
      ),
    })
    const { container, root, cleanup } = setupProvider(client)
    const text = await waitFor(container, ['loading'], () => {
      root.render(
        <AuthProvider>
          <AuthHarness />
        </AuthProvider>
      )
    })
    expect(text).toBe('loading')
    expect(client.getCurrentUser).toHaveBeenCalledWith(expect.any(AbortSignal))
    await cleanup()
  })

  it('transitions to logged-in when getCurrentUser resolves with a user', async () => {
    const client = createMockClient({
      getCurrentUser: vi.fn<AuthClientType['getCurrentUser']>().mockResolvedValue(testUser),
    })
    const { container, root, cleanup } = setupProvider(client)
    const text = await waitFor(container, ['user:reader@example.test'], () => {
      root.render(
        <AuthProvider>
          <AuthHarness />
        </AuthProvider>
      )
    })
    expect(text).toBe('user:reader@example.test')
    await cleanup()
  })

  it('transitions to logged-out when getCurrentUser resolves with null', async () => {
    const client = createMockClient()
    const { container, root, cleanup } = setupProvider(client)
    const text = await waitFor(container, ['logged-out'], () => {
      root.render(
        <AuthProvider>
          <AuthHarness />
        </AuthProvider>
      )
    })
    expect(text).toBe('logged-out')
    await cleanup()
  })

  it('transitions to error when getCurrentUser rejects', async () => {
    const client = createMockClient({
      getCurrentUser: vi.fn<AuthClientType['getCurrentUser']>().mockRejectedValue(
        new AuthClientError('http', 'Authentication request failed'),
      ),
    })
    const { container, root, cleanup } = setupProvider(client)
    const text = await waitFor(container, ['error:Authentication request failed'], () => {
      root.render(
        <AuthProvider>
          <AuthHarness />
        </AuthProvider>
      )
    })
    expect(text).toContain('error:Authentication request failed')
    await cleanup()
  })

  it('clears the user and previous error on logout', async () => {
    const logout = vi.fn<AuthClientType['logout']>().mockResolvedValue(undefined)
    const client = createMockClient({
      getCurrentUser: vi.fn<AuthClientType['getCurrentUser']>().mockResolvedValue(testUser),
      logout,
    })
    const logoutRef: LogoutRef = { current: null }
    const { container, root, cleanup } = setupProvider(client)
    await waitFor(container, ['user:reader@example.test'], () => {
      root.render(
        <AuthProvider>
          <AuthHarness onLogoutRef={logoutRef} />
        </AuthProvider>
      )
    })

    const handler = logoutRef.current
    if (handler === null) throw new Error('logout is not ready')
    const text = await waitFor(container, ['logged-out'], () => { void handler() })

    expect(logout).toHaveBeenCalledWith(expect.any(AbortSignal))
    expect(text).toBe('logged-out')
    await cleanup()
  })
})
