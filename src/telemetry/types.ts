/** Event names accepted by the telemetry boundary. This is intentionally a closed set. */
export type TelemetryEventType =
  | 'cycle_start'
  | 'cycle_end'
  | 'scroll_pos'
  | 'scroll_backward'
  | 'word_lookup'
  | 'rating'
  | 'quiz_answer'

export type TelemetryRating = 'again' | 'hard' | 'good' | 'easy'
export type TelemetryLookupSource = 'article' | 'example'

export type CycleStartPayload = { articleWordCount: number }
export type CycleEndPayload = Record<string, never>
export type ScrollPositionPayload = { position: number }
export type ScrollBackwardPayload = Record<string, never>
export type WordLookupPayload = { source: TelemetryLookupSource }
export type RatingPayload = { rating: TelemetryRating }
/** Answer identifiers are retained, but answer text and correctness are not collected. */
export type QuizAnswerPayload = { questionId: string; optionId: string }

export type TelemetryPayload =
  | CycleStartPayload
  | CycleEndPayload
  | ScrollPositionPayload
  | ScrollBackwardPayload
  | WordLookupPayload
  | RatingPayload
  | QuizAnswerPayload

type TelemetryEventBase = {
  sessionId: string
  cycleId: string
  clientEventId: string
  occurredAt: string
}

export type TelemetryEvent =
  | (TelemetryEventBase & { type: 'cycle_start'; payload: CycleStartPayload })
  | (TelemetryEventBase & { type: 'cycle_end'; payload: CycleEndPayload })
  | (TelemetryEventBase & { type: 'scroll_pos'; payload: ScrollPositionPayload })
  | (TelemetryEventBase & { type: 'scroll_backward'; payload: ScrollBackwardPayload })
  | (TelemetryEventBase & { type: 'word_lookup'; payload: WordLookupPayload })
  | (TelemetryEventBase & { type: 'rating'; payload: RatingPayload })
  | (TelemetryEventBase & { type: 'quiz_answer'; payload: QuizAnswerPayload })

export type TelemetryBatch = { events: TelemetryEvent[] }

export type ReadingStats = {
  activeDurationMs: number
  wordsPerMinute: number
  scrollBackwardCount: number
  lookupCount: number
  quizResponseCount: number
}

export const MAX_TELEMETRY_REQUEST_BODY_BYTES = 256 * 1024
export const MAX_TELEMETRY_ITEMS_PER_BATCH = 250
export const MAX_TELEMETRY_STRING_LENGTH = 256
export const MAX_ARTICLE_WORD_COUNT = 1_000_000
export const MAX_EVENT_PAYLOAD_BYTES = 4 * 1024

export class TelemetryValidationError extends Error {
  constructor() {
    super('Invalid telemetry payload')
    this.name = 'TelemetryValidationError'
  }
}
