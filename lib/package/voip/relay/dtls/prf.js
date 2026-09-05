import { createHmac } from 'node:crypto';

// TLS 1.2 PRF, RFC 5246 §5. All DTLS 1.2 cipher suites we support use
// P_SHA256 (the RFC mandates this for every TLS 1.2 suite): PRF(secret,
// label, seed) = P_hash(secret, label + seed), where
//   P_hash(secret, seed) = HMAC(secret, A(1)+seed) || HMAC(secret, A(2)+seed) || ...
//   A(0) = seed;  A(i) = HMAC(secret, A(i-1))
// iterated until at least `length` bytes are produced, then truncated.

function pHashSha256(secret, seed, length) {
  const out = [];
  let outLen = 0;
  let a = seed; // A(0)
  while (outLen < length) {
    a = createHmac('sha256', secret).update(a).digest(); // A(i) = HMAC(secret, A(i-1))
    const chunk = createHmac('sha256', secret).update(Buffer.concat([a, seed])).digest();
    out.push(chunk);
    outLen += chunk.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

/** @param {Buffer} secret @param {string} label @param {Buffer} seed @param {number} length */
export function prf(secret, label, seed, length) {
  return pHashSha256(secret, Buffer.concat([Buffer.from(label, 'ascii'), seed]), length);
}

/**
 * Master secret from the ECDHE pre-master secret (RFC 5246 §8.1):
 *   master_secret = PRF(pre_master_secret, "master secret", client_random + server_random)[0..48]
 */
export function deriveMasterSecret(preMasterSecret, clientRandom, serverRandom) {
  return prf(preMasterSecret, 'master secret', Buffer.concat([clientRandom, serverRandom]), 48);
}

/**
 * Key block from the master secret (RFC 5246 §6.3):
 *   key_block = PRF(master_secret, "key expansion", server_random + client_random)[0..needed]
 * NOTE the random order is reversed vs. master-secret derivation — easy spot
 * to get backwards, so it's called out explicitly here and in the caller.
 * For an AEAD cipher (AES-128-GCM) there is no separate MAC key: only
 * client_write_key, server_write_key, client_write_IV, server_write_IV
 * (the fixed/implicit part of the GCM nonce, RFC 5288 §3).
 */
export function deriveKeyBlock(masterSecret, clientRandom, serverRandom, { keyLen, fixedIvLen }) {
  const needed = 2 * keyLen + 2 * fixedIvLen;
  const block = prf(masterSecret, 'key expansion', Buffer.concat([serverRandom, clientRandom]), needed);
  let offset = 0;
  const take = (n) => { const b = block.subarray(offset, offset + n); offset += n; return b; };
  return {
    clientWriteKey: take(keyLen),
    serverWriteKey: take(keyLen),
    clientWriteIv: take(fixedIvLen),
    serverWriteIv: take(fixedIvLen),
  };
}

/**
 * Finished message verify_data (RFC 5246 §7.4.9):
 *   verify_data = PRF(master_secret, finished_label, Hash(handshake_messages))[0..12]
 * finished_label is "client finished" or "server finished"; handshakeHash is
 * SHA-256 over the exact concatenated bytes of every handshake message
 * exchanged so far (Certificate..ClientKeyExchange etc.), NOT including
 * record-layer framing — caller is responsible for accumulating the right
 * bytes (see handshake.js).
 */
export function deriveVerifyData(masterSecret, label, handshakeHash) {
  return prf(masterSecret, label, handshakeHash, 12);
}
