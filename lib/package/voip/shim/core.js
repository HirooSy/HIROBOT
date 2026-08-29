import { randomBytes } from 'node:crypto';
const noop = () => { };
export function createNoopLogger(level = 'trace') {
    const logger = {
        level,
        trace: noop,
        debug: noop,
        info: noop,
        warn: noop,
        error: noop,
        child: (_bindings, options) => (options?.level ? createNoopLogger(options.level) : logger)
    };
    return logger;
}
const LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4, silent: 5 };
export function createConsoleLogger(level = 'info', bindings = {}) {
    const threshold = LEVELS[level] ?? LEVELS.info;
    const prefix = Object.entries(bindings)
        .map(([k, v]) => `${k}=${v}`)
        .join(' ');
    const line = (lvl, msg, meta) => {
        if (LEVELS[lvl] < threshold)
            return;
        const extra = meta ? ` ${safeJson(meta)}` : '';
        const tag = prefix ? `[voip ${prefix}]` : '[voip]';
        const out = lvl === 'error' || lvl === 'warn' ? console.error : console.log;
        out(`${tag} ${msg}${extra}`);
    };
    return {
        level,
        trace: (msg, meta) => line('trace', msg, meta),
        debug: (msg, meta) => line('debug', msg, meta),
        info: (msg, meta) => line('info', msg, meta),
        warn: (msg, meta) => line('warn', msg, meta),
        error: (msg, meta) => line('error', msg, meta),
        child: (childBindings = {}, options) => createConsoleLogger(options?.level ?? level, { ...bindings, ...childBindings })
    };
}
function safeJson(meta) {
    try {
        return JSON.stringify(meta, (_k, v) => (v instanceof Uint8Array ? `<${v.length} bytes>` : v));
    }
    catch {
        return String(meta);
    }
}
const RANDOM_PAD_MAX_16_MASK = 0x0f;
export function writeRandomPadMax16(message) {
    const padLength = (randomBytes(1)[0] & RANDOM_PAD_MAX_16_MASK) + 1;
    const out = new Uint8Array(message.length + padLength);
    out.set(message, 0);
    out.fill(padLength, message.length);
    return out;
}
export function unpadPkcs7(bytes) {
    if (bytes.length === 0) {
        throw new Error('unpadPkcs7 given empty bytes');
    }
    const padLength = bytes[bytes.length - 1];
    if (padLength > bytes.length) {
        throw new Error(`unpadPkcs7 given ${bytes.length} bytes, but pad is ${padLength}`);
    }
    return bytes.subarray(0, bytes.length - padLength);
}
