import { createCipheriv, createDecipheriv } from 'node:crypto';
import { encodeEpochSeq, DTLS_1_2_VERSION } from './record.js';

// AES-128-GCM record protection for DTLS 1.2, per RFC 5288 (TLS_..._AES_128_GCM_SHA256)
// and RFC 6347 §4.1.2.1/§4.3 for how DTLS adapts the additional data.
//
// GCMNonce = salt(4 bytes, "implicit", = client_write_IV or server_write_IV
//            from the key block) || nonce_explicit(8 bytes)
// We use epoch||sequence_number as nonce_explicit, which RFC 5288 §3
// explicitly allows ("The nonce_explicit MAY be the 64-bit sequence
// number") and which meowcaller's pion/dtls dependency also does — this
// means the 8-byte epoch+seq already in every DTLS record header doubles as
// the GCM nonce_explicit, so nothing extra needs to go on the wire.
//
// additional_data = epoch(2) || seq(6) || type(1) || version(2) || length(2)
// (TLS 1.2's "seq_num || TLSCompressed.type || .version || .length", RFC
// 5246 §6.2.3.3, with seq_num widened to include the DTLS epoch per RFC
// 6347 §4.1.2.1)

const GCM_TAG_LEN = 16;
const GCM_SALT_LEN = 4; // "fixed_iv_length" for AEAD_AES_128_GCM, RFC 5288 §3
const GCM_EXPLICIT_NONCE_LEN = 8;

export const aes128GcmParams = { keyLen: 16, fixedIvLen: GCM_SALT_LEN };

function buildNonce(salt, epoch, sequenceNumber) {
  const explicitNonce = encodeEpochSeq(epoch, sequenceNumber); // 8 bytes, doubles as nonce_explicit
  return Buffer.concat([salt, explicitNonce]); // 4 + 8 = 12 bytes, GCM's required nonce length
}

function buildAdditionalData(epoch, sequenceNumber, type, plaintextLength) {
  return Buffer.concat([
    encodeEpochSeq(epoch, sequenceNumber),
    Buffer.from([type]),
    DTLS_1_2_VERSION,
    (() => { const b = Buffer.alloc(2); b.writeUInt16BE(plaintextLength, 0); return b; })(),
  ]);
}

/**
 * Encrypts one record's plaintext fragment.
 * @returns {Buffer} nonce_explicit(8) || ciphertext || tag(16) — this whole
 *   thing is the DTLSCiphertext.fragment that goes after the record header.
 */
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

/**
 * Decrypts one record's ciphertext fragment (as produced by encryptRecord,
 * or received from the peer in the same format).
 * @throws if the authentication tag doesn't verify (tampered/corrupt/wrong key)
 */
export function decryptRecord({ readKey, salt, epoch, sequenceNumber, type, fragment }) {
  const explicitNonce = fragment.subarray(0, GCM_EXPLICIT_NONCE_LEN);
  const tag = fragment.subarray(fragment.length - GCM_TAG_LEN);
  const ciphertext = fragment.subarray(GCM_EXPLICIT_NONCE_LEN, fragment.length - GCM_TAG_LEN);
  const nonce = Buffer.concat([salt, explicitNonce]);
  const plaintextLength = ciphertext.length; // AAD covers the *plaintext* length, which equals ciphertext length for GCM (no padding)
  const aad = buildAdditionalData(epoch, sequenceNumber, type, plaintextLength);
  const decipher = createDecipheriv('aes-128-gcm', readKey, nonce, { authTagLength: GCM_TAG_LEN });
  decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]); // throws on tag mismatch
}
