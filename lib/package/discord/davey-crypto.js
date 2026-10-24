import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto'
import { Writer } from './davey-tls.js'

export const NH = 32
export const NK = 16
export const NN = 12
export const KEM_ID = 0x0010
export const KDF_ID = 0x0001
export const AEAD_ID = 0x0001

const EMPTY = Buffer.alloc(0)

export const sha256 = (...parts) => {
  const hash = createHash('sha256')
  for (const part of parts) hash.update(part)
  return hash.digest()
}

export const hmacSha256 = (key, data) => createHmac('sha256', key).update(data).digest()

export const hkdfExtract = (salt, ikm) => hmacSha256(salt.length ? salt : Buffer.alloc(NH), ikm)

export function hkdfExpand(prk, info, length) {
  const blocks = []
  let previous = EMPTY
  let produced = 0
  for (let counter = 1; produced < length; counter++) {
    previous = hmacSha256(prk, Buffer.concat([previous, info, Buffer.from([counter])]))
    blocks.push(previous)
    produced += previous.length
  }
  return Buffer.concat(blocks).subarray(0, length)
}

export function expandWithLabel(secret, label, context, length) {
  const info = new Writer()
    .u16(length)
    .vec(Buffer.from(`MLS 1.0 ${label}`))
    .vec(context)
    .finish()
  return hkdfExpand(secret, info, length)
}

export const deriveSecret = (secret, label) => expandWithLabel(secret, label, EMPTY, NH)

export function mlsExporter(exporterSecret, label, context, length) {
  return expandWithLabel(deriveSecret(exporterSecret, label), 'exported', sha256(context), length)
}

export function refHash(label, value) {
  return sha256(new Writer().vec(Buffer.from(`MLS 1.0 ${label}`)).vec(value).finish())
}

export function generateP256() {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  const jwk = privateKey.export({ format: 'jwk' })
  return {
    privateKey: Buffer.from(jwk.d, 'base64url'),
    publicKey: Buffer.concat([Buffer.from([0x04]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
  }
}

export function publicFromPrivate(privateKey) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(privateKey)
  return ecdh.getPublicKey(null, 'uncompressed')
}

const ecJwk = (publicKey, privateKey) => {
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    x: publicKey.subarray(1, 33).toString('base64url'),
    y: publicKey.subarray(33, 65).toString('base64url')
  }
  if (privateKey) jwk.d = privateKey.toString('base64url')
  return jwk
}

export function ecdhSecret(privateKey, publicKey) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(privateKey)
  return ecdh.computeSecret(publicKey)
}

export function signBytes(privateKey, publicKey, data) {
  const key = createPrivateKey({ key: ecJwk(publicKey, privateKey), format: 'jwk' })
  return sign('sha256', data, { key, dsaEncoding: 'der' })
}

export function verifyBytes(publicKey, data, signature) {
  const key = createPublicKey({ key: ecJwk(publicKey), format: 'jwk' })
  try {
    return verify('sha256', data, { key, dsaEncoding: 'der' }, signature)
  } catch {
    return false
  }
}

export function signWithLabel(privateKey, publicKey, label, content) {
  return signBytes(privateKey, publicKey, signContent(label, content))
}

export function verifyWithLabel(publicKey, label, content, signature) {
  return verifyBytes(publicKey, signContent(label, content), signature)
}

function signContent(label, content) {
  return new Writer().vec(Buffer.from(`MLS 1.0 ${label}`)).vec(content).finish()
}

export function aeadSeal(key, nonce, aad, plaintext) {
  const cipher = createCipheriv('aes-128-gcm', key, nonce, { authTagLength: 16 })
  cipher.setAAD(aad)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return Buffer.concat([body, cipher.getAuthTag()])
}

export function aeadOpen(key, nonce, aad, ciphertext) {
  if (ciphertext.length < 16) throw new Error('AEAD ciphertext too short')
  const body = ciphertext.subarray(0, ciphertext.length - 16)
  const tag = ciphertext.subarray(ciphertext.length - 16)
  const decipher = createDecipheriv('aes-128-gcm', key, nonce, { authTagLength: 16 })
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

const hpkeSuite = Buffer.concat([Buffer.from('HPKE'), u16(KEM_ID), u16(KDF_ID), u16(AEAD_ID)])
const kemSuite = Buffer.concat([Buffer.from('KEM'), u16(KEM_ID)])

function u16(value) {
  return new Writer().u16(value).finish()
}

function labeledExtract(suiteId, salt, label, ikm) {
  return hkdfExtract(salt, Buffer.concat([Buffer.from('HPKE-v1'), suiteId, Buffer.from(label), ikm]))
}

function labeledExpand(suiteId, prk, label, info, length) {
  return hkdfExpand(prk, Buffer.concat([u16(length), Buffer.from('HPKE-v1'), suiteId, Buffer.from(label), info]), length)
}

function kemSharedSecret(dh, kemContext) {
  return labeledExpand(kemSuite, labeledExtract(kemSuite, EMPTY, 'eae_prk', dh), 'shared_secret', kemContext, NH)
}

function hpkeKeySchedule(sharedSecret, info) {
  const pskIdHash = labeledExtract(hpkeSuite, EMPTY, 'psk_id_hash', EMPTY)
  const infoHash = labeledExtract(hpkeSuite, EMPTY, 'info_hash', info)
  const context = Buffer.concat([Buffer.from([0]), pskIdHash, infoHash])
  const secret = labeledExtract(hpkeSuite, sharedSecret, 'secret', EMPTY)
  return {
    key: labeledExpand(hpkeSuite, secret, 'key', context, NK),
    nonce: labeledExpand(hpkeSuite, secret, 'base_nonce', context, NN)
  }
}

export function hpkeSeal(publicKey, info, aad, plaintext) {
  const ephemeral = generateP256()
  const dh = ecdhSecret(ephemeral.privateKey, publicKey)
  const shared = kemSharedSecret(dh, Buffer.concat([ephemeral.publicKey, publicKey]))
  const { key, nonce } = hpkeKeySchedule(shared, info)
  return { kemOutput: ephemeral.publicKey, ciphertext: aeadSeal(key, nonce, aad, plaintext) }
}

export function hpkeOpen(privateKey, publicKey, kemOutput, info, aad, ciphertext) {
  const dh = ecdhSecret(privateKey, kemOutput)
  const shared = kemSharedSecret(dh, Buffer.concat([kemOutput, publicKey]))
  const { key, nonce } = hpkeKeySchedule(shared, info)
  return aeadOpen(key, nonce, aad, ciphertext)
}

export function encryptWithLabel(publicKey, label, context, plaintext) {
  const info = new Writer().vec(Buffer.from(`MLS 1.0 ${label}`)).vec(context).finish()
  return hpkeSeal(publicKey, info, EMPTY, plaintext)
}

export function decryptWithLabel(privateKey, publicKey, label, context, sealed) {
  const info = new Writer().vec(Buffer.from(`MLS 1.0 ${label}`)).vec(context).finish()
  return hpkeOpen(privateKey, publicKey, sealed.kemOutput, info, EMPTY, sealed.ciphertext)
}

export const randomSecret = length => randomBytes(length)
