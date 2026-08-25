import type { Card } from '../domain/card'
import { deriveSeedFromSpec } from './question-format'
import { generateCycleContent } from './generator'
import type { CycleContent, GenerationSpec, TextGenerationClient } from './types'
import { ContentValidationError, validateCycleContent, validateGenerationSpec } from './validation'

/** Context selected by the caller for one generated reading cycle. */
export type GenerationContext = Pick<GenerationSpec, 'theme' | 'style' | 'articleWordTarget'>

/** Select a theme without involving the text-generation client. */
export type ThemeSelector = (cards: readonly Card[]) => string

/** Select generation context without involving the text-generation client. */
export type GenerationContextFactory = (cards: readonly Card[]) => GenerationContext

/** Select the words represented by a cycle's cards. */
export type TargetWordsFactory = (cards: readonly Card[]) => readonly string[]

/** A pure mapping from a cycle and caller-owned context to a generation request. */
export type GenerationSpecFactory = (cards: readonly Card[], seed?: string) => GenerationSpec

export type ThemeGenerationSpecFactoryConfig = {
  themeSelector: ThemeSelector
  style?: string
  articleWordTarget?: number
  targetWords?: TargetWordsFactory
}

export type ContextGenerationSpecFactoryConfig = {
  context: GenerationContext | GenerationContextFactory
  targetWords?: TargetWordsFactory
}

/** Configuration for creating a pure card-to-generation-spec mapper. */
export type GenerationSpecFactoryConfig =
  | ThemeGenerationSpecFactoryConfig
  | ContextGenerationSpecFactoryConfig

export const DEFAULT_GENERATION_STYLE = 'clear magazine prose'
export const DEFAULT_ARTICLE_WORD_TARGET = 500

const defaultTargetWords: TargetWordsFactory = (cards) => cards.map((card) => card.word)

const isContextConfig = (
  config: GenerationSpecFactoryConfig,
): config is ContextGenerationSpecFactoryConfig => 'context' in config

/**
 * Create a deterministic generation-spec factory. The factory only maps card
 * data and caller-supplied context; it never asks a model to choose a theme.
 */
export function createGenerationSpecFactory(config: GenerationSpecFactoryConfig): GenerationSpecFactory {
  const targetWords = config.targetWords ?? defaultTargetWords

  return (cards, seed) => {
    const context = isContextConfig(config)
      ? typeof config.context === 'function' ? config.context(cards) : config.context
      : {
          theme: config.themeSelector(cards),
          style: config.style ?? DEFAULT_GENERATION_STYLE,
          articleWordTarget: config.articleWordTarget ?? DEFAULT_ARTICLE_WORD_TARGET,
        }
    const words = [...targetWords(cards)]

    return validateGenerationSpec({
      targetWords: words,
      theme: context.theme,
      style: context.style,
      articleWordTarget: context.articleWordTarget,
      seed: seed ?? deriveSeedFromSpec({
        targetWords: words,
        theme: context.theme,
        style: context.style,
        articleWordTarget: context.articleWordTarget,
      }),
    })
  }
}

/** A small injectable cache boundary for generated cycle content. */
export interface CycleContentCache {
  get(key: string): CycleContent | undefined
  set(key: string, content: CycleContent): void
  invalidate(key?: string): void
}

/** Configuration for a cycle-content provider and its shared-cache partition. */
export type CycleContentProviderConfig = {
  cache?: CycleContentCache
  /**
   * A stable, non-secret identifier for the model/endpoint/configuration producing
   * content. This must be provided when `cache` is provided; never use a client,
   * endpoint, API key, or other credential as the namespace.
   */
  cacheNamespace?: string
}

/** Default partition for no-cache providers and direct cache-key helper calls. */
export const DEFAULT_CYCLE_CONTENT_CACHE_NAMESPACE = 'cycle-content-v1'

/** Deterministic process-local cache. It stores no client, credentials, or prompts. */
export class InMemoryCycleContentCache implements CycleContentCache {
  private readonly entries = new Map<string, CycleContent>()

  get(key: string): CycleContent | undefined {
    const content = this.entries.get(key)
    return content === undefined ? undefined : cloneCycleContent(content)
  }

  set(key: string, content: CycleContent): void {
    this.entries.set(key, cloneCycleContent(content))
  }

  invalidate(key?: string): void {
    if (key === undefined) {
      this.entries.clear()
      return
    }
    this.entries.delete(key)
  }
}

const validateCacheNamespace = (cacheNamespace: unknown): string => {
  if (typeof cacheNamespace !== 'string' || cacheNamespace.trim().length === 0) {
    throw new ContentValidationError('cacheNamespace must be a non-empty string')
  }
  return cacheNamespace.trim()
}

/**
 * Hash a cache namespace before it is persisted in a cache key.
 *
 * This is a small, dependency-free FNV-1a token rather than a security
 * primitive. Namespaces are still intended to be non-secret identifiers.
 */
const hashCacheNamespace = (cacheNamespace: string): string => {
  let hash = 2166136261
  for (let index = 0; index < cacheNamespace.length; index += 1) {
    hash ^= cacheNamespace.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `namespace-v1-${(hash >>> 0).toString(16).padStart(8, '0')}`
}

/** Build a cache key from only the request and an opaque namespace token. */
export function createCycleContentCacheKey(
  spec: GenerationSpec,
  cacheNamespace?: string,
): string {
  const validated = validateGenerationSpec(spec)
  // Keep the direct helper's omitted-argument default stable. Configured
  // namespaces, including an explicitly supplied default, are opaque in keys.
  const validatedNamespace = cacheNamespace === undefined
    ? DEFAULT_CYCLE_CONTENT_CACHE_NAMESPACE
    : hashCacheNamespace(validateCacheNamespace(cacheNamespace))
  return JSON.stringify({
    cacheNamespace: validatedNamespace,
    targetWords: validated.targetWords,
    theme: validated.theme,
    style: validated.style,
    articleWordTarget: validated.articleWordTarget,
    seed: validated.seed,
  })
}

const cloneCycleContent = (content: CycleContent): CycleContent => ({
  article: content.article,
  questions: content.questions.map((question) => ({
    ...question,
    options: question.options.map((option) => ({ ...option })),
    relatedWords: [...question.relatedWords],
  })),
})

/**
 * Adapts provider-independent cycle generation to the application ContentProvider
 * port. Cache configuration is optional; callers using a cache must provide a
 * stable, non-secret namespace for their model/endpoint configuration.
 *
 * Single-flight de-duplication is scoped to this provider instance. Completed
 * entries can be shared by providers using the same cache and matching
 * namespace.
 */
export class CycleContentProvider {
  private readonly inFlight = new Map<string, Promise<CycleContent>>()
  private readonly cache?: CycleContentCache
  private readonly cacheNamespace: string

  constructor(
    private readonly client: TextGenerationClient,
    private readonly specFactory: GenerationSpecFactory,
    config: CycleContentProviderConfig = {},
  ) {
    this.cache = config.cache
    const configuredNamespace = this.cache === undefined
      ? config.cacheNamespace ?? DEFAULT_CYCLE_CONTENT_CACHE_NAMESPACE
      : config.cacheNamespace
    this.cacheNamespace = validateCacheNamespace(configuredNamespace)
  }

  async getContent(cards: readonly Card[], seed?: string): Promise<CycleContent> {
    const spec = validateGenerationSpec(this.specFactory(cards, seed))
    const cacheKey = createCycleContentCacheKey(spec, this.cacheNamespace)
    const cached = this.cache?.get(cacheKey)
    if (cached !== undefined) {
      return cloneCycleContent(validateCycleContent(cached, spec))
    }

    const pending = this.inFlight.get(cacheKey)
    if (pending !== undefined) {
      return pending.then(cloneCycleContent)
    }

    let generation: Promise<CycleContent>
    generation = generateCycleContent(spec, this.client)
      .then((generated) => {
        // Keep custom cache implementations from sharing or mutating the value returned here.
        this.cache?.set(cacheKey, cloneCycleContent(generated))
        return generated
      })
      .finally(() => {
        if (this.inFlight.get(cacheKey) === generation) this.inFlight.delete(cacheKey)
      })
    this.inFlight.set(cacheKey, generation)

    return generation.then(cloneCycleContent)
  }
}

export function createCycleContentProvider(
  client: TextGenerationClient,
  specFactory: GenerationSpecFactory,
  config: CycleContentProviderConfig = {},
): CycleContentProvider {
  return new CycleContentProvider(client, specFactory, config)
}
