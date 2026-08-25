const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

const isHeader = (first: string): boolean => {
  const normalized = first.toLowerCase()
  return normalized === 'word' || normalized === '単語' || normalized === 'term'
}

const parseCsvLine = (line: string): string | undefined => {
  const trimmed = line.trim()
  if (trimmed.length === 0) return undefined

  let first = trimmed
  if (first.includes(',')) {
    const parts = first.split(',')
    first = parts[0] ?? ''
  }

  first = first.replace(/^"/, '').replace(/"$/, '').trim()
  if (isHeader(first)) return undefined
  return first.length > 0 ? first : undefined
}

export function parseCardCsv(text: string): string[] {
  const normalized = stripBom(text)
  const words: string[] = []

  for (const line of normalized.split(/\r?\n/)) {
    const word = parseCsvLine(line)
    if (word !== undefined) words.push(word)
  }

  return [...new Set(words)]
}
