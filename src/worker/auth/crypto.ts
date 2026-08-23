import type { CryptoProvider } from './types'

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')

export const toBase64Url = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export const webCryptoProvider: CryptoProvider = {
  async randomBytes(length) {
    const bytes = new Uint8Array(length)
    crypto.getRandomValues(bytes)
    return bytes
  },

  async sha256(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return bytesToHex(new Uint8Array(digest))
  },

  async sha256Base64Url(value) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
    return toBase64Url(new Uint8Array(digest))
  },
}
