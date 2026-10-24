import { DAVESession, DAVE_PROTOCOL_VERSION } from './davey.js'

export const DAVE_OP = Object.freeze({
  PREPARE_TRANSITION: 21,
  EXECUTE_TRANSITION: 22,
  TRANSITION_READY: 23,
  PREPARE_EPOCH: 24,
  EXTERNAL_SENDER: 25,
  KEY_PACKAGE: 26,
  PROPOSALS: 27,
  COMMIT_WELCOME: 28,
  ANNOUNCE_COMMIT: 29,
  WELCOME: 30,
  INVALID_COMMIT_WELCOME: 31
})

const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe])
const TRANSITION_EXPIRY = 10
const DOWNGRADE_EXPIRY = 24
const EMPTY = Buffer.alloc(0)

export class DaveController {
  constructor({ userId, channelId, sendJson, sendBinary, debug }) {
    this.userId = String(userId)
    this.channelId = String(channelId)
    this.sendJson = sendJson
    this.sendBinary = sendBinary
    this.debug = debug ?? (() => {})
    this.session = null
    this.protocolVersion = 0
    this.pendingTransitions = new Map()
    this.lastTransitionId = 0
    this.downgraded = false
    this.reinitializing = false
    this.connectedClients = new Set()
    this.passthroughUntil = 0
  }

  get maxProtocolVersion() {
    return DAVE_PROTOCOL_VERSION
  }

  get ready() {
    return this.protocolVersion > 0 && !!this.session && this.session.ready
  }

  get voicePrivacyCode() {
    return this.session?.voicePrivacyCode ?? null
  }

  sessionDescription(daveProtocolVersion) {
    if (!daveProtocolVersion) {
      this.protocolVersion = 0
      this.session = null
      return
    }
    this.protocolVersion = daveProtocolVersion
    this.reinit()
  }

  reinit() {
    if (this.protocolVersion > 0) {
      this.session = new DAVESession(this.protocolVersion, this.userId, this.channelId)
      this.sendBinary(DAVE_OP.KEY_PACKAGE, this.session.getSerializedKeyPackage())
      this.debug(`DAVE session initialized for protocol version ${this.protocolVersion}`)
    } else if (this.session) {
      this.session.reset()
      this.session.setPassthroughMode(true, TRANSITION_EXPIRY)
      this.debug('DAVE session reset')
    }
  }

  prepareTransition(data) {
    this.pendingTransitions.set(data.transition_id, data.protocol_version)
    if (data.transition_id === 0) {
      this.executeTransition(data.transition_id)
      return
    }
    if (data.protocol_version === 0) this.session?.setPassthroughMode(true, DOWNGRADE_EXPIRY)
    this.sendJson({ op: DAVE_OP.TRANSITION_READY, d: { transition_id: data.transition_id } })
  }

  executeTransition(transitionId) {
    if (!this.pendingTransitions.has(transitionId)) return false
    const previous = this.protocolVersion
    this.protocolVersion = this.pendingTransitions.get(transitionId)
    if (previous !== this.protocolVersion && this.protocolVersion === 0) {
      this.downgraded = true
    } else if (transitionId > 0 && this.downgraded) {
      this.downgraded = false
      this.session?.setPassthroughMode(true, TRANSITION_EXPIRY)
    }
    this.reinitializing = false
    this.lastTransitionId = transitionId
    this.pendingTransitions.delete(transitionId)
    this.debug(`DAVE transition ${transitionId} executed (v${previous} -> v${this.protocolVersion})`)
    return true
  }

  prepareEpoch(data) {
    if (data.epoch === 1) {
      this.protocolVersion = data.protocol_version
      this.reinit()
    }
  }

  setExternalSender(payload) {
    this.session?.setExternalSender(payload)
  }

  processProposals(payload) {
    if (!this.session || this.protocolVersion === 0) return
    const operationType = payload[0]
    const out = this.session.processProposals(operationType, payload.subarray(1), [...this.connectedClients])
    if (out.commit) this.sendBinary(DAVE_OP.COMMIT_WELCOME, Buffer.concat([out.commit, out.welcome ?? EMPTY]))
  }

  announceCommit(payload) {
    this.applyTransitionPayload(payload, () => this.session.processCommit(payload.subarray(2)))
  }

  welcome(payload) {
    this.applyTransitionPayload(payload, () => this.session.processWelcome(payload.subarray(2)))
  }

  applyTransitionPayload(payload, apply) {
    if (!this.session) return
    const transitionId = payload.readUInt16BE(0)
    try {
      apply()
    } catch (err) {
      this.debug(`DAVE transition ${transitionId} failed: ${err.message}`)
      this.recoverFromInvalidTransition(transitionId)
      return
    }
    if (transitionId === 0) {
      this.reinitializing = false
      this.lastTransitionId = 0
    } else {
      this.pendingTransitions.set(transitionId, this.protocolVersion)
      this.sendJson({ op: DAVE_OP.TRANSITION_READY, d: { transition_id: transitionId } })
    }
  }

  recoverFromInvalidTransition(transitionId) {
    if (this.reinitializing) return
    this.reinitializing = true
    this.sendJson({ op: DAVE_OP.INVALID_COMMIT_WELCOME, d: { transition_id: transitionId } })
    this.reinit()
  }

  clientsConnect(userIds) {
    for (const id of userIds) this.connectedClients.add(String(id))
  }

  clientDisconnect(userId) {
    this.connectedClients.delete(String(userId))
  }

  encryptOpus(frame) {
    if (!this.ready || frame.equals(SILENCE_FRAME)) return frame
    return this.session.encryptOpus(frame)
  }

  decryptOpus(userId, packet) {
    if (!this.session || !this.session.ready || packet.equals(SILENCE_FRAME)) return packet
    return this.session.decrypt(String(userId), 0, packet)
  }

  destroy() {
    this.session?.destroy()
    this.session = null
    this.protocolVersion = 0
    this.pendingTransitions.clear()
    this.connectedClients.clear()
  }
}
