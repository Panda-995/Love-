import { describe, expect, it, vi } from 'vitest'
import { createUuid } from '../app/utils/browserUuid'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('browser UUID compatibility', () => {
  it('uses the native randomUUID implementation when available', () => {
    const randomUUID = vi.fn(() => '11111111-1111-4111-8111-111111111111')
    const cryptoApi = { randomUUID } as unknown as Crypto

    expect(createUuid(cryptoApi)).toBe('11111111-1111-4111-8111-111111111111')
    expect(randomUUID).toHaveBeenCalledOnce()
  })

  it('creates an RFC 4122 v4 UUID when randomUUID is unavailable on HTTP', () => {
    const cryptoApi = {
      getRandomValues(bytes: Uint8Array) {
        bytes.set(Array.from({ length: 16 }, (_, index) => index))
        return bytes
      },
    } as unknown as Crypto

    expect(createUuid(cryptoApi)).toBe('00010203-0405-4607-8809-0a0b0c0d0e0f')
  })

  it('falls back when a browser exposes randomUUID but rejects the call', () => {
    const cryptoApi = {
      randomUUID() {
        throw new DOMException('Only available in secure contexts', 'SecurityError')
      },
      getRandomValues(bytes: Uint8Array) {
        bytes.fill(0xaa)
        return bytes
      },
    } as unknown as Crypto

    expect(createUuid(cryptoApi)).toMatch(UUID_V4)
  })

  it('still creates a valid local identifier in legacy WebViews without Web Crypto', () => {
    expect(createUuid(undefined)).toMatch(UUID_V4)
  })
})
