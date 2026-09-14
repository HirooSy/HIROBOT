import { generateKeyPairSync, createSign, randomBytes } from 'node:crypto';
import { der } from './der.js';

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

  return spkiDer;
}

function ecdsaSignatureFromNode(sig) {
  return sig;
}

export function generateSelfSignedCert(commonName = 'wa-voip') {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const spkiDer = publicKey.export({ format: 'der', type: 'spki' });

  const serialNumber = randomBytes(16);
  const notBefore = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);

  const tbsCertificate = der.sequence(
    der.contextConstructed(0, der.integer(2)),
    der.integer(serialNumber),
    algorithmIdentifierEcdsaSha256(),
    rdnSequence(commonName),
    der.sequence(der.utcTime(notBefore), der.utcTime(notAfter)),
    rdnSequence(commonName),
    subjectPublicKeyInfo(spkiDer),

  );

  const signer = createSign('SHA256');
  signer.update(tbsCertificate);
  signer.end();
  const signature = ecdsaSignatureFromNode(signer.sign(privateKey));

  const certDer = der.sequence(
    tbsCertificate,
    algorithmIdentifierEcdsaSha256(),
    der.bitString(signature),
  );

  const spkiParsed = spkiOuterBitStringContent(spkiDer);
  const publicKeyPoint = spkiParsed.subarray(1);

  return { certDer, privateKey, publicKeyPoint };
}

function spkiOuterBitStringContent(spkiDer) {

  let offset = 0;
  const tag = spkiDer.readUInt8(offset);
  if (tag !== 0x30) throw new Error('generateSelfSignedCert: unexpected SPKI outer tag');

  offset = skipTlvHeader(spkiDer, offset).next === undefined ? offset : offset;
  const outer = readOneTlv(spkiDer, 0);

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
