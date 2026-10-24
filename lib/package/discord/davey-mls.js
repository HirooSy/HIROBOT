import { Reader, Writer } from './davey-tls.js'
import * as C from './davey-codec.js'
import * as X from './davey-crypto.js'

const { NH, NK, NN } = X
const EMPTY = Buffer.alloc(0)
const ZERO = Buffer.alloc(NH)
const P256_ORDER = BigInt('0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551')
const KEM_SUITE = Buffer.concat([Buffer.from('KEM'), new Writer().u16(X.KEM_ID).finish()])

export const RATCHET_TREE_EXTENSION = C.EXTENSION.RATCHET_TREE

export function bigEndianUserId(value) {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(value))
  return buf
}

export const bigEndianGroupId = bigEndianUserId

function levelOf(x) {
  if ((x & 1) === 0) return 0
  let level = 0
  while ((x >> level) & 1) level++
  return level
}

function parentOf(x) {
  const k = levelOf(x)
  const b = (x >> (k + 1)) & 1
  return (x | (1 << k)) ^ (b << (k + 1))
}

function siblingOf(x) {
  const p = parentOf(x)
  const k = levelOf(x)
  return x < p ? p + (1 << k) : p - (1 << k)
}

function leftOf(p) {
  return p - (1 << (levelOf(p) - 1))
}

function rightOf(p) {
  return p + (1 << (levelOf(p) - 1))
}

const rootOf = width => (width - 1) >> 1

function directPath(x, width) {
  const root = rootOf(width)
  const path = []
  for (let n = x; n !== root;) {
    n = parentOf(n)
    path.push(n)
  }
  return path
}

function copath(x, width) {
  const root = rootOf(width)
  const out = []
  for (let n = x; n !== root; n = parentOf(n)) out.push(siblingOf(n))
  return out
}

function resolution(nodes, x) {
  const node = nodes[x]
  if (!node) {
    if (levelOf(x) === 0) return []
    return [...resolution(nodes, leftOf(x)), ...resolution(nodes, rightOf(x))]
  }
  if (node.nodeType === C.NODE_TYPE.LEAF) return [x]
  return [x, ...node.parent.unmergedLeaves.map(leaf => 2 * leaf)]
}

function filteredDirectPath(nodes, leafPos) {
  const width = nodes.length
  const dp = directPath(leafPos, width)
  const cp = copath(leafPos, width)
  const out = []
  for (let i = 0; i < dp.length; i++) {
    if (resolution(nodes, cp[i]).length) out.push({ node: dp[i], copath: cp[i] })
  }
  return out
}

function subtreeContains(root, x, width) {
  return root === x || directPath(x, width).includes(root)
}

function nodeHash(nodes, x) {
  const w = new Writer()
  if (levelOf(x) === 0) {
    w.u8(C.NODE_TYPE.LEAF).u32(x >> 1)
    const node = nodes[x]
    if (node) {
      w.u8(1)
      C.writeLeafNode(w, node.leaf)
    } else {
      w.u8(0)
    }
  } else {
    w.u8(C.NODE_TYPE.PARENT)
    const node = nodes[x]
    if (node) {
      w.u8(1)
      C.writeParentNode(w, node.parent)
    } else {
      w.u8(0)
    }
    w.vec(nodeHash(nodes, leftOf(x))).vec(nodeHash(nodes, rightOf(x)))
  }
  return X.sha256(w.finish())
}

export function treeHash(nodes) {
  return nodeHash(nodes, rootOf(nodes.length))
}

function nodePublicKey(node) {
  return node.nodeType === C.NODE_TYPE.LEAF ? node.leaf.encryptionKey : node.parent.encryptionKey
}

function trimTrailingBlanks(nodes) {
  let end = nodes.length
  while (end > 0 && !nodes[end - 1]) end--
  return nodes.slice(0, end)
}

function padToTree(nodes) {
  let width = 1
  while (width < nodes.length) width = width * 2 + 1
  const out = nodes.slice()
  while (out.length < width) out.push(null)
  return out
}

function extendTree(nodes) {
  const leaves = (nodes.length + 1) / 2
  const out = nodes.slice()
  while (out.length < 4 * leaves - 1) out.push(null)
  return out
}

function truncateTree(nodes) {
  let out = nodes
  while (out.length > 1) {
    const leaves = (out.length + 1) / 2
    if (out.slice(leaves).some(Boolean)) break
    out = out.slice(0, leaves - 1)
  }
  return out
}

function blankLeaf(nodes, leafIndex) {
  const out = nodes.slice()
  out[2 * leafIndex] = null
  for (const p of directPath(2 * leafIndex, out.length)) out[p] = null
  return out
}

function insertLeaf(nodes, leafNode) {
  const leaves = (nodes.length + 1) / 2
  let index = -1
  for (let i = 0; i < leaves; i++) {
    if (!nodes[2 * i]) {
      index = i
      break
    }
  }
  let out = nodes
  if (index === -1) {
    index = leaves
    out = extendTree(nodes)
  }
  out = out.slice()
  out[2 * index] = { nodeType: C.NODE_TYPE.LEAF, leaf: leafNode }
  for (const p of directPath(2 * index, out.length)) {
    if (out[p]) out[p] = { nodeType: C.NODE_TYPE.PARENT, parent: { ...out[p].parent, unmergedLeaves: [...out[p].parent.unmergedLeaves, index] } }
  }
  return { nodes: out, leafIndex: index }
}

export function applyProposals(nodes, proposals) {
  let current = nodes
  for (const proposal of proposals) {
    if (proposal.type === C.PROPOSAL.REMOVE) {
      if (!current[2 * proposal.removed]) throw new Error('remove of blank leaf')
      current = blankLeaf(current, proposal.removed)
    } else if (proposal.type !== C.PROPOSAL.ADD) {
      throw new Error(`unsupported proposal type ${proposal.type}`)
    }
  }
  const added = []
  for (const proposal of proposals) {
    if (proposal.type === C.PROPOSAL.ADD) {
      const result = insertLeaf(current, proposal.keyPackage.leafNode)
      current = result.nodes
      added.push(result.leafIndex)
    }
  }
  return { nodes: truncateTree(current), added }
}

export function deriveKeyPair(ikm) {
  const prk = X.hkdfExtract(EMPTY, Buffer.concat([Buffer.from('HPKE-v1'), KEM_SUITE, Buffer.from('dkp_prk'), ikm]))
  for (let counter = 0; counter < 256; counter++) {
    const candidate = X.hkdfExpand(prk, Buffer.concat([new Writer().u16(32).finish(), Buffer.from('HPKE-v1'), KEM_SUITE, Buffer.from('candidate'), Buffer.from([counter])]), 32)
    const scalar = BigInt(`0x${candidate.toString('hex')}`)
    if (scalar !== 0n && scalar < P256_ORDER) return { privateKey: candidate, publicKey: X.publicFromPrivate(candidate) }
  }
  throw new Error('DeriveKeyPair failed')
}

export function createLeafNode(userId, encryptionKey, signatureKey) {
  return {
    encryptionKey,
    signatureKey,
    credential: { type: C.CREDENTIAL.BASIC, identity: bigEndianUserId(userId) },
    capabilities: { versions: [C.PROTOCOL_VERSION], cipherSuites: [C.CIPHERSUITE], extensions: [], proposals: [], credentials: [C.CREDENTIAL.BASIC] },
    source: C.LEAF_SOURCE.KEY_PACKAGE,
    lifetime: { notBefore: 0n, notAfter: C.MAX_LIFETIME },
    parentHash: null,
    extensions: [],
    signature: null
  }
}

export function signLeafNode(leaf, signingKey, groupId, leafIndex) {
  const tbs = C.leafNodeTbs(leaf, groupId, leafIndex)
  return { ...leaf, signature: X.signWithLabel(signingKey.privateKey, signingKey.publicKey, 'LeafNodeTBS', tbs) }
}

export function verifyLeafNode(leaf, groupId, leafIndex) {
  return X.verifyWithLabel(leaf.signatureKey, 'LeafNodeTBS', C.leafNodeTbs(leaf, groupId, leafIndex), leaf.signature)
}

export function createKeyPackage(userId) {
  const init = X.generateP256()
  const encryption = X.generateP256()
  const signing = X.generateP256()
  const signingKey = { privateKey: signing.privateKey, publicKey: signing.publicKey }
  const leaf = signLeafNode(createLeafNode(userId, encryption.publicKey, signing.publicKey), signingKey)
  const kp = { version: C.PROTOCOL_VERSION, cipherSuite: C.CIPHERSUITE, initKey: init.publicKey, leafNode: leaf, extensions: [], signature: null }
  const tbs = new Writer()
  C.writeKeyPackageTbs(tbs, kp)
  kp.signature = X.signWithLabel(signing.privateKey, signing.publicKey, 'KeyPackageTBS', tbs.finish())
  const bytes = C.encodeKeyPackage(kp)
  return {
    bytes,
    ref: X.refHash('KeyPackage Reference', bytes),
    keyPackage: kp,
    privateKeys: {
      init: { privateKey: init.privateKey, publicKey: init.publicKey },
      encryption: { privateKey: encryption.privateKey, publicKey: encryption.publicKey },
      signing: signingKey
    }
  }
}

export function verifyKeyPackage(kp) {
  if (kp.version !== C.PROTOCOL_VERSION || kp.cipherSuite !== C.CIPHERSUITE) return false
  if (kp.leafNode.source !== C.LEAF_SOURCE.KEY_PACKAGE) return false
  if (kp.initKey.equals(kp.leafNode.encryptionKey)) return false
  if (!verifyLeafNode(kp.leafNode, null, null)) return false
  const w = new Writer()
  C.writeKeyPackageTbs(w, kp)
  return X.verifyWithLabel(kp.leafNode.signatureKey, 'KeyPackageTBS', w.finish(), kp.signature)
}

export function proposalRef(content, signature) {
  const authenticated = new Writer().u16(C.WIRE.PUBLIC)
  C.writeFramedContent(authenticated, content)
  authenticated.vec(signature)
  return X.refHash('Proposal Reference', authenticated.finish())
}

function deriveEpochSecrets(member, gcBytes) {
  const epoch = X.expandWithLabel(member, 'epoch', gcBytes, NH)
  return {
    welcome: X.deriveSecret(member, 'welcome'),
    senderData: X.deriveSecret(epoch, 'sender data'),
    encryption: X.deriveSecret(epoch, 'encryption'),
    exporter: X.deriveSecret(epoch, 'exporter'),
    external: X.deriveSecret(epoch, 'external'),
    confirmation: X.deriveSecret(epoch, 'confirm'),
    membership: X.deriveSecret(epoch, 'membership'),
    resumption: X.deriveSecret(epoch, 'resumption'),
    epochAuthenticator: X.deriveSecret(epoch, 'authentication'),
    init: X.deriveSecret(epoch, 'init')
  }
}

export function keySchedule(initSecret, commitSecret, gcBytes) {
  const intermediate = X.hkdfExtract(initSecret, commitSecret)
  const joiner = X.expandWithLabel(intermediate, 'joiner', gcBytes, NH)
  const member = X.hkdfExtract(joiner, ZERO)
  return { joiner, ...deriveEpochSecrets(member, gcBytes) }
}

function interimTranscriptHash(confirmedTranscriptHash, confirmationTag) {
  return X.sha256(confirmedTranscriptHash, new Writer().vec(confirmationTag).finish())
}

function gcBytesFor(groupId, epoch, nodes, confirmedTranscriptHash, extensions) {
  return C.encodeGroupContext({
    version: C.PROTOCOL_VERSION,
    cipherSuite: C.CIPHERSUITE,
    groupId,
    epoch,
    treeHash: treeHash(nodes),
    confirmedTranscriptHash,
    extensions
  })
}

function currentGroupContextBytes(state) {
  return gcBytesFor(state.groupId, state.epoch, state.nodes, state.confirmedTranscriptHash, state.extensions)
}

export function createGroupState({ groupId, keyPackage, extensions = [] }) {
  const leaf = keyPackage.keyPackage.leafNode
  const nodes = [{ nodeType: C.NODE_TYPE.LEAF, leaf }]
  const confirmedTranscriptHash = EMPTY
  const gcBytes = gcBytesFor(groupId, 0n, nodes, confirmedTranscriptHash, extensions)
  const secrets = keySchedule(X.randomSecret(NH), ZERO, gcBytes)
  const confirmationTag = X.hmacSha256(secrets.confirmation, confirmedTranscriptHash)
  return {
    groupId,
    epoch: 0n,
    nodes,
    ownLeaf: 0,
    keys: new Map([[0, keyPackage.privateKeys.encryption]]),
    signing: keyPackage.privateKeys.signing,
    confirmedTranscriptHash,
    interimTranscriptHash: interimTranscriptHash(confirmedTranscriptHash, confirmationTag),
    extensions,
    secrets
  }
}

function parentHashInput(encryptionKey, parentHash, siblingTreeHash) {
  return X.sha256(new Writer().vec(encryptionKey).vec(parentHash).vec(siblingTreeHash).finish())
}

function computePathParentHashes(nodes, filtered, encryptionKeys) {
  const hashes = new Array(filtered.length)
  for (let i = filtered.length - 1; i >= 0; i--) {
    if (i === filtered.length - 1) {
      hashes[i] = EMPTY
    } else {
      hashes[i] = parentHashInput(encryptionKeys[i + 1], hashes[i + 1], nodeHash(nodes, filtered[i + 1].copath))
    }
  }
  return hashes
}

function leafParentHashFor(nodes, filtered, encryptionKeys, parentHashes) {
  if (!filtered.length) return EMPTY
  return parentHashInput(encryptionKeys[0], parentHashes[0], nodeHash(nodes, filtered[0].copath))
}

function setPathParents(nodes, filtered, encryptionKeys, parentHashes) {
  for (let i = 0; i < filtered.length; i++) {
    nodes[filtered[i].node] = {
      nodeType: C.NODE_TYPE.PARENT,
      parent: { encryptionKey: encryptionKeys[i], parentHash: parentHashes[i], unmergedLeaves: [] }
    }
  }
}

function dropPathKeys(keys, leafPos, width) {
  const out = new Map(keys)
  for (const p of directPath(leafPos, width)) out.delete(p)
  return out
}

function generatePath(state, appliedNodes) {
  const leafIndex = state.ownLeaf
  const leafPos = 2 * leafIndex
  const nodes = appliedNodes.slice()
  for (const p of directPath(leafPos, nodes.length)) nodes[p] = null
  const filtered = filteredDirectPath(nodes, leafPos)
  const pathSecrets = [X.randomSecret(NH)]
  for (let i = 1; i <= filtered.length; i++) pathSecrets.push(X.deriveSecret(pathSecrets[i - 1], 'path'))
  const leafPair = deriveKeyPair(X.deriveSecret(pathSecrets[0], 'node'))
  const pairs = filtered.map((_, i) => deriveKeyPair(X.deriveSecret(pathSecrets[i + 1], 'node')))
  const encryptionKeys = pairs.map(pair => pair.publicKey)
  const parentHashes = computePathParentHashes(nodes, filtered, encryptionKeys)
  setPathParents(nodes, filtered, encryptionKeys, parentHashes)
  const oldLeaf = state.nodes[leafPos].leaf
  const leaf = signLeafNode(
    { ...oldLeaf, encryptionKey: leafPair.publicKey, source: C.LEAF_SOURCE.COMMIT, lifetime: null, parentHash: leafParentHashFor(nodes, filtered, encryptionKeys, parentHashes), signature: null },
    state.signing,
    state.groupId,
    leafIndex
  )
  nodes[leafPos] = { nodeType: C.NODE_TYPE.LEAF, leaf }
  const provisional = gcBytesFor(state.groupId, state.epoch + 1n, nodes, state.confirmedTranscriptHash, state.extensions)
  const updateNodes = filtered.map((entry, i) => ({
    encryptionKey: encryptionKeys[i],
    encryptedPathSecret: resolution(nodes, entry.copath).map(r => X.encryptWithLabel(nodePublicKey(nodes[r]), 'UpdatePathNode', provisional, pathSecrets[i + 1]))
  }))
  const keys = dropPathKeys(state.keys, leafPos, nodes.length)
  keys.set(leafPos, leafPair)
  filtered.forEach((entry, i) => keys.set(entry.node, pairs[i]))
  return {
    nodes,
    filtered,
    pathSecrets,
    keys,
    commitSecret: X.deriveSecret(pathSecrets[filtered.length], 'path'),
    updatePath: { leafNode: leaf, nodes: updateNodes }
  }
}

function applyUpdatePath(state, appliedNodes, senderLeaf, path) {
  const senderPos = 2 * senderLeaf
  const width = appliedNodes.length
  const nodes = appliedNodes.slice()
  for (const p of directPath(senderPos, width)) nodes[p] = null
  const filtered = filteredDirectPath(nodes, senderPos)
  if (path.nodes.length !== filtered.length) throw new Error('update path length mismatch')
  const leaf = path.leafNode
  if (leaf.source !== C.LEAF_SOURCE.COMMIT) throw new Error('update path leaf must be a commit leaf')
  if (!verifyLeafNode(leaf, state.groupId, senderLeaf)) throw new Error('invalid update path leaf signature')
  const encryptionKeys = path.nodes.map(node => node.encryptionKey)
  const parentHashes = computePathParentHashes(nodes, filtered, encryptionKeys)
  if (!leaf.parentHash.equals(leafParentHashFor(nodes, filtered, encryptionKeys, parentHashes))) throw new Error('update path parent hash mismatch')
  setPathParents(nodes, filtered, encryptionKeys, parentHashes)
  nodes[senderPos] = { nodeType: C.NODE_TYPE.LEAF, leaf }
  const provisional = gcBytesFor(state.groupId, state.epoch + 1n, nodes, state.confirmedTranscriptHash, state.extensions)
  const ourPath = [2 * state.ownLeaf, ...directPath(2 * state.ownLeaf, width)]
  const index = filtered.findIndex(entry => ourPath.includes(entry.copath))
  if (index === -1) throw new Error('update path does not cover our leaf')
  const resolved = resolution(nodes, filtered[index].copath)
  const j = resolved.findIndex(pos => state.keys.has(pos))
  if (j === -1) throw new Error('no private key for update path secret')
  const pair = state.keys.get(resolved[j])
  let pathSecret = X.decryptWithLabel(pair.privateKey, pair.publicKey, 'UpdatePathNode', provisional, path.nodes[index].encryptedPathSecret[j])
  const keys = dropPathKeys(state.keys, senderPos, width)
  for (let k = index; k < filtered.length; k++) {
    if (k > index) pathSecret = X.deriveSecret(pathSecret, 'path')
    const derived = deriveKeyPair(X.deriveSecret(pathSecret, 'node'))
    if (!derived.publicKey.equals(encryptionKeys[k])) throw new Error('update path public key mismatch')
    keys.set(filtered[k].node, derived)
  }
  return { nodes, keys, commitSecret: X.deriveSecret(pathSecret, 'path') }
}

function pathSecretForLeaf(path, leafIndex, width) {
  if (!path) return null
  const ancestors = [2 * leafIndex, ...directPath(2 * leafIndex, width)]
  const index = path.filtered.findIndex(entry => ancestors.includes(entry.copath))
  if (index === -1) throw new Error('new member outside committer path')
  return path.pathSecrets[index + 1]
}

function buildWelcome({ state, nodes, gc, confirmationTag, secrets, addedMembers, path }) {
  const treeWriter = new Writer()
  C.writeRatchetTree(treeWriter, trimTrailingBlanks(nodes))
  const groupInfo = {
    groupContext: gc,
    extensions: [{ type: RATCHET_TREE_EXTENSION, data: treeWriter.finish() }],
    confirmationTag,
    signer: state.ownLeaf,
    signature: null
  }
  const tbs = new Writer()
  C.writeGroupInfoTbs(tbs, groupInfo)
  groupInfo.signature = X.signWithLabel(state.signing.privateKey, state.signing.publicKey, 'GroupInfoTBS', tbs.finish())
  const giWriter = new Writer()
  C.writeGroupInfo(giWriter, groupInfo)
  const welcomeKey = X.expandWithLabel(secrets.welcome, 'key', EMPTY, NK)
  const welcomeNonce = X.expandWithLabel(secrets.welcome, 'nonce', EMPTY, NN)
  const encryptedGroupInfo = X.aeadSeal(welcomeKey, welcomeNonce, EMPTY, giWriter.finish())
  const secretsList = addedMembers.map(member => {
    const gsWriter = new Writer()
    C.writeGroupSecrets(gsWriter, { joinerSecret: secrets.joiner, pathSecret: pathSecretForLeaf(path, member.leafIndex, nodes.length) })
    return {
      newMember: member.ref,
      encryptedGroupSecrets: X.encryptWithLabel(member.keyPackage.initKey, 'Welcome', encryptedGroupInfo, gsWriter.finish())
    }
  })
  const w = new Writer()
  C.writeWelcome(w, { cipherSuite: C.CIPHERSUITE, secrets: secretsList, encryptedGroupInfo })
  return w.finish()
}

export function createCommit(state, proposals) {
  const applied = applyProposals(state.nodes, proposals)
  const needsPath = proposals.some(proposal => proposal.type === C.PROPOSAL.REMOVE || proposal.type === C.PROPOSAL.UPDATE)
  const path = needsPath ? generatePath(state, applied.nodes) : null
  const nodes = path ? path.nodes : applied.nodes
  const keys = path ? path.keys : state.keys
  const commit = {
    proposals: proposals.map(proposal => ({ type: C.PROPOSAL_OR_REF.PROPOSAL, proposal })),
    path: path ? path.updatePath : null
  }
  const content = {
    groupId: state.groupId,
    epoch: state.epoch,
    sender: { type: C.SENDER.MEMBER, index: state.ownLeaf },
    authenticatedData: EMPTY,
    contentType: C.CONTENT.COMMIT,
    body: commit
  }
  const tbs = C.encodeFramedContentTbs(C.PROTOCOL_VERSION, C.WIRE.PUBLIC, content, currentGroupContextBytes(state))
  const signature = X.signWithLabel(state.signing.privateKey, state.signing.publicKey, 'FramedContentTBS', tbs)
  const confirmedInput = new Writer().u16(C.WIRE.PUBLIC)
  C.writeFramedContent(confirmedInput, content)
  confirmedInput.vec(signature)
  const confirmedTranscriptHash = X.sha256(state.interimTranscriptHash, confirmedInput.finish())
  const epoch = state.epoch + 1n
  const gc = { version: C.PROTOCOL_VERSION, cipherSuite: C.CIPHERSUITE, groupId: state.groupId, epoch, treeHash: treeHash(nodes), confirmedTranscriptHash, extensions: state.extensions }
  const secrets = keySchedule(state.secrets.init, path ? path.commitSecret : ZERO, C.encodeGroupContext(gc))
  const confirmationTag = X.hmacSha256(secrets.confirmation, confirmedTranscriptHash)
  const membershipTag = X.hmacSha256(state.secrets.membership, Buffer.concat([tbs, new Writer().vec(signature).vec(confirmationTag).finish()]))
  const publicMessage = new Writer()
  C.writeFramedContent(publicMessage, content)
  publicMessage.vec(signature).vec(confirmationTag).vec(membershipTag)
  const commitMessage = C.encodeMlsMessage(C.WIRE.PUBLIC, publicMessage.finish())
  const addedMembers = proposals
    .filter(proposal => proposal.type === C.PROPOSAL.ADD)
    .map((proposal, i) => ({
      keyPackage: proposal.keyPackage,
      ref: X.refHash('KeyPackage Reference', C.encodeKeyPackage(proposal.keyPackage)),
      leafIndex: applied.added[i]
    }))
  const welcome = addedMembers.length ? buildWelcome({ state, nodes, gc, confirmationTag, secrets, addedMembers, path }) : null
  return {
    commit: commitMessage,
    welcome,
    pending: {
      groupId: state.groupId,
      epoch,
      commitBytes: commitMessage,
      nodes,
      keys,
      signing: state.signing,
      ownLeaf: state.ownLeaf,
      confirmedTranscriptHash,
      interimTranscriptHash: interimTranscriptHash(confirmedTranscriptHash, confirmationTag),
      extensions: state.extensions,
      secrets
    }
  }
}

export function joinWelcome(welcomeBytes, bundles) {
  const welcome = C.readWelcome(new Reader(welcomeBytes))
  if (welcome.cipherSuite !== C.CIPHERSUITE) throw new Error('welcome cipher suite mismatch')
  let match = null
  for (const secret of welcome.secrets) {
    const bundle = bundles.find(b => b.ref.equals(secret.newMember))
    if (bundle) {
      match = { bundle, secret }
      break
    }
  }
  if (!match) throw new Error('no matching key package for welcome')
  const { bundle, secret } = match
  const gsBytes = X.decryptWithLabel(bundle.privateKeys.init.privateKey, bundle.privateKeys.init.publicKey, 'Welcome', welcome.encryptedGroupInfo, secret.encryptedGroupSecrets)
  const gs = C.readGroupSecrets(new Reader(gsBytes))
  const member = X.hkdfExtract(gs.joinerSecret, ZERO)
  const welcomeSecret = X.deriveSecret(member, 'welcome')
  const welcomeKey = X.expandWithLabel(welcomeSecret, 'key', EMPTY, NK)
  const welcomeNonce = X.expandWithLabel(welcomeSecret, 'nonce', EMPTY, NN)
  const groupInfo = C.readGroupInfo(new Reader(X.aeadOpen(welcomeKey, welcomeNonce, EMPTY, welcome.encryptedGroupInfo)))
  const treeExt = groupInfo.extensions.find(ext => ext.type === RATCHET_TREE_EXTENSION)
  if (!treeExt) throw new Error('welcome has no ratchet tree')
  const nodes = padToTree(C.readRatchetTree(new Reader(treeExt.data)))
  const gc = groupInfo.groupContext
  if (!treeHash(nodes).equals(gc.treeHash)) throw new Error('ratchet tree hash mismatch')
  const signerNode = nodes[2 * groupInfo.signer]
  if (!signerNode) throw new Error('group info signer is blank')
  const giTbs = new Writer()
  C.writeGroupInfoTbs(giTbs, groupInfo)
  if (!X.verifyWithLabel(signerNode.leaf.signatureKey, 'GroupInfoTBS', giTbs.finish(), groupInfo.signature)) throw new Error('invalid group info signature')
  const gcBytes = C.encodeGroupContext(gc)
  const secrets = deriveEpochSecrets(member, gcBytes)
  const confirmation = X.hmacSha256(secrets.confirmation, gc.confirmedTranscriptHash)
  if (!confirmation.equals(groupInfo.confirmationTag)) throw new Error('welcome confirmation tag mismatch')
  const ownLeaf = findOwnLeaf(nodes, bundle.privateKeys.encryption.publicKey)
  const keys = new Map([[2 * ownLeaf, bundle.privateKeys.encryption]])
  if (gs.pathSecret) {
    const fdp = filteredDirectPath(nodes, 2 * groupInfo.signer)
    const ancestors = [2 * ownLeaf, ...directPath(2 * ownLeaf, nodes.length)]
    const start = fdp.findIndex(entry => ancestors.includes(entry.copath))
    if (start === -1) throw new Error('path secret does not match tree')
    let pathSecret = gs.pathSecret
    for (let i = start; i < fdp.length; i++) {
      if (i > start) pathSecret = X.deriveSecret(pathSecret, 'path')
      keys.set(fdp[i].node, deriveKeyPair(X.deriveSecret(pathSecret, 'node')))
    }
  }
  return {
    groupId: gc.groupId,
    epoch: gc.epoch,
    nodes,
    ownLeaf,
    keys,
    signing: bundle.privateKeys.signing,
    confirmedTranscriptHash: gc.confirmedTranscriptHash,
    interimTranscriptHash: interimTranscriptHash(gc.confirmedTranscriptHash, groupInfo.confirmationTag),
    extensions: gc.extensions,
    secrets
  }
}

function findOwnLeaf(nodes, encryptionPublicKey) {
  for (let i = 0; i < (nodes.length + 1) / 2; i++) {
    const node = nodes[2 * i]
    if (node && node.leaf.encryptionKey.equals(encryptionPublicKey)) return i
  }
  throw new Error('own leaf not found in tree')
}

export function parseProposalMessages(payload) {
  const outer = new Reader(payload)
  const body = outer.vec()
  outer.expectDone()
  const reader = new Reader(body)
  const messages = []
  while (!reader.done) {
    const version = reader.u16()
    if (version !== C.PROTOCOL_VERSION) throw new Error('unsupported MLS version')
    if (reader.u16() !== C.WIRE.PUBLIC) throw new Error('proposal must be a public message')
    messages.push(C.readPublicMessage(reader))
  }
  return messages
}

export function processCommitMessage(state, message, resolveReference = () => { throw new Error('proposal reference not found') }) {
  const { content, signature, confirmationTag, membershipTag } = message
  if (!content.groupId.equals(state.groupId)) throw new Error('commit for another group')
  if (content.epoch !== state.epoch) throw new Error('commit for wrong epoch')
  if (content.sender.type !== C.SENDER.MEMBER) throw new Error('commit sender must be a member')
  const senderLeaf = content.sender.index
  const senderNode = state.nodes[2 * senderLeaf]
  if (!senderNode) throw new Error('commit sender is not a member')
  const tbs = C.encodeFramedContentTbs(C.PROTOCOL_VERSION, C.WIRE.PUBLIC, content, currentGroupContextBytes(state))
  if (!X.verifyWithLabel(senderNode.leaf.signatureKey, 'FramedContentTBS', tbs, signature)) throw new Error('invalid commit signature')
  const expectedMembership = X.hmacSha256(state.secrets.membership, Buffer.concat([tbs, new Writer().vec(signature).vec(confirmationTag).finish()]))
  if (!expectedMembership.equals(membershipTag)) throw new Error('invalid membership tag')
  const commit = content.body
  const proposals = commit.proposals.map(por => (por.type === C.PROPOSAL_OR_REF.PROPOSAL ? por.proposal : resolveReference(por.reference)))
  const applied = applyProposals(state.nodes, proposals)
  let nodes = applied.nodes
  let keys = state.keys
  let commitSecret = ZERO
  if (commit.path) {
    const result = applyUpdatePath(state, applied.nodes, senderLeaf, commit.path)
    nodes = result.nodes
    keys = result.keys
    commitSecret = result.commitSecret
  } else if (proposals.some(proposal => proposal.type === C.PROPOSAL.REMOVE || proposal.type === C.PROPOSAL.UPDATE)) {
    throw new Error('commit without update path')
  }
  if (keys.get(2 * state.ownLeaf) === undefined) throw new Error('lost own leaf key')
  const confirmedInput = new Writer().u16(C.WIRE.PUBLIC)
  C.writeFramedContent(confirmedInput, content)
  confirmedInput.vec(signature)
  const confirmedTranscriptHash = X.sha256(state.interimTranscriptHash, confirmedInput.finish())
  const epoch = state.epoch + 1n
  const gc = { version: C.PROTOCOL_VERSION, cipherSuite: C.CIPHERSUITE, groupId: state.groupId, epoch, treeHash: treeHash(nodes), confirmedTranscriptHash, extensions: state.extensions }
  const secrets = keySchedule(state.secrets.init, commitSecret, C.encodeGroupContext(gc))
  if (!X.hmacSha256(secrets.confirmation, confirmedTranscriptHash).equals(confirmationTag)) throw new Error('commit confirmation tag mismatch')
  return {
    groupId: state.groupId,
    epoch,
    nodes,
    keys,
    signing: state.signing,
    ownLeaf: state.ownLeaf,
    confirmedTranscriptHash,
    interimTranscriptHash: interimTranscriptHash(confirmedTranscriptHash, confirmationTag),
    extensions: state.extensions,
    secrets
  }
}

export function memberSignatureKeys(nodes) {
  const keys = []
  for (let i = 0; i < (nodes.length + 1) / 2; i++) {
    const node = nodes[2 * i]
    if (node) keys.push(node.leaf.signatureKey)
  }
  return keys
}

export function memberIdentities(nodes) {
  const ids = []
  for (let i = 0; i < (nodes.length + 1) / 2; i++) {
    const node = nodes[2 * i]
    if (node) ids.push({ leafIndex: i, identity: node.leaf.credential.identity })
  }
  return ids
}
