import type { ReactElement, ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { BatchAddService } from '../batch-add/batch-add-service'
import { QuizService } from '../quiz/quiz-service'
import type { QuizQuestion, QuizState } from '../quiz/types'
import type { ReadingSession } from '../session/types'
import { BatchAddPanel } from './BatchAddPanel'
import { DictionaryPopover } from './DictionaryPopover'
import { DictionaryText } from './DictionaryText'
import { QuizCard } from './QuizCard'
import { RatingGroup } from './RatingGroup'
import { ReadingFlow, getArticleParagraphs, phaseForSessionStatus, resolveLookupInSrs, type ReadingFlowApplication } from './ReadingFlow'

const questions: QuizQuestion[] = Array.from({ length: 5 }, (_, index) => ({
  id: `q-${index}`,
  prompt: `問題 ${index + 1}`,
  options: [
    { id: 'a', text: '選択肢 A' },
    { id: 'b', text: '選択肢 B' },
    { id: 'c', text: '選択肢 C' },
    { id: 'd', text: '選択肢 D' },
  ],
  correctOptionId: 'a',
  relatedWords: ['river'],
  format: index % 3 === 0 ? 'ja' : index % 3 === 1 ? 'en' : 'reasoning',
}))

const content = {
  article: 'A river can shape a resilient town.\n\nPeople care for the path together.',
  questions,
}

function session(status: ReadingSession['status']): ReadingSession {
  return {
    id: `test-${status}`,
    cardIds: ['card-1'],
    status,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
    lookupEvents: [],
  }
}

function appFor(source: ReadingSession): ReadingFlowApplication {
  return {
    lookup: vi.fn(async () => ({ session: source, result: {
      word: 'river', pronunciation: '/rɪvər/', partOfSpeech: '名詞', definition: '川', examples: [], inSrs: false,
    } })),
    reviewCard: vi.fn(async () => { throw new Error('not used') }),
    undoReview: vi.fn(async () => { throw new Error('not used') }),
    transitionToQuiz: vi.fn(async () => ({ session: { ...source, status: 'quiz' as const }, quiz: new QuizService().create(questions) })),
    getQuizState: vi.fn(async () => new QuizService().create(questions)),
    answerQuestion: vi.fn(async () => { throw new Error('not used') }),
    completeSession: vi.fn(async () => ({ ...source, status: 'completed' as const })),
    createBatchSelection: vi.fn(async (sessionId: string) => new BatchAddService().createSelection(sessionId, [
      { word: 'river', normalizedWord: 'river', lookupCount: 1 },
    ])),
    toggleBatchSelection: vi.fn((state, word) => new BatchAddService().toggle(state, word)),
    addSelectedCandidates: vi.fn(async () => []),
  }
}

function completedQuiz(): QuizState {
  const service = new QuizService()
  let state = service.create(questions)
  for (const question of questions) state = service.answer(state, question.id, 'a')
  return state
}

describe('ReadingFlow', () => {
  it('keeps one route-independent phase for session lifecycle states', () => {
    expect(phaseForSessionStatus('created')).toBe('unavailable')
    expect(phaseForSessionStatus('abandoned')).toBe('unavailable')
    expect(phaseForSessionStatus('reading')).toBe('reading')
    expect(phaseForSessionStatus('quiz')).toBe('quiz')
    expect(phaseForSessionStatus('completed')).toBe('complete')
    expect(getArticleParagraphs('one\n\ntwo')).toEqual(['one', 'two'])
  })

  it.each([
    ['reading', undefined, undefined],
    ['quiz', new QuizService().create(questions), undefined],
    ['completed', completedQuiz(), new BatchAddService().createSelection('test-completed', [{ word: 'river', normalizedWord: 'river', lookupCount: 1 }])],
  ] as const)('keeps article visible in %s', (status, initialQuiz, initialBatchSelection) => {
    const html = renderToStaticMarkup(
      <ReadingFlow
        title="川の手入れ"
        session={session(status as ReadingSession['status'])}
        content={content}
        application={appFor(session(status as ReadingSession['status']))}
        initialQuiz={initialQuiz}
        initialBatchSelection={initialBatchSelection}
      />,
    )
    if (status === 'reading') {
      expect(html).toContain('>A</button>')
      expect(html).toContain('>river</button>')
      expect(html).toContain('>shape</button>')
      expect(html).toContain('>People</button>')
      expect(html).toContain('>together</button>')
    } else if (status === 'quiz') {
      expect(html).toContain('>A</button>')
      expect(html).toContain('>river</button>')
      expect(html).toContain('>resilient</button>')
    }
    if (status === 'quiz') {
      expect(html).toContain('問題 1')
      expect(html).toContain('ダブルクリック、Enter/Space で辞書を開く')
    }
    if (status === 'completed') {
      expect(html).not.toContain('ダブルクリック、Enter/Space で辞書を開く')
      expect(html).toContain('5 / 5問 正解')
      expect(html).toContain('river')
      expect(html).toContain('読了後にまとめて追加')
    }
  })

  it('does not invent a zero score when a completed session has no result', () => {
    const html = renderToStaticMarkup(
      <ReadingFlow
        title="川の手入れ"
        session={session('completed')}
        content={content}
        application={appFor(session('completed'))}
        initialBatchSelection={new BatchAddService().createSelection('test-completed', [{ word: 'river', normalizedWord: 'river', lookupCount: 1 }])}
      />,
    )
    expect(html).toContain('採点結果不明')
    expect(html).not.toContain('0 / 5問 正解')
  })

  it('prefers an explicit SRS resolver and falls back to card membership', () => {
    const cardLookup = vi.fn(() => 'card-1' as const)
    const resolver = vi.fn(() => false)
    expect(resolveLookupInSrs('river', resolver, cardLookup)).toBe(false)
    expect(resolveLookupInSrs('river', undefined, cardLookup)).toBe(true)
    expect(resolver).toHaveBeenCalledWith('river')
  })

  it.each(['created', 'abandoned'] as const)('renders %s as unavailable without active actions', (status) => {
    const html = renderToStaticMarkup(
      <ReadingFlow
        title="川の手入れ"
        session={session(status)}
        content={content}
        application={appFor(session(status))}
      />,
    )
    expect(html).toContain('data-phase="unavailable"')
    expect(html).toContain('この読解セッションは現在利用できません。')
    expect(html).not.toContain('読了して問題へ')
    expect(html).not.toContain('ダブルクリック、Enter/Space で辞書を開く')
  })

  it('keeps quiz reload in a loading state before the application responds', () => {
    const html = renderToStaticMarkup(
      <ReadingFlow title="川の手入れ" session={session('quiz')} content={content} application={appFor(session('quiz'))} />,
    )
    expect(html).toContain('問題を読み込んでいます')
    expect(html).toContain('ダブルクリック、Enter/Space で辞書を開く')
  })

  it('keeps a completed quiz resumable with a completion action', () => {
    const html = renderToStaticMarkup(
      <ReadingFlow title="川の手入れ" session={session('quiz')} content={content} application={appFor(session('quiz'))} initialQuiz={completedQuiz()} />,
    )
    expect(html).toContain('data-phase="quiz"')
    expect(html).toContain('読了を完了')
    expect(html).toContain('回答は保存されています')
  })

  it('passes the actual dictionary character offset to lookup consumers', () => {
    const onOpenAt = vi.fn()
    const rendered = DictionaryText({ text: 'A river', onOpenAt }) as ReactElement<{ children: ReactNode }>
    const children = rendered.props.children as ReactElement<{ children: ReactNode }>[]
    const word = children.find((child) => child !== null && typeof child === 'object' && child.props.children === 'river') as unknown as ReactElement<{ onOpen: (anchor: { top: number; left: number; bottom: number }) => void }>
    word.props.onOpen({ top: 1, left: 2, bottom: 3 })
    expect(onOpenAt).toHaveBeenCalledWith('river', { top: 1, left: 2, bottom: 3 }, 2)
  })

  it('keeps native quiz and batch controls accessible while showing pending state', () => {
    const quizHtml = renderToStaticMarkup(<QuizCard question="問題" options={[{ id: 'a', text: 'A' }]} pending />)
    const batchHtml = renderToStaticMarkup(<BatchAddPanel candidates={[{ word: 'river', context: '1回' }]} selected={['river']} loading disabled />)
    const ratingHtml = renderToStaticMarkup(<RatingGroup value="good" disabled />)
    expect(quizHtml).toContain('<fieldset')
    expect(quizHtml).toContain('type="radio"')
    expect(quizHtml).toContain('回答を保存しています')
    expect(batchHtml).toContain('aria-busy="true"')
    expect(batchHtml).toContain('追加しています')
    expect(batchHtml).toContain('role="status"')
    expect(ratingHtml).toContain('aria-pressed="true"')
    expect(ratingHtml).toContain('1分')
  })

  it('hides review controls in quiz and never renders an add no-op', () => {
    const word = { word: 'river', pronunciation: '/rɪvər/', partOfSpeech: '名詞', definition: '川', examples: [], inSrs: false }
    const quizHtml = renderToStaticMarkup(<DictionaryPopover word={word} reviewable={false} rating="good" onRate={() => undefined} onUndo={() => undefined} />)
    const noAddHtml = renderToStaticMarkup(<DictionaryPopover word={word} reviewable={true} />)
    expect(quizHtml).not.toContain('理解度')
    expect(quizHtml).not.toContain('元に戻す')
    expect(noAddHtml).not.toContain('SRSに追加')
  })
})
