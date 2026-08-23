import { describe, expect, it } from 'vitest'
import {
  deriveReadingStats,
  MAX_EVENT_PAYLOAD_BYTES,
  parseTelemetryBatch,
  type TelemetryEvent,
} from './index'

const event = (overrides: Partial<TelemetryEvent> & Pick<TelemetryEvent, 'type' | 'payload'>): TelemetryEvent => ({
  sessionId: 'session-1',
  cycleId: 'cycle-1',
  clientEventId: `${overrides.type}-1`,
  occurredAt: '2025-01-01T00:00:00.000Z',
  ...overrides,
} as TelemetryEvent)

describe('telemetry validation and statistics', () => {
  it('accepts the closed event union and defensively copies it', () => {
    const input = {
      events: [event({ type: 'cycle_start', payload: { articleWordCount: 300 } })],
    }
    const result = parseTelemetryBatch(input)
    expect(result).toEqual(input)
    expect(result.events).not.toBe(input.events)
  })

  it('rejects unknown payload fields, secrets, non-JSON-safe values, and oversized payloads', () => {
    expect(() => parseTelemetryBatch({ events: [event({ type: 'cycle_end', payload: { apiKey: 'secret' } as never })] })).toThrow('Invalid telemetry payload')
    expect(() => parseTelemetryBatch({ events: [event({ type: 'word_lookup', payload: { source: 'article', word: 'private text' } as never })] })).toThrow('Invalid telemetry payload')
    expect(() => parseTelemetryBatch({ events: [event({ type: 'quiz_answer', payload: { questionId: 'q', optionId: 'x', correct: true } as never })] })).toThrow('Invalid telemetry payload')
    expect(() => parseTelemetryBatch({ events: [event({ type: 'scroll_pos', payload: { position: Number.NaN } })] })).toThrow('Invalid telemetry payload')
    expect(() => parseTelemetryBatch({ events: [event({ type: 'quiz_answer', payload: { questionId: 'q'.repeat(MAX_EVENT_PAYLOAD_BYTES), optionId: 'o' } as never })] })).toThrow('Invalid telemetry payload')
  })

  it('derives mechanical reading measurements without learning outcomes', () => {
    const events: TelemetryEvent[] = [
      event({ type: 'cycle_start', payload: { articleWordCount: 600 }, occurredAt: '2025-01-01T00:00:00.000Z' }),
      event({ type: 'scroll_pos', payload: { position: 0.2 }, occurredAt: '2025-01-01T00:01:00.000Z' }),
      event({ type: 'scroll_backward', payload: {}, occurredAt: '2025-01-01T00:02:00.000Z' }),
      event({ type: 'word_lookup', payload: { source: 'article' }, occurredAt: '2025-01-01T00:03:00.000Z' }),
      event({ type: 'quiz_answer', payload: { questionId: 'q1', optionId: 'o1' }, occurredAt: '2025-01-01T00:04:00.000Z' }),
      event({ type: 'cycle_end', payload: {}, occurredAt: '2025-01-01T00:05:00.000Z' }),
    ]
    expect(deriveReadingStats(events)).toEqual({
      activeDurationMs: 300_000,
      wordsPerMinute: 120,
      scrollBackwardCount: 1,
      lookupCount: 1,
      quizResponseCount: 1,
    })
  })
})
