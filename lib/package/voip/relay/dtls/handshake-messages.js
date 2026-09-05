import { der, readTlv } from './der.js';

// DTLS 1.2 handshake message BODY encoding/decoding (the 12-byte
// Handshake header itself lives in handshake-framing.js — this file is
// only what comes after it). Wire formats per RFC 5246 §7.4 (TLS base),
// RFC 6347 (DTLS deltas: cookie in ClientHello/HelloVerifyRequest), and
// RFC 4492/8422 (ECDHE_ECDSA ServerKeyExchange/ClientKeyExchange shape).
//
// We only implement what our one negotiation actually needs: a single
// cipher suite offer (TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256), a single
// named curve (secp256r1), a single signature scheme
// (ecdsa_secp256r1_sha256), no compression, no session resumption, no
// renegotiation. Anything outside that narrow path is intentionally not
// parsed — the relay we talk to (mirroring meowcaller's Go/pion reference)
// doesn't need more, and parsing more surface than we act on just adds
// attack surface / bug surface for a peer we don't authenticate anyway.

export const CIPHER_SUITE_ECDHE_ECDSA_AES_128_GCM_SHA256 = 0xc02b;
export const COMPRESSION_METHOD_NULL = 0;
export const SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256 = 0x0403; // RFC 8446 naming, also valid as (hash,sig) pair 0x04,0x03 in TLS 1.2's supported_signature_algorithms
export const EXTENSION_SUPPORTED_GROUPS = 10; // RFC 8422 renamed "elliptic_curves" -> "supported_groups"
export const EXTENSION_SIGNATURE_ALGORITHMS = 13;
export const NAMED_CURVE_SECP256R1 = 23;

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16BE(n, 0); return b; }
function u8LenPrefixed(buf) { return Buffer.concat([Buffer.from([buf.length]), buf]); }
function u16LenPrefixed(buf) { return Buffer.concat([u16(buf.length), buf]); }

/**
 * Builds a ClientHello body.
 * @param {{ clientRandom: Buffer, sessionId?: Buffer, cookie?: Buffer }} params
 *   cookie is empty on the first ClientHello, and echoes the server's cookie
 *   from HelloVerifyRequest on the retry (RFC 6347 §4.2.1).
 */
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
    Buffer.from([0xfe, 0xfd]), // client_version = DTLS 1.2
    clientRandom, // 32 bytes
    u8LenPrefixed(sessionId),
    u8LenPrefixed(cookie),
    cipherSuites,
    compressionMethods,
    extensions,
  ]);
}

/** Parses a HelloVerifyRequest body -> { cookie }. RFC 6347 §4.2.1: server_version(2) + cookie<0..255>. */
export function parseHelloVerifyRequest(body) {
  const cookieLen = body.readUInt8(2);
  const cookie = body.subarray(3, 3 + cookieLen);
  return { cookie };
}

/** Parses a ServerHello body -> { serverRandom, sessionId, cipherSuite, compressionMethod }. */
export function parseServerHello(body) {
  let offset = 2; // skip server_version
  const serverRandom = body.subarray(offset, offset + 32);
  offset += 32;
  const sessionIdLen = body.readUInt8(offset);
  offset += 1 + sessionIdLen;
  const cipherSuite = body.readUInt16BE(offset);
  offset += 2;
  const compressionMethod = body.readUInt8(offset);
  offset += 1;
  // extensions (if present) intentionally unparsed — we don't act on any
  // ServerHello extension for this narrow negotiation.
  return { serverRandom, cipherSuite, compressionMethod };
}

/**
 * Parses a Certificate body (RFC 5246 §7.4.2: a 3-byte-length-prefixed list
 * of 3-byte-length-prefixed DER certs) -> { certificates: Buffer[] }.
 * We only ever use certificates[0] (the leaf) since we don't build/validate
 * a chain — see verifyEcdheParams in ecdhe.js, called against that leaf's
 * public key, and note the relay itself never checks OUR certificate either
 * (insecure-skip-verify on both reference implementations).
 */
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

/** Builds our Certificate message body carrying one DER cert (cert-builder.js's output). */
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

/**
 * Parses a ClientHello body -> { clientRandom, sessionId, cookie, cipherSuites,
 * compressionMethods }. Mirrors buildClientHello's wire format exactly (this
 * file only ever built one before — needed now for the server role, which
 * receives what the client role sends). Extensions are intentionally left
 * unparsed, same stance as parseServerHello: we don't act on any ClientHello
 * extension for this narrow negotiation (we always answer with the one
 * cipher suite/curve we support regardless of what's offered).
 */
export function parseClientHello(body) {
  let offset = 2; // skip client_version
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

/**
 * Builds a HelloVerifyRequest body (RFC 6347 §4.2.1): server_version(2) +
 * cookie<0..255>. Mirrors parseHelloVerifyRequest's format. Not currently
 * used by DtlsServer — RFC 6347 makes the cookie round-trip RECOMMENDED, not
 * mandatory; a compliant DTLS client (which is what the relay is, in the
 * role this plays against) must accept a server skipping straight to
 * ServerHello, so DtlsServer does that instead to keep the state machine
 * smaller. Kept here (like buildServerKeyExchange was kept for the mirror
 * case) in case a relay generation ever turns out to require it.
 */
export function buildHelloVerifyRequest({ cookie }) {
  return Buffer.concat([
    Buffer.from([0xfe, 0xfd]), // server_version = DTLS 1.2
    u8LenPrefixed(cookie),
  ]);
}

/**
 * Builds a ServerHello body. Mirrors parseServerHello's format exactly (no
 * extensions — parseServerHello never looks for any, and RFC 8422/4492
 * ECDHE_ECDSA doesn't require the server to echo supported_groups back).
 */
export function buildServerHello({ serverRandom, sessionId = Buffer.alloc(0), cipherSuite, compressionMethod = COMPRESSION_METHOD_NULL }) {
  return Buffer.concat([
    Buffer.from([0xfe, 0xfd]), // server_version = DTLS 1.2
    serverRandom, // 32 bytes
    u8LenPrefixed(sessionId),
    u16(cipherSuite),
    Buffer.from([compressionMethod]),
  ]);
}

/** ServerHelloDone (RFC 5246 §7.4.5): empty body, just the 12-byte handshake header around it. */
export function buildServerHelloDone() {
  return Buffer.alloc(0);
}

/**
 * Parses a ServerKeyExchange body for ECDHE_ECDSA (RFC 4492 §5.4) ->
 * { curveType, namedCurve, publicKeyPoint, signatureScheme, signature }.
 */
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

/** Builds a ServerKeyExchange body (used only if we ever need to act as the
 * DTLS server side — kept for symmetry/testing; the relay is always the
 * DTLS server in our real call flow, per relay.go's dtls.ClientWithOptions). */
export function buildServerKeyExchange({ publicKeyPoint, signature }) {
  return Buffer.concat([
    Buffer.from([3]), // named_curve
    u16(NAMED_CURVE_SECP256R1),
    u8LenPrefixed(publicKeyPoint),
    u16(SIGNATURE_SCHEME_ECDSA_SECP256R1_SHA256),
    u16LenPrefixed(signature),
  ]);
}

/** ClientKeyExchange for ECDHE (RFC 4492 §5.7): just our public point, u8-length-prefixed. */
export function buildClientKeyExchange(publicKeyPoint) {
  return u8LenPrefixed(publicKeyPoint);
}
export function parseClientKeyExchange(body) {
  const len = body.readUInt8(0);
  return { publicKeyPoint: body.subarray(1, 1 + len) };
}

/** Finished body is just verify_data (RFC 5246 §7.4.9), no extra framing. */
export function buildFinished(verifyData) { return verifyData; }
export function parseFinished(body) { return { verifyData: body }; }

/**
 * Builds a CertificateVerify body (RFC 5246 §7.4.8): signature_scheme(2) +
 * signature<0..2^16-1>. Only sent when the server asked for a client
 * certificate (CertificateRequest) — the signature covers the running
 * handshake hash from ClientHello through our own ClientKeyExchange
 * (Certificate and ClientKeyExchange included, CertificateVerify itself
 * excluded, since it can't sign itself).
 */
export function buildCertificateVerify({ signatureScheme, signature }) {
  return Buffer.concat([u16(signatureScheme), u16LenPrefixed(signature)]);
}
