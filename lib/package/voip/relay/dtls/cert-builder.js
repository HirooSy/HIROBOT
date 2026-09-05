import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { der } from './der.js';

// Builds a throwaway self-signed X.509v3 EC (P-256) certificate, purely to
// satisfy the DTLS Certificate handshake message's DER framing requirement.
// The relay never validates it (see relay.go: dtls.WithInsecureSkipVerify(true)
// — meowcaller's Go reference does the exact same thing with pion/dtls), so
// there's no CA, no chain, no real identity: just syntactically valid DER
// wrapping a keypair we generate fresh per call.

const EC_PUBLIC_KEY_OID = '1.2.840.10045.2.1';
const PRIME256V1_OID = '1.2.840.10045.3.1.7';
const ECDSA_WITH_SHA256_OID = '1.2.840.10045.4.3.2';
const COMMON_NAME_OID = '2.5.4.3';

function rdnSequence(commonName) {
  return der.sequence(
    der.set(
      der.sequence(
        der.objectIdentifier(COMMON_NAME_OID),
        der.utf8String(commonName),
      ),
    ),
  );
}

function algorithmIdentifierEcdsaSha256() {
  return der.sequence(der.objectIdentifier(ECDSA_WITH_SHA256_OID));
}

function subjectPublicKeyInfo(spkiDer) {
  // Node already emits a fully-formed SPKI SEQUENCE for an EC public key
  // (AlgorithmIdentifier{id-ecPublicKey, prime256v1} + BIT STRING point) —
  // no need to rebuild it by hand, just pass it through.
  return spkiDer;
}

/** DER-encodes an ECDSA signature (r, s) — Node returns SEQUENCE{INTEGER r, INTEGER s} already, so this is a passthrough kept for documentation. */
function ecdsaSignatureFromNode(sig) {
  return sig; // Node's sign() with 'ec' keys already returns DER SEQUENCE{r,s} in default (non-ieee-p1363) format
}

/**
 * @returns {{ certDer: Buffer, privateKey: import('crypto').KeyObject, publicKeyPoint: Buffer }}
 *   publicKeyPoint is the raw uncompressed EC point (0x04||X||Y, 65 bytes for
 *   P-256) — what ServerKeyExchange/ClientKeyExchange need on the wire, as
 *   opposed to the DER-wrapped SPKI form used inside the certificate.
 */
export function generateSelfSignedCert(commonName = 'wa-voip') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });

  const serialNumber = randomBytes(16); // DER INTEGER handles arbitrary-length bytes
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000); // yesterday, clock-skew slack
  const notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000); // tomorrow — this cert lives one call

  const tbsCertificate = der.sequence(
    der.contextConstructed(0, der.integer(2)), // version [0] EXPLICIT INTEGER v3(2)
    der.integer(serialNumber),
    algorithmIdentifierEcdsaSha256(), // signature algorithm (in TBS)
    rdnSequence(commonName), // issuer == subject (self-signed)
    der.sequence(der.utcTime(notBefore), der.utcTime(notAfter)), // validity
    rdnSequence(commonName), // subject
    subjectPublicKeyInfo(spkiDer),
    // no extensions — the relay doesn't parse them, and the DTLS Certificate
    // message just needs a well-formed X.509, not a browser-grade one
  );

  const signer = createSign('SHA256');
  signer.update(tbsCertificate);
  signer.end();
  const signature = ecdsaSignatureFromNode(signer.sign(privateKey));

  const certDer = der.sequence(
    tbsCertificate,
    algorithmIdentifierEcdsaSha256(), // signatureAlgorithm (outer, must match TBS)
    der.bitString(signature),
  );

  // Raw point for ECDHE key-exchange messages: SPKI BIT STRING content is
  // `0x00` (unused-bits count) followed by the point itself.
  const spkiParsed = spkiOuterBitStringContent(spkiDer);
  const publicKeyPoint = spkiParsed.subarray(1); // drop the unused-bits byte

  return { certDer, privateKey, publicKeyPoint };
}

/** Extracts the raw BIT STRING content (including its leading unused-bits
 * byte) from an SPKI DER blob — i.e. digs past SEQUENCE{AlgorithmIdentifier,
 * BIT STRING} to the BIT STRING's own content bytes. */
function spkiOuterBitStringContent(spkiDer) {
  // SPKI ::= SEQUENCE { AlgorithmIdentifier, BIT STRING }
  // Walk it with the same minimal reader used for self-checks in der.js.
  let offset = 0;
  const tag = spkiDer.readUInt8(offset);
  if (tag !== 0x30) throw new Error('generateSelfSignedCert: unexpected SPKI outer tag');
  // skip outer SEQUENCE header
  offset = skipTlvHeader(spkiDer, offset).next === undefined ? offset : offset;
  const outer = readOneTlv(spkiDer, 0);
  // outer.content is [AlgorithmIdentifier SEQUENCE][BIT STRING]
  const algId = readOneTlv(outer.content, 0);
  const bitString = readOneTlv(outer.content, algId.next);
  if (bitString.tag !== 0x03) throw new Error('generateSelfSignedCert: expected BIT STRING after AlgorithmIdentifier');
  return bitString.content;
}

function skipTlvHeader(buf, offset) {
  return readOneTlv(buf, offset);
}

function readOneTlv(buf, offset) {
  const tag = buf.readUInt8(offset);
  let lenByte = buf.readUInt8(offset + 1);
  let lenStart = offset + 2;
  let length;
  if (lenByte & 0x80) {
    const numBytes = lenByte & 0x7f;
    length = 0;
    for (let i = 0; i < numBytes; i++) length = (length << 8) | buf.readUInt8(lenStart + i);
    lenStart += numBytes;
  } else {
    length = lenByte;
  }
  return { tag, content: buf.subarray(lenStart, lenStart + length), next: lenStart + length };
}
