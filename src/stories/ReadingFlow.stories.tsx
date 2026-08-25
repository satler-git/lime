import type { Meta, StoryObj } from '@storybook/react'
import { BatchAddService } from '../batch-add/batch-add-service'
import { ReadingFlow, type ReadingFlowApplication } from '../components/ReadingFlow'
import type { TargetWordData } from '../components/types'
import { createCard } from '../domain/card'
import { QuizService } from '../quiz/quiz-service'
import type { QuizQuestion, QuizState } from '../quiz/types'
import type { ReadingSession } from '../session/types'

const questions: QuizQuestion[] = Array.from({ length: 5 }, (_, index) => ({
  id: `question-${index + 1}`,
  prompt: index === 0 ? '川沿いの町が静かな場所を守った理由は何ですか？' : `本文の要点を確認する問題 ${index + 1}`,
  options: [
    { id: 'a', text: '人々が長く話し合ったから' },
    { id: 'b', text: '変化に合わせて使い方を工夫したから' },
    { id: 'c', text: '新しい道路を先に作ったから' },
    { id: 'd', text: '町を離れる人が増えたから' },
  ],
  correctOptionId: 'b',
  relatedWords: ['resilient'],
  format: index % 3 === 0 ? 'ja' : index % 3 === 1 ? 'en' : 'reasoning',
}))

const content = {
  article: 'Along the quiet river, a resilient community restored an old footbridge.\n\nThe project began with a small group of residents. They kept the path open while the town planned a permanent crossing.',
  questions,
}

const entries: Record<string, TargetWordData> = {
  quiet: {
    word: 'quiet', pronunciation: '/ˈkwaɪət/', partOfSpeech: '形容詞', inSrs: true,
    definition: '音や動きが少ない', examples: ['The river was quiet after sunset.'],
  },
  resilient: {
    word: 'resilient', pronunciation: '/rɪˈzɪliənt/', partOfSpeech: '形容詞', inSrs: false,
    definition: '困難や変化のあとに、すぐに回復できる性質', examples: ['Small communities can be remarkably resilient.'],
  },
}

function makeSession(status: ReadingSession['status']): ReadingSession {
  return {
    id: `storybook-${status}`,
    cardIds: ['resilient-card'],
    status,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    startedAt: new Date('2025-01-01T00:00:00.000Z'),
    lookupEvents: [],
  }
}

const fakeCard = createCard({ id: 'resilient-card', word: 'resilient', now: new Date('2025-01-01T00:00:00.000Z') })
const quizService = new QuizService()
const batchService = new BatchAddService()

function completeQuiz(): QuizState {
  let state = quizService.create(questions)
  for (const question of questions) state = quizService.answer(state, question.id, 'b')
  return state
}

function makeApplication(session: ReadingSession): ReadingFlowApplication {
  let quizState = quizService.create(questions)
  return {
    lookup: async (_sessionId, input) => ({ session, result: entries[input.word.toLocaleLowerCase()] ?? entries.quiet }),
    reviewCard: async (_session, _cardId, rating) => ({
      previous: fakeCard,
      next: fakeCard,
      action: {
        id: `storybook-review-${rating}`,
        sessionId: session.id,
        cardId: fakeCard.id,
        rating,
        timestamp: new Date('2025-01-01T00:00:00.000Z'),
        previousState: fakeCard,
        nextState: fakeCard,
        undone: false,
      },
    }),
    undoReview: async () => ({
      previous: fakeCard,
      next: fakeCard,
      action: {
        id: 'storybook-review', sessionId: session.id, cardId: fakeCard.id, rating: 'good',
        timestamp: new Date('2025-01-01T00:00:00.000Z'), previousState: fakeCard, nextState: fakeCard, undone: true,
      },
    }),
    transitionToQuiz: async () => {
      quizState = quizService.create(questions)
      return { session: { ...session, status: 'quiz' }, quiz: quizState }
    },
    getQuizState: async () => quizState,
    answerQuestion: async (_sessionId, questionId, optionId) => {
      quizState = quizService.answer(quizState, questionId, optionId)
      return { session: { ...session, status: 'quiz' }, quiz: quizState }
    },
    completeSession: async () => ({ ...session, status: 'completed', completedAt: new Date('2025-01-01T00:00:00.000Z') }),
    createBatchSelection: async (sessionId) => batchService.createSelection(sessionId, [
      { word: 'resilient', normalizedWord: 'resilient', lookupCount: 1 },
      { word: 'footbridge', normalizedWord: 'footbridge', lookupCount: 1 },
    ]),
    toggleBatchSelection: (state, word) => batchService.toggle(state, word),
    addSelectedCandidates: async () => [],
  }
}

const meta = {
  title: 'lime / 読解フロー',
  parameters: { layout: 'fullscreen' },
} satisfies Meta

export default meta
type Story = StoryObj<typeof meta>

export const 読書中: Story = {
  render: () => {
    const session = makeSession('reading')
    return <ReadingFlow title="川辺の小さな再生" session={session} content={content} application={makeApplication(session)} cycle={2} totalCycles={7} targetWords={{ resilient: 'new' }} isWordInSrs={(word) => word.toLocaleLowerCase() === 'quiet'} cardIdForWord={(word) => word.toLocaleLowerCase() === 'resilient' ? fakeCard.id : undefined} />
  },
}

export const 利用できないセッション: Story = {
  render: () => {
    const session = makeSession('abandoned')
    return <ReadingFlow title="川辺の小さな再生" session={session} content={content} application={makeApplication(session)} cycle={2} totalCycles={7} />
  },
}

export const 問題中も本文を表示: Story = {
  render: () => {
    const session = makeSession('quiz')
    return <ReadingFlow title="川辺の小さな再読み込み" session={session} content={content} application={makeApplication(session)} cycle={2} totalCycles={7} targetWords={{ resilient: 'new' }} />
  },
}

export const 問題中の保存済み状態: Story = {
  render: () => {
    const session = makeSession('quiz')
    return <ReadingFlow title="川辺の小さな再生" session={session} content={content} application={makeApplication(session)} initialQuiz={quizService.create(questions)} cycle={2} totalCycles={7} targetWords={{ resilient: 'new' }} />
  },
}

export const 読了と一括追加: Story = {
  render: () => {
    const session = makeSession('completed')
    const selection = batchService.createSelection(session.id, [
      { word: 'resilient', normalizedWord: 'resilient', lookupCount: 2 },
      { word: 'footbridge', normalizedWord: 'footbridge', lookupCount: 1 },
    ])
    return <ReadingFlow title="川辺の小さな再生" session={session} content={content} application={makeApplication(session)} initialQuiz={completeQuiz()} initialBatchSelection={selection} cycle={2} totalCycles={7} />
  },
}
