import * as Popover from '@radix-ui/react-popover'
import { BookOpen, RotateCcw, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Rating } from '../domain/card'
import { DictionaryText } from './DictionaryText'
import { RatingGroup } from './RatingGroup'
import type { TargetWordData, WordAnchor } from './types'

type DictionaryPopoverProps = {
  word: TargetWordData
  anchor?: WordAnchor
  rating?: Rating
  onRate?: (rating: Rating) => void
  onUndo?: () => void
  onClose?: () => void
  onAddToSrs?: () => void
  onOpenWord?: (word: string, anchor: WordAnchor) => void
}

const closeButtonClass = 'inline-flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-transparent p-0 transition-[background-color,transform] duration-120 hover:bg-surface-hover active:scale-[.96]'
const ratingLabels: Record<Rating, string> = { again: 'もう一度', hard: '難しい', good: 'できた', easy: '簡単' }

export function DictionaryPopover({ word, anchor, rating, onRate, onUndo, onClose, onAddToSrs, onOpenWord }: DictionaryPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const [inlineClose, setInlineClose] = useState(false)
  const [localRating, setLocalRating] = useState<Rating | undefined>(rating)
  const [undone, setUndone] = useState(false)
  const canAdd = word.inSrs === false || word.inSrs === undefined
  const popoverAnchor = anchor ?? { top: 80, left: 16, bottom: 80 }
  const currentRating = undone ? undefined : localRating ?? rating

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

  const handleRate = (nextRating: Rating) => {
    setUndone(false)
    setLocalRating(nextRating)
    onRate?.(nextRating)
  }
  const handleUndo = () => {
    setUndone(true)
    setLocalRating(undefined)
    onUndo?.()
  }
  const headerClass = inlineClose ? 'flex flex-wrap items-baseline gap-2.5 pt-1' : 'flex flex-wrap items-baseline gap-2.5 pr-10 pt-1'
  const closeButton = (className: string) => (
    <Popover.Close asChild>
      <button className={className} type="button" aria-label="辞書を閉じる"><X size={17} strokeWidth={1.8} aria-hidden="true" /></button>
    </Popover.Close>
  )

  return (
    <Popover.Root open onOpenChange={(open) => !open && onClose?.()}>
      <Popover.Anchor asChild>
        <span className="fixed h-px w-px opacity-0" style={{ top: popoverAnchor.bottom, left: popoverAnchor.left }} aria-hidden="true" />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content ref={panelRef} className="relative z-50 max-h-[min(680px,calc(100vh-108px))] w-[min(340px,calc(100vw-24px))] overflow-y-auto rounded-[10px] border border-[#485044] bg-surface-raised p-[18px] text-text shadow-[0_18px_48px_rgba(0,0,0,.45)] data-[state=open]:animate-[dictionary-popover-in_160ms_cubic-bezier(.2,0,0,1)_both]" side="bottom" align="start" sideOffset={8} collisionPadding={12} onOpenAutoFocus={(event) => event.preventDefault()}>
          {!inlineClose && <div className="absolute right-3 top-3">{closeButton(closeButtonClass)}</div>}
          <div className={headerClass}>
            <h2 ref={titleRef} id="dictionary-word-title" className="m-0 min-w-0 max-w-full break-words font-serif text-[34px] font-medium tracking-[-.04em]">{word.word}</h2>
            <span className="text-xs text-text-faint">{word.pronunciation}</span>
            {inlineClose && closeButton(closeButtonClass)}
          </div>
          <p className="mt-1 text-xs text-text-muted">{word.partOfSpeech}</p>
          <p className="mt-4 text-[15px] leading-normal">{word.definition}</p>
          <div className="mt-[18px] border-t border-line pt-[15px]">
            <p className="m-0 flex items-center gap-1.5 text-[10px] font-semibold tracking-[.1em] text-text-faint"><BookOpen size={14} strokeWidth={1.8} aria-hidden="true" /> 例文</p>
            {word.examples.map((example, index) => <p className="mt-3 font-serif text-[15px] leading-normal text-text-muted" key={`${word.word}-${index}`}>{typeof example === 'string' ? <DictionaryText text={example} entry={word.word} onOpen={onOpenWord} /> : example}</p>)}
          </div>
          {canAdd ? (
            <button className="mt-[15px] flex min-h-10 w-full cursor-pointer items-center justify-center gap-[7px] rounded-[7px] border-0 bg-accent px-3 text-xs font-semibold text-accent-ink transition-[background-color,transform] duration-120 animate-[dictionary-add-in_180ms_cubic-bezier(.2,0,0,1)_both] hover:bg-accent-strong active:scale-[.98]" type="button" onClick={onAddToSrs}><BookOpen size={15} strokeWidth={2} aria-hidden="true" /> SRSに追加</button>
          ) : currentRating ? (
            <button className="mt-[18px] flex min-h-10 w-full cursor-pointer items-center justify-center gap-[7px] rounded-[7px] border border-accent bg-[rgba(194,230,111,.11)] px-3 text-xs font-semibold text-accent transition-[background-color,border-color,transform] duration-120 animate-[dictionary-undo-in_180ms_cubic-bezier(.2,0,0,1)_both] hover:bg-[rgba(194,230,111,.18)] active:scale-[.98]" type="button" onClick={handleUndo}><RotateCcw size={15} strokeWidth={2} aria-hidden="true" /> {ratingLabels[currentRating]}を元に戻す</button>
          ) : (
            <div className="mt-[18px] border-t border-line pt-[15px] animate-[dictionary-rating-in_180ms_cubic-bezier(.2,0,0,1)_both]">
              <p className="m-0 flex items-center gap-1.5 text-[10px] font-semibold tracking-[.1em] text-text-faint">理解度</p>
              <RatingGroup value={currentRating} onChange={handleRate} compact />
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}
