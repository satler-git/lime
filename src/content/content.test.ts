import { describe, expect, it, vi } from 'vitest'
import {
  ContentParseError,
  ContentValidationError,
  OpenAICompatibleFetchClient,
  TextGenerationRequestError,
  buildGenerationPrompt,
  generateCycleContent,
  parseGeneratedJson,
  validateCycleContent,
} from './index'
import { createQuizState } from '../quiz'
import type { CycleContent, GenerationSpec, TextGenerationClient } from './types'

const spec: GenerationSpec = {
  targetWords: ['resilient', "learner's", 'state-of-the-art'],
  theme: 'Cities adapting to change',
  style: 'clear magazine prose',
  articleWordTarget: 180,
}

const content: CycleContent = {
  article: 'A RESILIENT city supports a learner’s curiosity with state‑of‑the‑art public spaces.',
  questions: Array.from({ length: 5 }, (_, index) => ({
    id: `question-${index + 1}`,
    prompt: `What does the article emphasize in point ${index + 1}?`,
    options: [
      { id: 'a', text: `A distinct answer ${index + 1}` },
      { id: 'b', text: `A different answer ${index + 1}` },
      { id: 'c', text: `Another answer ${index + 1}` },
      { id: 'd', text: `The final answer ${index + 1}` },
    ],
    correctOptionId: 'a',
    relatedWords: ['resilient'],
  })),
}

const responseFor = (value: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(value), init)

const serializeErrorGraph = (value: unknown, seen = new Set<object>()): string => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value)
  if (seen.has(value)) return '[Circular]'
  seen.add(value)

  const properties = Object.getOwnPropertyNames(value).map((property) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, property)
    return `${property}:${serializeErrorGraph(descriptor?.value, seen)}`
  })
  return `{${properties.join(',')}}`
}

describe('generation spec and prompt', () => {
  it('includes the requested theme, style, target, and JSON-only constraints', () => {
    const prompt = buildGenerationPrompt(spec)
    expect(prompt).toContain(spec.theme)
    expect(prompt).toContain(spec.style)
    expect(prompt).toContain('180')
    expect(prompt).toContain('resilient')
    expect(prompt).toContain("learner's")
    expect(prompt).toContain('Return only valid JSON')
    expect(prompt).toContain('exactly five contextual multiple-choice questions')
  })

  it('rejects an invalid generation spec before invoking a client', async () => {
    const client: TextGenerationClient = { generate: vi.fn() }
    await expect(generateCycleContent({ ...spec, articleWordTarget: 0 }, client))
      .rejects.toThrowError(ContentValidationError)
    expect(client.generate).not.toHaveBeenCalled()
  })
})

describe('cycle content generation', () => {
  it('generates, parses, and strictly validates a cycle', async () => {
    const client: TextGenerationClient = { generate: vi.fn(async () => JSON.stringify(content)) }
    await expect(generateCycleContent(spec, client)).resolves.toEqual(content)
    expect(client.generate).toHaveBeenCalledWith(expect.stringContaining('Use every target word'))
  })

  it('passes generated cycle questions directly to quiz state creation', async () => {
    const client: TextGenerationClient = { generate: vi.fn(async () => JSON.stringify(content)) }
    const generated = await generateCycleContent(spec, client)
    const state = createQuizState(generated.questions)

    expect(state.questions).toEqual(generated.questions)
  })

  it('rejects content with a missing target word', () => {
    expect(() => validateCycleContent({ ...content, article: 'A resilient city adapts.' }, spec))
      .toThrowError(/missing target words.*learner's.*state-of-the-art/)
  })

  it('rejects the wrong question count and wrong option count', () => {
    expect(() => validateCycleContent({ ...content, questions: content.questions.slice(0, 4) }, spec))
      .toThrowError(/exactly 5 questions/)
    const questions = content.questions.map((question, index) => index === 0
      ? { ...question, options: question.options.slice(0, 3) }
      : question)
    expect(() => validateCycleContent({ ...content, questions }, spec)).toThrowError(/exactly 4 options/)
  })

  it('rejects a missing or invalid answer and duplicate options', () => {
    const noAnswer = content.questions.map((question, index) => index === 0
      ? { ...question, correctOptionId: 'missing' }
      : question)
    expect(() => validateCycleContent({ ...content, questions: noAnswer }, spec)).toThrowError(/correctOptionId/)
    const duplicateOptions = content.questions.map((question, index) => index === 0
      ? { ...question, options: question.options.map((option, optionIndex) => optionIndex === 1 ? { ...option, text: question.options[0].text } : option) }
      : question)
    expect(() => validateCycleContent({ ...content, questions: duplicateOptions }, spec)).toThrowError(/options must be unique/)
  })
})

describe('generated JSON parsing', () => {
  it('parses plain and fenced JSON', () => {
    const json = JSON.stringify(content)
    expect(parseGeneratedJson(json)).toEqual(content)
    expect(parseGeneratedJson(`\n\`\`\`json\n${json}\n\`\`\`\n`)).toEqual(content)
  })

  it('rejects malformed JSON without retaining generated-output secrets', () => {
    const secret = 'sk-generated-output-secret'
    const malformed = `{"article":"${secret}",`
    const error = (() => {
      try {
        parseGeneratedJson(malformed)
      } catch (caught: unknown) {
        return caught
      }
      return undefined
    })()

    expect(error).toBeInstanceOf(ContentParseError)
    expect((error as Error).message).toBe('Generated output is not valid JSON')
    expect((error as Error).cause).toBeUndefined()
    expect(serializeErrorGraph(error)).not.toContain(secret)
  })
})

describe('OpenAI-compatible fetch client', () => {
  it('sends the prompt, model, and key using the standard chat request', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => responseFor({ choices: [{ message: { content: '{"ok":true}' } }] }))
    const client = new OpenAICompatibleFetchClient({
      endpoint: 'https://llm.example.test/v1/chat/completions',
      model: 'test-model',
      apiKey: 'secret-key',
      fetch: fetcher,
    })

    await expect(client.generate('make JSON')).resolves.toBe('{"ok":true}')
    expect(fetcher).toHaveBeenCalledWith(
      'https://llm.example.test/v1/chat/completions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer secret-key' }),
      }),
    )
    const request = fetcher.mock.calls[0]?.[1]
    expect(JSON.parse(String(request?.body))).toEqual({
      model: 'test-model',
      messages: [{ role: 'user', content: 'make JSON' }],
    })
  })

  it('turns network, JSON, and HTTP failures into safe request errors', async () => {
    const secret = 'secret-api-key'
    const networkFailure = Object.assign(
      new Error(`request failed for https://llm.example.test?api_key=${secret}`),
      { requestHeaders: { Authorization: `Bearer ${secret}` } },
    )
    const networkClient = new OpenAICompatibleFetchClient({
      endpoint: 'https://llm.example.test',
      model: 'model',
      apiKey: secret,
      fetch: vi.fn(async () => { throw networkFailure }),
    })
    const networkError = await networkClient.generate('prompt').catch((error: unknown) => error)
    expect(networkError).toBeInstanceOf(TextGenerationRequestError)
    expect((networkError as Error).name).toBe('TextGenerationRequestError')
    expect((networkError as Error).message).toBe('Text generation request failed')
    expect((networkError as Error).cause).toBeUndefined()
    expect(serializeErrorGraph(networkError)).not.toContain(secret)

    const response = responseFor({}, { status: 200 })
    response.json = async () => {
      throw Object.assign(new Error(`invalid response from ${secret}`), {
        responseHeaders: { Authorization: `Bearer ${secret}` },
      })
    }
    const jsonClient = new OpenAICompatibleFetchClient({
      endpoint: 'https://llm.example.test',
      model: 'model',
      apiKey: secret,
      fetch: vi.fn(async () => response),
    })
    const jsonError = await jsonClient.generate('prompt').catch((error: unknown) => error)
    expect(jsonError).toBeInstanceOf(TextGenerationRequestError)
    expect((jsonError as Error).name).toBe('TextGenerationRequestError')
    expect((jsonError as Error).message).toBe('Text generation response was not valid JSON')
    expect((jsonError as { status?: number }).status).toBe(200)
    expect((jsonError as Error).cause).toBeUndefined()
    expect(serializeErrorGraph(jsonError)).not.toContain(secret)

    const httpClient = new OpenAICompatibleFetchClient({
      endpoint: 'https://llm.example.test',
      model: 'model',
      apiKey: secret,
      fetch: vi.fn(async () => responseFor({ error: 'bad request' }, { status: 400 })),
    })
    await expect(httpClient.generate('prompt')).rejects.toThrowError(/status 400/)
  })
})
