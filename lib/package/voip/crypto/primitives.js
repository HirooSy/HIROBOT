import { createCipheriv, createHmac, randomBytes as nodeRandomBytes, randomInt as nodeRandomInt } from 'node:crypto';
import { toBytesView } from '../shim/util.js';
export function randomBytes(length) {
    return toBytesView(nodeRandomBytes(length));
}
export function randomInt(min, max) {
    return nodeRandomInt(min, max);
}
export function hmacSha1(key, ...parts) {
    const hmac = createHmac('sha1', key);
    for (const part of parts) {
        hmac.update(part);
    }
    return toBytesView(hmac.digest());
}
export function aesCtr128(key, iv, data) {
    const cipher = createCipheriv('aes-128-ctr', key, iv);
    const output = toBytesView(cipher.update(data));
    cipher.final();
    return output;
}
