import { createNoopLogger, unpadPkcs7, writeRandomPadMax16 } from '../shim/core.js';
import { proto } from '../shim/proto.js';
import { parseSignalAddressFromJid, toUserJid } from '../shim/protocol.js';
import { buildReceiptNode, findNodeChild, getFirstNodeChild, getNodeChildren, getNodeChildrenByTag } from '../shim/transport.js';
import { bytesToHex, toError } from '../shim/util.js';
import { randomBytes } from '../crypto/primitives.js';
export async function encodeWAMessage(message) {
    return writeRandomPadMax16(proto.Message.encode(message).finish());
}
export function generateCallId() {
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
        bytes[i] = Math.floor(Math.random() * 256);
    }
    return bytesToHex(bytes).toUpperCase();
}
export function generateCallStanzaId() {
    return bytesToHex(randomBytes(16)).toUpperCase();
}
export function extractNodeInfo(node) {
    const innerNode = getFirstNodeChild(node);
    if (!innerNode) {
        return null;
    }
    return {
        tag: innerNode.tag,
        peerJid: node.attrs.from,
        callId: innerNode.attrs?.['call-id'] || '',
        peerPlatform: node.attrs.platform || '',
        peerAppVersion: node.attrs.version || '',
        epochId: innerNode.attrs?.e,
        timestamp: innerNode.attrs?.t,
        innerNode
    };
}
function toRelayEndpoint(node) {
    const relay = {
        ip: node.attrs?.ip || '',
        port: parseInt(node.attrs?.port || '3480', 10),
        token: node.attrs?.token || '',
        key: node.attrs?.['relay-key'] || node.attrs?.key || '',
        relayId: parseInt(node.attrs?.['relay-id'] || '0', 10),
        c2rRtt: node.attrs?.['c2r-rtt'] ? parseInt(node.attrs['c2r-rtt'], 10) : undefined
    };
    return relay.ip && relay.token ? relay : null;
}
export function extractRelayEndpoints(node) {
    const relayNodes = [...getNodeChildrenByTag(node, 'relay')];
    for (const wrapper of getNodeChildrenByTag(node, 'relays')) {
        relayNodes.push(...getNodeChildrenByTag(wrapper, 'relay'));
    }
    const relays = [];
    for (const relayNode of relayNodes) {
        const relay = toRelayEndpoint(relayNode);
        if (relay) {
            relays.push(relay);
        }
    }
    relays.sort((a, b) => (a.c2rRtt ?? Infinity) - (b.c2rRtt ?? Infinity));
    return relays;
}
export async function decryptCallKey(deps, node, peerJid, logger) {
    const log = logger ?? createNoopLogger();
    const isEnc = (child) => child.tag === 'enc' && !!child.attrs?.type;
    const encNodes = getNodeChildren(node).filter(isEnc);
    const destinationNode = findNodeChild(node, 'destination');
    if (destinationNode) {
        for (const toNode of getNodeChildren(destinationNode)) {
            if (toNode.tag === 'to') {
                encNodes.push(...getNodeChildren(toNode).filter(isEnc));
            }
        }
    }
    const address = parseSignalAddressFromJid(peerJid);
    for (const encNode of encNodes) {
        if (!(encNode.content instanceof Uint8Array)) {
            continue;
        }
        try {
            const decrypted = await deps.signalProtocol.decryptMessage(address, {
                type: encNode.attrs.type,
                ciphertext: encNode.content
            });
            const message = proto.Message.decode(unpadPkcs7(decrypted));
            const callKey = message.call?.callKey;
            if (callKey && callKey.length === 32) {
                return callKey;
            }
        }
        catch (err) {
            log.trace('call key decrypt candidate failed', { message: toError(err).message });
        }
    }
    return undefined;
}
const CAPABILITY_OFFER = new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe4, 0xbb, 0x07]);
const CAPABILITY_PREACCEPT = new Uint8Array([0x01, 0x05, 0xff, 0x09, 0xe4, 0xbb, 0x07]);
export async function buildCallParticipantNodes(deps, devices, callKey) {
    await deps.sessionResolver.ensureSessionsBatch(devices);
    const plaintext = await encodeWAMessage({ call: { callKey } });
    const encrypted = await Promise.all(devices.map((jid) => deps.signalProtocol.encryptMessage(parseSignalAddressFromJid(jid), plaintext)));
    const nodes = devices.map((jid, index) => ({
        tag: 'to',
        attrs: { jid },
        content: [
            {
                tag: 'enc',
                attrs: { v: '2', type: encrypted[index].type, count: '0' },
                content: encrypted[index].ciphertext
            }
        ]
    }));
    return {
        nodes,
        shouldIncludeDeviceIdentity: encrypted.some((entry) => entry.type === 'pkmsg')
    };
}
export async function buildOfferStanza(deps, stores, callId, callKey, peerJid, isVideo, logger) {
    const log = logger ?? createNoopLogger();
    const creds = deps.authClient.getCurrentCredentials();
    const callCreator = creds?.meLid || creds?.meJid || '';
    const synced = await deps.signalDeviceSync.syncDeviceList([peerJid]);
    const devices = synced.flatMap((entry) => entry.deviceJids);
    if (devices.length === 0) {
        throw new Error(`no device sessions to encrypt the call offer for ${peerJid}`);
    }
    const { nodes: destinations, shouldIncludeDeviceIdentity } = await buildCallParticipantNodes(deps, devices, callKey);
    const offerContent = [];
    try {
        const peerJidNormalized = toUserJid(peerJid);
        const tcTokenRecord = await stores.privacyToken.getByJid(peerJidNormalized);
        const tctoken = tcTokenRecord?.tcToken;
        if (tctoken) {
            offerContent.push({
                tag: 'privacy',
                attrs: {},
                content: tctoken instanceof Uint8Array ? tctoken : new Uint8Array(tctoken)
            });
        }
    }
    catch (err) {
        log.trace('tctoken lookup failed', { message: toError(err).message });
    }
    offerContent.push({ tag: 'audio', attrs: { enc: 'opus', rate: '8000' }, content: undefined }, { tag: 'audio', attrs: { enc: 'opus', rate: '16000' }, content: undefined });
    if (isVideo) {
        // Codec is H.264, not VP8 — meowcaller's signaling/video.go (videoOfferNode,
        // ported from whatsapp-rust) uses exactly these enc/dec spellings ("h.264"
        // lowercase-dotted for enc, "H264" uppercase for dec); the peer parses these
        // literally, and our RTP payloader (media/h264.js) only speaks H.264 (PT 97).
        offerContent.push({
            tag: 'video',
            attrs: {
                enc: 'h.264',
                dec: 'H264',
                screen_width: '1920',
                screen_height: '1080',
                device_orientation: '0'
            },
            content: undefined
        });
    }
    offerContent.push({ tag: 'net', attrs: { medium: '3' }, content: undefined });
    offerContent.push({
        tag: 'capability',
        attrs: { ver: '1' },
        content: CAPABILITY_OFFER
    });
    offerContent.push({ tag: 'destination', attrs: {}, content: destinations });
    offerContent.push({
        tag: 'encopt',
        attrs: { keygen: '2' },
        content: undefined
    });
    if (shouldIncludeDeviceIdentity && creds?.signedIdentity) {
        offerContent.push({
            tag: 'device-identity',
            attrs: {},
            content: creds.signedIdentity
        });
    }
    return {
        tag: 'call',
        attrs: { to: peerJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'offer',
                attrs: { 'call-id': callId, 'call-creator': callCreator },
                content: offerContent
            }
        ]
    };
}
export async function buildAcceptStanza(deps, callId, callKey, peerJid, callCreator, isVideo) {
    await deps.messageDispatch.syncSignalSession(callCreator);
    const bytes = await encodeWAMessage({ call: { callKey } });
    let encNode;
    let shouldIncludeDeviceIdentity = false;
    try {
        const { type, ciphertext } = await deps.signalProtocol.encryptMessage(parseSignalAddressFromJid(callCreator), bytes);
        if (type === 'pkmsg') {
            shouldIncludeDeviceIdentity = true;
        }
        encNode = {
            tag: 'enc',
            attrs: { v: '2', type, count: '0' },
            content: ciphertext
        };
    }
    catch (err) {
        throw new Error(`Failed to encrypt accept for ${callCreator}: ${err.message}`);
    }
    const acceptContent = [
        { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
        { tag: 'net', attrs: { medium: '3' } },
        encNode,
        { tag: 'encopt', attrs: { keygen: '2' } }
    ];
    const acceptSignedIdentity = deps.authClient.getCurrentCredentials()?.signedIdentity;
    if (shouldIncludeDeviceIdentity && acceptSignedIdentity) {
        acceptContent.push({
            tag: 'device-identity',
            attrs: {},
            content: acceptSignedIdentity
        });
    }
    if (isVideo) {
        // Matches meowcaller's videoAcceptNode(): dec:"H264" only, no enc attr on accept.
        acceptContent.push({ tag: 'video', attrs: { dec: 'H264', device_orientation: '0' } });
    }
    const toJidClean = toUserJid(peerJid);
    return {
        tag: 'call',
        attrs: { to: toJidClean, id: generateCallStanzaId() },
        content: [
            {
                tag: 'accept',
                attrs: { 'call-id': callId, 'call-creator': callCreator },
                content: acceptContent
            }
        ]
    };
}
export function buildTerminateStanza(peerJid, callId, callCreator, audioDurationMs, reason) {
    const attrs = {
        'call-id': callId,
        'call-creator': callCreator
    };
    if (audioDurationMs !== undefined && audioDurationMs >= 0) {
        const ms = String(Math.floor(audioDurationMs));
        attrs.duration = ms;
        attrs.audio_duration = ms;
    }
    if (reason !== undefined) {
        attrs.reason = reason;
    }
    return {
        tag: 'call',
        attrs: { to: peerJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'terminate',
                attrs,
                content: undefined
            }
        ]
    };
}
export function buildRelaylatencyForwardStanza(peerJid, callId, callCreator, teNodes, destinationJids) {
    const destinationContent = destinationJids.map((jid) => ({
        tag: 'to',
        attrs: { jid },
        content: undefined
    }));
    return {
        tag: 'call',
        attrs: { to: toUserJid(peerJid), id: generateCallStanzaId() },
        content: [
            {
                tag: 'relaylatency',
                attrs: { 'call-id': callId, 'call-creator': callCreator },
                content: [
                    ...teNodes,
                    { tag: 'destination', attrs: {}, content: destinationContent }
                ]
            }
        ]
    };
}
export function buildRejectStanza(peerJid, callId, callCreator) {
    const toJidClean = toUserJid(peerJid);
    return {
        tag: 'call',
        attrs: { to: toJidClean, id: generateCallStanzaId() },
        content: [
            {
                tag: 'reject',
                attrs: { 'call-id': callId, 'call-creator': callCreator }
            }
        ]
    };
}
export function buildPreacceptStanza(peerJid, callId, callCreator) {
    return {
        tag: 'call',
        attrs: { to: peerJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'preaccept',
                attrs: { 'call-id': callId, 'call-creator': callCreator },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                    { tag: 'encopt', attrs: { keygen: '2' } },
                    { tag: 'capability', attrs: { ver: '1' }, content: CAPABILITY_PREACCEPT }
                ]
            }
        ]
    };
}
export function buildRelayLatencyStanza(peerJid, callId, callCreator, relays, destinationJids, meId) {
    const seenRelays = new Set();
    const teNodes = [];
    for (const relay of relays) {
        if (!relay.relayName || seenRelays.has(relay.relayName))
            continue;
        seenRelays.add(relay.relayName);
        const encodedLatency = 0x2000000 + (relay.latency || 0);
        teNodes.push({
            tag: 'te',
            attrs: {
                latency: String(encodedLatency),
                relay_name: relay.relayName
            },
            content: relay.addressBytes || undefined
        });
    }
    const destinationContent = destinationJids.map((jid) => ({
        tag: 'to',
        attrs: { jid },
        content: undefined
    }));
    const relayLatencyContent = [...teNodes];
    if (destinationContent.length > 0) {
        relayLatencyContent.push({
            tag: 'destination',
            attrs: {},
            content: destinationContent
        });
    }
    const toJidClean = toUserJid(peerJid);
    return {
        tag: 'call',
        attrs: { to: toJidClean, id: generateCallStanzaId() },
        content: [
            {
                tag: 'relaylatency',
                attrs: { 'call-id': callId, 'call-creator': callCreator },
                content: relayLatencyContent
            }
        ]
    };
}
export function buildTransportStanza(peerJid, callId, callCreator, meId, messageType = '0', p2pCandRound = '0') {
    return {
        tag: 'call',
        attrs: { to: peerJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'transport',
                attrs: {
                    'call-id': callId,
                    'call-creator': callCreator,
                    'transport-message-type': messageType,
                    'p2p-cand-round': p2pCandRound
                },
                content: [
                    {
                        tag: 'net',
                        attrs: { medium: '2', protocol: '0' },
                        content: undefined
                    }
                ]
            }
        ]
    };
}
export function buildMuteV2Stanza(peerDeviceJid, callId, callCreator, muteState, meId) {
    return {
        tag: 'call',
        attrs: { to: peerDeviceJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'mute_v2',
                attrs: {
                    'call-id': callId,
                    'call-creator': callCreator,
                    'mute-state': String(muteState)
                }
            }
        ]
    };
}
export function buildAcceptReceiptStanza(peerDeviceJid, acceptMsgId, callId, callCreator, ourJid) {
    return buildReceiptNode({
        kind: 'custom',
        attrs: { to: peerDeviceJid, id: acceptMsgId, from: ourJid },
        content: [{ tag: 'accept', attrs: { 'call-id': callId, 'call-creator': callCreator } }]
    });
}
export const ENCRYPTED_TAGS = ['preaccept', 'accept'];
export function needsDecryption(tag) {
    return ENCRYPTED_TAGS.includes(tag);
}
