import { describe, expect, it, vi } from 'vitest'
import {
  ContentValidationError,
  CycleContentProvider,
  DEFAULT_CYCLE_CONTENT_CACHE_NAMESPACE,
  InMemoryCycleContentCache,
  createCycleContentCacheKey,
  createGenerationSpecFactory,
} from './index'
import { createCard } from '../domain/card'
import type { Card } from '../domain/card'
import type { CycleContent, TextGenerationClient } from './types'

const makeContent = (words: readonly string[]): CycleContent => ({
  article: `A cycle about ${words.join(' and ')}.`,
  questions: Array.from({ length: 5 }, (_, index) => ({
    id: `question-${index + 1}`,
    prompt: `What is discussed in part ${index + 1}?`,
    options: [
      { id: 'a', text: `Answer ${index + 1}` },
      { id: 'b', text: `Alternative ${index + 1}` },
      { id: 'c', text: `Another ${index + 1}` },
      { id: 'd', text: `Last ${index + 1}` },
    ],
    correctOptionId: 'a',
    relatedWords: [words[0] ?? 'cycle'],
  })),
})

const cards = (words: readonly string[]): Card[] => words.map((word, index) => (
  createCard({ id: `card-${index}`, word, now: new Date('2025-01-01T00:00:00.000Z') })
))

const context = {
  theme: 'Public spaces',
  style: 'factual prose',
  articleWordTarget: 240,
}

const testCacheNamespace = 'cycle-content-test'

const makeClient = (content: CycleContent) => {
  const client: TextGenerationClient = {
    generate: vi.fn(async () => JSON.stringify(content)),
  }
  return client
}

describe('GenerationSpecFactory', () => {
  it('maps card words and caller-selected context to a generation spec', () => {
    const cycle = cards(['resilient', 'civic'])
    const selectTheme = vi.fn(() => 'Public spaces')
    const factory = createGenerationSpecFactory({
      themeSelector: selectTheme,
      style: 'narrative prose',
      articleWordTarget: 240,
    })

    expect(factory(cycle)).toEqual({
      targetWords: ['resilient', 'civic'],
      theme: 'Public spaces',
      style: 'narrative prose',
      articleWordTarget: 240,
    })
    expect(selectTheme).toHaveBeenCalledWith(cycle)
  })

  it('requires caller context and applies documented defaults for theme selection config', () => {
    const cycle = cards(['resilient'])
    const factory = createGenerationSpecFactory({ themeSelector: () => 'Public spaces' })

    expect(factory(cycle)).toEqual({
      targetWords: ['resilient'],
      theme: 'Public spaces',
      style: 'clear magazine prose',
      articleWordTarget: 500,
    })

    const contextFactory = createGenerationSpecFactory({
      context: () => context,
    })
    expect(contextFactory(cycle)).toEqual({ targetWords: ['resilient'], ...context })
  })

  it('does not permit missing or invalid caller context to reach generation', () => {
    const factory = createGenerationSpecFactory({
      themeSelector: () => ' ',
      style: 'factual prose',
      articleWordTarget: 240,
    })

    expect(() => factory(cards(['resilient']))).toThrowError(ContentValidationError)
  })
})

describe('CycleContentProvider', () => {
  it('generates through the existing generator and propagates output validation errors', async () => {
    const client = makeClient(makeContent(['resilient', 'civic']))
    const provider = new CycleContentProvider(
      client,
      createGenerationSpecFactory({ context }),
    )

    await expect(provider.getContent(cards(['resilient', 'civic']))).resolves.toEqual(makeContent(['resilient', 'civic']))
    expect(client.generate).toHaveBeenCalledWith(expect.stringContaining('Public spaces'))

    const invalidClient = makeClient({ ...makeContent(['resilient', 'civic']), article: 'No requested words.' })
    const invalidProvider = new CycleContentProvider(invalidClient, createGenerationSpecFactory({ context }))
    await expect(invalidProvider.getContent(cards(['resilient', 'civic'])))
      .rejects.toThrowError(ContentValidationError)
  })

  it('requires an explicit non-secret namespace when a cache is supplied', () => {
    const client = makeClient(makeContent(['resilient']))
    const factory = createGenerationSpecFactory({ context })
    const cache = new InMemoryCycleContentCache()

    expect(() => new CycleContentProvider(client, factory, { cache }))
      .toThrowError(ContentValidationError)
    expect(() => new CycleContentProvider(client, factory, { cache, cacheNamespace: ' ' }))
      .toThrowError(ContentValidationError)
    expect(() => new CycleContentProvider(client, factory, { cache, cacheNamespace: testCacheNamespace }))
      .not.toThrow()
  })

  it('uses opaque deterministic tokens for supplied cache namespaces', () => {
    const spec = { targetWords: ['resilient'], ...context }
    const apiKeyLikeNamespace = 'sk-test-cache-namespace-123456'
    const rawNamespace = 'model-a-endpoint-1'
    const apiKeyKey = createCycleContentCacheKey(spec, apiKeyLikeNamespace)
    const rawKey = createCycleContentCacheKey(spec, rawNamespace)

    expect(apiKeyKey).not.toContain(apiKeyLikeNamespace)
    expect(apiKeyKey).not.toContain('sk-test-cache')
    expect(rawKey).not.toContain(rawNamespace)
    expect(apiKeyKey).toBe(createCycleContentCacheKey(spec, apiKeyLikeNamespace))
    expect(createCycleContentCacheKey(spec)).toContain(
      `"cacheNamespace":"${DEFAULT_CYCLE_CONTENT_CACHE_NAMESPACE}`,
    )
  })

  it('deduplicates concurrent misses per cache key and returns defensive clones', async () => {
    const cycle = cards(['resilient'])
    const generated = makeContent(['resilient'])
    let resolveGeneration: ((value: string) => void) | undefined
    const client: TextGenerationClient = {
      generate: vi.fn(() => new Promise<string>((resolve) => {
        resolveGeneration = resolve
      })),
    }
    const provider = new CycleContentProvider(
      client,
      createGenerationSpecFactory({ context }),
      { cache: new InMemoryCycleContentCache(), cacheNamespace: testCacheNamespace },
    )

    const firstRequest = provider.getContent(cycle)
    const secondRequest = provider.getContent(cycle)
    expect(client.generate).toHaveBeenCalledTimes(1)
    resolveGeneration?.(JSON.stringify(generated))

    const [first, second] = await Promise.all([firstRequest, secondRequest])
    expect(first).toEqual(generated)
    expect(second).toEqual(generated)
    expect(first).not.toBe(second)
    first.questions[0].options[0].text = 'mutated'
    expect(second.questions[0].options[0].text).toBe('Answer 1')
  })

  it('clears failed in-flight generations before retrying', async () => {
    const cycle = cards(['resilient'])
    const generated = makeContent(['resilient'])
    let fail = true
    const client: TextGenerationClient = {
      generate: vi.fn(async () => {
        if (fail) {
          fail = false
          throw new Error('temporary failure')
        }
        return JSON.stringify(generated)
      }),
    }
    const provider = new CycleContentProvider(client, createGenerationSpecFactory({ context }))

    const firstRequest = provider.getContent(cycle)
    const secondRequest = provider.getContent(cycle)
    await expect(Promise.all([firstRequest, secondRequest])).rejects.toThrow('temporary failure')
    await expect(provider.getContent(cycle)).resolves.toEqual(generated)
    expect(client.generate).toHaveBeenCalledTimes(2)
  })

  it('shares completed cache entries between provider instances with matching namespace', async () => {
    const cycle = cards(['resilient'])
    const cache = new InMemoryCycleContentCache()
    const firstClient = makeClient(makeContent(['resilient']))
    const secondClient = makeClient(makeContent(['resilient']))
    const factory = createGenerationSpecFactory({ context })
    const apiKeyLikeNamespace = 'sk-test-cache-namespace-123456'
    const firstProvider = new CycleContentProvider(firstClient, factory, {
      cache,
      cacheNamespace: apiKeyLikeNamespace,
    })
    const secondProvider = new CycleContentProvider(secondClient, factory, {
      cache,
      cacheNamespace: apiKeyLikeNamespace,
    })

    await firstProvider.getContent(cycle)
    await expect(secondProvider.getContent(cycle)).resolves.toEqual(makeContent(['resilient']))

    const key = createCycleContentCacheKey({ targetWords: ['resilient'], ...context }, apiKeyLikeNamespace)
    expect(key).not.toContain(apiKeyLikeNamespace)
    expect(firstClient.generate).toHaveBeenCalledTimes(1)
    expect(secondClient.generate).not.toHaveBeenCalled()
  })

  it('separates shared cache entries by non-secret cache namespace', async () => {
    const cycle = cards(['resilient'])
    const cache = new InMemoryCycleContentCache()
    const firstClient = makeClient(makeContent(['resilient']))
    const secondClient = makeClient(makeContent(['resilient']))
    const factory = createGenerationSpecFactory({ context })
    const firstProvider = new CycleContentProvider(firstClient, factory, {
      cache,
      cacheNamespace: 'model-a-endpoint-1',
    })
    const secondProvider = new CycleContentProvider(secondClient, factory, {
      cache,
      cacheNamespace: 'model-b-endpoint-2',
    })

    await firstProvider.getContent(cycle)
    await secondProvider.getContent(cycle)

    expect(firstClient.generate).toHaveBeenCalledTimes(1)
    expect(secondClient.generate).toHaveBeenCalledTimes(1)
    expect(createCycleContentCacheKey({ targetWords: ['resilient'], ...context }))
      .toContain(`"cacheNamespace":"${DEFAULT_CYCLE_CONTENT_CACHE_NAMESPACE}"`)
  })

  it('has deterministic cache hit, miss, and invalidation behavior', async () => {
    const cycle = cards(['resilient'])
    const client = makeClient(makeContent(['resilient']))
    const cache = new InMemoryCycleContentCache()
    const provider = new CycleContentProvider(
      client,
      createGenerationSpecFactory({ context }),
      { cache, cacheNamespace: testCacheNamespace },
    )

    await provider.getContent(cycle)
    await provider.getContent(cycle)
    expect(client.generate).toHaveBeenCalledTimes(1)

    const key = createCycleContentCacheKey({ targetWords: ['resilient'], ...context }, testCacheNamespace)
    expect(cache.get(key)).toEqual(makeContent(['resilient']))
    cache.invalidate(key)
    await provider.getContent(cycle)
    expect(client.generate).toHaveBeenCalledTimes(2)

    cache.invalidate()
    expect(cache.get(key)).toBeUndefined()
  })

  it('separates cache entries when generation context changes', async () => {
    const cycle = cards(['resilient'])
    const client = makeClient(makeContent(['resilient']))
    const cache = new InMemoryCycleContentCache()
    let selectedContext = context
    const provider = new CycleContentProvider(
      client,
      createGenerationSpecFactory({ context: () => selectedContext }),
      { cache, cacheNamespace: testCacheNamespace },
    )

    await provider.getContent(cycle)
    selectedContext = { ...context, theme: 'Rivers' }
    await provider.getContent(cycle)

    expect(client.generate).toHaveBeenCalledTimes(2)
  })
})
