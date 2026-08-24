import type { GenerationSpec } from './types'
import { validateGenerationSpec } from './validation'

/** Build the provider-neutral instruction sent to a text generation client. */
export function buildGenerationPrompt(spec: GenerationSpec): string {
  const validated = validateGenerationSpec(spec)
  const targetWords = validated.targetWords.map((word) => JSON.stringify(word)).join(', ')

  return [
    'Create reading-cycle content for a language learner.',
    `Theme: ${validated.theme}`,
    `Style: ${validated.style}`,
    `Target approximately ${validated.articleWordTarget} words for the article.`,
    `Target words (Use every target word in the article at least once): [${targetWords}]`,
    '',
    'Return only valid JSON, preferably as plain JSON without Markdown fences. For defensive compatibility, a single fenced JSON block is also accepted; do not include commentary or extra keys.',
    'The JSON must have this exact shape:',
    '{',
    '  "article": "...",',
    '  "questions": [',
    '    {',
    '      "id": "question-1",',
    '      "prompt": "...",',
    '      "options": [{"id": "a", "text": "..."}, {"id": "b", "text": "..."}, {"id": "c", "text": "..."}, {"id": "d", "text": "..."}],',
    '      "correctOptionId": "a",',
    '      "relatedWords": ["target word"]',
    '    }',
    '  ]',
    '}',
    'Write exactly five contextual multiple-choice questions about the article.',
    'Each question must have exactly four different options, exactly one correctOptionId that matches an option id, and a non-empty relatedWords array.',
  ].join('\n')
}
