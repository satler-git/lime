import type { QuizQuestion } from '../quiz/types'

/** The JSON document returned for one reading cycle. */
export type CycleContent = {
  article: string
  questions: QuizQuestion[]
}

export type GenerationSpec = {
  targetWords: readonly string[]
  theme: string
  style: string
  articleWordTarget: number
}

/** A provider-neutral text generation port. */
export interface TextGenerationClient {
  generate(prompt: string): Promise<string>
}
