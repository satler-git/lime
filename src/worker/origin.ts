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

export type ResolveEndpointOptions = {
  /** Expected origin for absolute base URLs. When provided, the resolved origin must match it. */
  expectedOrigin?: string
  /** Human-readable client name included in validation error messages. */
  label?: string
}

const labelPart = (label: string | undefined, capitalize = false): string => {
  if (label === undefined) return ''
  const value = label.trim()
  if (value.length === 0) return ''
  if (capitalize) return `${value[0].toUpperCase()}${value.slice(1)} `
  return `${value} `
}

/**
 * Resolve a same-origin or relative base URL into an endpoint path.
 * For an absolute base URL, the resolved origin is checked against `expectedOrigin`
 * when one is supplied. All callers share the same normalization rules:
 * trailing slashes are stripped from the base, and the path is appended.
 */
export const resolveEndpoint = (
  baseUrl: string | undefined,
  path: string,
  { expectedOrigin, label }: ResolveEndpointOptions = {},
): string => {
  const value = (baseUrl ?? '').trim()
  if (value.length === 0) return path

  if (hasControlCharacters(value)) {
    throw new TypeError(`Control characters in ${labelPart(label)}base URLs are not supported`)
  }
  if (/\s/.test(value)) {
    throw new TypeError(`Whitespace in ${labelPart(label)}base URLs are not supported`)
  }
  if (value.includes('\\')) {
    throw new TypeError(`Backslashes in ${labelPart(label)}base URLs are not supported`)
  }
  if (value.startsWith('//')) {
    throw new TypeError(`Protocol-relative ${labelPart(label)}base URLs are not supported`)
  }

  if (value.startsWith('/')) {
    if (value.includes('?') || value.includes('#')) {
      throw new TypeError(`Relative ${labelPart(label)}base URLs must not contain a query or fragment`)
    }
    return `${value.replace(/\/+$/, '')}${path}`
  }

  let resolved: URL
  try {
    resolved = new URL(value)
  } catch {
    throw new TypeError(`A valid ${labelPart(label)}base URL is required`)
  }

  if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') {
    throw new TypeError(`Only http: and https: ${labelPart(label)}base URLs are supported`)
  }
  if (resolved.search || resolved.hash) {
    throw new TypeError(`${labelPart(label, true)}base URLs must not contain a query or fragment`)
  }
  if (hasUserinfoSyntax(value) || resolved.username.length > 0 || resolved.password.length > 0) {
    throw new TypeError(`${labelPart(label, true)}base URLs must not contain credentials`)
  }
  if (expectedOrigin !== undefined && resolved.origin !== expectedOrigin) {
    throw new TypeError(`${labelPart(label, true)}base URL must be same-origin`)
  }

  return `${value.replace(/\/+$/, '')}${path}`
}
