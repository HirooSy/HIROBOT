import { der, readTlv } from './der.js';

export const CIPHER_SUITE_ECDHE_ECDSA_AES_128_GCM_SHA256 = 0xc02b;
export const COMPRESSION_METHOD_NULL = 0;
export const SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256 = 0x0403;
export const EXTENSION_SUPPORTED_GROUPS = 10;
export const EXTENSION_SIGNATURE_ALGORITHMS = 13;
export const NAMED_CURVE_SECP256R1 = 23;

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u8LenPrefixed(buf) { return Buffer.concat([Buffer.from([buf.length]), buf]); }
function u16LenPrefixed(buf) { return Buffer.concat([u16(buf.length), buf]); }

export function buildClientHello({ clientRandom, sessionId = Buffer.alloc(0), cookie = Buffer.alloc(0) }) {
  const cipherSuites = u16LenPrefixed(u16(CIPHER_SUITE_ECDHE_ECDSA_AES_128_GCM_SHA256));
  const compressionMethods = u8LenPrefixed(Buffer.from([COMPRESSION_METHOD_NULL]));

  const supportedGroupsExt = Buffer.concat([
    u16(EXTENSION_SUPPORTED_GROUPS),
    u16LenPrefixed(u16LenPrefixed(u16(NAMED_CURVE_SECP256R1))),
  ]);
  const sigAlgsExt = Buffer.concat([
    u16(EXTENSION_SIGNATURE_ALGORITHMS),
    u16LenPrefixed(u16LenPrefixed(u16(SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256))),
  ]);
  const extensions = u16LenPrefixed(Buffer.concat([supportedGroupsExt, sigAlgsExt]));

  return Buffer.concat([
    Buffer.from([0xfe, 0xfd]),
    clientRandom,
    u8LenPrefixed(sessionId),
    u8LenPrefixed(cookie),
    cipherSuites,
    compressionMethods,
    extensions,
  ]);
}

export function parseHelloVerifyRequest(body) {
  const cookieLen = body.readUInt8(2);
  const cookie = body.subarray(3, 3 + cookieLen);
  return { cookie };
}

export function parseServerHello(body) {
  let offset = 2;
  const serverRandom = body.subarray(offset, offset + 32);
  offset += 32;
  const sessionIdLen = body.readUInt8(offset);
  offset += 1 + sessionIdLen;
  const cipherSuite = body.readUInt16BE(offset);
  offset += 2;
  const compressionMethod = body.readUInt8(offset);
  offset += 1;

  return { serverRandom, cipherSuite, compressionMethod };
}

export function parseCertificate(body) {
  const listLen = (body.readUInt8(0) << 16) | (body.readUInt8(1) << 8) | body.readUInt8(2);
  const certificates = [];
  let offset = 3;
  const end = 3 + listLen;
  while (offset < end) {
    const certLen = (body.readUInt8(offset) << 16) | (body.readUInt8(offset + 1) << 8) | body.readUInt8(offset + 2);
    offset += 3;
    certificates.push(body.subarray(offset, offset + certLen));
    offset += certLen;
  }
  return { certificates };
}

export function buildCertificate(certDer) {
  const oneCert = Buffer.concat([
    Buffer.from([(certDer.length >> 16) & 0xff, (certDer.length >> 8) & 0xff, certDer.length & 0xff]),
    certDer,
  ]);
  const listLen = oneCert.length;
  return Buffer.concat([
    Buffer.from([(listLen >> 16) & 0xff, (listLen >> 8) & 0xff, listLen & 0xff]),
    oneCert,
  ]);
}

export function parseClientHello(body) {
  let offset = 2;
  const clientRandom = body.subarray(offset, offset + 32);
  offset += 32;
  const sessionIdLen = body.readUInt8(offset); offset += 1;
  const sessionId = body.subarray(offset, offset + sessionIdLen); offset += sessionIdLen;
  const cookieLen = body.readUInt8(offset); offset += 1;
  const cookie = body.subarray(offset, offset + cookieLen); offset += cookieLen;
  const cipherSuitesLen = body.readUInt16BE(offset); offset += 2;
  const cipherSuites = [];
  for (let i = 0; i < cipherSuitesLen; i += 2) cipherSuites.push(body.readUInt16BE(offset + i));
  offset += cipherSuitesLen;
  const compressionMethodsLen = body.readUInt8(offset); offset += 1;
  const compressionMethods = Array.from(body.subarray(offset, offset + compressionMethodsLen));
  return { clientRandom, sessionId, cookie, cipherSuites, compressionMethods };
}

export function buildHelloVerifyRequest({ cookie }) {
  return Buffer.concat([
    Buffer.from([0xfe, 0xfd]),
    u8LenPrefixed(cookie),
  ]);
}

export function buildServerHello({ serverRandom, sessionId = Buffer.alloc(0), cipherSuite, compressionMethod = COMPRESSION_METHOD_NULL }) {
  return Buffer.concat([
    Buffer.from([0xfe, 0xfd]),
    serverRandom,
    u8LenPrefixed(sessionId),
    u16(cipherSuite),
    Buffer.from([compressionMethod]),
  ]);
}

export function buildServerHelloDone() {
  return Buffer.alloc(0);
}

export function parseServerKeyExchange(body) {
  let offset = 0;
  const curveType = body.readUInt8(offset); offset += 1;
  const namedCurve = body.readUInt16BE(offset); offset += 2;
  const pointLen = body.readUInt8(offset); offset += 1;
  const publicKeyPoint = body.subarray(offset, offset + pointLen); offset += pointLen;
  const signatureScheme = body.readUInt16BE(offset); offset += 2;
  const sigLen = body.readUInt16BE(offset); offset += 2;
  const signature = body.subarray(offset, offset + sigLen); offset += sigLen;
  return { curveType, namedCurve, publicKeyPoint, signatureScheme, signature };
}

export function buildServerKeyExchange({ publicKeyPoint, signature }) {
  return Buffer.concat([
    Buffer.from([3]),
    u16(NAMED_CURVE_SECP256R1),
    u8LenPrefixed(publicKeyPoint),
    u16(SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256),
    u16LenPrefixed(signature),
  ]);
}

export function buildClientKeyExchange(publicKeyPoint) {
  return u8LenPrefixed(publicKeyPoint);
}
export function parseClientKeyExchange(body) {
  const len = body.readUInt8(0);
  return { publicKeyPoint: body.subarray(1, 1 + len) };
}

export function buildFinished(verifyData) { return verifyData; }
export function parseFinished(body) { return { verifyData: body }; }

export function buildCertificateVerify({ signatureScheme, signature }) {
  return Buffer.concat([u16(signatureScheme), u16LenPrefixed(signature)]);
}
