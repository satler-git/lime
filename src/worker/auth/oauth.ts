import type { Env, GoogleProfile } from './types'

export const GOOGLE_AUTHORIZATION_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const GOOGLE_USERINFO_ENDPOINT = 'https://openidconnect.googleapis.com/v1/userinfo'

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

export const exchangeGoogleCode = async (
  env: Pick<Env, 'GOOGLE_CLIENT_ID' | 'GOOGLE_CLIENT_SECRET' | 'APP_URL'>,
  code: string,
  codeVerifier: string,
  fetcher: typeof fetch,
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
    })
  } catch {
    throw providerFailure()
  }

  if (!response.ok) throw providerFailure()

  let payload: GoogleTokenResponse
  try {
    payload = (await response.json()) as GoogleTokenResponse
  } catch {
    throw providerFailure()
  }

  if (!isNonEmptyString(payload.access_token)) throw providerFailure()
  return payload.access_token
}

export const fetchGoogleProfile = async (accessToken: string, fetcher: typeof fetch): Promise<GoogleProfile> => {
  let response: Response
  try {
    response = await fetcher(GOOGLE_USERINFO_ENDPOINT, {
      headers: { authorization: `Bearer ${accessToken}` },
    })
  } catch {
    throw providerFailure()
  }

  if (!response.ok) throw providerFailure()

  let payload: GoogleUserInfoResponse
  try {
    payload = (await response.json()) as GoogleUserInfoResponse
  } catch {
    throw providerFailure()
  }

  if (!isNonEmptyString(payload.sub) || !isNonEmptyString(payload.email)) throw providerFailure()

  return {
    googleId: payload.sub,
    email: payload.email,
    name: isNonEmptyString(payload.name) ? payload.name : null,
    picture: isNonEmptyString(payload.picture) ? payload.picture : null,
  }
}
