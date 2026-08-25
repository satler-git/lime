// @vitest-environment jsdom
declare global {
  // Used by React `act` to enable test-environment behavior.
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined
}

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { createElement, act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useLimits, getSettingsEndpoint } from './use-limits'
import type { AuthUser } from './worker/auth/client'

const STORAGE_KEY = 'lime-settings-v1'
const PUSH_DEBOUNCE_MS = 500

const user: AuthUser = { id: 'user-1', email: 'u1@example.test', name: 'User', picture: null }

const jsonResponse = (value: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
  ...init,
})

class MemoryStorage implements Storage {
  private readonly store = new Map<string, string>()

  get length() {
    return this.store.size
  }

  clear() {
    this.store.clear()
  }

  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }

  key(index: number): string | null {
    if (index < 0 || index >= this.store.size) return null
    return Array.from(this.store.keys())[index] ?? null
  }

  removeItem(key: string): void {
    this.store.delete(key)
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }

  [name: string]: unknown
}

type LimitsResult = ReturnType<typeof useLimits>

function TestComponent(props: { user: AuthUser | null; isAuthLoading: boolean; resultsRef: { current: LimitsResult | null } }): null {
  const limits = useLimits(props.user, props.isAuthLoading)
  props.resultsRef.current = limits
  return null
}

describe('useLimits', () => {
  let container: HTMLDivElement
  let root: Root
  let resultsRef: { current: LimitsResult | null }
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('localStorage', new MemoryStorage())
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    resultsRef = { current: null }
  })

  afterEach(async () => {
    await act(() => { root.unmount() })
    vi.useRealTimers()
    vi.unstubAllGlobals()
    container.remove()
  })

  const waitForValue = async <T,>(
    getValue: () => T,
    predicate: (value: T) => boolean,
    maxAttempts = 30,
  ): Promise<void> => {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (predicate(getValue())) return
      await act(() => Promise.resolve())
    }
    throw new Error('waitForValue: predicate was not satisfied')
  }

  const renderUser = async (userValue: AuthUser | null, isAuthLoading = false): Promise<void> => {
    await act(() => {
      root.render(createElement(TestComponent, { user: userValue, isAuthLoading, resultsRef }))
    })
    // Wait for the async remote-load effect to settle before assertions.
    await waitForValue(
      () => resultsRef.current?.isLoading,
      (isLoading) => isLoading === false,
    )
  }

  it('loads local limits on mount and does not fetch or push', async () => {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({ reviewLimit: 100, newLimit: 40 }))
    await renderUser(null)

    expect(resultsRef.current?.reviewLimit).toBe(100)
    expect(resultsRef.current?.newLimit).toBe(40)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fetches remote limits when a user is provided and applies them without pushing', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 80, newLimit: 25 }))
    await renderUser(user)

    expect(resultsRef.current?.reviewLimit).toBe(80)
    expect(resultsRef.current?.newLimit).toBe(25)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/settings/limits', expect.objectContaining({ method: 'GET' }))

    // No push should be scheduled from the remote load itself.
    vi.useFakeTimers()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('keeps local values when the remote fetch returns null limits', async () => {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify({ reviewLimit: 100, newLimit: 40 }))
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: null, newLimit: null }))
    await renderUser(user)

    expect(resultsRef.current?.reviewLimit).toBe(100)
    expect(resultsRef.current?.newLimit).toBe(40)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('debounces user changes into a single push', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 80, newLimit: 25 }))
    await renderUser(user)
    fetchMock.mockClear()

    vi.useFakeTimers()
    await act(() => { resultsRef.current?.setReviewLimit(77) })
    await act(() => { resultsRef.current?.setNewLimit(15) })

    expect(fetchMock).not.toHaveBeenCalled()

    await act(async () => { await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/limits',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reviewLimit: 77, newLimit: 15 }),
      }),
    )
  })

  it('pushes user changes even immediately after remote load', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 80, newLimit: 25 }))
    await renderUser(user)
    fetchMock.mockClear()

    vi.useFakeTimers()
    await act(() => { resultsRef.current?.setReviewLimit(12) })

    expect(fetchMock).not.toHaveBeenCalled()
    await act(async () => { await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS) })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/settings/limits',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reviewLimit: 12, newLimit: 25 }),
      }),
    )
  })

  it('cancels a pending push when the user becomes null', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 80, newLimit: 25 }))
    await renderUser(user)
    fetchMock.mockClear()

    vi.useFakeTimers()
    await act(() => { resultsRef.current?.setReviewLimit(12) })
    await act(() => { root.render(createElement(TestComponent, { user: null, isAuthLoading: false, resultsRef })) })
    await act(async () => { await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS + 100) })

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('aborts an in-flight push when a new change is made', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 80, newLimit: 25 }))
    await renderUser(user)
    fetchMock.mockClear()

    // Make the POST hang so we can observe an in-flight fetch being aborted.
    fetchMock.mockImplementationOnce(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        })
      }
      return jsonResponse({ reviewLimit: 1, newLimit: 1 })
    })

    vi.useFakeTimers()
    await act(() => { resultsRef.current?.setReviewLimit(12) })
    await act(async () => { await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS) })

    // fetch should now be in-flight with a signal.
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.lastCall as [unknown, RequestInit | undefined]
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    expect(init?.signal?.aborted).toBe(false)

    // A new change reschedules and aborts the in-flight push.
    await act(() => { resultsRef.current?.setReviewLimit(34) })
    expect(init?.signal?.aborted).toBe(true)

    // Mock the second POST so saveRemoteLimits succeeds.
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 34, newLimit: 25 }))

    // The new debounced push should use the latest value.
    await act(async () => { await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [, secondInit] = fetchMock.mock.lastCall as [unknown, RequestInit | undefined]
    expect(secondInit?.signal).toBeInstanceOf(AbortSignal)
    expect(secondInit?.signal).not.toBe(init?.signal)
    expect(secondInit?.signal?.aborted).toBe(false)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/settings/limits',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reviewLimit: 34, newLimit: 25 }),
      }),
    )
  })

  it('keeps local changes when the user edits while remote limits are loading', async () => {
    let resolveGet: (value: Response) => void = () => {}
    const getPromise = new Promise<Response>((resolve) => { resolveGet = resolve })
    fetchMock.mockImplementationOnce(() => getPromise)

    vi.useFakeTimers()
    await act(() => {
      root.render(createElement(TestComponent, { user, isAuthLoading: false, resultsRef }))
    })
    // Let the remote-load effect start and block on the pending GET.
    await act(() => Promise.resolve())

    // User edits before the remote response arrives.
    await act(() => { resultsRef.current?.setReviewLimit(123) })

    // The remote GET resolves with a different value.
    await act(() => { resolveGet(jsonResponse({ reviewLimit: 80, newLimit: 25 })) })
    await waitForValue(
      () => resultsRef.current?.isLoading,
      (isLoading) => isLoading === false,
    )

    // The local edit should win and not be overwritten.
    expect(resultsRef.current?.reviewLimit).toBe(123)
    expect(resultsRef.current?.newLimit).toBe(20)

    // The scheduled push should fire after the debounce and send the local value.
    fetchMock.mockResolvedValueOnce(jsonResponse({ reviewLimit: 123, newLimit: 20 }))
    await act(async () => { await vi.advanceTimersByTimeAsync(PUSH_DEBOUNCE_MS) })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/settings/limits',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ reviewLimit: 123, newLimit: 20 }),
      }),
    )
  })
})

describe('getSettingsEndpoint', () => {
  it('resolves empty and relative worker base URLs', () => {
    expect(getSettingsEndpoint('')).toBe('/api/settings/limits')
    expect(getSettingsEndpoint('  ')).toBe('/api/settings/limits')
    expect(getSettingsEndpoint('/')).toBe('/api/settings/limits')
    expect(getSettingsEndpoint('/deployment')).toBe('/deployment/api/settings/limits')
    expect(getSettingsEndpoint('/deployment/')).toBe('/deployment/api/settings/limits')
    expect(getSettingsEndpoint('/deployment//')).toBe('/deployment/api/settings/limits')
  })

  it('resolves absolute worker base URLs and preserves paths', () => {
    expect(getSettingsEndpoint('https://app.example.test')).toBe('https://app.example.test/api/settings/limits')
    expect(getSettingsEndpoint('https://app.example.test/')).toBe('https://app.example.test/api/settings/limits')
    expect(getSettingsEndpoint('https://app.example.test/api')).toBe('https://app.example.test/api/api/settings/limits')
    expect(getSettingsEndpoint('https://app.example.test/deployment/')).toBe('https://app.example.test/deployment/api/settings/limits')
  })

  it('rejects invalid worker base URLs with clear TypeErrors', () => {
    expect(() => getSettingsEndpoint('not-a-url')).toThrow('A valid settings base URL is required')
    expect(() => getSettingsEndpoint('//app.example.test')).toThrow(/protocol-relative/i)
    expect(() => getSettingsEndpoint('https://app.example.test?query')).toThrow(/query or fragment/i)
    expect(() => getSettingsEndpoint('https://app.example.test#fragment')).toThrow(/query or fragment/i)
    expect(() => getSettingsEndpoint('https://user@app.example.test')).toThrow(/credentials/i)
    expect(() => getSettingsEndpoint('/deployment?query')).toThrow(/query or fragment/i)
    expect(() => getSettingsEndpoint('/deployment#fragment')).toThrow(/query or fragment/i)
    expect(() => getSettingsEndpoint('https://app.example.test\\path')).toThrow(/backslash/i)
    expect(() => getSettingsEndpoint('ftp://app.example.test')).toThrow('Only http: and https: settings base URLs are supported')
    // NUL (\x00) is a control character and must be rejected.
    expect(() => getSettingsEndpoint('https://app.example.test\x00/api')).toThrow(/control characters/i)
  })
})
