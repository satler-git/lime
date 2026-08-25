import type { ReactNode } from 'react'
import { DictionaryWord } from './DictionaryWord'
import type { WordAnchor, WordKind } from './types'

type DictionaryTextProps = {
  text: string
  entry?: string
  targetWords?: Record<string, WordKind>
  onOpen?: (word: string, anchor: WordAnchor) => void
  /** Also reports the character offset needed by a session lookup port. */
  onOpenAt?: (word: string, anchor: WordAnchor, character: number, opener?: HTMLElement) => void
}

const wordPattern = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g

function normalize(word: string) {
  return word.toLocaleLowerCase().replaceAll('’', "'")
}

export function DictionaryText({ text, entry, targetWords = {}, onOpen, onOpenAt }: DictionaryTextProps) {
  const parts: ReactNode[] = []
  let cursor = 0
  const normalizedEntry = entry ? normalize(entry) : undefined

  for (const match of text.matchAll(wordPattern)) {
    const index = match.index ?? 0
    const token = match[0]
    if (index > cursor) parts.push(text.slice(cursor, index))
    const normalizedToken = normalize(token)
    parts.push(
      <DictionaryWord
        key={`${index}-${token}`}
        kind={targetWords[normalizedToken]}
        entry={normalizedToken === normalizedEntry}
        onOpen={(anchor, opener) => {
          onOpen?.(token, anchor)
          if (opener) onOpenAt?.(token, anchor, index, opener)
          else onOpenAt?.(token, anchor, index)
        }}
      >
        {token}
      </DictionaryWord>,
    )
    cursor = index + token.length
  }

  if (cursor < text.length) parts.push(text.slice(cursor))
  return <>{parts}</>
}
