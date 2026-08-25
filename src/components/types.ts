import type { ReactNode } from 'react'

export type WordKind = 'new' | 'review'

export type WordAnchor = {
  top: number
  left: number
  bottom: number
}

export type TargetWordData = {
  word: string
  kind?: WordKind
  pronunciation: string
  partOfSpeech: string
  definition: string
  examples: ReactNode[]
  inSrs: boolean
}
