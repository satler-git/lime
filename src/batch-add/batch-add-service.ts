import type { ReadingSession, UnregisteredLookup } from '../session/types'
import type { Card, NewCard } from '../domain/card'
import type {
  BatchCandidate,
  BatchCandidateSource,
  BatchSelectionState,
  CardCreator,
} from './types'

export class BatchCandidateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchCandidateError'
  }
}

export class BatchSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BatchSelectionError'
  }
}

export class EmptyBatchSelectionError extends Error {
  constructor(message = 'Select at least one word before adding cards') {
    super(message)
    this.name = 'EmptyBatchSelectionError'
  }
}

const normalizeApostrophes = (word: string): string => word.replace(/[\u2018\u2019\u201B\u2032\uFF07]/g, "'")

/** Shared matching rule for both supplied candidates and session events. */
export function normalizeBatchWord(word: string): string {
  return normalizeApostrophes(word.normalize('NFKC')).trim().toLocaleLowerCase('en-US').replace(/\s+/g, ' ')
}

const candidateFromWord = (word: string, lookupCount: number): BatchCandidate | undefined => {
  if (typeof word !== 'string') {
    throw new BatchCandidateError('Candidate word must be a string')
  }
  const normalizedWord = normalizeBatchWord(word)
  if (normalizedWord.length === 0) return undefined
  if (!Number.isInteger(lookupCount) || lookupCount < 1) {
    throw new BatchCandidateError(`Lookup count must be a positive integer for ${word}`)
  }
  return { word: word.trim(), normalizedWord, lookupCount }
}

const mergeCandidate = (candidates: Map<string, BatchCandidate>, word: string, lookupCount: number): void => {
  const candidate = candidateFromWord(word, lookupCount)
  if (candidate === undefined) return
  const existing = candidates.get(candidate.normalizedWord)
  if (existing === undefined) {
    candidates.set(candidate.normalizedWord, candidate)
  } else {
    existing.lookupCount += candidate.lookupCount
  }
}

const candidatesFromLookups = (lookups: readonly UnregisteredLookup[]): BatchCandidate[] => {
  const candidates = new Map<string, BatchCandidate>()
  for (const lookup of lookups) {
    if (lookup === null || typeof lookup !== 'object') {
      throw new BatchCandidateError('Unregistered lookup must be an object')
    }
    mergeCandidate(candidates, lookup.word, lookup.lookupCount)
  }
  return [...candidates.values()]
}

const candidatesFromSession = (session: ReadingSession): BatchCandidate[] => {
  const candidates = new Map<string, BatchCandidate>()
  for (const event of session.lookupEvents) {
    if (event.inSrs) continue
    mergeCandidate(candidates, event.word, 1)
  }
  return [...candidates.values()]
}

const isReadingSession = (source: BatchCandidateSource): source is ReadingSession => !Array.isArray(source)

/**
 * Convert either the session boundary or an already-derived lookup list into
 * normalized, first-seen candidates. Counts are summed if a caller supplies
 * duplicate UnregisteredLookup records.
 */
export function deriveBatchCandidates(source: BatchCandidateSource): BatchCandidate[] {
  return isReadingSession(source) ? candidatesFromSession(source) : candidatesFromLookups(source)
}

export const getBatchCandidates = deriveBatchCandidates
export const deriveCandidates = deriveBatchCandidates

const copyCandidate = (candidate: BatchCandidate): BatchCandidate => ({ ...candidate })

/** Start an immutable selection over a candidate list. */
export function createBatchSelection(candidates: readonly BatchCandidate[]): BatchSelectionState {
  const normalizedCandidates = deriveBatchCandidates(candidates.map((candidate) => ({
    word: candidate.word,
    lookupCount: candidate.lookupCount,
  })))
  return { candidates: normalizedCandidates, selectedWords: [] }
}

const assertCandidate = (state: BatchSelectionState, word: string): string => {
  if (typeof word !== 'string') {
    throw new BatchSelectionError('A word is required')
  }
  const normalizedWord = normalizeBatchWord(word)
  if (!state.candidates.some((candidate) => candidate.normalizedWord === normalizedWord)) {
    throw new BatchSelectionError(`Candidate not found: ${word}`)
  }
  return normalizedWord
}

const copySelection = (state: BatchSelectionState): BatchSelectionState => ({
  candidates: state.candidates.map(copyCandidate),
  selectedWords: [...state.selectedWords],
})

/** Toggle a candidate using its normalized word, regardless of input casing. */
export function toggleBatchSelection(state: BatchSelectionState, word: string): BatchSelectionState {
  const normalizedWord = assertCandidate(state, word)
  const selected = new Set(state.selectedWords)
  if (selected.has(normalizedWord)) selected.delete(normalizedWord)
  else selected.add(normalizedWord)
  return { ...copySelection(state), selectedWords: [...selected] }
}

export const toggleSelection = toggleBatchSelection

export function selectBatchWord(state: BatchSelectionState, word: string): BatchSelectionState {
  const normalizedWord = assertCandidate(state, word)
  if (state.selectedWords.includes(normalizedWord)) return copySelection(state)
  return { ...copySelection(state), selectedWords: [...state.selectedWords, normalizedWord] }
}

export function deselectBatchWord(state: BatchSelectionState, word: string): BatchSelectionState {
  const normalizedWord = assertCandidate(state, word)
  return {
    ...copySelection(state),
    selectedWords: state.selectedWords.filter((selectedWord) => selectedWord !== normalizedWord),
  }
}

export function getSelectedBatchCandidates(state: BatchSelectionState): BatchCandidate[] {
  const selected = new Set(state.selectedWords)
  return state.candidates.filter((candidate) => selected.has(candidate.normalizedWord)).map(copyCandidate)
}

export const getSelectedCandidates = getSelectedBatchCandidates

export type BatchAddOptions = {
  clock?: () => Date
}

/** Create one card for each selected normalized word, in candidate order. */
export async function addSelectedWords(
  state: BatchSelectionState,
  creator: CardCreator,
  options: BatchAddOptions = {},
): Promise<Card[]> {
  const selectedCandidates = getSelectedBatchCandidates(state)
  if (selectedCandidates.length === 0) throw new EmptyBatchSelectionError()

  const cards: Card[] = []
  for (const candidate of selectedCandidates) {
    const input: NewCard = { word: candidate.word }
    if (options.clock !== undefined) input.now = options.clock()
    cards.push(await creator.create(input))
  }
  return cards
}

export const createSelectedCards = addSelectedWords
export const addSelectedCandidates = addSelectedWords

/** Injectable facade for application callers. */
export class BatchAddService {
  private readonly clock?: () => Date

  constructor(options: BatchAddOptions = {}) {
    this.clock = options.clock
  }

  candidates(source: BatchCandidateSource): BatchCandidate[] {
    return deriveBatchCandidates(source)
  }

  createSelection(candidates: readonly BatchCandidate[]): BatchSelectionState {
    return createBatchSelection(candidates)
  }

  toggle(state: BatchSelectionState, word: string): BatchSelectionState {
    return toggleBatchSelection(state, word)
  }

  add(state: BatchSelectionState, creator: CardCreator): Promise<Card[]> {
    return addSelectedWords(state, creator, { clock: this.clock })
  }
}
