import {
  MAX_ARTICLE_WORD_COUNT,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_TELEMETRY_ITEMS_PER_BATCH,
  MAX_TELEMETRY_STRING_LENGTH,
  TelemetryValidationError,
  type TelemetryLookupSource,
  type ReadingStats,
  type TelemetryBatch,
  type TelemetryEvent,
  type TelemetryEventType,
  type TelemetryRating,
} from './types'

const eventTypes: readonly TelemetryEventType[] = [
  'cycle_start', 'cycle_end', 'scroll_pos', 'scroll_backward', 'word_lookup', 'rating', 'quiz_answer',
]
const lookupSources: readonly TelemetryLookupSource[] = ['article', 'example']
const ratings: readonly TelemetryRating[] = ['again', 'hard', 'good', 'easy']

type RecordValue = Record<string, unknown>

const invalid = (): never => { throw new TelemetryValidationError() }
const isRecord = (value: unknown): value is RecordValue => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)
const record = (value: unknown): RecordValue => isRecord(value) ? value : invalid()
const hasOnlyKeys = (value: RecordValue, keys: readonly string[]): void => {
  if (Object.keys(value).some((key) => !keys.includes(key))) invalid()
}
const boundedString = (value: unknown): string => {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TELEMETRY_STRING_LENGTH) invalid()
  return value as string
}
const oneOf = <T extends string>(value: unknown, values: readonly T[]): T => (
  typeof value === 'string' && values.includes(value as T) ? value as T : invalid()
)
const finiteNumber = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : invalid()
)
const boundedInteger = (value: unknown, max: number): number => {
  const number = finiteNumber(value)
  if (!Number.isSafeInteger(number) || number < 0 || number > max) invalid()
  return number
}
const dateString = (value: unknown): string => {
  const text = boundedString(value)
  if (Number.isNaN(Date.parse(text))) invalid()
  return text
}

const parsePayload = (type: TelemetryEventType, value: unknown): TelemetryEvent['payload'] => {
  const input = record(value)
  let payload: TelemetryEvent['payload']
  switch (type) {
    case 'cycle_start':
      hasOnlyKeys(input, ['articleWordCount'])
      payload = { articleWordCount: boundedInteger(input.articleWordCount, MAX_ARTICLE_WORD_COUNT) }
      if (payload.articleWordCount < 1) invalid()
      break
    case 'cycle_end':
    case 'scroll_backward':
      hasOnlyKeys(input, [])
      payload = {}
      break
    case 'scroll_pos': {
      hasOnlyKeys(input, ['position'])
      const position = finiteNumber(input.position)
      if (position < 0 || position > 1) invalid()
      payload = { position }
      break
    }
    case 'word_lookup':
      hasOnlyKeys(input, ['source'])
      payload = { source: oneOf(input.source, lookupSources) }
      break
    case 'rating':
      hasOnlyKeys(input, ['rating'])
      payload = { rating: oneOf(input.rating, ratings) }
      break
    case 'quiz_answer':
      hasOnlyKeys(input, ['questionId', 'optionId'])
      payload = { questionId: boundedString(input.questionId), optionId: boundedString(input.optionId) }
      break
  }

  // JSON.parse cannot produce undefined/functions, but retain this check for direct callers.
  let encoded: string
  try {
    encoded = JSON.stringify(payload)
  } catch {
    return invalid()
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_EVENT_PAYLOAD_BYTES) invalid()
  return payload
}

const parseEvent = (value: unknown): TelemetryEvent => {
  const input = record(value)
  hasOnlyKeys(input, ['sessionId', 'cycleId', 'clientEventId', 'occurredAt', 'type', 'payload'])
  const type = oneOf(input.type, eventTypes)
  const base = {
    sessionId: boundedString(input.sessionId),
    cycleId: boundedString(input.cycleId),
    clientEventId: boundedString(input.clientEventId),
    occurredAt: dateString(input.occurredAt),
  }
  return { ...base, type, payload: parsePayload(type, input.payload) } as TelemetryEvent
}

/** Validate a batch and return a defensive, closed-shape copy of it. */
export const validateTelemetryBatch = (value: unknown): TelemetryBatch => {
  const input = record(value)
  hasOnlyKeys(input, ['events'])
  const events: unknown[] = Array.isArray(input.events) ? input.events : invalid()
  if (events.length > MAX_TELEMETRY_ITEMS_PER_BATCH) invalid()
  return { events: events.map(parseEvent) }
}

export const parseTelemetryBatch = validateTelemetryBatch

/**
 * Derive only mechanical reading measurements from raw events. This function does
 * not score quiz answers, interpret ratings, or touch the FSRS scheduling model.
 */
export const deriveReadingStats = (
  events: readonly TelemetryEvent[],
  articleWordCount?: number,
): ReadingStats => {
  let activeDurationMs = 0
  let readingStartedAt: number | undefined
  let words = articleWordCount
  const timeline = [...events].sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt))

  for (const event of timeline) {
    const at = Date.parse(event.occurredAt)
    if (!Number.isFinite(at)) continue
    if (event.type === 'cycle_start') {
      if (readingStartedAt === undefined) readingStartedAt = at
      if (words === undefined) words = event.payload.articleWordCount
    } else if (event.type === 'cycle_end' && readingStartedAt !== undefined) {
      if (at >= readingStartedAt) activeDurationMs += at - readingStartedAt
      readingStartedAt = undefined
    }
  }

  const durationMinutes = activeDurationMs / 60_000
  return {
    activeDurationMs,
    wordsPerMinute: words !== undefined && durationMinutes > 0 ? words / durationMinutes : 0,
    scrollBackwardCount: events.filter((event) => event.type === 'scroll_backward').length,
    lookupCount: events.filter((event) => event.type === 'word_lookup').length,
    quizResponseCount: events.filter((event) => event.type === 'quiz_answer').length,
  }
}
