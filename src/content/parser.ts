export class ContentParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ContentParseError'
  }
}

/** Parse model output that is either JSON or a single fenced JSON block. */
export function parseGeneratedJson(text: string): unknown {
  if (typeof text !== 'string') throw new ContentParseError('Generated output must be a string')
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const json = (fenced?.[1] ?? trimmed).trim()
  if (json.length === 0) throw new ContentParseError('Generated output is empty')
  try {
    return JSON.parse(json) as unknown
  } catch {
    throw new ContentParseError('Generated output is not valid JSON')
  }
}
