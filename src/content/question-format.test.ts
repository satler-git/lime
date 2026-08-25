import { describe, expect, it } from 'vitest'
import { QUIZ_QUESTION_FORMATS, deriveSeedFromSpec, determineQuestionFormats, formatAssignmentText } from './question-format'

const countBy = <T>(values: readonly T[]): Map<T, number> => {
  const counts = new Map<T, number>()
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return counts
}

describe('determineQuestionFormats', () => {
  it('returns five formats for any seed', () => {
    expect(determineQuestionFormats('seed-1')).toHaveLength(5)
    expect(determineQuestionFormats('')).toHaveLength(5)
  })

  it('is reproducible for the same seed', () => {
    const a = determineQuestionFormats('cycle-123')
    const b = determineQuestionFormats('cycle-123')
    expect(a).toEqual(b)
  })

  it('uses the initial 40/40/20 distribution', () => {
    const formats = determineQuestionFormats('any-seed')
    const counts = countBy(formats)
    expect(counts.get('ja')).toBe(2)
    expect(counts.get('en')).toBe(2)
    expect(counts.get('reasoning')).toBe(1)
  })

  it('includes at least two distinct formats and never all five the same', () => {
    const formats = determineQuestionFormats('another-seed')
    expect(new Set(formats).size).toBeGreaterThanOrEqual(2)
    expect(new Set(formats).size).not.toBe(1)
  })

  it('produces different shuffles for different seeds', () => {
    const a = determineQuestionFormats('seed-a')
    const b = determineQuestionFormats('seed-b')
    // Different seeds are very likely to produce different orders; if this
    // test ever flakes, the seed strings can be changed.
    expect(a).not.toEqual(b)
  })
})

describe('deriveSeedFromSpec', () => {
  it('is deterministic for the same spec fields', () => {
    const spec = {
      targetWords: ['resilient', 'civic'],
      theme: 'Public spaces',
      style: 'factual prose',
      articleWordTarget: 240,
    }
    expect(deriveSeedFromSpec(spec)).toBe(deriveSeedFromSpec(spec))
  })

  it('changes when any spec field changes', () => {
    const a = deriveSeedFromSpec({
      targetWords: ['resilient'],
      theme: 'Public spaces',
      style: 'factual prose',
      articleWordTarget: 240,
    })
    const b = deriveSeedFromSpec({
      targetWords: ['resilient'],
      theme: 'Rivers',
      style: 'factual prose',
      articleWordTarget: 240,
    })
    expect(a).not.toBe(b)
  })
})

describe('formatAssignmentText', () => {
  it('lists each question with an allowed format', () => {
    const text = formatAssignmentText('seed-text')
    expect(text).toContain('question-1')
    expect(text).toContain('question-5')
    for (const format of QUIZ_QUESTION_FORMATS) {
      expect(text).toContain(format)
    }
  })
})
