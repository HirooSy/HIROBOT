import { hkdfSync } from 'node:crypto';
import { toBytesView } from './util.js';
const EMPTY_BYTES = Object.freeze(new Uint8Array(0));
export function hkdf(ikm, salt, info, outLength) {
    return toBytesView(hkdfSync('sha256', ikm, salt ?? EMPTY_BYTES, info, outLength));
}
