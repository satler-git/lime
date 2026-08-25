/**
 * Parse an origin value without allowing URL components outside the origin.
 * Paths (including an explicit trailing slash), queries, fragments, credentials,
 * and malformed values fail. Trusted app configuration may be normalized separately.
 */
export const hasControlCharacters = (value: string): boolean => /[\u0000-\u001f\u007f-\u009f]/.test(value)

const originOnly = (value: string, allowTrailingSlash = false): string | null => {
  if (
    value.length === 0 ||
    hasControlCharacters(value) ||
    value.trim() !== value ||
    value.includes('\\')
  ) return null

  const schemeEnd = value.indexOf('://')
  if (schemeEnd <= 0) return null
  const authorityStart = schemeEnd + 3
  const suffixStart = value.slice(authorityStart).search(/[/?#]/)
  const authorityEnd = suffixStart === -1 ? value.length : authorityStart + suffixStart
  const authority = value.slice(authorityStart, authorityEnd)
  const suffix = value.slice(authorityEnd)
  if (authority.length === 0 || authority.includes('@') || (suffix !== '' && !(allowTrailingSlash && suffix === '/'))) return null

  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (url.origin === 'null' || url.username.length > 0 || url.password.length > 0) return null
    return url.origin
  } catch {
    return null
  }
}

export const hasUserinfoSyntax = (value: string): boolean => {
  const schemeEnd = value.indexOf('://')
  if (schemeEnd <= 0) return false
  const authorityStart = schemeEnd + 3
  const suffixStart = value.slice(authorityStart).search(/[/?#]/)
  const authorityEnd = suffixStart === -1 ? value.length : authorityStart + suffixStart
  return value.slice(authorityStart, authorityEnd).includes('@')
}

export const sameOrigin = (candidate: string, expected: string): boolean => {
  if (hasControlCharacters(candidate) || hasControlCharacters(expected)) return false
  const candidateOrigin = originOnly(candidate)
  // APP_URL is trusted deployment configuration and may include its conventional
  // trailing slash (or an app path used by the redirect target).
  let expectedOrigin: string | null = originOnly(expected, true)
  if (expectedOrigin === null) {
    try {
      const url = new URL(expected)
      if (
        (url.protocol === 'http:' || url.protocol === 'https:') &&
        url.origin !== 'null' &&
        !hasUserinfoSyntax(expected) &&
        url.username.length === 0 &&
        url.password.length === 0
      ) {
        expectedOrigin = url.origin
      }
    } catch {}
  }
  return candidateOrigin !== null && expectedOrigin !== null && candidateOrigin === expectedOrigin
}

export const parseExpectedOrigin = (value: string): string => {
  const origin = originOnly(value)
  if (origin === null) throw new TypeError('A valid same-origin origin is required')
  return origin
}
