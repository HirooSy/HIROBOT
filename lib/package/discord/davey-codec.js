import { Reader, Writer } from './davey-tls.js'

export const PROTOCOL_VERSION = 1
export const CIPHERSUITE = 2
export const WIRE = { PUBLIC: 1, PRIVATE: 2, WELCOME: 3, GROUP_INFO: 4, KEY_PACKAGE: 5 }
export const CONTENT = { APPLICATION: 1, PROPOSAL: 2, COMMIT: 3 }
export const SENDER = { MEMBER: 1, EXTERNAL: 2, NEW_MEMBER_PROPOSAL: 3, NEW_MEMBER_COMMIT: 4 }
export const PROPOSAL = { ADD: 1, UPDATE: 2, REMOVE: 3, PSK: 4, REINIT: 5, EXTERNAL_INIT: 6, GROUP_CONTEXT_EXTENSIONS: 7 }
export const PROPOSAL_OR_REF = { PROPOSAL: 1, REFERENCE: 2 }
export const LEAF_SOURCE = { KEY_PACKAGE: 1, UPDATE: 2, COMMIT: 3 }
export const NODE_TYPE = { LEAF: 1, PARENT: 2 }
export const CREDENTIAL = { BASIC: 1 }
export const EXTENSION = { APPLICATION_ID: 1, RATCHET_TREE: 2, REQUIRED_CAPABILITIES: 3, EXTERNAL_PUB: 4, EXTERNAL_SENDERS: 5, LAST_RESORT: 10 }
export const MAX_LIFETIME = (1n << 64n) - 1n

export function writeCredential(w, credential) {
  if (credential.type !== CREDENTIAL.BASIC) throw new Error('unsupported credential type')
  w.u16(credential.type).vec(credential.identity)
}

export function readCredential(r) {
  const type = r.u16()
  if (type !== CREDENTIAL.BASIC) throw new Error('unsupported credential type')
  return { type, identity: Buffer.from(r.vec()) }
}

export function writeCapabilities(w, caps) {
  w.list(caps.versions, (x, v) => x.u16(v))
  w.list(caps.cipherSuites, (x, v) => x.u16(v))
  w.list(caps.extensions, (x, v) => x.u16(v))
  w.list(caps.proposals, (x, v) => x.u16(v))
  w.list(caps.credentials, (x, v) => x.u16(v))
}

export function readCapabilities(r) {
  return {
    versions: r.list(x => x.u16()),
    cipherSuites: r.list(x => x.u16()),
    extensions: r.list(x => x.u16()),
    proposals: r.list(x => x.u16()),
    credentials: r.list(x => x.u16())
  }
}

export function writeExtensions(w, extensions) {
  w.list(extensions, (x, ext) => x.u16(ext.type).vec(ext.data))
}

export function readExtensions(r) {
  return r.list(x => ({ type: x.u16(), data: Buffer.from(x.vec()) }))
}

export function writeLeafNodeContent(w, leaf) {
  w.vec(leaf.encryptionKey)
  w.vec(leaf.signatureKey)
  writeCredential(w, leaf.credential)
  writeCapabilities(w, leaf.capabilities)
  w.u8(leaf.source)
  if (leaf.source === LEAF_SOURCE.KEY_PACKAGE) w.u64(leaf.lifetime.notBefore).u64(leaf.lifetime.notAfter)
  else if (leaf.source === LEAF_SOURCE.COMMIT) w.vec(leaf.parentHash)
  writeExtensions(w, leaf.extensions)
}

export function leafNodeTbs(leaf, groupId, leafIndex) {
  const w = new Writer()
  writeLeafNodeContent(w, leaf)
  if (leaf.source !== LEAF_SOURCE.KEY_PACKAGE) w.vec(groupId).u32(leafIndex)
  return w.finish()
}

export function writeLeafNode(w, leaf) {
  writeLeafNodeContent(w, leaf)
  w.vec(leaf.signature)
}

export function readLeafNode(r) {
  const encryptionKey = Buffer.from(r.vec())
  const signatureKey = Buffer.from(r.vec())
  const credential = readCredential(r)
  const capabilities = readCapabilities(r)
  const source = r.u8()
  const leaf = { encryptionKey, signatureKey, credential, capabilities, source, lifetime: null, parentHash: null, extensions: null, signature: null }
  if (source === LEAF_SOURCE.KEY_PACKAGE) leaf.lifetime = { notBefore: r.u64(), notAfter: r.u64() }
  else if (source === LEAF_SOURCE.COMMIT) leaf.parentHash = Buffer.from(r.vec())
  else if (source !== LEAF_SOURCE.UPDATE) throw new Error('invalid leaf node source')
  leaf.extensions = readExtensions(r)
  leaf.signature = Buffer.from(r.vec())
  return leaf
}

export function writeKeyPackageTbs(w, kp) {
  w.u16(kp.version).u16(kp.cipherSuite).vec(kp.initKey)
  writeLeafNode(w, kp.leafNode)
  writeExtensions(w, kp.extensions)
}

export function writeKeyPackage(w, kp) {
  writeKeyPackageTbs(w, kp)
  w.vec(kp.signature)
}

export function encodeKeyPackage(kp) {
  const w = new Writer()
  writeKeyPackage(w, kp)
  return w.finish()
}

export function readKeyPackage(r) {
  const version = r.u16()
  const cipherSuite = r.u16()
  const initKey = Buffer.from(r.vec())
  const leafNode = readLeafNode(r)
  const extensions = readExtensions(r)
  const signature = Buffer.from(r.vec())
  return { version, cipherSuite, initKey, leafNode, extensions, signature }
}

export function parseKeyPackage(buf) {
  const r = new Reader(buf)
  const kp = readKeyPackage(r)
  r.expectDone()
  return kp
}

export function writeParentNode(w, node) {
  w.vec(node.encryptionKey)
  w.vec(node.parentHash)
  w.list(node.unmergedLeaves, (x, leaf) => x.u32(leaf))
}

export function readParentNode(r) {
  return {
    encryptionKey: Buffer.from(r.vec()),
    parentHash: Buffer.from(r.vec()),
    unmergedLeaves: r.list(x => x.u32())
  }
}

export function writeRatchetTree(w, nodes) {
  w.list(nodes, (x, node) => {
    if (!node) {
      x.u8(0)
      return
    }
    x.u8(1).u8(node.nodeType)
    if (node.nodeType === NODE_TYPE.LEAF) writeLeafNode(x, node.leaf)
    else writeParentNode(x, node.parent)
  })
}

export function readRatchetTree(r) {
  return r.list(x => {
    if (x.u8() === 0) return null
    const nodeType = x.u8()
    if (nodeType === NODE_TYPE.LEAF) return { nodeType, leaf: readLeafNode(x) }
    if (nodeType === NODE_TYPE.PARENT) return { nodeType, parent: readParentNode(x) }
    throw new Error('invalid node type')
  })
}

export function writeGroupContext(w, gc) {
  w.u16(gc.version).u16(gc.cipherSuite).vec(gc.groupId).u64(gc.epoch).vec(gc.treeHash).vec(gc.confirmedTranscriptHash)
  writeExtensions(w, gc.extensions)
}

export function encodeGroupContext(gc) {
  const w = new Writer()
  writeGroupContext(w, gc)
  return w.finish()
}

export function readGroupContext(r) {
  return {
    version: r.u16(),
    cipherSuite: r.u16(),
    groupId: Buffer.from(r.vec()),
    epoch: r.u64(),
    treeHash: Buffer.from(r.vec()),
    confirmedTranscriptHash: Buffer.from(r.vec()),
    extensions: readExtensions(r)
  }
}

export function writeHpkeCiphertext(w, ct) {
  w.vec(ct.kemOutput).vec(ct.ciphertext)
}

export function readHpkeCiphertext(r) {
  return { kemOutput: Buffer.from(r.vec()), ciphertext: Buffer.from(r.vec()) }
}

export function writeProposal(w, proposal) {
  w.u16(proposal.type)
  switch (proposal.type) {
    case PROPOSAL.ADD:
      writeKeyPackage(w, proposal.keyPackage)
      break
    case PROPOSAL.UPDATE:
      writeLeafNode(w, proposal.leafNode)
      break
    case PROPOSAL.REMOVE:
      w.u32(proposal.removed)
      break
    case PROPOSAL.GROUP_CONTEXT_EXTENSIONS:
      writeExtensions(w, proposal.extensions)
      break
    case PROPOSAL.EXTERNAL_INIT:
      w.vec(proposal.kemOutput)
      break
    default:
      throw new Error(`unsupported proposal type ${proposal.type}`)
  }
}

export function readProposal(r) {
  const type = r.u16()
  switch (type) {
    case PROPOSAL.ADD:
      return { type, keyPackage: readKeyPackage(r) }
    case PROPOSAL.UPDATE:
      return { type, leafNode: readLeafNode(r) }
    case PROPOSAL.REMOVE:
      return { type, removed: r.u32() }
    case PROPOSAL.GROUP_CONTEXT_EXTENSIONS:
      return { type, extensions: readExtensions(r) }
    case PROPOSAL.EXTERNAL_INIT:
      return { type, kemOutput: Buffer.from(r.vec()) }
    default:
      throw new Error(`unsupported proposal type ${type}`)
  }
}

export function writeUpdatePath(w, path) {
  writeLeafNode(w, path.leafNode)
  w.list(path.nodes, (x, node) => {
    x.vec(node.encryptionKey)
    x.list(node.encryptedPathSecret, (y, ct) => writeHpkeCiphertext(y, ct))
  })
}

export function readUpdatePath(r) {
  return {
    leafNode: readLeafNode(r),
    nodes: r.list(x => ({
      encryptionKey: Buffer.from(x.vec()),
      encryptedPathSecret: x.list(y => readHpkeCiphertext(y))
    }))
  }
}

export function writeCommit(w, commit) {
  w.list(commit.proposals, (x, por) => {
    if (por.type === PROPOSAL_OR_REF.PROPOSAL) {
      x.u8(PROPOSAL_OR_REF.PROPOSAL)
      writeProposal(x, por.proposal)
    } else {
      x.u8(PROPOSAL_OR_REF.REFERENCE).vec(por.reference)
    }
  })
  if (commit.path) {
    w.u8(1)
    writeUpdatePath(w, commit.path)
  } else {
    w.u8(0)
  }
}

export function readCommit(r) {
  const proposals = r.list(x => {
    const type = x.u8()
    if (type === PROPOSAL_OR_REF.PROPOSAL) return { type, proposal: readProposal(x) }
    if (type === PROPOSAL_OR_REF.REFERENCE) return { type, reference: Buffer.from(x.vec()) }
    throw new Error('invalid proposal or ref type')
  })
  const hasPath = r.u8()
  if (hasPath !== 0 && hasPath !== 1) throw new Error('invalid optional path flag')
  return { proposals, path: hasPath ? readUpdatePath(r) : null }
}

export function writeSender(w, sender) {
  w.u8(sender.type)
  if (sender.type === SENDER.MEMBER || sender.type === SENDER.EXTERNAL) w.u32(sender.index)
}

export function readSender(r) {
  const type = r.u8()
  if (type === SENDER.MEMBER || type === SENDER.EXTERNAL) return { type, index: r.u32() }
  if (type === SENDER.NEW_MEMBER_PROPOSAL || type === SENDER.NEW_MEMBER_COMMIT) return { type }
  throw new Error('invalid sender type')
}

export function writeFramedContentBody(w, content) {
  switch (content.contentType) {
    case CONTENT.APPLICATION:
      w.vec(content.body)
      break
    case CONTENT.PROPOSAL:
      writeProposal(w, content.body)
      break
    case CONTENT.COMMIT:
      writeCommit(w, content.body)
      break
    default:
      throw new Error('invalid content type')
  }
}

export function writeFramedContent(w, content) {
  w.vec(content.groupId).u64(content.epoch)
  writeSender(w, content.sender)
  w.vec(content.authenticatedData)
  w.u8(content.contentType)
  writeFramedContentBody(w, content)
}

export function readFramedContent(r) {
  const groupId = Buffer.from(r.vec())
  const epoch = r.u64()
  const sender = readSender(r)
  const authenticatedData = Buffer.from(r.vec())
  const contentType = r.u8()
  let body
  if (contentType === CONTENT.APPLICATION) body = Buffer.from(r.vec())
  else if (contentType === CONTENT.PROPOSAL) body = readProposal(r)
  else if (contentType === CONTENT.COMMIT) body = readCommit(r)
  else throw new Error('invalid content type')
  return { groupId, epoch, sender, authenticatedData, contentType, body }
}

export function encodeFramedContentTbs(version, wireFormat, content, groupContextBytes) {
  const w = new Writer().u16(version).u16(wireFormat)
  writeFramedContent(w, content)
  if (content.sender.type === SENDER.MEMBER || content.sender.type === SENDER.NEW_MEMBER_COMMIT) {
    w.raw(groupContextBytes)
  }
  return w.finish()
}

export function writePublicMessage(w, pm) {
  writeFramedContent(w, pm.content)
  w.vec(pm.signature)
  if (pm.content.contentType === CONTENT.COMMIT) w.vec(pm.confirmationTag)
  if (pm.content.sender.type === SENDER.MEMBER) w.vec(pm.membershipTag)
}

export function readPublicMessage(r) {
  const content = readFramedContent(r)
  const signature = Buffer.from(r.vec())
  const confirmationTag = content.contentType === CONTENT.COMMIT ? Buffer.from(r.vec()) : null
  const membershipTag = content.sender.type === SENDER.MEMBER ? Buffer.from(r.vec()) : null
  return { content, signature, confirmationTag, membershipTag }
}

export function encodeMlsMessage(wireFormat, body) {
  return new Writer().u16(PROTOCOL_VERSION).u16(wireFormat).raw(body).finish()
}

export function readMlsMessage(r) {
  const version = r.u16()
  if (version !== PROTOCOL_VERSION) throw new Error('unsupported MLS version')
  const wireFormat = r.u16()
  if (wireFormat === WIRE.PUBLIC) return { wireFormat, message: readPublicMessage(r) }
  throw new Error(`unsupported wire format ${wireFormat}`)
}

export function writeGroupInfoTbs(w, gi) {
  writeGroupContext(w, gi.groupContext)
  writeExtensions(w, gi.extensions)
  w.vec(gi.confirmationTag).u32(gi.signer)
}

export function readGroupInfo(r) {
  const groupContext = readGroupContext(r)
  const extensions = readExtensions(r)
  const confirmationTag = Buffer.from(r.vec())
  const signer = r.u32()
  const signature = Buffer.from(r.vec())
  return { groupContext, extensions, confirmationTag, signer, signature }
}

export function writeGroupInfo(w, gi) {
  writeGroupInfoTbs(w, gi)
  w.vec(gi.signature)
}

export function readGroupSecrets(r) {
  const joinerSecret = Buffer.from(r.vec())
  const pathSecretFlag = r.u8()
  if (pathSecretFlag !== 0 && pathSecretFlag !== 1) throw new Error('invalid optional path secret flag')
  const pathSecret = pathSecretFlag ? Buffer.from(r.vec()) : null
  const pskCount = r.list(x => x.rest()).length
  if (pskCount) throw new Error('pre-shared keys are not supported')
  return { joinerSecret, pathSecret }
}

export function writeGroupSecrets(w, gs) {
  w.vec(gs.joinerSecret)
  if (gs.pathSecret) w.u8(1).vec(gs.pathSecret)
  else w.u8(0)
  w.vec(Buffer.alloc(0))
}

export function readWelcome(r) {
  const cipherSuite = r.u16()
  const secrets = r.list(x => ({
    newMember: Buffer.from(x.vec()),
    encryptedGroupSecrets: readHpkeCiphertext(x)
  }))
  const encryptedGroupInfo = Buffer.from(r.vec())
  return { cipherSuite, secrets, encryptedGroupInfo }
}

export function writeWelcome(w, welcome) {
  w.u16(welcome.cipherSuite)
  w.list(welcome.secrets, (x, s) => {
    x.vec(s.newMember)
    writeHpkeCiphertext(x, s.encryptedGroupSecrets)
  })
  w.vec(welcome.encryptedGroupInfo)
}
