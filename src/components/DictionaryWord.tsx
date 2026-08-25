import type { KeyboardEvent, MouseEvent, ReactNode } from 'react'
import type { WordAnchor, WordKind } from './types'

type DictionaryWordProps = {
  children: ReactNode
  kind?: WordKind
  entry?: boolean
  active?: boolean
  onOpen?: (anchor: WordAnchor, opener: HTMLElement) => void
}

function getAnchor(element: HTMLElement): WordAnchor {
  const rect = element.getBoundingClientRect()
  return { top: rect.top, left: rect.left, bottom: rect.bottom }
}

export function DictionaryWord({ children, kind, entry = false, active = false, onOpen }: DictionaryWordProps) {
  const open = (element: HTMLElement) => onOpen?.(getAnchor(element), element)
  const handleDoubleClick = (event: MouseEvent<HTMLButtonElement>) => open(event.currentTarget)
  const handleKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      open(event.currentTarget)
    }
  }
  const kindClass = kind === 'new' ? 'text-word-new' : kind === 'review' ? 'text-word-review' : ''
  const entryClass = entry ? 'bg-transparent font-medium text-text underline decoration-accent decoration-1 underline-offset-[3px]' : ''
  const activeClass = active ? 'rounded-sm bg-[rgba(194,230,111,.18)] text-text' : ''

  return (
    <button
      className={`relative inline cursor-default border-0 bg-transparent px-px font-[inherit] ${kindClass} ${entryClass} ${activeClass} hover:rounded-sm hover:bg-[rgba(194,230,111,.18)] hover:text-text`}
      type="button"
      aria-label={`${children}。ダブルクリック、Enter/Space で辞書を開く`}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
    >
      {children}
      {kind && <span className={`absolute bottom-0.5 left-px right-px border-b border-current opacity-80 ${kind === 'review' ? 'border-dotted' : ''}`} aria-hidden="true" />}
    </button>
  )
}
