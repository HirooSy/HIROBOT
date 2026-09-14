import { createCipheriv, createDecipheriv } from 'node:crypto';
import { encodeEpochSeq, DTLS_1_2_VERSION } from './record.js';

const GCM_TAG_LEN = 16;
const GCM_SALT_LEN = 4;
const GCM_EXPLICIT_NONCE_LEN = 8;

export const aes128GcmParams = { keyLen: 16, fixedIvLen: GCM_SALT_LEN };

function buildNonce(salt, epoch, sequenceNumber) {
  const explicitNonce = encodeEpochSeq(epoch, sequenceNumber);
  return Buffer.concat([salt, explicitNonce]);
}

function buildAdditionalData(epoch, sequenceNumber, type, plaintextLength) {
  return Buffer.concat([
    encodeEpochSeq(epoch, sequenceNumber),
    Buffer.from([type]),
    DTLS_1_2_VERSION,
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(plaintextLength, 0); return b; })(),
  ]);
}

export function encryptRecord({ writeKey, salt, epoch, sequenceNumber, type, plaintext }) {
  const nonce = buildNonce(salt, epoch, sequenceNumber);
  const aad = buildAdditionalData(epoch, sequenceNumber, type, plaintext.length);
  const cipher = createCipheriv('aes-128-gcm', writeKey, nonce, { authTagLength: GCM_TAG_LEN });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const explicitNonce = nonce.subarray(GCM_SALT_LEN);
  return Buffer.concat([explicitNonce, ciphertext, tag]);
}

export function decryptRecord({ readKey, salt, epoch, sequenceNumber, type, fragment }) {
  const explicitNonce = fragment.subarray(0, GCM_EXPLICIT_NONCE_LEN);
  const tag = fragment.subarray(fragment.length - GCM_TAG_LEN);
  const ciphertext = fragment.subarray(GCM_EXPLICIT_NONCE_LEN, fragment.length - GCM_TAG_LEN);
  const nonce = Buffer.concat([salt, explicitNonce]);
  const plaintextLength = ciphertext.length;
  const aad = buildAdditionalData(epoch, sequenceNumber, type, plaintextLength);
  const decipher = createDecipheriv('aes-128-gcm', readKey, nonce, { authTagLength: GCM_TAG_LEN });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}
