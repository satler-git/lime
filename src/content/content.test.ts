import { describe, expect, it, vi } from 'vitest'
import {
  ContentParseError,
  ContentValidationError,
  OpenAICompatibleFetchClient,
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

  it('rejects malformed JSON', () => {
    expect(() => parseGeneratedJson('{not-json}')).toThrowError(ContentParseError)
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

  it('turns network and HTTP failures into safe request errors', async () => {
    const networkClient = new OpenAICompatibleFetchClient({
      endpoint: 'https://llm.example.test',
      model: 'model',
      apiKey: 'do-not-leak',
      fetch: vi.fn(async () => { throw new Error('network') }),
    })
    await expect(networkClient.generate('prompt')).rejects.toThrowError('Text generation request failed')
    await expect(networkClient.generate('prompt')).rejects.not.toThrowError('do-not-leak')

    const httpClient = new OpenAICompatibleFetchClient({
      endpoint: 'https://llm.example.test',
      model: 'model',
      apiKey: 'secret',
      fetch: vi.fn(async () => responseFor({ error: 'bad request' }, { status: 400 })),
    })
    await expect(httpClient.generate('prompt')).rejects.toThrowError(/status 400/)
  })
})
