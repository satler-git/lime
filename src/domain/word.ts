/**
 * Normalize a word for matching across application and persistence adapters.
 *
 * This intentionally lives in the domain layer rather than a UI or batch
 * module so every card adapter uses the same case, Unicode, apostrophe, and
 * whitespace rules.
 */
const apostrophePattern = /[\u2018\u2019\u201B\u2032\u2033\u2034\u2057\uFF07]/g

export function normalizeWord(word: string): string {
  return word
    .replace(apostrophePattern, "'")
    .normalize('NFKC')
    .replace(apostrophePattern, "'")
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
}
