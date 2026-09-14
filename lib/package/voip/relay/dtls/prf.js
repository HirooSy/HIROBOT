import { createHmac } from 'node:crypto';

function pHashSha256(secret, seed, length) {
  const out = [];
  let outLen = 0;
  let a = seed;
  while (outLen < length) {
    a = createHmac('sha256', secret).update(a).digest();
    const chunk = createHmac('sha256', secret).update(Buffer.concat([a, seed])).digest();
    out.push(chunk);
    outLen += chunk.length;
  }
  return Buffer.concat(out).subarray(0, length);
}

export function prf(secret, label, seed, length) {
  return pHashSha256(secret, Buffer.concat([Buffer.from(label, 'ascii'), seed]), length);
}

export function deriveMasterSecret(preMasterSecret, clientRandom, serverRandom) {
  return prf(preMasterSecret, 'master secret', Buffer.concat([clientRandom, serverRandom]), 48);
}

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

export function deriveVerifyData(masterSecret, label, handshakeHash) {
  return prf(masterSecret, label, handshakeHash, 12);
}
