import { timingSafeEqual } from 'node:crypto';
export const TEXT_ENCODER = new TextEncoder();
export const TEXT_DECODER = new TextDecoder();
export const EMPTY_BYTES = Object.freeze(new Uint8Array(0));
export function concatBytes(parts) {
    let total = 0;
    for (let i = 0; i < parts.length; i += 1) {
        total += parts[i].length;
    }
    const out = new Uint8Array(total);
    let offset = 0;
    for (let i = 0; i < parts.length; i += 1) {
        out.set(parts[i], offset);
        offset += parts[i].length;
    }
    return out;
}
const HEX_CHARS = '0123456789abcdef';
const HEX_TABLE = (() => {
    const table = new Array(256);
    for (let i = 0; i < 256; i += 1) {
        table[i] = HEX_CHARS[i >> 4] + HEX_CHARS[i & 0x0f];
    }
    return table;
})();
const HEX_LOOKUP = (() => {
    const table = new Int8Array(128).fill(-1);
    for (let i = 0x30; i <= 0x39; i += 1)
        table[i] = i - 0x30;
    for (let i = 0x41; i <= 0x46; i += 1)
        table[i] = i - 0x41 + 10;
    for (let i = 0x61; i <= 0x66; i += 1)
        table[i] = i - 0x61 + 10;
    return table;
})();
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_LOOKUP = (() => {
    const table = new Uint8Array(128).fill(0xff);
    for (let i = 0; i < BASE64_CHARS.length; i += 1) {
        table[BASE64_CHARS.charCodeAt(i)] = i;
    }
    table[0x3d] = 0;
    return table;
})();
export function bytesToHex(value) {
    let out = '';
    for (let i = 0; i < value.length; i += 1) {
        out += HEX_TABLE[value[i]];
    }
    return out;
}
export function hexToBytes(value) {
    const len = value.length;
    if (len & 1) {
        throw new Error('hex string must have even length');
    }
    const out = new Uint8Array(len >> 1);
    for (let i = 0; i < len; i += 2) {
        const hiCode = value.charCodeAt(i);
        const loCode = value.charCodeAt(i + 1);
        const hi = hiCode < 128 ? HEX_LOOKUP[hiCode] : -1;
        const lo = loCode < 128 ? HEX_LOOKUP[loCode] : -1;
        if ((hi | lo) < 0) {
            throw new Error('invalid hex character');
        }
        out[i >> 1] = (hi << 4) | lo;
    }
    return out;
}
function lookupBase64(code) {
    if (code > 127) {
        throw new Error('invalid base64 character');
    }
    const v = BASE64_LOOKUP[code];
    if (v === 0xff) {
        throw new Error('invalid base64 character');
    }
    return v;
}
function encodeBase64(value, alphabet, pad) {
    const len = value.length;
    if (len === 0)
        return '';
    const remainder = len % 3;
    const mainLen = len - remainder;
    const chunks = Math.ceil(len / 3);
    const out = new Array(pad ? chunks * 4 : Math.ceil((len * 4) / 3));
    let k = 0;
    for (let i = 0; i < mainLen; i += 3) {
        const a = value[i];
        const b = value[i + 1];
        const c = value[i + 2];
        out[k++] = alphabet[a >> 2];
        out[k++] = alphabet[((a & 0x03) << 4) | (b >> 4)];
        out[k++] = alphabet[((b & 0x0f) << 2) | (c >> 6)];
        out[k++] = alphabet[c & 0x3f];
    }
    if (remainder === 1) {
        const a = value[mainLen];
        out[k++] = alphabet[a >> 2];
        out[k++] = alphabet[(a & 0x03) << 4];
        if (pad) {
            out[k++] = '=';
            out[k++] = '=';
        }
    }
    else if (remainder === 2) {
        const a = value[mainLen];
        const b = value[mainLen + 1];
        out[k++] = alphabet[a >> 2];
        out[k++] = alphabet[((a & 0x03) << 4) | (b >> 4)];
        out[k++] = alphabet[(b & 0x0f) << 2];
        if (pad) {
            out[k++] = '=';
        }
    }
    return out.join('');
}
export function bytesToBase64(value) {
    return encodeBase64(value, BASE64_CHARS, true);
}
export function base64ToBytes(value) {
    const len = value.length;
    if (len === 0)
        return EMPTY_BYTES;
    if ((len & 3) !== 0) {
        throw new Error('base64 string length must be multiple of 4');
    }
    let padding = 0;
    if (value.charCodeAt(len - 1) === 0x3d)
        padding += 1;
    if (value.charCodeAt(len - 2) === 0x3d)
        padding += 1;
    const outLen = ((len * 3) >> 2) - padding;
    const out = new Uint8Array(outLen);
    let j = 0;
    const mainLen = len - 4;
    let i = 0;
    for (; i < mainLen; i += 4) {
        const a = lookupBase64(value.charCodeAt(i));
        const b = lookupBase64(value.charCodeAt(i + 1));
        const c = lookupBase64(value.charCodeAt(i + 2));
        const d = lookupBase64(value.charCodeAt(i + 3));
        out[j++] = (a << 2) | (b >> 4);
        out[j++] = ((b & 0x0f) << 4) | (c >> 2);
        out[j++] = ((c & 0x03) << 6) | d;
    }
    const a = lookupBase64(value.charCodeAt(i));
    const b = lookupBase64(value.charCodeAt(i + 1));
    out[j++] = (a << 2) | (b >> 4);
    if (j < outLen) {
        const c = lookupBase64(value.charCodeAt(i + 2));
        out[j++] = ((b & 0x0f) << 4) | (c >> 2);
        if (j < outLen) {
            const d = lookupBase64(value.charCodeAt(i + 3));
            out[j++] = ((c & 0x03) << 6) | d;
        }
    }
    return out;
}
export function toBytesView(value) {
    if (value instanceof Uint8Array) {
        return value.constructor === Uint8Array
            ? value
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    }
    if (value instanceof ArrayBuffer) {
        return new Uint8Array(value);
    }
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
}
export function uint8TimingSafeEqual(left, right) {
    if (left.byteLength !== right.byteLength) {
        return false;
    }
    return timingSafeEqual(left, right);
}
export function toError(value) {
    if (value instanceof Error)
        return value;
    if (typeof value === 'string')
        return new Error(value);
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
        return new Error(String(value));
    }
    if (value && typeof value === 'object') {
        const message = value.message;
        if (typeof message === 'string' && message.length > 0) {
            return new Error(message);
        }
        const code = value.code;
        if (typeof code === 'string' || typeof code === 'number') {
            return new Error(`unknown error (${code})`);
        }
    }
    return new Error('unknown error');
}
function resolveOptionalPositive(value, name) {
    if (value === undefined)
        return undefined;
    if (Number.isSafeInteger(value) && value > 0)
        return value;
    throw new Error(`${name} must be a positive safe integer`);
}
export function resolvePositive(value, fallback, name) {
    return resolveOptionalPositive(value, name) ?? fallback;
}
