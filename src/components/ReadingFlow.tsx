import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CardId, Rating } from '../domain/card'
import type { CycleContent } from '../content/types'
import type {
  DictionaryResolverSnapshot,
  LearningSessionService,
} from '../application/learning-session-service'
import type { BatchSelectionState } from '../batch-add/types'
import type { RecordLookupInput } from '../session/session-service'
import type { ReadingSession } from '../session/types'
import type { QuizQuestion, QuizState } from '../quiz/types'
import { BatchAddPanel } from './BatchAddPanel'
import { DictionaryPopover } from './DictionaryPopover'
import { DictionaryText } from './DictionaryText'
import { QuizCard } from './QuizCard'
import type { TargetWordData, WordAnchor, WordKind } from './types'

export type ReadingFlowPhase = 'unavailable' | 'reading' | 'quiz' | 'complete'

/** The application methods used by the screen. A real LearningSessionService
 * can be passed directly; dictionary results are narrowed by the UI adapter. */
export type ReadingFlowApplication = Pick<
  LearningSessionService,
  | 'lookup'
  | 'reviewCard'
  | 'undoReview'
  | 'transitionToQuiz'
  | 'getQuizState'
  | 'answerQuestion'
  | 'completeSession'
  | 'createBatchSelection'
  | 'toggleBatchSelection'
  | 'addSelectedCandidates'
>

export type ReadingFlowProps = {
  session: ReadingSession
  content: CycleContent
  title: string
  application: ReadingFlowApplication
  cycle?: number
  totalCycles?: number
  targetWords?: Record<string, WordKind>
  /** Converts a provider-neutral dictionary result into the existing popover shape. */
  dictionaryAdapter?: (result: unknown, requestedWord: string) => TargetWordData
  /** Returns whether a looked-up word already has an SRS card. */
  isWordInSrs?: (word: string) => boolean
  /** Returns the card represented by a looked-up word, when it is reviewable. */
  cardIdForWord?: (word: string) => CardId | undefined
  initialQuiz?: QuizState
  initialBatchSelection?: BatchSelectionState
  completionScore?: number
}

type OpenWord = {
  id: string
  word: TargetWordData
  anchor: WordAnchor
  cardId?: CardId
  parentId?: string
  restoreFocus?: () => void
}

type LookupRequest = {
  word: string
  anchor: WordAnchor
  source: RecordLookupInput['source']
  position: RecordLookupInput['position']
  inSrs: boolean
  replace: boolean
  opener?: HTMLElement
  parentId?: string
}

type ReviewPendingAction = 'rate' | 'undo'

export function getArticleParagraphs(article: string): string[] {
  const paragraphs = article.split(/\r?\n(?:\s*\r?\n)+/).map((paragraph) => paragraph.trim()).filter(Boolean)
  return paragraphs.length > 0 ? paragraphs : [article]
}

export function phaseForSessionStatus(status: ReadingSession['status']): ReadingFlowPhase {
  if (status === 'reading') return 'reading'
  if (status === 'quiz') return 'quiz'
  if (status === 'completed') return 'complete'
  return 'unavailable'
}

export function resolveLookupInSrs(
  word: string,
  isWordInSrs?: (word: string) => boolean,
  cardIdForWord?: (word: string) => CardId | undefined,
): boolean {
  return isWordInSrs?.(word) ?? (cardIdForWord?.(word) !== undefined)
}

function removePopupWithDescendants(popups: OpenWord[], targetId: string): OpenWord[] {
  const toRemove = new Set<string>()
  const queue = [targetId]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (toRemove.has(id)) continue
    toRemove.add(id)
    for (const popup of popups) {
      if (popup.parentId === id) queue.push(popup.id)
    }
  }
  return popups.filter((popup) => !toRemove.has(popup.id))
}

function isTargetWordData(value: unknown): value is TargetWordData {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<TargetWordData>
  return typeof candidate.word === 'string'
    && typeof candidate.pronunciation === 'string'
    && typeof candidate.partOfSpeech === 'string'
    && typeof candidate.definition === 'string'
    && Array.isArray(candidate.examples)
}

function lookupResultToWord(
  result: DictionaryResolverSnapshot['result'],
  requestedWord: string,
  adapter?: ReadingFlowProps['dictionaryAdapter'],
): TargetWordData {
  const adapted = adapter?.(result, requestedWord)
  if (adapted !== undefined) return { ...adapted, inSrs: adapted.inSrs ?? false }
  if (isTargetWordData(result)) return { ...result, inSrs: result.inSrs ?? false }
  throw new Error(`Dictionary adapter did not return an entry for ${requestedWord}`)
}

export function ReadingFlow({
  session: initialSession,
  content,
  title,
  application,
  cycle = 1,
  totalCycles = 1,
  targetWords = {},
  dictionaryAdapter,
  isWordInSrs,
  cardIdForWord,
  initialQuiz,
  initialBatchSelection,
  completionScore,
}: ReadingFlowProps) {
  const [session, setSession] = useState(initialSession)
  const [phase, setPhase] = useState<ReadingFlowPhase>(() => phaseForSessionStatus(initialSession.status))
  const [quiz, setQuiz] = useState<QuizState | undefined>(initialQuiz)
  const [quizLoading, setQuizLoading] = useState(() => initialQuiz === undefined && phaseForSessionStatus(initialSession.status) === 'quiz')
  const [quizLoadAttempt, setQuizLoadAttempt] = useState(0)
  const [selectedAnswer, setSelectedAnswer] = useState<string>()
  const [transitioning, setTransitioning] = useState(false)
  const [completionPending, setCompletionPending] = useState(false)
  const [completionFailed, setCompletionFailed] = useState(false)
  const [flowError, setFlowError] = useState<string>()
  const [popovers, setPopovers] = useState<OpenWord[]>([])
  const [pendingLookup, setPendingLookup] = useState(false)
  const lookupRequestId = useRef(0)
  const popoverIdSequence = useRef(0)
  const phaseChangeId = useRef(0)
  const [ratings, setRatings] = useState<Record<string, Rating>>({})
  const [reviewActions, setReviewActions] = useState<Record<string, string>>({})
  const [pendingReviews, setPendingReviews] = useState<Record<string, ReviewPendingAction>>({})
  const pendingReviewsRef = useRef<Record<string, ReviewPendingAction>>({})
  const [batchSelection, setBatchSelection] = useState<BatchSelectionState | undefined>(initialBatchSelection)
  const [batchLoading, setBatchLoading] = useState(() => initialBatchSelection === undefined && phaseForSessionStatus(initialSession.status) === 'complete')
  const [batchLoadAttempt, setBatchLoadAttempt] = useState(0)
  const [batchAdding, setBatchAdding] = useState(false)
  const [batchAdded, setBatchAdded] = useState(false)

  const paragraphs = useMemo(() => getArticleParagraphs(content.article), [content.article])
  const articleWordCount = useMemo(() => content.article.trim().split(/\s+/).filter(Boolean).length, [content.article])

  useEffect(() => {
    if (phase !== 'quiz' || quiz !== undefined) return
    let active = true
    setQuizLoading(true)
    setFlowError(undefined)
    application.getQuizState(session.id)
      .then((state) => {
        if (active) setQuiz(state)
      })
      .catch((error: unknown) => {
        if (active) setFlowError(error instanceof Error ? error.message : '問題を読み込めませんでした')
      })
      .finally(() => {
        if (active) setQuizLoading(false)
      })
    return () => {
      active = false
    }
  }, [application, phase, quiz, quizLoadAttempt, session.id])

  useEffect(() => {
    if (phase !== 'complete' || batchSelection !== undefined) return
    let active = true
    setBatchLoading(true)
    setFlowError(undefined)
    application.createBatchSelection(session.id)
      .then((selection) => {
        if (active) setBatchSelection(selection)
      })
      .catch((error: unknown) => {
        if (active) setFlowError(error instanceof Error ? error.message : '単語を読み込めませんでした')
      })
      .finally(() => {
        if (active) setBatchLoading(false)
      })
    return () => {
      active = false
    }
  }, [application, batchLoadAttempt, batchSelection, phase, session.id])

  const lookupInSrs = useCallback((word: string) => resolveLookupInSrs(word, isWordInSrs, cardIdForWord), [cardIdForWord, isWordInSrs])
  const invalidateLookupRequests = useCallback(() => {
    lookupRequestId.current += 1
    phaseChangeId.current += 1
    setPendingLookup(false)
  }, [])

  useEffect(() => {
    // A phase change invalidates every in-flight dictionary response, including
    // responses for popovers that were rendered in the previous phase.
    invalidateLookupRequests()
    setPopovers([])
  }, [invalidateLookupRequests, phase])

  const openLookup = useCallback(async ({ word, anchor, source, position, inSrs, replace, opener, parentId }: LookupRequest) => {
    if (phase !== 'reading' && phase !== 'quiz') return
    const requestId = lookupRequestId.current + 1
    lookupRequestId.current = requestId
    const startGeneration = phaseChangeId.current
    const popupId = `dictionary-popup-${popoverIdSequence.current + 1}`
    popoverIdSequence.current += 1
    setFlowError(undefined)
    setPendingLookup(true)
    if (replace) setPopovers([])
    try {
      const snapshot = await application.lookup(session.id, {
        word,
        source,
        position,
        inSrs,
      })
      if (lookupRequestId.current !== requestId || phaseChangeId.current !== startGeneration) return
      const entry = lookupResultToWord(snapshot.result, word, dictionaryAdapter)
      entry.inSrs = inSrs
      const cardId = inSrs ? cardIdForWord?.(entry.word) : undefined
      const popup: OpenWord = {
        id: popupId,
        parentId,
        word: entry,
        anchor,
        cardId,
        restoreFocus: opener ? () => opener.focus() : undefined,
      }
      setSession(snapshot.session)
      setPopovers((current) => replace ? [popup] : [...current, popup])
    } catch (error: unknown) {
      if (lookupRequestId.current === requestId && phaseChangeId.current === startGeneration) {
        setFlowError(error instanceof Error ? error.message : '辞書を読み込めませんでした')
      }
    } finally {
      if (lookupRequestId.current === requestId && phaseChangeId.current === startGeneration) {
        setPendingLookup(false)
      }
    }
  }, [application, cardIdForWord, dictionaryAdapter, phase, session.id])

  const handleArticleLookup = useCallback((paragraph: number, word: string, anchor: WordAnchor, character: number, opener?: HTMLElement) => {
    if (phase !== 'reading' && phase !== 'quiz') return
    void openLookup({
      word,
      anchor,
      source: 'article',
      position: { paragraph, character },
      inSrs: lookupInSrs(word),
      replace: true,
      opener,
    })
  }, [lookupInSrs, openLookup, phase])

  const handleExampleLookup = useCallback((word: string, anchor: WordAnchor, position: RecordLookupInput['position'], opener?: HTMLElement, parentId?: string) => {
    if (phase !== 'reading' && phase !== 'quiz') return
    void openLookup({
      word,
      anchor,
      source: 'example',
      // Examples use their own paragraph index and the actual character offset.
      position,
      inSrs: lookupInSrs(word),
      replace: false,
      opener,
      parentId,
    })
  }, [lookupInSrs, openLookup, phase])

  const handleRate = useCallback(async (popup: OpenWord, rating: Rating) => {
    if (phase !== 'reading' || popup.cardId === undefined) return
    const cardId = popup.cardId
    if (pendingReviewsRef.current[cardId] !== undefined) return
    pendingReviewsRef.current[cardId] = 'rate'
    setPendingReviews((current) => ({ ...current, [cardId]: 'rate' }))
    setFlowError(undefined)
    try {
      const result = await application.reviewCard(session.id, cardId, rating)
      setRatings((current) => ({ ...current, [cardId]: result.action.rating }))
      setReviewActions((current) => ({ ...current, [cardId]: result.action.id }))
    } catch (error: unknown) {
      setFlowError(error instanceof Error ? error.message : '評価を保存できませんでした')
      throw error
    } finally {
      setPendingReviews((current) => {
        const next = { ...current }
        delete next[cardId]
        return next
      })
      delete pendingReviewsRef.current[cardId]
    }
  }, [application, phase, session.id])

  const handleUndo = useCallback(async (popup: OpenWord) => {
    if (phase !== 'reading' || popup.cardId === undefined) return
    const cardId = popup.cardId
    if (pendingReviewsRef.current[cardId] !== undefined) return
    pendingReviewsRef.current[cardId] = 'undo'
    setPendingReviews((current) => ({ ...current, [cardId]: 'undo' }))
    setFlowError(undefined)
    try {
      await application.undoReview(session.id, cardId, reviewActions[cardId])
      setRatings((current) => {
        const next = { ...current }
        delete next[cardId]
        return next
      })
      setReviewActions((current) => {
        const next = { ...current }
        delete next[cardId]
        return next
      })
    } catch (error: unknown) {
      setFlowError(error instanceof Error ? error.message : '評価を元に戻せませんでした')
      throw error
    } finally {
      setPendingReviews((current) => {
        const next = { ...current }
        delete next[cardId]
        return next
      })
      delete pendingReviewsRef.current[cardId]
    }
  }, [application, phase, reviewActions, session.id])

  const startQuiz = async () => {
    if (phase !== 'reading' || transitioning) return
    setTransitioning(true)
    setFlowError(undefined)
    invalidateLookupRequests()
    setPopovers([])
    try {
      const snapshot = await application.transitionToQuiz(session.id, content)
      setSession(snapshot.session)
      setQuiz(snapshot.quiz)
      setSelectedAnswer(undefined)
      setCompletionFailed(false)
      setPhase('quiz')
    } catch (error: unknown) {
      setFlowError(error instanceof Error ? error.message : '問題を開始できませんでした')
    } finally {
      setTransitioning(false)
    }
  }

  const finishQuiz = useCallback(async () => {
    if (phase !== 'quiz' || completionPending) return
    setCompletionPending(true)
    setCompletionFailed(false)
    setFlowError(undefined)
    invalidateLookupRequests()
    setPopovers([])
    try {
      const completed = await application.completeSession(session.id)
      setSession(completed)
      setPhase('complete')
    } catch (error: unknown) {
      setCompletionFailed(true)
      setFlowError(error instanceof Error ? error.message : '読了を完了できませんでした')
    } finally {
      setCompletionPending(false)
    }
  }, [application, completionPending, invalidateLookupRequests, phase, session.id])

  const answerCurrentQuestion = async () => {
    if (phase !== 'quiz' || quiz === undefined || selectedAnswer === undefined || transitioning) return
    const question = quiz.questions[quiz.currentQuestionIndex]
    if (question === undefined) return
    setTransitioning(true)
    setFlowError(undefined)
    try {
      const snapshot = await application.answerQuestion(session.id, question.id, selectedAnswer)
      setSession(snapshot.session)
      setQuiz(snapshot.quiz)
      setSelectedAnswer(undefined)
      if (snapshot.quiz.completed) await finishQuiz()
    } catch (error: unknown) {
      setFlowError(error instanceof Error ? error.message : '回答を保存できませんでした')
    } finally {
      setTransitioning(false)
    }
  }

  const toggleBatchCandidate = (word: string) => {
    if (phase !== 'complete' || batchSelection === undefined || batchAdding || batchAdded) return
    try {
      setBatchSelection(application.toggleBatchSelection(batchSelection, word))
    } catch (error: unknown) {
      setFlowError(error instanceof Error ? error.message : '単語を選択できませんでした')
    }
  }

  const addBatchCandidates = async () => {
    if (phase !== 'complete' || batchSelection === undefined || batchSelection.selectedWords.length === 0 || batchAdding || batchAdded) return
    setBatchAdding(true)
    setFlowError(undefined)
    try {
      await application.addSelectedCandidates(session.id, batchSelection)
      setBatchAdded(true)
    } catch (error: unknown) {
      setFlowError(error instanceof Error ? error.message : '単語を追加できませんでした')
    } finally {
      setBatchAdding(false)
    }
  }

  const currentQuestion: QuizQuestion | undefined = quiz?.questions[quiz.currentQuestionIndex]
  const displayScore = quiz?.score ?? completionScore

  return (
    <main className="min-h-screen bg-background px-4 py-8 text-text sm:px-6 sm:py-12" data-phase={phase}>
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-8 border-b border-line pb-5">
          <div className="flex items-center justify-between gap-4 text-[11px] font-semibold tracking-[.1em] text-text-faint">
            <span>読解サイクル</span>
            <span>{cycle} / {totalCycles}</span>
          </div>
          <div className="mt-3 h-1 overflow-hidden rounded-full bg-line" role="progressbar" aria-label={`読解サイクル ${cycle} / ${totalCycles}`} aria-valuenow={cycle} aria-valuemin={0} aria-valuemax={totalCycles}>
            <span className="block h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${Math.min(100, Math.max(0, (cycle / Math.max(totalCycles, 1)) * 100))}%` }} />
          </div>
          <p className="mb-0 mt-4 text-xs text-text-faint">{articleWordCount}語</p>
          <h1 className="m-0 mt-2 max-w-[680px] font-serif text-[clamp(32px,7vw,52px)] font-normal leading-[1.05] tracking-[-.045em]">{title}</h1>
        </header>

        <article className="font-serif text-[clamp(20px,3.4vw,26px)] leading-[1.75] text-text" aria-label="読解本文">
          {paragraphs.map((paragraph, paragraphIndex) => (
            <p className="m-0 mb-7 last:mb-0" key={`${paragraphIndex}-${paragraph.slice(0, 20)}`}>
              {phase === 'reading' || phase === 'quiz'
                ? <DictionaryText text={paragraph} targetWords={targetWords} onOpenAt={(word, anchor, character, opener) => handleArticleLookup(paragraphIndex, word, anchor, character, opener)} />
                : paragraph}
            </p>
          ))}
        </article>

        {pendingLookup && (phase === 'reading' || phase === 'quiz') && <p className="mt-4 text-xs text-text-faint" role="status">辞書を読み込んでいます</p>}
        {flowError && <p className="mt-4 text-xs text-again" role="alert">{flowError}</p>}

        {phase === 'unavailable' && (
          <p className="mt-10 border-t border-line pt-6 text-sm text-text-muted" role="status">この読解セッションは現在利用できません。</p>
        )}

        {phase === 'reading' && (
          <section className="mt-10 border-t border-line pt-6">
            <button className="min-h-11 w-full cursor-pointer rounded-[7px] border-0 bg-accent px-4 text-sm font-semibold text-accent-ink transition-[background-color,transform] duration-120 hover:bg-accent-strong active:scale-[.99] disabled:cursor-wait disabled:opacity-60 sm:w-auto" type="button" onClick={() => void startQuiz()} disabled={transitioning}>
              読了して問題へ
            </button>
          </section>
        )}

        {phase === 'quiz' && currentQuestion !== undefined && (
          <section className="mt-10 border-t border-line pt-6" aria-label="読解問題">
            <QuizCard
              question={currentQuestion.prompt}
              questionNumber={quiz?.currentQuestionIndex === undefined ? 1 : quiz.currentQuestionIndex + 1}
              totalQuestions={quiz?.questions.length ?? 5}
              options={currentQuestion.options}
              selectedId={selectedAnswer}
              correctId={selectedAnswer === undefined ? undefined : currentQuestion.correctOptionId}
              onSelect={setSelectedAnswer}
              onNext={() => void answerCurrentQuestion()}
              pending={transitioning}
            />
          </section>
        )}

        {phase === 'quiz' && quiz === undefined && quizLoading && <p className="mt-10 border-t border-line pt-6 text-sm text-text-muted" role="status">問題を読み込んでいます</p>}
        {phase === 'quiz' && quiz === undefined && !quizLoading && (
          <section className="mt-10 border-t border-line pt-6" aria-label="問題の再読み込み">
            <p className="text-sm text-text-muted" role="status">問題を読み込めませんでした。</p>
            <button className="mt-4 min-h-11 cursor-pointer rounded-[7px] border border-line bg-surface-raised px-4 text-sm font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.99]" type="button" onClick={() => { setFlowError(undefined); setQuizLoadAttempt((attempt) => attempt + 1) }}>
              問題を再読み込み
            </button>
          </section>
        )}

        {phase === 'quiz' && quiz?.completed && (
          <section className="mt-10 border-t border-line pt-6" aria-label="読了完了の再試行">
            <p className="text-sm text-text-muted" role="status">{completionFailed ? '回答は保存されています。読了の完了に失敗しました。' : '回答は保存されています。読了を完了してください。'}</p>
            <button className="mt-4 min-h-11 cursor-pointer rounded-[7px] border border-line bg-surface-raised px-4 text-sm font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.99] disabled:cursor-wait disabled:opacity-60" type="button" onClick={() => void finishQuiz()} disabled={completionPending} aria-busy={completionPending}>
              {completionPending ? '読了を完了しています' : completionFailed ? '読了完了を再試行' : '読了を完了'}
            </button>
          </section>
        )}

        {phase === 'complete' && (
          <section className="mt-10 border-t border-line pt-8" aria-labelledby="reading-complete-title">
            <p className="m-0 text-[10px] font-semibold tracking-[.1em] text-accent">読解完了</p>
            <h2 id="reading-complete-title" className="m-0 mt-2 font-serif text-[clamp(32px,7vw,48px)] font-normal leading-tight tracking-[-.04em]">{displayScore === undefined ? '採点結果不明' : `${displayScore} / ${quiz?.questions.length ?? 5}問 正解`}</h2>
            {batchLoading && <p className="mt-4 text-sm text-text-muted" role="status">調べた単語を読み込んでいます</p>}
            {!batchLoading && batchSelection === undefined && (
              <div className="mt-4" aria-label="一括追加候補の再読み込み">
                <p className="text-sm text-text-muted" role="status">調べた単語を読み込めませんでした。</p>
                <button className="mt-4 min-h-11 cursor-pointer rounded-[7px] border border-line bg-surface-raised px-4 text-sm font-semibold transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.99]" type="button" onClick={() => { setFlowError(undefined); setBatchLoadAttempt((attempt) => attempt + 1) }}>
                  単語を再読み込み
                </button>
              </div>
            )}
            {batchSelection !== undefined && (
              <div className="mt-7">
                <BatchAddPanel
                  candidates={batchSelection.candidates.map((candidate) => ({ word: candidate.word, context: `${candidate.lookupCount}回調べました` }))}
                  selected={batchSelection.candidates.filter((candidate) => batchSelection.selectedWords.includes(candidate.normalizedWord)).map((candidate) => candidate.word)}
                  onToggle={toggleBatchCandidate}
                  onAdd={() => void addBatchCandidates()}
                  disabled={batchAdded}
                  loading={batchAdding}
                />
                {batchAdded && <p className="mt-3 text-xs text-accent" role="status">SRSに追加しました</p>}
              </div>
            )}
          </section>
        )}

        {(phase === 'reading' || phase === 'quiz') && popovers.map((popup) => (
          <DictionaryPopover
            key={popup.id}
            word={popup.word}
            reviewable={phase === 'reading' && popup.cardId !== undefined}
            anchor={popup.anchor}
            rating={popup.cardId === undefined ? undefined : ratings[popup.cardId]}
            reviewPending={popup.cardId === undefined ? false : pendingReviews[popup.cardId] !== undefined}
            onRate={(rating) => handleRate(popup, rating)}
            onUndo={() => handleUndo(popup)}
            onClose={() => {
              invalidateLookupRequests()
              setPopovers((current) => removePopupWithDescendants(current, popup.id))
              popup.restoreFocus?.()
            }}
            onRestoreFocus={popup.restoreFocus}
            onOpenWord={(word, anchor, position, opener) => handleExampleLookup(word, anchor, position, opener, popup.id)}
          />
        ))}
      </div>
    </main>
  )
}
