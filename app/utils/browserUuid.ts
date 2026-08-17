function fillLegacyRandom(bytes: Uint8Array) {
  let timestamp = Date.now()
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Math.floor(Math.random() * 256) ^ (timestamp & 0xff)
    timestamp = Math.floor(timestamp / 256) || Date.now()
  }
}

export function createUuid(
  cryptoApi: Crypto | undefined = typeof globalThis === 'undefined' ? undefined : globalThis.crypto,
): string {
  if (typeof cryptoApi?.randomUUID === 'function') {
    try {
      return cryptoApi.randomUUID()
    } catch {
      // Some WebViews expose the method but reject it outside a secure context.
    }
  }

  const bytes = new Uint8Array(16)
  if (typeof cryptoApi?.getRandomValues === 'function') {
    try {
      cryptoApi.getRandomValues(bytes)
    } catch {
      fillLegacyRandom(bytes)
    }
  } else {
    fillLegacyRandom(bytes)
  }

  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
