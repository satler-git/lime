import { cancelResponseBody } from '../../response'
import type { Env, GoogleProfile } from './types'

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

/** Maximum number of bytes buffered from either successful Google JSON response. */
export const MAX_OAUTH_RESPONSE_BODY_BYTES = 16 * 1024

const providerFailure = (): Error => new Error('OAuth provider request failed')

export const callbackUrl = (appUrl: string): string => {
  const baseUrl = appUrl.endsWith('/') ? appUrl : `${appUrl}/`
  return new URL('auth/google/callback', baseUrl).toString()
}

export const buildGoogleAuthorizationUrl = (
  env: Pick<Env, 'APP_URL' | 'GOOGLE_CLIENT_ID'>,
  state: string,
  codeChallenge: string,
): string => {
  const url = new URL(GOOGLE_AUTHORIZATION_ENDPOINT)
  url.searchParams.set('client_id', env.GOOGLE_CLIENT_ID)
  url.searchParams.set('redirect_uri', callbackUrl(env.APP_URL))
  url.searchParams.set('response_type', 'code')
  url.searchParams.set('scope', 'openid email profile')
  url.searchParams.set('state', state)
  url.searchParams.set('code_challenge', codeChallenge)
  url.searchParams.set('code_challenge_method', 'S256')
  return url.toString()
}

interface GoogleTokenResponse {
  access_token?: unknown
}

interface GoogleUserInfoResponse {
  sub?: unknown
  email?: unknown
  name?: unknown
  picture?: unknown
}

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const isRecord = (value: unknown): value is Record<string, unknown> => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
)

const hasJsonContentType = (response: Response): boolean => {
  const contentType = response.headers.get('Content-Type')
  return contentType !== null && contentType.split(';', 1)[0]?.trim().toLowerCase() === 'application/json'
}

const contentLengthExceedsLimit = (response: Response): boolean => {
  const contentLength = response.headers.get('Content-Length')
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false
  const length = Number(contentLength)
  return !Number.isSafeInteger(length) || length > MAX_OAUTH_RESPONSE_BODY_BYTES
}

/** Read provider JSON while bounding each stream and cancelling on failure/abort. */
const readProviderJson = async (response: Response, signal?: AbortSignal): Promise<unknown> => {
  if (signal?.aborted || contentLengthExceedsLimit(response) || response.body === null) {
    cancelResponseBody(response)
    throw providerFailure()
  }

  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let aborted = false
  const onAbort = () => {
    aborted = true
    void reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    while (true) {
      if (signal?.aborted || aborted) throw providerFailure()
      let result: ReadableStreamReadResult<Uint8Array>
      try {
        result = await reader.read()
      } catch {
        throw providerFailure()
      }
      if (result.done) {
        if (signal?.aborted || aborted) throw providerFailure()
        break
      }
      size += result.value.byteLength
      if (size > MAX_OAUTH_RESPONSE_BODY_BYTES) {
        try { await reader.cancel() } catch {}
        throw providerFailure()
      }
      chunks.push(result.value)
    }
  } catch {
    try { await reader.cancel() } catch {}
    throw providerFailure()
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }

  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }

  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown
  } catch {
    throw providerFailure()
  }
}

const providerJson = async (response: Response, signal?: AbortSignal): Promise<unknown> => {
  if (!response.ok || !hasJsonContentType(response)) {
    cancelResponseBody(response)
    throw providerFailure()
  }
  return readProviderJson(response, signal)
}

export const exchangeGoogleCode = async (
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'APP_URL'>,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<string> => {
  let response: Response
  try {
    response = await fetcher(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        code_verifier: codeVerifier,
        client_id: env.GOOGLE_CLIENT_ID,
        client_secret: env.GOOGLE_CLIENT_SECRET,
        redirect_uri: callbackUrl(env.APP_URL),
        grant_type: 'authorization_code',
      }),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    throw providerFailure()
  }

  const rawPayload = await providerJson(response, signal)
  if (!isRecord(rawPayload)) throw providerFailure()
  const payload = rawPayload as GoogleTokenResponse
  if (!isNonEmptyString(payload.access_token)) throw providerFailure()
  return payload.access_token
}

export const fetchGoogleProfile = async (
  accessToken: string,
  fetcher: typeof fetch,
  signal?: AbortSignal,
): Promise<GoogleProfile> => {
  let response: Response
  try {
    response = await fetcher(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
      ...(signal === undefined ? {} : { signal }),
    })
  } catch {
    throw providerFailure()
  }

  const rawPayload = await providerJson(response, signal)
  if (!isRecord(rawPayload)) throw providerFailure()
  const payload = rawPayload as GoogleUserInfoResponse
  if (!isNonEmptyString(payload.sub) || !isNonEmptyString(payload.email)) throw providerFailure()

  return {
    googleId: payload.sub,
    email: payload.email,
    name: isNonEmptyString(payload.name) ? payload.name : null,
    picture: isNonEmptyString(payload.picture) ? payload.picture : null,
  }
}
