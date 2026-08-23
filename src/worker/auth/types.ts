import type { D1Database } from '@cloudflare/workers-types'

export interface Env {
  DB: D1Database
  GOOGLE_CLIENT_ID: string
  GOOGLE_CLIENT_SECRET: string
  APP_URL: string
}

export interface GoogleProfile {
  googleId: string
  email: string
  name: string | null
  picture: string | null
}

export interface User {
  id: string
  googleId: string
  email: string
  name: string | null
  picture: string | null
  createdAt: number
  updatedAt: number
}

export interface AuthSession {
  user: User
  expiresAt: number
}

export interface AuthStore {
  upsertUser(profile: GoogleProfile, id: string, now: number): Promise<User>
  createSession(userId: string, tokenHash: string, expiresAt: number, now: number): Promise<void>
  findSession(tokenHash: string, now: number): Promise<AuthSession | null>
  deleteSession(tokenHash: string): Promise<void>
}

export interface CryptoProvider {
  randomBytes(length: number): Promise<Uint8Array>
  sha256(value: string): Promise<string>
  sha256Base64Url(value: string): Promise<string>
}

export interface AuthDependencies {
  store?: AuthStore
  crypto?: CryptoProvider
  fetcher?: typeof fetch
  now?: () => number
}

export const SESSION_COOKIE = 'lime_session'
export const STATE_COOKIE = 'lime_oauth_state'
export const CODE_VERIFIER_COOKIE = 'lime_oauth_code_verifier'
export const STATE_MAX_AGE_SECONDS = 300
export const CODE_VERIFIER_MAX_AGE_SECONDS = 300
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30
