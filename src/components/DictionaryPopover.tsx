import * as Popover from '@radix-ui/react-popover'
import { BookOpen, RotateCcw, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { Rating } from '../domain/card'
import type { TextPosition } from '../session/types'
import { DictionaryText } from './DictionaryText'
import { RatingGroup } from './RatingGroup'
import type { TargetWordData, TargetWordSubEntry, WordAnchor } from './types'

type DictionaryPopoverProps = {
  word: TargetWordData
  reviewable: boolean
  anchor?: WordAnchor
  rating?: Rating
  onRate?: (rating: Rating) => void | Promise<void>
  onUndo?: () => void | Promise<void>
  onClose?: () => void
  onAddToSrs?: () => void
  /** The position is local to the example when its article paragraph is unavailable. */
  onOpenWord?: (word: string, anchor: WordAnchor, position: TextPosition, opener?: HTMLElement) => void
  /** Restores focus to the word control that opened this UI-only popup. */
  onRestoreFocus?: () => void
  reviewPending?: boolean
}

function getSubEntries(word: TargetWordData): TargetWordSubEntry[] {
  const first: TargetWordSubEntry = {
    pronunciation: word.pronunciation,
    partOfSpeech: word.partOfSpeech,
    definition: word.definition,
    examples: word.examples,
  }
  return word.entries ? [first, ...word.entries] : [first]
}

function getSubEntriesWithOffsets(word: TargetWordData): { entry: TargetWordSubEntry; exampleOffset: number }[] {
  const subEntries = getSubEntries(word)
  const result: { entry: TargetWordSubEntry; exampleOffset: number }[] = []
  let offset = 0
  for (const entry of subEntries) {
    result.push({ entry, exampleOffset: offset })
    offset += entry.examples.length
  }
  return result
}

const closeButtonClass = 'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent p-0 transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96] disabled:cursor-wait disabled:opacity-60'
const ratingLabels: Record<Rating, string> = { again: 'もう一度', hard: '難しい', good: 'できた', easy: '簡単' }

type ReviewAction = 'rate' | 'undo'

export function DictionaryPopover({ word, reviewable, anchor, rating, onRate, onUndo, onClose, onAddToSrs, onOpenWord, onRestoreFocus, reviewPending = false }: DictionaryPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const [inlineClose, setInlineClose] = useState(false)
  const popoverId = useId().replaceAll(':', '')
  const titleId = `dictionary-word-title-${popoverId}`
  const actionErrorId = `dictionary-action-error-${popoverId}`
  const [localRating, setLocalRating] = useState<Rating | undefined>(rating)
  const [undone, setUndone] = useState(false)
  const [pendingAction, setPendingAction] = useState<ReviewAction>()
  const [actionError, setActionError] = useState<string>()
  const canAdd = onAddToSrs !== undefined && !word.inSrs
  const canReview = reviewable && onRate !== undefined && word.inSrs
  const popoverAnchor = anchor ?? { top: 80, left: 16, bottom: 80 }
  const currentRating = undone ? undefined : localRating ?? rating
  const actionPending = pendingAction !== undefined || reviewPending

  useEffect(() => {
    setLocalRating(rating)
    setUndone(false)
  }, [rating, word.word])

  useLayoutEffect(() => {
    const measureClosePosition = () => {
      const panel = panelRef.current
      const title = titleRef.current
      if (!panel || !title) return
      const style = window.getComputedStyle(title)
      const canvas = document.createElement('canvas')
      const context = canvas.getContext('2d')
      if (!context) return
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`
      const titleWidth = context.measureText(word.word).width
      const availableWidth = panel.clientWidth - 36
      setInlineClose(titleWidth + 32 + 20 <= availableWidth)
    }
    measureClosePosition()
    window.addEventListener('resize', measureClosePosition)
    return () => window.removeEventListener('resize', measureClosePosition)
  }, [word.word])

  const handleRate = async (nextRating: Rating) => {
    if (actionPending || !onRate) return
    const previousRating = currentRating
    setActionError(undefined)
    setPendingAction('rate')
    setUndone(false)
    setLocalRating(nextRating)
    try {
      await onRate?.(nextRating)
    } catch (error: unknown) {
      setUndone(previousRating === undefined)
      setLocalRating(previousRating)
      setActionError(error instanceof Error ? error.message : '評価を保存できませんでした')
    } finally {
      setPendingAction(undefined)
    }
  }

  const handleUndo = async () => {
    if (actionPending || currentRating === undefined || !onUndo) return
    const previousRating = currentRating
    setActionError(undefined)
    setPendingAction('undo')
    setUndone(true)
    setLocalRating(undefined)
    try {
      await onUndo?.()
    } catch (error: unknown) {
      setUndone(false)
      setLocalRating(previousRating)
      setActionError(error instanceof Error ? error.message : '評価を元に戻せませんでした')
    } finally {
      setPendingAction(undefined)
    }
  }

  const headerClass = inlineClose ? 'flex flex-wrap items-baseline gap-3 pt-1' : 'flex flex-wrap items-baseline gap-3 pr-10 pt-1'
  const closeButton = (className: string) => (
    <Popover.Close asChild>
      <button ref={closeButtonRef} className={className} type="button" aria-label="辞書を閉じる"><X size={17} strokeWidth={1.8} aria-hidden="true" /></button>
    </Popover.Close>
  )

  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose?.()}>
      <Popover.Anchor asChild>
        <span className="fixed h-px w-px opacity-0" style={{ top: popoverAnchor.bottom, left: popoverAnchor.left }} aria-hidden="true" />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content ref={panelRef} aria-labelledby={titleId} aria-describedby={actionError ? actionErrorId : undefined} className="relative z-50 max-h-[min(680px,calc(100vh-108px))] w-[min(340px,calc(100vw-24px))] overflow-y-auto rounded-[10px] border border-[#485044] bg-surface-raised p-5 text-text shadow-[0_18px_48px_rgba(0,0,0,.45)] data-[state=open]:animate-[dictionary-popover-in_160ms_cubic-bezier(.2,0,0,1)_both]" side="bottom" align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={(event) => { event.preventDefault(); closeButtonRef.current?.focus() }} onCloseAutoFocus={(event) => { event.preventDefault(); onRestoreFocus?.() }}>
          {!inlineClose && <div className="absolute right-3 top-3">{closeButton(closeButtonClass)}</div>}
          <div className={headerClass}>
            <h2 ref={titleRef} id={titleId} className="m-0 min-w-0 max-w-full break-words font-serif text-[34px] font-medium tracking-[-.04em]">{word.word}</h2>
            {inlineClose && closeButton(closeButtonClass)}
          </div>
          {getSubEntriesWithOffsets(word).map(({ entry, exampleOffset }, index) => (
            <div key={`${word.word}-${index}`} className={index > 0 ? 'mt-4 border-t border-line pt-4' : ''}>
              {(entry.pronunciation || entry.partOfSpeech) && (
                <div className={`flex flex-wrap items-baseline gap-2 ${index === 0 ? '' : 'mt-1'}`}>
                  {entry.pronunciation && <span className="text-xs text-text-faint">{entry.pronunciation}</span>}
                  {entry.partOfSpeech && <span className="text-xs text-text-muted">{entry.partOfSpeech}</span>}
                </div>
              )}
              <p className="mt-2 text-[15px] leading-normal">{entry.definition}</p>
              {entry.examples.length > 0 && (
                <div className="mt-5 border-t border-line pt-4">
                  <p className="m-0 flex items-center gap-2 text-[10px] font-semibold tracking-[.1em] text-text-faint"><BookOpen size={14} strokeWidth={1.8} aria-hidden="true" /> 例文</p>
                  {entry.examples.map((example, exampleIndex) => {
                    const paragraph = exampleOffset + exampleIndex
                    return (
                      <p className="mt-3 font-serif text-[15px] leading-normal text-text-muted" key={`${word.word}-${paragraph}`}>
                        {typeof example === 'string' ? <DictionaryText text={example} entry={word.word} onOpenAt={(selected, exampleAnchor, character, opener) => onOpenWord?.(selected, exampleAnchor, { paragraph, character }, opener)} /> : example}
                      </p>
                    )
                  })}
                </div>
              )}
            </div>
          ))}
          {actionError && <p id={actionErrorId} className="mt-3 text-xs text-again" role="alert">{actionError}</p>}
          {actionPending && <p className="mt-3 text-xs text-text-faint" role="status" aria-live="polite">{pendingAction === 'undo' ? '評価を元に戻しています' : '評価を保存しています'}</p>}
          {canAdd ? (
            <button className="mt-4 flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border-0 bg-accent px-4 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 animate-[dictionary-add-in_180ms_cubic-bezier(.2,0,0,1)_both] hover:bg-accent-strong active:scale-[.98]" type="button" onClick={onAddToSrs}><BookOpen size={15} strokeWidth={2} aria-hidden="true" /> SRSに追加</button>
          ) : canReview && currentRating !== undefined && onUndo !== undefined && !actionPending ? (
            <button className="mt-5 flex min-h-10 w-full cursor-pointer items-center justify-center gap-2 rounded-[7px] border border-accent bg-[rgba(194,230,111,.11)] px-4 text-xs font-semibold text-accent transition-[background-color,border-color,transform] duration-120 animate-[dictionary-undo-in_180ms_cubic-bezier(.2,0,0,1)_both] hover:bg-[rgba(194,230,111,.18)] active:scale-[.98] disabled:cursor-wait disabled:opacity-60" type="button" onClick={() => void handleUndo()} disabled={actionPending} aria-busy={pendingAction === 'undo'}><RotateCcw size={15} strokeWidth={2} aria-hidden="true" /> {`${ratingLabels[currentRating]}を元に戻す`}</button>
          ) : canReview ? (
            <div className="mt-5 border-t border-line pt-4 animate-[dictionary-rating-in_180ms_cubic-bezier(.2,0,0,1)_both]">
              <p className="m-0 flex items-center gap-2 text-[10px] font-semibold tracking-[.1em] text-text-faint">理解度</p>
              <RatingGroup value={currentRating} onChange={(nextRating) => void handleRate(nextRating)} compact disabled={actionPending} />
            </div>
          ) : null}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
