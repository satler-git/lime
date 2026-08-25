import type { GenerationSpec } from './types'
import { QUIZ_QUESTION_FORMATS, type QuizQuestionFormat } from '../quiz/types'

export { QUIZ_QUESTION_FORMATS }
export type { QuizQuestionFormat }

const QUESTION_COUNT = 5

/** The initial target distribution for 5 questions: 40% ja, 40% en, 20% reasoning. */
const QUESTION_FORMAT_BASE: readonly QuizQuestionFormat[] = ['ja', 'ja', 'en', 'en', 'reasoning']

/** FNV-1a hash for a stable 32-bit integer from a string. */
const hashString = (value: string): number => {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** A small 32-bit LCG returns values in [0, 1). */
const createSeededRng = (seed: number) => {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 4294967296
  }
}

/**
 * Return a reproducible, seeded shuffle of the initial question-format
 * distribution. The base pool guarantees at least two distinct formats and
 * prevents all five questions from sharing the same format.
 */
export function determineQuestionFormats(seed: string): QuizQuestionFormat[] {
  const rng = createSeededRng(hashString(seed))
  const formats = [...QUESTION_FORMAT_BASE]
  for (let index = formats.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1))
    ;[formats[index], formats[swapIndex]] = [formats[swapIndex], formats[index]]
  }
  return formats
}

/** Format description used in the generation prompt. */
const formatDescriptions: Record<QuizQuestionFormat, string> = {
  ja: 'Japanese question and Japanese options',
  en: 'English question and English options',
  reasoning: 'a reasoning or summary question (either language; it must ask the reader to infer, summarize, or explain)',
}

/**
 * Build a human-readable format assignment block for the model prompt.
 * The output lists each question's expected format so the model can produce
 * the correct language and style per question. The raw seed is intentionally
 * omitted from the prompt to avoid leaking internal identifiers to the model.
 */
export function formatAssignmentText(seed: string): string {
  const formats = determineQuestionFormats(seed)
  const lines = [
    'Format assignment:',
    ...formats.map((format, index) => `  question-${index + 1}: ${format} (${formatDescriptions[format]})`),
  ]
  return lines.join('\n')
}

/**
 * Derive a stable seed from the core generation fields when no explicit seed
 * is supplied. The same target words + theme + style + word target always
 * produce the same seed, so the format assignment is reproducible for a cycle.
 */
export function deriveSeedFromSpec(spec: Pick<GenerationSpec, 'targetWords' | 'theme' | 'style' | 'articleWordTarget'>): string {
  const key = JSON.stringify({
    targetWords: spec.targetWords,
    theme: spec.theme,
    style: spec.style,
    articleWordTarget: spec.articleWordTarget,
  })
  return `spec-${(hashString(key) >>> 0).toString(16).padStart(8, '0')}`
}
