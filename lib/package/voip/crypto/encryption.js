import { hkdf } from '../shim/crypto.js';
import { TEXT_ENCODER } from '../bytes.js';
import { randomBytes } from './primitives.js';
export function derivePerJidSrtpKey(callKey, deviceJid) {
    const output = hkdf(callKey, null, TEXT_ENCODER.encode(deviceJid), 46);
    return {
        masterKey: output.subarray(0, 16),
        masterSalt: output.subarray(16, 30)
    };
}
export function generateCallKey() {
    return randomBytes(32);
}
