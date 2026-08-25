import { describe, expect, it } from 'vitest'
import { hasControlCharacters, parseExpectedOrigin, sameOrigin } from './origin'

describe('origin validation', () => {
  it('rejects C0 and other control characters before URL parsing', () => {
    for (const character of ['\u0000', '\u0009', '\u000a', '\u001f', '\u007f', '\u0085', '\u009f']) {
      expect(hasControlCharacters(`https://app.example.test${character}`)).toBe(true)
      expect(() => parseExpectedOrigin(`https://app.example.test${character}`)).toThrow(/valid same-origin origin/)
      expect(sameOrigin(`https://app.example.test${character}`, 'https://app.example.test')).toBe(false)
    }
  })

  it('accepts only an origin for request Origin values while allowing an app path in APP_URL', () => {
    expect(sameOrigin('https://app.example.test', 'https://app.example.test/deployment')).toBe(true)
    for (const value of [
      'https://app.example.test/',
      'https://app.example.test/path',
      'https://app.example.test?query',
      'https://app.example.test#fragment',
      '//app.example.test',
      'https://user@app.example.test',
      'https:\\app.example.test',
    ]) {
      expect(sameOrigin(value, 'https://app.example.test')).toBe(false)
    }
  })
})
