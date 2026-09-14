import { createECDH, createSign, createVerify } from 'node:crypto';

export const NAMED_CURVE_SECP256R1 = 23;

export function generateEcdheKeypair() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    publicKeyPoint: ecdh.getPublicKey(),
    computeSharedSecret: (peerPublicKeyPoint) => ecdh.computeSecret(peerPublicKeyPoint),
  };
}

export function buildEcdheSignedParams(clientRandom, serverRandom, publicKeyPoint) {
  return Buffer.concat([
    clientRandom,
    serverRandom,
    Buffer.from([3]),
    Buffer.from([0, NAMED_CURVE_SECP256R1]),
    Buffer.from([publicKeyPoint.length]),
    publicKeyPoint,
  ]);
}

export function signEcdheParams(privateKey, signedParams) {
  const signer = createSign('SHA256');
  signer.update(signedParams);
  signer.end();
  return signer.sign(privateKey);
}

export function verifyEcdheParams(peerPublicKey, signedParams, signature) {
  const verifier = createVerify('SHA256');
  verifier.update(signedParams);
  verifier.end();
  return verifier.verify(peerPublicKey, signature);
}
