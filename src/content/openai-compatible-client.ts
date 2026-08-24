import type { TextGenerationClient } from './types'

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

export type OpenAICompatibleClientOptions = {
  endpoint: string
  model: string
  apiKey: string
  fetch?: FetchLike
}

export class TextGenerationRequestError extends Error {
  readonly status?: number

  constructor(message: string, status?: number, options?: ErrorOptions) {
    super(message, options)
    this.name = 'TextGenerationRequestError'
    this.status = status
  }
}

/**
 * A small OpenAI-compatible adapter. It only sends the supplied key in the
 * authorization header; it does not persist, print, or include it in errors.
 */
export class OpenAICompatibleFetchClient implements TextGenerationClient {
  private readonly endpoint: string
  private readonly model: string
  private readonly apiKey: string
  private readonly fetcher: FetchLike

  constructor(options: OpenAICompatibleClientOptions) {
    if (typeof options.endpoint !== 'string' || options.endpoint.trim().length === 0) {
      throw new TypeError('An endpoint is required')
    }
    if (typeof options.model !== 'string' || options.model.trim().length === 0) {
      throw new TypeError('A model is required')
    }
    if (typeof options.apiKey !== 'string' || options.apiKey.length === 0) {
      throw new TypeError('An API key is required')
    }
    this.endpoint = options.endpoint
    this.model = options.model
    this.apiKey = options.apiKey
    const fetcher = options.fetch ?? globalThis.fetch
    if (fetcher === undefined) throw new TypeError('A fetch implementation is required')
    this.fetcher = fetcher.bind(globalThis)
  }

  async generate(prompt: string): Promise<string> {
    if (typeof prompt !== 'string' || prompt.trim().length === 0) {
      throw new TypeError('A generation prompt is required')
    }

    let response: Response
    try {
      response = await this.fetcher(this.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [{ role: 'user', content: prompt }],
        }),
      })
    } catch {
      // Do not preserve the underlying error: fetch errors may include request URLs,
      // headers, or credentials supplied by an adapter.
      throw new TextGenerationRequestError('Text generation request failed')
    }

    if (!response.ok) {
      throw new TextGenerationRequestError(`Text generation request failed with status ${response.status}`, response.status)
    }

    let payload: unknown
    try {
      payload = await response.json() as unknown
    } catch {
      // Response parsing failures can expose provider response details; keep the
      // public error limited to a safe, stable message and status.
      throw new TextGenerationRequestError('Text generation response was not valid JSON', response.status)
    }
    const content = readMessageContent(payload)
    if (content === undefined) {
      throw new TextGenerationRequestError('Text generation response did not contain message content', response.status)
    }
    return content
  }
}

const readMessageContent = (payload: unknown): string | undefined => {
  if (payload === null || typeof payload !== 'object' || !('choices' in payload)) return undefined
  const choices = (payload as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return undefined
  const first = choices[0]
  if (first === null || typeof first !== 'object' || !('message' in first)) return undefined
  const message = (first as { message?: unknown }).message
  if (message === null || typeof message !== 'object' || !('content' in message)) return undefined
  const content = (message as { content?: unknown }).content
  return typeof content === 'string' ? content : undefined
}

export function createOpenAICompatibleClient(options: OpenAICompatibleClientOptions): TextGenerationClient {
  return new OpenAICompatibleFetchClient(options)
}
