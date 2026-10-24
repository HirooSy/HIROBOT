import { createCipheriv } from 'node:crypto'

export const MODE_PREFERENCE = ['aead_aes256_gcm_rtpsize', 'aead_xchacha20_poly1305_rtpsize']
export const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe])

export function pickMode(modes = []) {
  return MODE_PREFERENCE.find(mode => modes.includes(mode)) ?? null
}

const rotl = (value, bits) => ((value << bits) | (value >>> (32 - bits))) >>> 0

export function hchacha20(key, nonce) {
  const s = new Uint32Array(16)
  s[0] = 0x61707865
  s[1] = 0x3320646e
  s[2] = 0x79622d32
  s[3] = 0x6b206574
  for (let i = 0; i < 8; i++) s[4 + i] = key.readUInt32LE(i * 4)
  for (let i = 0; i < 4; i++) s[12 + i] = nonce.readUInt32LE(i * 4)
  const quarter = (a, b, c, d) => {
    s[a] = (s[a] + s[b]) >>> 0
    s[d] = rotl(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) >>> 0
    s[b] = rotl(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) >>> 0
    s[d] = rotl(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) >>> 0
    s[b] = rotl(s[b] ^ s[c], 7)
  }
  for (let round = 0; round < 10; round++) {
    quarter(0, 4, 8, 12)
    quarter(1, 5, 9, 13)
    quarter(2, 6, 10, 14)
    quarter(3, 7, 11, 15)
    quarter(0, 5, 10, 15)
    quarter(1, 6, 11, 12)
    quarter(2, 7, 8, 13)
    quarter(3, 4, 9, 14)
  }
  const out = Buffer.alloc(32)
  const words = [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]]
  words.forEach((word, i) => out.writeUInt32LE(word >>> 0, i * 4))
  return out
}

export function encryptRtp(mode, key, header, payload, counter) {
  const counterBytes = Buffer.alloc(4)
  counterBytes.writeUInt32BE(counter >>> 0)
  if (mode === 'aead_aes256_gcm_rtpsize') {
    const iv = Buffer.alloc(12)
    counterBytes.copy(iv)
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: 16 })
    cipher.setAAD(header)
    const body = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()])
    return Buffer.concat([header, body, counterBytes])
  }
  if (mode === 'aead_xchacha20_poly1305_rtpsize') {
    const nonce = Buffer.alloc(24)
    counterBytes.copy(nonce)
    const subkey = hchacha20(key, nonce.subarray(0, 16))
    const iv = Buffer.alloc(12)
    nonce.copy(iv, 4, 16, 24)
    const cipher = createCipheriv('chacha20-poly1305', subkey, iv, { authTagLength: 16 })
    cipher.setAAD(header)
    const body = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()])
    return Buffer.concat([header, body, counterBytes])
  }
  throw new Error(`Unsupported voice encryption mode: ${mode}`)
}
