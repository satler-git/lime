import type { ReadingSession, UnregisteredLookup } from '../session/types'
import type { Card, NewCard } from '../domain/card'
import { normalizeWord } from '../domain/word'
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

const candidateFromWord = (word: string, lookupCount: number): BatchCandidate | undefined => {
  if (typeof word !== 'string') {
    throw new BatchCandidateError('Candidate word must be a string')
  }
  const normalizedWord = normalizeWord(word)
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

const copyCandidate = (candidate: BatchCandidate): BatchCandidate => ({ ...candidate })

/** Validate the canonical shape used by selection snapshots. */
const assertCandidatePayload: (candidate: unknown) => asserts candidate is BatchCandidate = (candidate) => {
  if (candidate === null || typeof candidate !== 'object') {
    throw new BatchSelectionError('Batch candidate must be an object')
  }
  const value = candidate as BatchCandidate
  if (typeof value.word !== 'string' || normalizeWord(value.word).length === 0) {
    throw new BatchSelectionError('Batch candidate word must be nonempty')
  }
  if (value.word !== value.word.trim()) {
    throw new BatchSelectionError('Batch candidate word must be trimmed')
  }
  if (typeof value.normalizedWord !== 'string' || value.normalizedWord !== normalizeWord(value.word)) {
    throw new BatchSelectionError('Batch candidate normalizedWord must match its word')
  }
  if (!Number.isInteger(value.lookupCount) || value.lookupCount < 1) {
    throw new BatchSelectionError('Batch candidate lookupCount must be a positive integer')
  }
}

const assertCandidatePayloads = (candidates: readonly BatchCandidate[]): void => {
  if (!Array.isArray(candidates)) {
    throw new BatchSelectionError('Batch candidates must be an array')
  }
  const normalizedWords = new Set<string>()
  for (const candidate of candidates) {
    assertCandidatePayload(candidate)
    if (normalizedWords.has(candidate.normalizedWord)) {
      throw new BatchSelectionError('Batch candidates must have unique normalized words')
    }
    normalizedWords.add(candidate.normalizedWord)
  }
}

/**
 * Return a stable representation of a candidate list. The first-seen spelling,
 * normalized word, count, and order are all part of the snapshot so changes to
 * what the learner saw cannot be applied through an older selection.
 */
export function getBatchCandidateFingerprint(candidates: readonly BatchCandidate[]): string {
  return JSON.stringify(candidates.map((candidate) => ({
    word: candidate.word,
    normalizedWord: candidate.normalizedWord,
    lookupCount: candidate.lookupCount,
  })))
}

/** Validate the selection's own snapshot and normalized selected-word values. */
function assertSelectionIntegrity(state: BatchSelectionState): void {
  if (state === null || typeof state !== 'object') {
    throw new BatchSelectionError('Batch selection must be an object')
  }
  if (typeof state.sessionId !== 'string' || state.sessionId.length === 0) {
    throw new BatchSelectionError('Batch selection sessionId is required')
  }
  if (typeof state.candidateFingerprint !== 'string') {
    throw new BatchSelectionError('Batch selection candidateFingerprint is required')
  }
  if (!Array.isArray(state.candidates) || !Array.isArray(state.selectedWords)) {
    throw new BatchSelectionError('Batch selection has an invalid payload')
  }
  assertCandidatePayloads(state.candidates)
  if (getBatchCandidateFingerprint(state.candidates) !== state.candidateFingerprint) {
    throw new BatchSelectionError('Batch selection is invalid because its candidate payload changed')
  }

  const candidateWords = new Set(state.candidates.map((candidate) => candidate.normalizedWord))
  const selectedWords = new Set<string>()
  for (const selectedWord of state.selectedWords) {
    if (
      typeof selectedWord !== 'string'
      || normalizeWord(selectedWord) !== selectedWord
      || !candidateWords.has(selectedWord)
    ) {
      throw new BatchSelectionError(`Selected word is not a normalized candidate: ${String(selectedWord)}`)
    }
    if (selectedWords.has(selectedWord)) {
      throw new BatchSelectionError(`Selected word is duplicated: ${selectedWord}`)
    }
    selectedWords.add(selectedWord)
  }
}

/** Start a session-bound selection over a candidate list. */
export function createBatchSelection(
  sessionId: string,
  candidates: readonly BatchCandidate[],
): BatchSelectionState {
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new BatchSelectionError('A sessionId is required')
  }
  // The factory is intentionally strict: derivation is the only operation
  // that normalizes, trims, or merges raw lookup records.
  assertCandidatePayloads(candidates)
  const preservedCandidates = candidates.map(copyCandidate)
  return {
    sessionId,
    candidateFingerprint: getBatchCandidateFingerprint(preservedCandidates),
    candidates: preservedCandidates,
    selectedWords: [],
  }
}

/** Reject a selection that was made for another session or candidate snapshot. */
export function assertBatchSelectionMatches(
  selection: BatchSelectionState,
  sessionId: string,
  currentCandidates: readonly BatchCandidate[],
): void {
  assertSelectionIntegrity(selection)
  if (selection.sessionId !== sessionId) {
    throw new BatchSelectionError(
      `Batch selection belongs to session ${selection.sessionId}, not ${sessionId}`,
    )
  }
  assertCandidatePayloads(currentCandidates)
  const currentFingerprint = getBatchCandidateFingerprint(currentCandidates)
  if (selection.candidateFingerprint !== currentFingerprint) {
    throw new BatchSelectionError('Batch selection is stale because its candidate snapshot has changed')
  }
}

const assertCandidate = (state: BatchSelectionState, word: string): string => {
  assertSelectionIntegrity(state)
  if (typeof word !== 'string') {
    throw new BatchSelectionError('A word is required')
  }
  const normalizedWord = normalizeWord(word)
  if (!state.candidates.some((candidate) => candidate.normalizedWord === normalizedWord)) {
    throw new BatchSelectionError(`Candidate not found: ${word}`)
  }
  return normalizedWord
}

const copySelection = (state: BatchSelectionState): BatchSelectionState => ({
  sessionId: state.sessionId,
  candidateFingerprint: state.candidateFingerprint,
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
  assertSelectionIntegrity(state)
  const selected = new Set(state.selectedWords)
  return state.candidates.filter((candidate) => selected.has(candidate.normalizedWord)).map(copyCandidate)
}

export type BatchAddOptions = {
  clock?: () => Date
}

/**
 * Return one card for each selected normalized word, in candidate order.
 *
 * Creation uses the creator's required atomic `createIfAbsent` operation, so
 * retries reuse earlier successes. Creation is sequential: a failure leaves
 * earlier cards committed and later candidates unattempted. Adapters without
 * native atomic storage must provide that operation through their own fallback.
 */
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

    cards.push(await creator.createIfAbsent(input))
  }
  return cards
}

/** Injectable facade for application callers. */
export class BatchAddService {
  private readonly clock?: () => Date

  constructor(options: BatchAddOptions = {}) {
    this.clock = options.clock
  }

  candidates(source: BatchCandidateSource): BatchCandidate[] {
    return deriveBatchCandidates(source)
  }

  createSelection(sessionId: string, candidates: readonly BatchCandidate[]): BatchSelectionState {
    return createBatchSelection(sessionId, candidates)
  }

  toggle(state: BatchSelectionState, word: string): BatchSelectionState {
    return toggleBatchSelection(state, word)
  }

  add(state: BatchSelectionState, creator: CardCreator): Promise<Card[]> {
    return addSelectedWords(state, creator, { clock: this.clock })
  }
}
