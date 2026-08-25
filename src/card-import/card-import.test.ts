import { describe, expect, it } from 'vitest'
import { parseCardCsv } from './csv-parser'

describe('parseCardCsv', () => {
  it('extracts one word per line', () => {
    const words = parseCardCsv('resilient\nquiet\n')
    expect(words).toEqual(['resilient', 'quiet'])
  })

  it('uses the first CSV column', () => {
    const words = parseCardCsv('resilient,しなやかな\nquiet,静かな\n')
    expect(words).toEqual(['resilient', 'quiet'])
  })

  it('strips quotes and blank lines', () => {
    const words = parseCardCsv('"resilient"\n\n  quiet  \n')
    expect(words).toEqual(['resilient', 'quiet'])
  })

  it('removes duplicates', () => {
    const words = parseCardCsv('resilient\nresilient\nquiet\n')
    expect(words).toEqual(['resilient', 'quiet'])
  })

  it('ignores a header line', () => {
    const words = parseCardCsv('word\nresilient\nquiet\n')
    expect(words).toEqual(['resilient', 'quiet'])
  })
})
