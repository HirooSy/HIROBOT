import { parseSignalAddressFromJid } from './shim/protocol.js';
const SESSION_CACHE_TTL_MS = 5 * 60 * 1000;
const TC_TOKEN_REQUEST_TIMEOUT_MS = 3500;
let cachedBaileysHelpers = null;
async function loadBaileysHelpers() {
    if (cachedBaileysHelpers)
        return cachedBaileysHelpers;
    const mod = await import('baileys');
    cachedBaileysHelpers = {
        jidDecode: mod.jidDecode,
        jidEncode: mod.jidEncode,
        parseAndInjectE2ESessions: mod.parseAndInjectE2ESessions,
        encodeSignedDeviceIdentity: mod.encodeSignedDeviceIdentity,
        getBinaryNodeChild: mod.getBinaryNodeChild,
        getAllBinaryNodeChildren: mod.getAllBinaryNodeChildren
    };
    return cachedBaileysHelpers;
}
function addressToJid(address) {
    return address.device
        ? `${address.user}:${address.device}@${address.server}`
        : `${address.user}@${address.server}`;
}
function normalizeDeviceList(baileysHelpers, jids) {
    const { jidDecode, jidEncode } = baileysHelpers;
    const result = new Set();
    for (const jid of jids) {
        const decoded = jidDecode(jid);
        if (!decoded?.user) {
            result.add(jid);
            continue;
        }
        const server = String(jid).endsWith('@lid') ? 'lid' : 's.whatsapp.net';
        result.add(jidEncode(decoded.user, server));
        if (decoded.device != null)
            result.add(`${decoded.user}:${decoded.device}@${server}`);
    }
    return [...result].slice(0, 5);
}
async function resolvePeerLid(sock, target) {
    const raw = String(target || '').trim();
    if (!raw)
        throw new Error('resolvePeerLid: target is required');
    if (raw.endsWith('@lid'))
        return raw;
    const pnJid = raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
    const lid = await sock.signalRepository.lidMapping?.getLIDForPN(pnJid);
    if (lid)
        return lid;
    return pnJid;
}
async function discoverPeerDevices(sock, baileysHelpers, peerLid) {
    const devices = await sock.getUSyncDevices([peerLid], true, false);
    const jids = devices.map((d) => d.jid).filter(Boolean);
    if (!jids.length)
        return [];
    return normalizeDeviceList(baileysHelpers, jids);
}
async function ensureSignalSessions(sock, baileysHelpers, jids, cache) {
    const missing = [];
    for (const jid of [...new Set(jids.filter(Boolean))]) {
        const signalId = sock.signalRepository.jidToSignalProtocolAddress(jid);
        const cachedAt = cache.get(signalId);
        if (cachedAt && Date.now() - cachedAt < SESSION_CACHE_TTL_MS)
            continue;
        const validation = await sock.signalRepository.validateSession(jid);
        if (validation?.exists) {
            cache.set(signalId, Date.now());
            continue;
        }
        missing.push(jid);
    }
    if (!missing.length)
        return;
    const sessionNode = await sock.query({
        tag: 'iq',
        attrs: { xmlns: 'encrypt', type: 'get', to: 's.whatsapp.net' },
        content: [
            { tag: 'key', attrs: {}, content: missing.map((jid) => ({ tag: 'user', attrs: { jid } })) }
        ]
    });
    await baileysHelpers.parseAndInjectE2ESessions(sessionNode, sock.signalRepository);
    for (const jid of missing) {
        cache.set(sock.signalRepository.jidToSignalProtocolAddress(jid), Date.now());
    }
}
function toBareJid(jid) {
    const at = String(jid).indexOf('@');
    if (at < 0)
        return jid;
    const user = String(jid).slice(0, at).split(':')[0];
    return `${user}@${String(jid).slice(at + 1)}`;
}
async function issueTcToken(sock, baileysHelpers, jid) {
    const userJid = toBareJid(jid);
    const issuedAt = Math.floor(Date.now() / 1000);
    try {
        const response = await sock.query({
            tag: 'iq',
            attrs: { to: 's.whatsapp.net', type: 'set', xmlns: 'privacy', id: sock.generateMessageTag() },
            content: [
                {
                    tag: 'tokens',
                    attrs: {},
                    content: [{ tag: 'token', attrs: { jid: userJid, t: String(issuedAt), type: 'trusted_contact' } }]
                }
            ]
        });
        const { getBinaryNodeChild, getAllBinaryNodeChildren } = baileysHelpers;
        const tokensNode = getBinaryNodeChild(response, 'tokens');
        const tokenNodes = tokensNode ? getAllBinaryNodeChildren(tokensNode).filter((c) => c.tag === 'token') : [];
        for (const tokenNode of tokenNodes) {
            if (tokenNode.attrs.type !== 'trusted_contact')
                continue;
            const content = tokenNode.content;
            if (content instanceof Uint8Array && content.length > 0) {
                await sock.authState.keys.set({
                    tctoken: { [userJid]: { token: Buffer.from(content), timestamp: String(tokenNode.attrs.t ?? issuedAt) } }
                });
                return Buffer.from(content);
            }
        }
        return undefined;
    }
    catch {
        return undefined;
    }
}
async function getCachedTcToken(sock, jid) {
    try {
        const result = await sock.authState.keys.get('tctoken', [jid]);
        const cached = result?.[jid];
        return cached?.token?.length ? Buffer.from(cached.token) : undefined;
    }
    catch {
        return undefined;
    }
}
async function ensureTcToken(sock, baileysHelpers, jid) {
    const bare = toBareJid(jid);
    const cached = await getCachedTcToken(sock, bare);
    if (cached?.length)
        return cached;
    return Promise.race([
        issueTcToken(sock, baileysHelpers, bare),
        new Promise((resolve) => setTimeout(() => resolve(undefined), TC_TOKEN_REQUEST_TIMEOUT_MS))
    ]);
}
export async function createVoipDeps(sock) {
    const baileysHelpers = await loadBaileysHelpers();
    const sessionCache = new Map();
    const deps = {
        authClient: {
            getCurrentCredentials() {
                const creds = sock.authState?.creds;
                const account = creds?.account;
                let signedIdentity;
                if (account) {
                    try {
                        signedIdentity = baileysHelpers.encodeSignedDeviceIdentity(account, true);
                    }
                    catch {
                        signedIdentity = undefined;
                    }
                }
                return {
                    meLid: creds?.me?.lid,
                    meJid: creds?.me?.id,
                    signedIdentity
                };
            }
        },
        lowLevelCoordinator: {
            async sendNode(node) {
                await sock.sendNode(node);
            }
        },
        signalDeviceSync: {
            async syncDeviceList(jids) {
                const out = [];
                for (const jid of jids) {
                    try {
                        const peerLid = await resolvePeerLid(sock, jid);
                        const deviceJids = await discoverPeerDevices(sock, baileysHelpers, peerLid);
                        out.push({ deviceJids });
                    }
                    catch {
                        out.push({ deviceJids: [] });
                    }
                }
                return out;
            },
            async queryLidsByPhoneJids(jids) {
                const out = [];
                for (const jid of jids) {
                    try {
                        out.push({ lidJid: await resolvePeerLid(sock, jid) });
                    }
                    catch {
                        out.push({ lidJid: undefined });
                    }
                }
                return out;
            }
        },
        sessionResolver: {
            async ensureSessionsBatch(devices) {
                await ensureSignalSessions(sock, baileysHelpers, devices, sessionCache);
                return devices.map((jid) => ({ address: parseSignalAddressFromJid(jid), session: null }));
            }
        },
        signalProtocol: {
            async encryptMessage(address, plaintext) {
                const jid = addressToJid(address);
                const { type, ciphertext } = await sock.signalRepository.encryptMessage({
                    jid,
                    data: Buffer.from(plaintext)
                });
                return { type, ciphertext: new Uint8Array(ciphertext) };
            },
            async decryptMessage(address, { type, ciphertext }) {
                const jid = addressToJid(address);
                const decrypted = await sock.signalRepository.decryptMessage({ jid, type, ciphertext });
                return new Uint8Array(decrypted);
            }
        },
        messageDispatch: {
            async syncSignalSession(jid) {
                await ensureSignalSessions(sock, baileysHelpers, [jid], sessionCache);
            }
        }
    };
    const stores = {
        privacyToken: {
            async getByJid(jid) {
                const token = await ensureTcToken(sock, baileysHelpers, jid);
                return token?.length ? { tcToken: token } : undefined;
            }
        }
    };
    return { deps, stores };
}
