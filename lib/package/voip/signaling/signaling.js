import { createNoopLogger, unpadPkcs7, writeRandomPadMax16 } from '../shim/core.js';
import { getProto } from '../shim/proto.js';
import { parseSignalAddressFromJid, toUserJid } from '../shim/protocol.js';
import { buildAckNode, buildReceiptNode, findNodeChild, getFirstNodeChild, getNodeChildren, getNodeChildrenByTag } from '../shim/transport.js';
import { bytesToHex, toError } from '../shim/util.js';
import { randomBytes } from '../crypto/primitives.js';
import { TEXT_ENCODER } from '../bytes.js';
export async function encodeWAMessage(message) {
    const proto = await getProto();
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
    const proto = await getProto();
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
export function parseMuteV2(inner) {
    const rawMuteState = inner.attrs?.['mute-state'];
    let muted = null;
    if (rawMuteState === '1') {
        muted = true;
    }
    else if (rawMuteState === '0') {
        muted = false;
    }
    return { muted, isRequest: inner.attrs?.['request-state'] !== undefined };
}
const RAISE_HAND_ACTION = 'raise_hand';
const RAISE_HAND_STATE_ATTR = 'raise-hand-state';
export function buildRaiseHandStanza(peerDeviceJid, callId, callCreator, raised, broadcast = false) {
    const attrs = {
        'call-id': callId,
        'call-creator': callCreator,
        action: RAISE_HAND_ACTION
    };
    if (broadcast) {
        attrs.broadcast = '1';
    }
    return {
        tag: 'call',
        attrs: { to: peerDeviceJid, id: generateCallStanzaId() },
        content: [
            {
                tag: 'user_action',
                attrs,
                content: [
                    {
                        tag: RAISE_HAND_ACTION,
                        attrs: { [RAISE_HAND_STATE_ATTR]: raised ? '1' : '0' }
                    }
                ]
            }
        ]
    };
}
export function parseRaiseHandState(node) {
    const stateNode = node.tag === RAISE_HAND_ACTION ? node : findNodeChild(node, RAISE_HAND_ACTION);
    const raw = stateNode?.attrs?.[RAISE_HAND_STATE_ATTR];
    if (raw === '1')
        return true;
    if (raw === '0')
        return false;
    return null;
}
export function buildAcceptReceiptStanza(peerDeviceJid, acceptMsgId, callId, callCreator, ourJid) {
    return buildReceiptNode({
        kind: 'custom',
        attrs: { to: peerDeviceJid, id: acceptMsgId, from: ourJid },
        content: [{ tag: 'accept', attrs: { 'call-id': callId, 'call-creator': callCreator } }]
    });
}

export const VideoState = {
    Disabled: 0,
    Enabled: 1,
    UpgradeRequest: 3,
    UpgradeAccept: 4,
    UpgradeReject: 5,
    Stopped: 6,
    UpgradeCancel: 8,
    UpgradeRequestV2: 11
};
export const VideoDecRequest = 'H264';
export const VideoDecAccept = 'H264,AV1';

export function buildVideoStateStanza(peerJid, callId, callCreator, state, { dec, deviceOrientation } = {}) {
    const attrs = {
        'call-id': callId,
        'call-creator': callCreator,
        state: String(state)
    };
    if (dec)
        attrs.dec = dec;
    if (state === VideoState.UpgradeRequestV2)
        attrs.voip_settings = 'video';
    if (deviceOrientation !== undefined && deviceOrientation !== null)
        attrs.device_orientation = String(deviceOrientation);
    return {
        tag: 'call',
        attrs: { to: peerJid, id: generateCallStanzaId() },
        content: [{ tag: 'video', attrs }]
    };
}
export const ENCRYPTED_TAGS = ['preaccept', 'accept'];
export function needsDecryption(tag) {
    return ENCRYPTED_TAGS.includes(tag);
}
const groupCapabilityOffer = new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x13]);
export const GroupCapability = Object.freeze({
    offer: groupCapabilityOffer,
    videoOffer: new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xfa, 0x13]),
    preaccept: new Uint8Array([0x01, 0x05, 0xf7, 0x09, 0xe0, 0xbb, 0x07])
});
export function callJidFor(callId) {
    return `${callId}@call`;
}
function readOptionalUint(node, key) {
    const raw = node?.attrs?.[key];
    if (raw === undefined || raw === null || raw === '') {
        return undefined;
    }
    const value = Number(raw);
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
        throw new Error(`invalid ${key} "${raw}"`);
    }
    return value;
}
function readRequiredUint(node, key) {
    const value = readOptionalUint(node, key);
    if (value === undefined) {
        throw new Error(`missing ${key}`);
    }
    return value;
}
function readNodeBytes(node) {
    if (node?.content instanceof Uint8Array) {
        return node.content;
    }
    if (typeof node?.content === 'string') {
        return TEXT_ENCODER.encode(node.content);
    }
    return undefined;
}
function sameBytes(left, right) {
    return !!left && !!right && bytesToHex(left) === bytesToHex(right);
}
function buildGroupUserNodes(participants, creator, video) {
    return participants.map((participant) => {
        if (!participant.jid || !participant.devices?.length) {
            throw new Error('group participant is incomplete');
        }
        const attrs = { jid: participant.jid };
        if (participant.state) {
            attrs.state = participant.state;
        }
        return {
            tag: 'user',
            attrs,
            content: participant.devices.map((device) => {
                if (!device.jid) {
                    throw new Error('group device jid is required');
                }
                let content;
                if (device.capability) {
                    content = [
                        {
                            tag: 'capability',
                            attrs: device.capabilityVersion ? { ver: String(device.capabilityVersion) } : {},
                            content: video && device.jid === creator && sameBytes(device.capability, groupCapabilityOffer) ? GroupCapability.videoOffer : device.capability
                        }
                    ];
                }
                return { tag: 'device', attrs: { jid: device.jid }, content };
            })
        };
    });
}
function buildGroupVideoOfferNode() {
    return {
        tag: 'video',
        attrs: { enc: 'h.264', dec: 'H264', screen_width: '1920', screen_height: '1080', device_orientation: '0' }
    };
}
export function buildInitialGroupOfferStanza({ callId, creator, groupJid, participants, video }) {
    if (!callId || !creator) {
        throw new Error('call id and creator are required');
    }
    if (participants.length < 3) {
        throw new Error('a group call needs yourself and at least two other participants');
    }
    const content = [
        { tag: 'audio', attrs: { enc: 'opus', rate: '8000' } },
        { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } }
    ];
    if (video) {
        content.push(buildGroupVideoOfferNode());
    }
    content.push({ tag: 'net', attrs: { medium: '3' } }, { tag: 'group_info', attrs: {}, content: buildGroupUserNodes(participants, creator, video) });
    const attrs = { 'call-id': callId, 'call-creator': creator };
    if (groupJid) {
        attrs['group-jid'] = groupJid;
    }
    return {
        tag: 'call',
        attrs: { to: callJidFor(callId) },
        content: [{ tag: 'offer', attrs, content }]
    };
}
export function buildGroupInviteOfferStanza({ callId, to, creator, targetDevices, participants, video }) {
    if (!callId || !to || !creator || !targetDevices?.length || !participants?.length) {
        throw new Error('invite needs call identity, target devices and roster');
    }
    const content = [{ tag: 'audio', attrs: { enc: 'opus', rate: '16000' } }];
    if (video) {
        content.push(buildGroupVideoOfferNode());
    }
    content.push({ tag: 'net', attrs: { medium: '2' } }, {
        tag: 'destination',
        attrs: {},
        content: targetDevices.map((jid) => ({ tag: 'to', attrs: { jid } }))
    }, { tag: 'group_info', attrs: {}, content: buildGroupUserNodes(participants, undefined, false) });
    return {
        tag: 'call',
        attrs: { to },
        content: [{ tag: 'offer', attrs: { 'call-id': callId, 'call-creator': creator }, content }]
    };
}
export function buildGroupPreacceptStanza(callId, creator, video) {
    const content = [{ tag: 'audio', attrs: { enc: 'opus', rate: '16000' } }];
    if (video) {
        content.push({
            tag: 'video',
            attrs: { dec: 'H264', device_orientation: '0', screen_width: '0', screen_height: '0' }
        });
    }
    content.push({ tag: 'encopt', attrs: { keygen: '2' } }, { tag: 'capability', attrs: { ver: '1' }, content: video ? groupCapabilityOffer : GroupCapability.preaccept });
    return {
        tag: 'call',
        attrs: { to: callJidFor(callId), id: generateCallStanzaId() },
        content: [{ tag: 'preaccept', attrs: { 'call-id': callId, 'call-creator': creator }, content }]
    };
}
export function buildGroupAcceptStanza(callId, creator) {
    return {
        tag: 'call',
        attrs: { to: callJidFor(callId), id: generateCallStanzaId() },
        content: [
            {
                tag: 'accept',
                attrs: { 'call-id': callId, 'call-creator': creator },
                content: [
                    { tag: 'audio', attrs: { enc: 'opus', rate: '16000' } },
                    { tag: 'net', attrs: { medium: '2' } },
                    { tag: 'encopt', attrs: { keygen: '2' } }
                ]
            }
        ]
    };
}
export function buildGroupTerminateStanza(callId, creator) {
    return {
        tag: 'call',
        attrs: { to: callJidFor(callId), id: generateCallStanzaId() },
        content: [{ tag: 'terminate', attrs: { 'call-id': callId, 'call-creator': creator } }]
    };
}
export function buildGroupEncRekeyStanza({ callId, to, creator, transactionId, encType, ciphertext }) {
    if (!callId || !to || !creator || !transactionId || !ciphertext?.length) {
        throw new Error('group rekey is incomplete');
    }
    if (encType !== 'msg' && encType !== 'pkmsg') {
        throw new Error(`unsupported group rekey encryption ${encType}`);
    }
    return {
        tag: 'call',
        attrs: { to, id: generateCallStanzaId() },
        content: [
            {
                tag: 'enc_rekey',
                attrs: { 'call-id': callId, 'call-creator': creator, 'transaction-id': String(transactionId) },
                content: [
                    { tag: 'encopt', attrs: { keygen: '2' } },
                    { tag: 'enc', attrs: { v: '2', type: encType, count: '0' }, content: ciphertext }
                ]
            }
        ]
    };
}
function parseGroupDeviceNode(node) {
    const capabilityNode = findNodeChild(node, 'capability');
    return {
        jid: node.attrs?.jid,
        platform: node.attrs?.platform,
        pid: readOptionalUint(node, 'pid'),
        capabilityVersion: capabilityNode ? readOptionalUint(capabilityNode, 'ver') : undefined,
        capability: capabilityNode ? readNodeBytes(capabilityNode) : undefined
    };
}
function parseGroupInfoNode(groupInfo) {
    const participants = getNodeChildrenByTag(groupInfo, 'user').map((user) => ({
        jid: user.attrs?.jid,
        pn: user.attrs?.user_pn,
        state: user.attrs?.state || '',
        type: user.attrs?.type,
        rekey: user.attrs?.rekey === '1',
        devices: getNodeChildrenByTag(user, 'device').map(parseGroupDeviceNode)
    }));
    return {
        groupJid: groupInfo.attrs?.['group-jid'],
        media: groupInfo.attrs?.media,
        joinable: groupInfo.attrs?.joinable === '1',
        rekeyRequested: groupInfo.attrs?.rekey === '1' || participants.some((participant) => participant.rekey),
        transactionId: readRequiredUint(groupInfo, 'transaction-id'),
        connectedLimit: readRequiredUint(groupInfo, 'connected-limit'),
        participants
    };
}
function parseGroupRelayNode(relayNode) {
    const hbhKey = readNodeBytes(findNodeChild(relayNode, 'hbh_key'));
    return {
        node: relayNode,
        uuid: relayNode.attrs?.uuid,
        participantUuid: relayNode.attrs?.participant_uuid,
        transactionId: readOptionalUint(relayNode, 'transaction-id'),
        selfPid: readOptionalUint(relayNode, 'self_pid'),
        warpMiTagLength: readOptionalUint(relayNode, 'warp_mi_tag_len'),
        hbhKey: hbhKey && hbhKey.length === 30 ? hbhKey : undefined
    };
}
export function parseGroupInviteSnapshot(offerNode) {
    const groupInfo = findNodeChild(offerNode, 'group_info');
    if (!groupInfo) {
        return null;
    }
    const update = {
        callId: offerNode.attrs?.['call-id'],
        callCreator: offerNode.attrs?.['call-creator'],
        ...parseGroupInfoNode(groupInfo)
    };
    update.joinable = offerNode.attrs?.joinable === '1';
    return update;
}
export function parseInitialGroupAck(ackNode) {
    const groupInfo = findNodeChild(ackNode, 'group_info');
    if (!groupInfo) {
        return null;
    }
    const update = {
        callId: groupInfo.attrs?.['call-id'],
        callCreator: groupInfo.attrs?.['call-creator'],
        ...parseGroupInfoNode(groupInfo)
    };
    const relayNode = findNodeChild(ackNode, 'relay');
    if (relayNode) {
        update.relay = parseGroupRelayNode(relayNode);
    }
    return update;
}
export function parseGroupUpdate(node) {
    const groupInfo = findNodeChild(node, 'group_info');
    if (!groupInfo) {
        throw new Error('group_update is missing group_info');
    }
    const update = {
        callId: node.attrs?.['call-id'],
        callCreator: node.attrs?.['call-creator'],
        ...parseGroupInfoNode(groupInfo)
    };
    update.avUpgradable = findNodeChild(node, 'av_upgrade')?.attrs?.['av-upgradable'] === '1';
    const relayNode = findNodeChild(node, 'relay');
    if (relayNode) {
        update.relay = parseGroupRelayNode(relayNode);
    }
    return update;
}
export function parseGroupEncRekey(node) {
    const encopt = findNodeChild(node, 'encopt');
    const enc = findNodeChild(node, 'enc');
    if (!encopt || !enc) {
        throw new Error('enc_rekey is missing encopt or enc');
    }
    if (readRequiredUint(encopt, 'keygen') !== 2) {
        throw new Error('unsupported key generation');
    }
    const encType = enc.attrs?.type;
    if ((encType !== 'msg' && encType !== 'pkmsg') || readRequiredUint(enc, 'v') !== 2) {
        throw new Error('unsupported group rekey encryption');
    }
    if (!(enc.content instanceof Uint8Array)) {
        throw new Error('enc_rekey ciphertext is missing');
    }
    return {
        callId: node.attrs?.['call-id'],
        callCreator: node.attrs?.['call-creator'],
        transactionId: readRequiredUint(node, 'transaction-id'),
        encType,
        ciphertext: enc.content
    };
}
export function buildCallControlAckNode(node, childTag) {
    const { id, from, participant, recipient } = node.attrs ?? {};
    if (!id || !from || !childTag) {
        return null;
    }
    return buildAckNode({
        kind: 'custom',
        ackClass: 'call',
        to: from,
        id,
        type: childTag,
        participant: participant && participant !== from ? participant : undefined,
        recipient: recipient || undefined
    });
}
function normalizeLinkMedia(media) {
    if (media !== 'audio' && media !== 'video') {
        throw new Error(`invalid call link media "${media}"`);
    }
    return media;
}
export function buildCallLinkUrl(token, media) {
    return `https://call.whatsapp.com/${normalizeLinkMedia(media) === 'video' ? 'video' : 'voice'}/${token}`;
}
export function parseCallLink(raw) {
    const text = String(raw ?? '').trim();
    if (!text) {
        throw new Error('call link token is required');
    }
    if (!text.includes('://')) {
        if (text.includes('/')) {
            throw new Error('invalid call link token');
        }
        return { token: text, media: undefined };
    }
    const url = new URL(text);
    const parts = url.pathname.split('/').filter(Boolean);
    if (url.protocol !== 'https:' || url.hostname !== 'call.whatsapp.com' || parts.length !== 2 || !['audio', 'video', 'voice'].includes(parts[0])) {
        throw new Error('invalid WhatsApp call link');
    }
    return { token: parts[1], media: parts[0] === 'video' ? 'video' : 'audio' };
}
export function parseCallLinkToken(raw) {
    return parseCallLink(raw).token;
}
function buildCallServiceRequest(requestId, action) {
    return { tag: 'call', attrs: { to: '@call', id: requestId }, content: [action] };
}
export function buildCallLinkCreateStanza(media, requestId) {
    return buildCallServiceRequest(requestId, { tag: 'link_create', attrs: { media: normalizeLinkMedia(media) } });
}
export function buildCallLinkQueryStanza(token, media, requestId) {
    return buildCallServiceRequest(requestId, { tag: 'link_query', attrs: { token, media: normalizeLinkMedia(media) } });
}
export function buildCallLinkJoinStanza(token, media, requestId) {
    const content = [{ tag: 'audio', attrs: { enc: 'opus', rate: '16000' } }];
    if (normalizeLinkMedia(media) === 'video') {
        content.push({ tag: 'video', attrs: { dec: 'H264', device_orientation: '0' } });
    }
    content.push({ tag: 'net', attrs: { medium: '2' } }, { tag: 'capability', attrs: { ver: '1' }, content: groupCapabilityOffer });
    return buildCallServiceRequest(requestId, { tag: 'link_join', attrs: { token, media }, content });
}
export function buildWaitingRoomRequestStanza(tag, callId, creator, requestId, extraAttrs = {}, children = undefined) {
    return {
        tag: 'call',
        attrs: { to: callJidFor(callId), id: requestId },
        content: [{ tag, attrs: { 'call-id': callId, 'call-creator': creator, ...extraAttrs }, content: children }]
    };
}
function validateCallLinkAck(node, expectedType) {
    if (!node || node.tag !== 'ack' || node.attrs?.class !== 'call' || node.attrs?.type !== expectedType) {
        const reason = node?.attrs?.error ? ` (error ${node.attrs.error})` : '';
        throw new Error(`unexpected ${expectedType} response${reason}`);
    }
    return findNodeChild(node, expectedType);
}
export function parseCallLinkCreateAck(node) {
    const child = validateCallLinkAck(node, 'link_create');
    const token = child?.attrs?.token;
    if (!token) {
        throw new Error('link_create response has no token');
    }
    return { token, media: normalizeLinkMedia(child.attrs.media) };
}
export function parseCallLinkQueryAck(node) {
    const child = validateCallLinkAck(node, 'link_query');
    if (!child) {
        throw new Error('link_query response has no payload');
    }
    const room = findNodeChild(child, 'waiting_room');
    if (!room) {
        throw new Error('link_query response has no waiting_room');
    }
    return {
        token: child.attrs?.token,
        media: normalizeLinkMedia(child.attrs?.media),
        creator: child.attrs?.link_creator,
        creatorPn: child.attrs?.link_creator_pn,
        waitingRoomEnabled: room.attrs?.enabled === '1',
        isAdmin: room.attrs?.is_admin === '1'
    };
}
function parseWaitingRoomNode(node) {
    const transactionId = node.attrs?.['transaction-id'];
    return {
        callId: node.attrs?.['call-id'],
        callCreator: node.attrs?.['call-creator'],
        linkToken: node.attrs?.['link-token'],
        media: normalizeLinkMedia(node.attrs?.media),
        enabled: node.attrs?.enabled === '1',
        isAdmin: node.attrs?.is_admin === '1',
        transactionId: transactionId ? Number(transactionId) : 0,
        users: getNodeChildrenByTag(node, 'user').map((user) => ({
            jid: user.attrs?.jid,
            pn: user.attrs?.user_pn,
            state: user.attrs?.state || ''
        }))
    };
}
export function parseCallLinkJoinAck(node) {
    validateCallLinkAck(node, 'link_join');
    const waitingNode = findNodeChild(node, 'waiting_room');
    const result = { waitingRoom: waitingNode ? parseWaitingRoomNode(waitingNode) : null, group: parseInitialGroupAck(node) };
    if (!result.waitingRoom && !result.group) {
        throw new Error('link_join response has no group_info or waiting_room');
    }
    result.callId = result.waitingRoom?.callId || result.group.callId;
    result.callCreator = result.waitingRoom?.callCreator || result.group.callCreator;
    result.inWaitingRoom = !!result.waitingRoom && result.waitingRoom.enabled && !result.group;
    return result;
}
export function parseWaitingRoomUpdate(node) {
    const child = findNodeChild(node, 'waiting_room');
    if (!child) {
        throw new Error('waiting_room_update has no waiting_room');
    }
    return parseWaitingRoomNode(child);
}
