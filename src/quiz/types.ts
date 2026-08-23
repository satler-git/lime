export type QuizOption = {
  id: string
  text: string
}

export type QuizQuestion = {
  id: string
  prompt: string
  options: QuizOption[]
  correctOptionId: string
  relatedWords: string[]
}

export type QuizAnswer = {
  questionId: string
  optionId: string
  correct: boolean
  answeredAt: Date
}

export type QuizState = {
  questions: readonly QuizQuestion[]
  answers: readonly QuizAnswer[]
  currentQuestionIndex: number
  score: number
  completed: boolean
  startedAt: Date
  completedAt?: Date
}

export type QuizClock = () => Date

export type QuizServiceOptions = {
  clock?: QuizClock
}

export type QuizProgress = {
  answered: number
  total: number
  remaining: number
  currentQuestionIndex: number
  currentQuestionNumber: number
  completed: boolean
}
