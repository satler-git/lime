import { useEffect, useState } from 'react'
import { workerBaseUrl } from './config'
import { createTelemetryQueue, type TelemetryTransport } from './telemetry/client'

const FLUSH_INTERVAL_MS = 30_000

export type UseTelemetryQueueResult = {
  queue: TelemetryTransport | undefined
  error: Error | undefined
}

export function useTelemetryQueue(userId?: string): UseTelemetryQueueResult {
  const [queue, setQueue] = useState<TelemetryTransport | undefined>(undefined)
  const [error, setError] = useState<Error | undefined>(undefined)

  useEffect(() => {
    setQueue(undefined)
    setError(undefined)

    if (
      globalThis.indexedDB == null ||
      userId === undefined ||
      userId.length === 0 ||
      typeof globalThis.fetch !== 'function'
    ) {
      return
    }

    let created: TelemetryTransport | undefined

    try {
      created = createTelemetryQueue({ baseUrl: workerBaseUrl })
    } catch (err: unknown) {
      setError(err instanceof Error ? err : new Error('Failed to create telemetry queue'))
      return
    }

    if (created === undefined) {
      return
    }

    const queue = created
    setQueue(queue)
    const interval = setInterval(() => { queue.flush().catch(() => {}) }, FLUSH_INTERVAL_MS)

    return () => {
      clearInterval(interval)
      queue.flush().catch(() => {})
    }
  }, [userId])

  return { queue, error }
}
