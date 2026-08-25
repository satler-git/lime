import { parseGeneratedJson } from './parser'
import { buildGenerationPrompt } from './prompt'
import type { CycleContent, GenerationSpec, TextGenerationClient } from './types'
import { validateCycleContent, validateGenerationSpec } from './validation'

/** Compose prompt creation, provider invocation, JSON parsing, and validation. */
export async function generateCycleContent(
  spec: GenerationSpec,
  client: TextGenerationClient,
): Promise<CycleContent> {
  const validatedSpec = validateGenerationSpec(spec)
  const raw = await client.generate(buildGenerationPrompt(validatedSpec))
  return validateCycleContent(parseGeneratedJson(raw), validatedSpec)
}

export class CycleContentGenerator {
  constructor(private readonly client: TextGenerationClient) {}

  generate(spec: GenerationSpec): Promise<CycleContent> {
    return generateCycleContent(spec, this.client)
  }
}
