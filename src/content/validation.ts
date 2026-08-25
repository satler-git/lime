import type { QuizOption, QuizQuestion, QuizQuestionFormat } from '../quiz/types'
import type { CycleContent, GenerationSpec } from './types'
import { QUIZ_QUESTION_FORMATS, deriveSeedFromSpec, determineQuestionFormats } from './question-format'

const QUESTION_COUNT = 5
const OPTION_COUNT = 4
const apostrophePattern = /[\u2018\u2019\u201B\u2032\uFF07]/g
const hyphenPattern = /[\u2010\u2011\u2012\u2013\u2014\u2015\u2212\uFE58\uFE63\uFF0D]/g

export class ContentValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentValidationError'
  }
}

/** Normalize spelling variants for target-word matching, without changing display text. */
export function normalizeContentText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(apostrophePattern, "'")
    .replace(hyphenPattern, '-')
    .toLocaleLowerCase('en-US')
    .trim()
    .replace(/\s+/g, ' ')
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const requireNonEmptyString = (value: unknown, name: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ContentValidationError(`${name} must be a non-empty string`)
  }
  return value
}

/** Validate and copy a generation request before it reaches a provider. */
export function validateGenerationSpec(spec: unknown): Required<GenerationSpec> {
  if (!isRecord(spec)) throw new ContentValidationError('Generation spec must be an object')
  if (!Array.isArray(spec.targetWords) || spec.targetWords.length === 0) {
    throw new ContentValidationError('Generation spec must contain at least one target word')
  }
  const targetWords = spec.targetWords.map((word, index) => requireNonEmptyString(word, `Target word ${index + 1}`).trim())
  const normalizedTargetWords = targetWords.map(normalizeContentText)
  if (new Set(normalizedTargetWords).size !== normalizedTargetWords.length) {
    throw new ContentValidationError('Target words must be unique')
  }
  const theme = requireNonEmptyString(spec.theme, 'Theme').trim()
  const style = requireNonEmptyString(spec.style, 'Style').trim()
  if (!Number.isInteger(spec.articleWordTarget) || (spec.articleWordTarget as number) < 1) {
    throw new ContentValidationError('articleWordTarget must be a positive integer')
  }
  const base: Pick<GenerationSpec, 'targetWords' | 'theme' | 'style' | 'articleWordTarget'> = {
    targetWords,
    theme,
    style,
    articleWordTarget: spec.articleWordTarget as number,
  }
  const seed = spec.seed === undefined
    ? deriveSeedFromSpec(base)
    : requireNonEmptyString(spec.seed, 'seed').trim()
  return { ...base, seed }
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const containsNormalizedWord = (article: string, targetWord: string): boolean => {
  const normalizedArticle = normalizeContentText(article)
  const normalizedTarget = normalizeContentText(targetWord)
  const pattern = new RegExp(
    `(^|[^\\p{L}\\p{N}])${escapeRegExp(normalizedTarget)}(?=$|[^\\p{L}\\p{N}])`,
    'u',
  )
  return pattern.test(normalizedArticle)
}

const validateOption = (option: unknown, questionId: string, index: number): QuizOption => {
  if (!isRecord(option)) {
    throw new ContentValidationError(`Question ${questionId} option ${index + 1} must be an object`)
  }
  return {
    id: requireNonEmptyString(option.id, `Question ${questionId} option ${index + 1} id`).trim(),
    text: requireNonEmptyString(option.text, `Question ${questionId} option ${index + 1} text`).trim(),
  }
}

export function validateQuizQuestion(question: unknown, index: number): QuizQuestion {
  if (!isRecord(question)) throw new ContentValidationError(`Question ${index + 1} must be an object`)
  const id = requireNonEmptyString(question.id, `Question ${index + 1} id`).trim()
  const prompt = requireNonEmptyString(question.prompt, `Question ${id} prompt`).trim()
  if (!Array.isArray(question.options) || question.options.length !== OPTION_COUNT) {
    throw new ContentValidationError(`Question ${id} must have exactly ${OPTION_COUNT} options`)
  }
  const options = question.options.map((option, optionIndex) => validateOption(option, id, optionIndex))
  const optionIds = new Set<string>()
  const optionTexts = new Set<string>()
  for (const option of options) {
    if (optionIds.has(option.id)) throw new ContentValidationError(`Question ${id} option IDs must be unique`)
    optionIds.add(option.id)
    const normalizedText = normalizeContentText(option.text)
    if (optionTexts.has(normalizedText)) throw new ContentValidationError(`Question ${id} options must be unique`)
    optionTexts.add(normalizedText)
  }

  const correctOptionId = requireNonEmptyString(question.correctOptionId, `Question ${id} correctOptionId`).trim()
  if (!optionIds.has(correctOptionId)) {
    throw new ContentValidationError(`Question ${id} correctOptionId must identify one option`)
  }
  if (!Array.isArray(question.relatedWords) || question.relatedWords.length === 0) {
    throw new ContentValidationError(`Question ${id} relatedWords must be a non-empty array of strings`)
  }
  const relatedWords = question.relatedWords.map((word, relatedIndex) => (
    requireNonEmptyString(word, `Question ${id} relatedWords[${relatedIndex}]`).trim()
  ))
  const format = requireNonEmptyString(question.format, `Question ${id} format`).trim() as QuizQuestionFormat
  if (!QUIZ_QUESTION_FORMATS.includes(format)) {
    throw new ContentValidationError(`Question ${id} format must be one of ${QUIZ_QUESTION_FORMATS.join(', ')}`)
  }

  return { id, prompt, options, correctOptionId, relatedWords, format }
}

/** Validate and defensively copy model output against the requested generation spec. */
export function validateCycleContent(content: unknown, spec: GenerationSpec): CycleContent {
  const validatedSpec = validateGenerationSpec(spec)
  if (!isRecord(content)) throw new ContentValidationError('Generated content must be a JSON object')
  const article = requireNonEmptyString(content.article, 'Article').trim()
  if (!Array.isArray(content.questions) || content.questions.length !== QUESTION_COUNT) {
    throw new ContentValidationError(`Generated content must contain exactly ${QUESTION_COUNT} questions`)
  }
  const questions = content.questions.map((question, index) => validateQuizQuestion(question, index))
  const questionIds = new Set<string>()
  for (const question of questions) {
    if (questionIds.has(question.id)) throw new ContentValidationError(`Question IDs must be unique: ${question.id}`)
    questionIds.add(question.id)
  }

  const expectedFormats = determineQuestionFormats(validatedSpec.seed)
  for (let index = 0; index < QUESTION_COUNT; index += 1) {
    const question = questions[index]
    const expected = expectedFormats[index]
    if (question.format !== expected) {
      throw new ContentValidationError(
        `Question ${question.id} format must be "${expected}" for the seeded assignment (expected order: ${expectedFormats.join(', ')})`,
      )
    }
  }

  const missingWords = validatedSpec.targetWords.filter((word) => !containsNormalizedWord(article, word))
  if (missingWords.length > 0) {
    throw new ContentValidationError(`Article is missing target words: ${missingWords.join(', ')}`)
  }

  return { article, questions }
}
