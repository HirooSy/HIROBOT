import { createECDH, createSign, createVerify } from 'node:crypto';

// ECDHE_ECDSA key exchange, curve secp256r1 (TLS named curve "secp256r1" =
// 0x0017 = 23, aka P-256/prime256v1 — the only curve we support, matching
// what meowcaller's pion/dtls negotiates against these relays). Point format
// on the wire is always uncompressed: 0x04 || X(32) || Y(32) = 65 bytes,
// per RFC 4492 §5.4 / RFC 8422.

export const NAMED_CURVE_SECP256R1 = 23; // TLS NamedCurve enum value

/** One ephemeral ECDHE keypair for this handshake. */
export function generateEcdheKeypair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKeyPoint: ecdh.getPublicKey(), // 65-byte uncompressed point, goes on the wire as-is
    computeSharedSecret: (peerPublicKeyPoint) => ecdh.computeSecret(peerPublicKeyPoint), // pre_master_secret = X coordinate only, per RFC 4492 §5.10
  };
}

/**
 * Builds the ServerKeyExchange.signed_params bytes that get ECDSA-signed:
 * client_random(32) || server_random(32) || curve_type(1)=named_curve(3) ||
 * named_curve(2) || pubkey_len(1) || pubkey_point.
 * (RFC 4492 §5.4 ServerECDHParams, wrapped in the digitally-signed struct
 * whose signed content also prepends the two randoms per RFC 5246 §7.4.3.)
 */
export function buildEcdheSignedParams(clientRandom, serverRandom, publicKeyPoint) {
  return Buffer.concat([
    clientRandom,
    serverRandom,
    Buffer.from([3]), // ECCurveType.named_curve
    Buffer.from([0, NAMED_CURVE_SECP256R1]),
    Buffer.from([publicKeyPoint.length]),
    publicKeyPoint,
  ]);
}

/** Signs signedParams with our DTLS identity private key (ecdsa_secp256r1_sha256, the only sig/hash pair we offer). */
export function signEcdheParams(privateKey, signedParams) {
  const signer = createSign('SHA256');
  signer.update(signedParams);
  signer.end();
  return signer.sign(privateKey); // DER SEQUENCE{r,s}
}

/** Verifies a peer's ServerKeyExchange signature against their certificate's public key. */
export function verifyEcdheParams(peerPublicKey, signedParams, signature) {
  const verifier = createVerify('SHA256');
  verifier.update(signedParams);
  verifier.end();
  return verifier.verify(peerPublicKey, signature);
}
