import { useCallback, useEffect, useRef, useState } from 'react'
import { workerBaseUrl } from './config'
import { loadSettings } from './settings-storage'
import { hasControlCharacters, hasUserinfoSyntax } from './worker/origin'
import type { AuthUser } from './worker/auth/client'

const DEFAULT_REVIEW_LIMIT = 50
const DEFAULT_NEW_LIMIT = 20
const PUSH_DEBOUNCE_MS = 500

const LIMITS_PATH = 'api/settings/limits'
const ABSOLUTE_LIMITS_PATH = '/api/settings/limits'

type Limits = {
  reviewLimit: number
  newLimit: number
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const isNonNegativeInteger = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0
)

const validateBaseUrl = (value: string): void => {
  if (hasControlCharacters(value)) {
    throw new TypeError('Control characters in settings base URLs are not supported')
  }
  if (/\s/.test(value)) {
    throw new TypeError('Whitespace in settings base URLs is not supported')
  }
  if (value.includes('\\')) {
    throw new TypeError('Backslashes in settings base URLs are not supported')
  }
  if (value.startsWith('//')) {
    throw new TypeError('Protocol-relative settings base URLs are not supported')
  }
}

export const getSettingsEndpoint = (base: string = workerBaseUrl): string => {
  const value = base.trim()
  if (value.length === 0) return ABSOLUTE_LIMITS_PATH

  validateBaseUrl(value)

  if (value.startsWith('/')) {
    if (value.includes('?') || value.includes('#')) {
      throw new TypeError('Relative settings base URLs must not contain a query or fragment')
    }
    return `${value.replace(/\/+$/, '')}${ABSOLUTE_LIMITS_PATH}`
  }

  let resolvedBase: URL
  try {
    resolvedBase = new URL(value)
  } catch {
    throw new TypeError('A valid settings base URL is required')
  }

  if (resolvedBase.protocol !== 'http:' && resolvedBase.protocol !== 'https:') {
    throw new TypeError('Only http: and https: settings base URLs are supported')
  }

  if (resolvedBase.search || resolvedBase.hash) {
    throw new TypeError('Settings base URLs must not contain a query or fragment')
  }

  if (hasUserinfoSyntax(value) || resolvedBase.username.length > 0 || resolvedBase.password.length > 0) {
    throw new TypeError('Settings base URLs must not contain credentials')
  }

  const normalizedBase = `${resolvedBase.href.replace(/\/+$/, '')}/`
  return new URL(LIMITS_PATH, normalizedBase).toString()
}

const loadRemoteLimits = async (signal: AbortSignal): Promise<Limits | null> => {
  const response = await fetch(getSettingsEndpoint(), {
    method: 'GET',
    credentials: 'same-origin',
    cache: 'no-store',
    signal,
  })

  if (response.status === 401) return null
  if (!response.ok) return null

  const payload = await response.json() as unknown
  if (!isRecord(payload)) return null

  const reviewLimit = payload.reviewLimit
  const newLimit = payload.newLimit
  if (reviewLimit === null && newLimit === null) return null
  if (!isNonNegativeInteger(reviewLimit) || !isNonNegativeInteger(newLimit)) return null

  return { reviewLimit, newLimit }
}

const saveRemoteLimits = async (limits: Limits, signal?: AbortSignal): Promise<void> => {
  const init: RequestInit = {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(limits),
  }
  if (signal !== undefined) {
    init.signal = signal
  }
  const response = await fetch(getSettingsEndpoint(), init)
  if (!response.ok) {
    throw new Error(`Settings push failed: ${response.status}`)
  }
}

export function useLimits(user: AuthUser | null, isAuthLoading: boolean): {
  reviewLimit: number
  newLimit: number
  setReviewLimit: (value: number) => void
  setNewLimit: (value: number) => void
  isLoading: boolean
} {
  const [reviewLimit, setReviewLimitState] = useState(DEFAULT_REVIEW_LIMIT)
  const [newLimit, setNewLimitState] = useState(DEFAULT_NEW_LIMIT)
  const [isLoading, setIsLoading] = useState(false)

  const userRef = useRef(user)
  const reviewLimitRef = useRef(reviewLimit)
  const newLimitRef = useRef(newLimit)
  const pushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pushAbortControllerRef = useRef<AbortController | null>(null)
  const abortControllerRef = useRef<AbortController | null>(null)
  const isMountedRef = useRef(false)

  userRef.current = user
  reviewLimitRef.current = reviewLimit
  newLimitRef.current = newLimit

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
    }
  }, [])

  const cancelPendingPush = useCallback((): void => {
    if (pushTimeoutRef.current !== null) {
      clearTimeout(pushTimeoutRef.current)
      pushTimeoutRef.current = null
    }
    if (pushAbortControllerRef.current !== null) {
      pushAbortControllerRef.current.abort()
      pushAbortControllerRef.current = null
    }
  }, [])

  // Cancel pending push when the user changes or on unmount.
  useEffect(() => {
    return () => {
      cancelPendingPush()
    }
  }, [user?.id, cancelPendingPush])

  // Load locally persisted limits on mount without pushing them to the server.
  useEffect(() => {
    const loaded = loadSettings()
    if (loaded === undefined) return

    if (loaded.reviewLimit !== undefined) setReviewLimitState(loaded.reviewLimit)
    if (loaded.newLimit !== undefined) setNewLimitState(loaded.newLimit)
  }, [])

  // Fetch remote limits when an authenticated user is known and auth is no longer loading.
  useEffect(() => {
    if (user === null || isAuthLoading) {
      if (isMountedRef.current) {
        setIsLoading(false)
      }
      return
    }

    const controller = new AbortController()
    abortControllerRef.current = controller
    if (isMountedRef.current) {
      setIsLoading(true)
    }

    let cancelled = false

    const finish = (): void => {
      if (!cancelled && isMountedRef.current && abortControllerRef.current === controller) {
        setIsLoading(false)
      }
    }

    const run = async (): Promise<void> => {
      const startingReview = reviewLimitRef.current
      const startingNew = newLimitRef.current
      try {
        const remote = await loadRemoteLimits(controller.signal)
        if (cancelled || controller.signal.aborted) {
          return
        }
        if (
          remote !== null &&
          reviewLimitRef.current === startingReview &&
          newLimitRef.current === startingNew
        ) {
          cancelPendingPush()
          if (isMountedRef.current) {
            setReviewLimitState(remote.reviewLimit)
            setNewLimitState(remote.newLimit)
          }
        }
      } catch {
        // Network, abort, and parse errors are intentionally ignored: the local values still work.
      } finally {
        finish()
      }
    }

    void run()

    return () => {
      cancelled = true
      controller.abort()
      abortControllerRef.current = null
    }
  }, [user, isAuthLoading, cancelPendingPush])

  const schedulePush = useCallback((): void => {
    if (userRef.current === null) return
    cancelPendingPush()
    pushTimeoutRef.current = setTimeout(() => {
      pushTimeoutRef.current = null
      const currentUser = userRef.current
      if (currentUser === null) return
      const limits: Limits = {
        reviewLimit: reviewLimitRef.current,
        newLimit: newLimitRef.current,
      }
      const controller = new AbortController()
      pushAbortControllerRef.current = controller
      void saveRemoteLimits(limits, controller.signal)
        .catch(() => {})
        .finally(() => {
          if (pushAbortControllerRef.current === controller) {
            pushAbortControllerRef.current = null
          }
        })
    }, PUSH_DEBOUNCE_MS)
  }, [cancelPendingPush])

  const setReviewLimit = useCallback((value: number): void => {
    setReviewLimitState(value)
    schedulePush()
  }, [schedulePush])

  const setNewLimit = useCallback((value: number): void => {
    setNewLimitState(value)
    schedulePush()
  }, [schedulePush])

  return {
    reviewLimit,
    newLimit,
    setReviewLimit,
    setNewLimit,
    isLoading,
  }
}
