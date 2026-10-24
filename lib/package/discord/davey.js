import { createCipheriv, createDecipheriv } from 'node:crypto'
import { Reader, Writer } from './davey-tls.js'
import * as C from './davey-codec.js'
import * as M from './davey-mls.js'
import * as X from './davey-crypto.js'

export const DAVE_PROTOCOL_VERSION = 1
export const MediaType = Object.freeze({ AUDIO: 0, VIDEO: 1 })
export const Codec = Object.freeze({ UNKNOWN: 0, OPUS: 1, VP8: 2, VP9: 3, H264: 4, H265: 5, AV1: 6 })
export const ProposalsOperationType = Object.freeze({ APPEND: 0, REVOKE: 1 })
export const SessionStatus = Object.freeze({ INACTIVE: 0, PENDING: 1, AWAITING_RESPONSE: 2, ACTIVE: 3 })

const EMPTY_BUFFER = Buffer.alloc(0)
const MAGIC = Buffer.from([0xfa, 0xfa])
const FRAME_LABEL = 'Discord Secure Frames v0'
const GENERATION_SHIFT = 24
const TAG_LENGTH = 8
const MAX_KEY_PACKAGES = 4
const MAX_CACHED_GENERATIONS = 8

function leU32(value) {
  const buf = Buffer.alloc(4)
  buf.writeUInt32LE(value >>> 0)
  return buf
}

function leU64(value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(BigInt(value))
  return buf
}

function uleb128(value) {
  const bytes = []
  let v = value
  do {
    let byte = v & 0x7f
    v = Math.floor(v / 128)
    if (v !== 0) byte |= 0x80
    bytes.push(byte)
  } while (v !== 0)
  return Buffer.from(bytes)
}

function readUleb128(buf, pos) {
  let value = 0
  let scale = 1
  let i = pos
  for (;;) {
    if (i >= buf.length) throw new RangeError('truncated uleb128')
    const byte = buf[i++]
    value += (byte & 0x7f) * scale
    if (!(byte & 0x80)) break
    scale *= 128
  }
  return { value, next: i }
}

function frameIv(nonce) {
  const iv = Buffer.alloc(12)
  iv.writeUInt32LE(nonce >>> 0, 8)
  return iv
}

function encryptFrame(key, nonce, plaintext) {
  const cipher = createCipheriv('aes-128-gcm', key, frameIv(nonce), { authTagLength: 16 })
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag().subarray(0, TAG_LENGTH)
  const nonceBytes = uleb128(nonce)
  const size = TAG_LENGTH + nonceBytes.length + 1 + MAGIC.length
  return Buffer.concat([body, tag, nonceBytes, Buffer.from([size]), MAGIC])
}

function parseFrame(packet) {
  if (packet.length < TAG_LENGTH + 4 || !packet.subarray(packet.length - 2).equals(MAGIC)) return null
  const size = packet[packet.length - 3]
  if (size < TAG_LENGTH + 3 || size > packet.length) throw new Error('invalid DAVE supplemental size')
  const supplemental = packet.subarray(packet.length - size)
  const tag = supplemental.subarray(0, TAG_LENGTH)
  const { value: nonce, next } = readUleb128(supplemental, TAG_LENGTH)
  if (next !== size - 3) throw new Error('unencrypted ranges are not supported for audio')
  return { ciphertext: packet.subarray(0, packet.length - size), tag, nonce }
}

function decryptFrame(key, frame) {
  const decipher = createDecipheriv('aes-128-gcm', key, frameIv(frame.nonce), { authTagLength: TAG_LENGTH })
  decipher.setAuthTag(frame.tag)
  return Buffer.concat([decipher.update(frame.ciphertext), decipher.final()])
}

class SenderRatchet {
  constructor(exporterSecret, userId) {
    this.base = X.mlsExporter(exporterSecret, FRAME_LABEL, leU64(userId), 16)
    this.keys = new Map()
  }

  keyFor(generation) {
    let key = this.keys.get(generation)
    if (!key) {
      key = X.expandWithLabel(this.base, 'key', leU32(generation), 16)
      this.keys.set(generation, key)
      if (this.keys.size > MAX_CACHED_GENERATIONS) this.keys.delete(this.keys.keys().next().value)
    }
    return key
  }
}

function identityToUserId(identity) {
  return identity.readBigUInt64BE(0).toString()
}

export function generateDisplayableCode(data, desiredLength, groupSize) {
  if (desiredLength % groupSize !== 0) throw new Error('desired length must be a multiple of the group size')
  if (data.length < desiredLength) throw new Error('data is shorter than the desired length')
  const modulus = 10n ** BigInt(groupSize)
  let out = ''
  for (let offset = 0; offset < desiredLength; offset += groupSize) {
    const value = BigInt(`0x${data.subarray(offset, offset + groupSize).toString('hex')}`) % modulus
    out += value.toString().padStart(groupSize, '0')
  }
  return out
}

export function generateP256Keypair() {
  const key = X.generateP256()
  return { private: key.privateKey, public: key.publicKey }
}

export class DAVESession {
  constructor(protocolVersion, userId, channelId) {
    this.init(protocolVersion, userId, channelId)
  }

  init(protocolVersion, userId, channelId) {
    this.protocolVersionValue = protocolVersion
    this.userIdValue = String(userId)
    this.channelIdValue = String(channelId)
    this.groupId = M.bigEndianGroupId(BigInt(channelId))
    this.externalSender = null
    this.externalSenderBytes = null
    this.bundles = []
    this.group = null
    this.pending = null
    this.proposals = new Map()
    this.ratchets = new Map()
    this.ownNonce = 0
    this.passthroughEnabled = false
    this.passthroughUntil = 0
    this.established = false
  }

  reinit(protocolVersion, userId, channelId) {
    this.init(protocolVersion, userId, channelId)
  }

  reset() {
    this.init(this.protocolVersionValue, this.userIdValue, this.channelIdValue)
  }

  get protocolVersion() {
    return this.protocolVersionValue
  }

  get userId() {
    return this.userIdValue
  }

  get channelId() {
    return this.channelIdValue
  }

  get ciphersuite() {
    return C.CIPHERSUITE
  }

  get epoch() {
    return this.group ? this.group.epoch : null
  }

  get ownLeafIndex() {
    return this.group ? this.group.ownLeaf : null
  }

  get status() {
    if (this.group && !this.pending) return SessionStatus.ACTIVE
    if (this.pending) return SessionStatus.AWAITING_RESPONSE
    if (this.externalSender) return SessionStatus.PENDING
    return SessionStatus.INACTIVE
  }

  get ready() {
    return this.group !== null && this.established
  }

  get voicePrivacyCode() {
    if (!this.group) return ''
    return generateDisplayableCode(this.group.secrets.epochAuthenticator, 30, 5)
  }

  getEpochAuthenticator() {
    return this.group ? Buffer.from(this.group.secrets.epochAuthenticator) : null
  }

  getUserIds() {
    if (!this.group) return []
    return M.memberIdentities(this.group.nodes).map(member => identityToUserId(member.identity))
  }

  setExternalSender(buf) {
    const reader = new Reader(buf)
    const signatureKey = Buffer.from(reader.vec())
    const credential = C.readCredential(reader)
    reader.expectDone()
    this.externalSender = { signatureKey, credential }
    this.externalSenderBytes = Buffer.from(buf)
  }

  getSerializedKeyPackage() {
    const bundle = M.createKeyPackage(this.userIdValue)
    this.bundles.push(bundle)
    if (this.bundles.length > MAX_KEY_PACKAGES) this.bundles.shift()
    return bundle.bytes
  }

  processProposals(operationType, payload, recognizedUserIds = []) {
    if (operationType === ProposalsOperationType.REVOKE) {
      const inner = new Reader(new Reader(payload).vec())
      while (!inner.done) this.proposals.delete(Buffer.from(inner.vec()).toString('hex'))
      return {}
    }
    if (!this.externalSender) throw new Error('external sender is not set')
    const messages = M.parseProposalMessages(payload)
    const bodies = []
    for (const message of messages) {
      const { content, signature } = message
      if (content.sender.type !== C.SENDER.EXTERNAL || content.sender.index !== 0) throw new Error('proposal is not from the external sender')
      const tbs = C.encodeFramedContentTbs(C.PROTOCOL_VERSION, C.WIRE.PUBLIC, content, EMPTY_BUFFER)
      if (!X.verifyWithLabel(this.externalSender.signatureKey, 'FramedContentTBS', tbs, signature)) throw new Error('invalid proposal signature')
      this.proposals.set(M.proposalRef(content, signature).toString('hex'), content.body)
      bodies.push(content.body)
    }
    if (!this.group) {
      const bundle = this.bundles[this.bundles.length - 1]
      if (!bundle) throw new Error('no key package to create the group with')
      const extensions = [{ type: C.EXTENSION.EXTERNAL_SENDERS, data: new Writer().vec(this.externalSenderBytes).finish() }]
      this.group = M.createGroupState({ groupId: this.groupId, keyPackage: bundle, extensions })
    }
    const proposals = this.selectProposals(bodies, recognizedUserIds)
    if (!proposals.length) return {}
    const result = M.createCommit(this.group, proposals)
    this.pending = result.pending
    return { commit: result.commit, welcome: result.welcome ?? undefined }
  }

  selectProposals(bodies, recognizedUserIds) {
    const members = new Set(M.memberSignatureKeys(this.group.nodes).map(key => key.toString('hex')))
    const recognized = new Set(recognizedUserIds.map(String))
    const selected = []
    for (const body of bodies) {
      if (body.type === C.PROPOSAL.ADD) {
        const kp = body.keyPackage
        if (!M.verifyKeyPackage(kp)) continue
        if (members.has(kp.leafNode.signatureKey.toString('hex'))) continue
        if (recognized.size && !recognized.has(identityToUserId(kp.leafNode.credential.identity))) continue
        members.add(kp.leafNode.signatureKey.toString('hex'))
        selected.push(body)
      } else if (body.type === C.PROPOSAL.REMOVE) {
        if (body.removed === this.group.ownLeaf) continue
        if (!this.group.nodes[2 * body.removed]) continue
        selected.push(body)
      }
    }
    return selected
  }

  processCommit(buf) {
    const { message } = C.readMlsMessage(new Reader(buf))
    if (!this.group) throw new Error('no group to process commit for')
    if (this.pending && (buf.equals(this.pending.commitBytes) || (message.content.sender.index === this.group.ownLeaf && message.content.epoch === this.group.epoch))) {
      this.adoptState(this.pending)
      return
    }
    const next = M.processCommitMessage(this.group, message, ref => this.resolveProposal(ref))
    this.pending = null
    this.adoptState(next)
  }

  processWelcome(buf) {
    if (!this.externalSender) throw new Error('external sender is not set')
    const state = M.joinWelcome(buf, this.bundles)
    this.bundles = []
    this.pending = null
    this.adoptState(state)
  }

  adoptState(state) {
    this.group = state
    this.established = true
    this.pending = null
    this.ratchets.clear()
    this.proposals.clear()
  }

  resolveProposal(reference) {
    const body = this.proposals.get(reference.toString('hex'))
    if (!body) throw new Error('unknown proposal reference')
    return body
  }

  ownRatchet() {
    return this.ratchetFor(this.userIdValue)
  }

  ratchetFor(userId) {
    const key = String(userId)
    let ratchet = this.ratchets.get(key)
    if (!ratchet) {
      if (!this.group) throw new Error('no group')
      const member = M.memberIdentities(this.group.nodes).find(m => identityToUserId(m.identity) === key)
      if (!member) throw new Error('user is not in the group')
      ratchet = new SenderRatchet(this.group.secrets.exporter, BigInt(key))
      this.ratchets.set(key, ratchet)
    }
    return ratchet
  }

  encryptOpus(packet) {
    return this.encrypt(MediaType.AUDIO, Codec.OPUS, packet)
  }

  encrypt(mediaType, codec, packet) {
    if (mediaType !== MediaType.AUDIO || codec !== Codec.OPUS) throw new Error('only opus audio is supported')
    if (!this.ready) throw new Error('session is not ready')
    this.ownNonce = (this.ownNonce + 1) >>> 0
    if (this.ownNonce === 0) throw new Error('frame nonce exhausted')
    const generation = this.ownNonce >>> GENERATION_SHIFT
    return encryptFrame(this.ownRatchet().keyFor(generation), this.ownNonce, packet)
  }

  decrypt(userId, mediaType, packet) {
    if (mediaType !== MediaType.AUDIO) throw new Error('only audio is supported')
    if (!this.group) throw new Error('no group')
    const frame = parseFrame(packet)
    if (!frame) {
      if (this.canPassthrough(userId)) return packet
      throw new Error('unencrypted frame without passthrough')
    }
    const generation = frame.nonce >>> GENERATION_SHIFT
    return decryptFrame(this.ratchetFor(userId).keyFor(generation), frame)
  }

  canPassthrough() {
    return this.passthroughEnabled || Date.now() < this.passthroughUntil
  }

  setPassthroughMode(enabled, transitionExpiry = 10) {
    if (enabled) {
      this.passthroughEnabled = true
      this.passthroughUntil = 0
    } else {
      this.passthroughEnabled = false
      this.passthroughUntil = Date.now() + transitionExpiry * 1000
    }
  }

  destroy() {
    this.reset()
  }
}

export const DaveSession = DAVESession
export const VERSION = '0.1.0-native'
