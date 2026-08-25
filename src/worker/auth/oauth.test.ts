import { describe, expect, it, vi } from 'vitest'
import {
  exchangeGoogleCode,
  fetchGoogleProfile,
  MAX_OAUTH_RESPONSE_BODY_BYTES,
} from './oauth'

const env = {
  APP_URL: 'https://app.example.test',
  GOOGLE_CLIENT_ID: 'client-id',
  GOOGLE_CLIENT_SECRET: 'client-secret',
}

const json = (value: unknown, init?: ResponseInit): Response => new Response(JSON.stringify(value), {
  headers: { 'Content-Type': 'application/json' },
  ...init,
})

const serialized = (value: unknown): string => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return String(value)
  return Object.getOwnPropertyNames(value)
    .map((key) => `${key}:${serialized(Object.getOwnPropertyDescriptor(value, key)?.value)}`)
    .join('|')
}

describe('Google OAuth provider response handling', () => {
  it('requires application/json for token and userinfo responses', async () => {
    await expect(exchangeGoogleCode(env, 'code', 'verifier', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ access_token: 'secret-token' }), { headers: { 'Content-Type': 'text/html' } }),
    ))).rejects.toThrow('OAuth provider request failed')

    await expect(fetchGoogleProfile('secret-token', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ sub: 'google-id', email: 'reader@example.test' }), { headers: { 'Content-Type': 'text/plain' } }),
    ))).rejects.toThrow('OAuth provider request failed')
  })

  it('rejects oversized streamed token and userinfo responses without retaining provider details', async () => {
    const secret = 'provider-body-secret'
    const oversized = () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"access_token":"'))
        controller.enqueue(new TextEncoder().encode(secret))
        controller.enqueue(new Uint8Array(MAX_OAUTH_RESPONSE_BODY_BYTES))
        controller.close()
      },
    })
    const tokenError = await exchangeGoogleCode(env, 'code', 'verifier', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(oversized(), { headers: { 'Content-Type': 'application/json' } }),
    )).catch((error: unknown) => error)
    expect(tokenError).toBeInstanceOf(Error)
    expect((tokenError as Error).message).toBe('OAuth provider request failed')
    expect((tokenError as Error & { cause?: unknown }).cause).toBeUndefined()
    expect(serialized(tokenError)).not.toContain(secret)

    const profileError = await fetchGoogleProfile('secret-token', vi.fn<typeof fetch>().mockResolvedValue(
      new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"sub":"google-id","email":"'))
          controller.enqueue(new Uint8Array(MAX_OAUTH_RESPONSE_BODY_BYTES))
          controller.close()
        },
      }), { headers: { 'Content-Type': 'application/json' } }),
    )).catch((error: unknown) => error)
    expect(profileError).toBeInstanceOf(Error)
    expect((profileError as Error).message).toBe('OAuth provider request failed')
  })

  it('keeps locked provider bodies from escaping generic provider failures', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('provider-secret'))
        controller.close()
      },
    }), { status: 503, headers: { 'Content-Type': 'text/plain' } })
    const reader = response.body?.getReader()
    const error = await exchangeGoogleCode(env, 'code', 'verifier', vi.fn<typeof fetch>().mockResolvedValue(response))
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe('OAuth provider request failed')
    reader?.releaseLock()
  })

  it('accepts parameterized JSON content types for valid provider responses', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(json({ access_token: 'access-token' }, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
      .mockResolvedValueOnce(json({ sub: 'google-id', email: 'reader@example.test' }, { headers: { 'Content-Type': 'application/json; charset=utf-8' } }))
    await expect(exchangeGoogleCode(env, 'code', 'verifier', fetcher)).resolves.toBe('access-token')
    await expect(fetchGoogleProfile('access-token', fetcher)).resolves.toMatchObject({ googleId: 'google-id' })
  })
})
