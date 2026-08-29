export const WA_DEFAULTS = Object.freeze({
    HOST_DOMAIN: 's.whatsapp.net',
    GROUP_SERVER: 'g.us',
    BROADCAST_SERVER: 'broadcast',
    LID_SERVER: 'lid',
    HOSTED_SERVER: 'hosted',
    HOSTED_LID_SERVER: 'hosted.lid',
    HOSTED_DEVICE_ID: 99,
    MSGR_SERVER: 'msgr',
    INTEROP_SERVER: 'interop',
    NEWSLETTER_SERVER: 'newsletter',
    BOT_SERVER: 'bot',
    STATUS_BROADCAST_JID: 'status@broadcast'
});
export const WA_MESSAGE_TAGS = Object.freeze({
    MESSAGE: 'message',
    ENC: 'enc',
    RECEIPT: 'receipt',
    ACK: 'ack',
    ERROR: 'error'
});
const KNOWN_SERVERS = [
    WA_DEFAULTS.LID_SERVER,
    WA_DEFAULTS.HOST_DOMAIN,
    WA_DEFAULTS.GROUP_SERVER,
    WA_DEFAULTS.BROADCAST_SERVER,
    WA_DEFAULTS.NEWSLETTER_SERVER,
    WA_DEFAULTS.HOSTED_SERVER,
    WA_DEFAULTS.HOSTED_LID_SERVER,
    WA_DEFAULTS.BOT_SERVER,
    WA_DEFAULTS.MSGR_SERVER,
    WA_DEFAULTS.INTEROP_SERVER
];
function internServerAt(jid, from) {
    const length = jid.length - from;
    for (let index = 0; index < KNOWN_SERVERS.length; index += 1) {
        const server = KNOWN_SERVERS[index];
        if (server.length === length && jid.startsWith(server, from))
            return server;
    }
    return jid.slice(from);
}
function findAtIndex(jid) {
    const atIndex = jid.indexOf('@');
    if (atIndex < 1 || atIndex >= jid.length - 1)
        throw new Error(`invalid jid: ${jid}`);
    return atIndex;
}
function isJidType(jid, type) {
    const atIndex = jid.length - type.length - 1;
    if (atIndex < 1 || jid.charCodeAt(atIndex) !== 64 || !jid.endsWith(type))
        return false;
    for (let i = 0; i < atIndex; i += 1) {
        if (jid.charCodeAt(i) === 64)
            return false;
    }
    return true;
}
export function isLidJid(jid) {
    return isJidType(jid, WA_DEFAULTS.LID_SERVER);
}
export function isUserJid(jid) {
    return isJidType(jid, WA_DEFAULTS.HOST_DOMAIN);
}
export function isGroupJid(jid) {
    return isJidType(jid, WA_DEFAULTS.GROUP_SERVER);
}
export function parseSignalAddressFromJid(jid) {
    const atIndex = findAtIndex(jid);
    const colonIndex = jid.indexOf(':', 0);
    const server = internServerAt(jid, atIndex + 1);
    if (colonIndex === -1 || colonIndex > atIndex) {
        return { user: jid.slice(0, atIndex), server, device: 0 };
    }
    if (colonIndex >= atIndex - 1)
        throw new Error(`invalid jid device: ${jid}`);
    let device = 0;
    for (let i = colonIndex + 1; i < atIndex; i += 1) {
        const digit = jid.charCodeAt(i) - 48;
        if (digit < 0 || digit > 9)
            throw new Error(`invalid jid device: ${jid}`);
        device = device * 10 + digit;
        if (device > Number.MAX_SAFE_INTEGER)
            throw new Error(`invalid jid device: ${jid}`);
    }
    return { user: jid.slice(0, colonIndex), server, device };
}
function isHostedServerAt(jid, from) {
    const length = jid.length - from;
    if (length === WA_DEFAULTS.HOSTED_SERVER.length) {
        return jid.startsWith(WA_DEFAULTS.HOSTED_SERVER, from);
    }
    if (length === WA_DEFAULTS.HOSTED_LID_SERVER.length) {
        return jid.startsWith(WA_DEFAULTS.HOSTED_LID_SERVER, from);
    }
    return false;
}
function canonicalizeSignalServer(server, hostDomain = WA_DEFAULTS.HOST_DOMAIN) {
    if (server === WA_DEFAULTS.HOSTED_SERVER)
        return hostDomain;
    if (server === WA_DEFAULTS.HOSTED_LID_SERVER)
        return WA_DEFAULTS.LID_SERVER;
    return server;
}
export function toUserJid(jid, options = {}) {
    const canonicalize = options.canonicalizeSignalServer === true;
    const atIndex = jid.indexOf('@');
    if (atIndex >= 1 && atIndex < jid.length - 1) {
        const colonIndex = jid.indexOf(':', 0);
        if ((colonIndex === -1 || colonIndex > atIndex) &&
            (!canonicalize || !isHostedServerAt(jid, atIndex + 1))) {
            return jid;
        }
    }
    const address = parseSignalAddressFromJid(jid);
    const baseServer = address.server ?? WA_DEFAULTS.HOST_DOMAIN;
    const server = canonicalize
        ? canonicalizeSignalServer(baseServer, options.hostDomain ?? WA_DEFAULTS.HOST_DOMAIN)
        : baseServer;
    if (server === baseServer && jid.length === address.user.length + 1 + server.length) {
        return jid;
    }
    return `${address.user}@${server}`;
}
export function normalizeDeviceJid(jid) {
    const address = parseSignalAddressFromJid(jid);
    if (address.device === 0)
        return `${address.user}@${address.server}`;
    return `${address.user}:${address.device}@${address.server}`;
}
