import { toUserJid } from '../shim/protocol.js';
import { getFirstNodeChild, getNodeChildrenByTag } from '../shim/transport.js';
import { toError, uint8TimingSafeEqual } from '../shim/util.js';
import { concatBytes, EMPTY_BYTES, readUInt32BE, toArrayBuffer } from '../bytes.js';
import { derivePerJidSrtpKey } from '../crypto/encryption.js';
import { SrtpSession } from '../crypto/srtp.js';
import { SrtcpSendContext } from '../crypto/rtcp.js';
import { generateSecureSsrc } from '../crypto/ssrc.js';
import { AudioCodec } from '../media/audio-codec.js';
import { RtpSession, RtpPacket, VideoRtpStream, VideoMediaFrameInfo, videoRtpDurationSamples } from '../media/rtp.js';
import { auHasIDR, buildAccessUnitPayload, packageH264NALU, H264AccessUnitAssembler } from '../media/h264.js';
import { buildSenderReportWithSdes, generateWhatsappRtcpCname } from '../media/rtcp.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { WaVideoEngine } from '../media/WaVideoEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { isRtpPacket, isStunPacket } from '../relay/stun.js';
import { WaManualRelay } from '../relay/WaManualRelay.js';
import { buildAcceptReceiptStanza, buildAcceptStanza, buildMuteV2Stanza, buildPreacceptStanza, buildRejectStanza, buildRelaylatencyForwardStanza, buildRelayLatencyStanza, buildTerminateStanza, buildTransportStanza, buildVideoStateStanza, decryptCallKey, extractNodeInfo, extractRelayEndpoints, needsDecryption, VideoDecAccept, VideoDecRequest, VideoState } from '../signaling/signaling.js';
import { CallDirection, CallMediaType, CallState, EndCallReason, PayloadType, SRTP_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN, SRTP_SEND_AUTH_TAG_LEN } from '../types.js';
export class WaCallMediaSession {
    info;
    deps;
    logger;
    delegate;
    rtpSession = null;
    srtpSession = null;
    opusCodec = null;
    sctpRelay;
    audioEngine;
    initialTransportSent = false;
    outgoingPreacceptSent = false;
    selfSsrc = 0;
    peerSsrcs = [];
    firstPacketSent = false;
    acceptedByJid = null;
    debeEnabled = true;
    audioSendCount = 0;
    audioDropCount = 0;
    realAudioSendCount = 0;
    static EMPTY_BYTES = EMPTY_BYTES;
    encodeBufferA = null;
    encodeBufferB = null;
    encodeBuffer = null;
    encodeBufferPos = 0;
    authPaddingBuffer = null;
    audioRecvCount = 0;
    recvRealCount = 0;
    recvDtxCount = 0;
    srtpErrorCount = 0;
    relayPacketCount = 0;
    stunResponseCount = 0;
    selfEchoCount = 0;
    lastRecvSeq = -1;
    recvSeqGaps = 0;
    actualPeerSsrc = null;
    ssrcResubscribed = false;

    videoSsrc = 0;
    videoRtpStream = null;
    videoSrtpSession = null;
    videoEngine;
    videoSendCount = 0;
    videoIdrSendCount = 0;
    videoDropCount = 0;

    audioRtcpSession = null;
    videoRtcpSession = null;
    audioRtcpCname = null;
    videoRtcpCname = null;
    audioOctetsSent = 0;
    videoOctetsSent = 0;
    rtcpTimer = null;
    mediaStartedAtMs = null;

    peerVideoUpgradePending = false;
    videoAssembler = null;
    constructor(options) {
        this.deps = options.deps;
        this.logger = options.logger;
        this.info = options.info;
        this.delegate = options.delegate;
        this.sctpRelay = new WaManualRelay({
            logger: this.logger.child({ component: 'sctp' })
        });
        this.audioEngine = new WaAudioEngine({
            logger: this.logger.child({ component: 'audio-engine' })
        });
        this.audioEngine.setAudioSender(this);
        this.audioEngine.setOnAudioFinished(() => {
            this.delegate.emitOutboundAudioFinished(this.info);
        });
        this.videoEngine = new WaVideoEngine({
            logger: this.logger.child({ component: 'video-engine' }),
            ...(options.videoConfig || {})
        });
        this.videoEngine.setVideoSender(this);
        this.sctpRelay.on('relay_connected', () => {
            this.onRelayConnected();
        });
        this.sctpRelay.on('relay_receive', (relayInfo) => {
            this.onRelayData(relayInfo.data);
        });
    }
    get callId() {
        return this.info.callId;
    }
    async initMedia(selfLid, peerJid) {
        const ssrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(selfLid));
        this.rtpSession = RtpSession.whatsappOpus(ssrc);
        this.selfSsrc = ssrc;
        const peerSsrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(peerJid));
        this.peerSsrcs = [peerSsrc];
        this.logger.media('call media initialized', {
            callId: this.info.callId,
            selfSsrc: `0x${ssrc.toString(16).toUpperCase()}`,
            peerSsrc: `0x${peerSsrc.toString(16).toUpperCase()}`
        });
        this.opusCodec = await AudioCodec.create();
        if (this.info.mediaType === CallMediaType.Video) {

            this.videoSsrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(selfLid), 2);
            this.videoRtpStream = new VideoRtpStream(this.videoSsrc, videoRtpDurationSamples(this.videoEngine.frameDurationMs));
            this.videoAssembler = new H264AccessUnitAssembler();
            this.logger.media('video media initialized', {
                callId: this.info.callId,
                videoSsrc: `0x${this.videoSsrc.toString(16).toUpperCase()}`
            });
        }
    }
    resetOutgoingFlags() {
        this.initialTransportSent = false;
        this.outgoingPreacceptSent = false;
    }
    async acceptCall() {
        if (!this.info.canAccept) {
            throw new Error(`Call ${this.info.callId} cannot be accepted in state ${this.info.stateData.state}`);
        }
        this.info.applyTransition({ type: 'local_accepted' });
        this.delegate.emitState(this.info);
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const peerJid = this.info.peerJid;
        const isVideo = this.info.mediaType === CallMediaType.Video;
        this.acceptedByJid = peerJid;
        this.initSrtpKeys();
        try {
            const muteNode = buildMuteV2Stanza(peerJid, callId, callCreator, 0, meId);
            await this.deps.lowLevelCoordinator.sendNode(muteNode);
        }
        catch (err) {
            this.logger.error('error sending mute_v2', {
                message: toError(err).message
            });
        }
        try {
            const transportNode = buildTransportStanza(peerJid, callId, callCreator, meId, '1', '1');
            await this.deps.lowLevelCoordinator.sendNode(transportNode);
        }
        catch (err) {
            this.logger.error('error sending transport', {
                message: toError(err).message
            });
        }
        if (this.info.encryptionKey) {
            const acceptStanza = await buildAcceptStanza(this.deps, this.info.callId, this.info.encryptionKey, this.info.peerJid, this.info.callCreator, isVideo);
            try {
                await this.deps.lowLevelCoordinator.sendNode(acceptStanza);
            }
            catch (err) {
                this.logger.error('accept send error', {
                    message: toError(err).message
                });
            }
        }
        if (this.info.relayData) {
            await this.connectRelays(this.info.relayData.endpoints);
        }
        this.logger.media('call accepted', { callId });
    }
    async rejectCall(reason = EndCallReason.Declined) {
        this.info.applyTransition({ type: 'local_rejected', reason });
        this.delegate.emitState(this.info);
        const node = buildRejectStanza(this.info.peerJid, this.info.callId, this.info.callCreator);
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('reject send failed', { message: toError(err).message });
        }
        this.cleanup();
    }
    async endCall(reason = EndCallReason.UserEnded) {
        if (this.info.isEnded)
            return;
        const connectedAt = this.info.stateData.connectedAt;
        const audioDurationMs = connectedAt ? Date.now() - connectedAt.getTime() : undefined;
        this.info.applyTransition({ type: 'terminated', reason });
        const terminateTarget = this.acceptedByJid ?? this.info.peerJid;
        const node = buildTerminateStanza(terminateTarget, this.info.callId, this.info.callCreator, audioDurationMs);
        this.delegate.emitEnded(this.info);
        this.delegate.emitState(this.info);
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('terminate send failed', { message: toError(err).message });
        }

        await new Promise((resolve) => setTimeout(resolve, 400));
        this.cleanup();
    }
    setMute(muted) {
        if (!this.info.isActive)
            return;
        this.info.applyTransition({ type: 'audio_mute_changed', muted });
        this.delegate.emitState(this.info);
        if (muted) {
            this.audioEngine.stopCapture();
        }
        else {
            this.audioEngine.startCapture();
        }
    }
    async loadAudio(audioPath) {
        this.audioEngine.setLoopMode(false);
        await this.audioEngine.loadAudioFile(audioPath);
        this.resetEncodeState();
        this.logger.media('audio loaded for call', { callId: this.info.callId });
    }
    setExternalAudioMode(enabled) {
        this.audioEngine.setExternalMode(enabled);
        if (enabled) {
            this.resetEncodeState();
            this.logger.debug('external audio mode enabled', { callId: this.info.callId });
        }
    }
    feedLiveAudio(data) {
        return this.audioEngine.feedExternalAudio(data);
    }
    getLiveBufferMs() {
        return this.audioEngine.getLiveBufferMs();
    }
    async sendIncomingPreaccept(peerJid) {
        try {
            const preacceptNode = buildPreacceptStanza(peerJid, this.info.callId, this.info.callCreator);
            await this.deps.lowLevelCoordinator.sendNode(preacceptNode);
        }
        catch (err) {
            this.logger.error('error sending preaccept', {
                message: toError(err).message
            });
        }
    }
    async sendIncomingRelayLatency() {
        if (!this.info.relayData)
            return;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const destinationJids = this.info.relayData.participantJids || [];
        const seenRelayNames = new Set();
        for (const ep of this.info.relayData.endpoints) {
            const name = ep.relayName || '';
            if (!name || seenRelayNames.has(name))
                continue;
            seenRelayNames.add(name);
            try {
                const relayData = [
                    {
                        relayName: name,
                        latency: ep.c2rRtt || 0,
                        addressBytes: ep.addressBytes
                    }
                ];
                const relayLatencyNode = buildRelayLatencyStanza(this.info.peerJid, callId, callCreator, relayData, destinationJids, meId);
                await this.deps.lowLevelCoordinator.sendNode(relayLatencyNode);
            }
            catch (err) {
                this.logger.error('error sending incoming relaylatency', {
                    relayName: name,
                    message: toError(err).message
                });
            }
        }
    }
    async handleCallAccept(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        let srtpFromPeerKey = false;
        if (needsDecryption(nodeInfo.tag)) {
            try {
                const peerCallKey = await decryptCallKey(this.deps, nodeInfo.innerNode, peerJid, this.logger.child({ component: 'signaling' }));
                if (peerCallKey) {
                    const ourCallKey = this.info.encryptionKey;
                    const keysMatch = ourCallKey
                        ? uint8TimingSafeEqual(ourCallKey, peerCallKey)
                        : false;
                    if (!keysMatch && ourCallKey) {
                        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
                        const meJid = this.deps.authClient.getCurrentCredentials()?.meJid;
                        const ourCredJid = meLid || meJid || '';
                        const ourBase = ourCredJid ? toUserJid(ourCredJid) : '';
                        const participants = this.info.relayData?.participantJids || [];
                        const ourDeviceJid = participants.find((jid) => {
                            const jBase = toUserJid(jid);
                            return jBase === ourBase && /:\d+@/.test(jid);
                        }) || ourCredJid;
                        if (ourDeviceJid && peerJid) {
                            try {
                                const sendKeying = derivePerJidSrtpKey(ourCallKey, this.ensureDeviceJid(ourDeviceJid));
                                const recvKeying = derivePerJidSrtpKey(peerCallKey, this.ensureDeviceJid(peerJid));
                                this.srtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
                                srtpFromPeerKey = true;
                                this.logger.debug('srtp re-initialized with peer call_key', {
                                    callId: this.info.callId
                                });
                            }
                            catch (err) {
                                this.logger.error('per-jid srtp re-derivation failed', {
                                    message: toError(err).message
                                });
                            }
                        }
                    }
                }
            }
            catch (err) {
                this.logger.error('accept decrypt error', {
                    message: toError(err).message
                });
            }
        }
        try {
            this.info.applyTransition({ type: 'remote_accepted' });
            this.delegate.emitState(this.info);
        }
        catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message });
        }
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
        const ourJid = meLid || meId;
        const ourBase = ourJid ? toUserJid(ourJid) : '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const acceptingDeviceJid = peerJid;
        this.acceptedByJid = acceptingDeviceJid;
        if (this.actualPeerSsrc !== null) {
            const calculatedJid = this.ensureDeviceJid(acceptingDeviceJid);
            this.logger.debug('accept keeping actual peer ssrc', {
                callId,
                actualPeerSsrc: `0x${this.actualPeerSsrc.toString(16)}`,
                calculatedJid
            });
        }
        else {
            const peerDeviceJidForSsrc = this.ensureDeviceJid(acceptingDeviceJid);
            const acceptSsrc = generateSecureSsrc(callId, peerDeviceJidForSsrc);
            this.peerSsrcs = [acceptSsrc];
            this.logger.debug('accept ssrc assigned', {
                callId,
                jid: peerDeviceJidForSsrc,
                ssrc: `0x${acceptSsrc.toString(16)}`
            });
        }
        this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
        this.sctpRelay.resendSubscriptions();
        if (!srtpFromPeerKey) {
            this.initSrtpKeys();
        }
        if (this.info.relayData?.participantJids) {
            const otherDevices = this.info.relayData.participantJids.filter((jid) => {
                if (jid === acceptingDeviceJid)
                    return false;
                const jidBase = toUserJid(jid);
                if (jidBase === ourBase)
                    return false;
                return true;
            });
            for (const deviceJid of otherDevices) {
                try {
                    const terminateNode = buildTerminateStanza(deviceJid, callId, callCreator, undefined, 'accepted_elsewhere');
                    await this.deps.lowLevelCoordinator.sendNode(terminateNode);
                }
                catch (err) {
                    this.logger.error('error sending terminate_elsewhere', {
                        deviceJid,
                        message: toError(err).message
                    });
                }
            }
        }
        try {
            const transportNode = buildTransportStanza(acceptingDeviceJid, callId, callCreator, meId, '1', '1');
            await this.deps.lowLevelCoordinator.sendNode(transportNode);
        }
        catch (err) {
            this.logger.error('error sending transport', {
                message: toError(err).message
            });
        }
        try {
            const muteNode = buildMuteV2Stanza(acceptingDeviceJid, callId, callCreator, 0, meId);
            await this.deps.lowLevelCoordinator.sendNode(muteNode);
        }
        catch (err) {
            this.logger.error('error sending mute_v2', {
                message: toError(err).message
            });
        }
        const acceptMsgId = node.attrs?.id;
        if (acceptMsgId) {
            try {
                const receiptNode = buildAcceptReceiptStanza(acceptingDeviceJid, acceptMsgId, callId, callCreator, ourJid);
                await this.deps.lowLevelCoordinator.sendNode(receiptNode);
            }
            catch (err) {
                this.logger.error('error sending accept receipt', {
                    message: toError(err).message
                });
            }
        }
        if (this.sctpRelay.hasConnection()) {
            try {
                this.info.applyTransition({ type: 'media_connected' });
                this.delegate.emitState(this.info);
                this.startMediaFlow();
            }
            catch (err) {
                this.logger.trace('call transition skipped', { message: toError(err).message });
            }
        }
        else if (this.info.relayData) {
            await this.connectRelays(this.info.relayData.endpoints);
        }
    }
    async handleCallPreaccept(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        if (this.info.direction === CallDirection.Outgoing && this.info.relayData) {
            const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
            const callId = this.info.callId;
            const callCreator = this.info.callCreator;
            const destinationJids = this.info.relayData.participantJids || [];
            const seenRelayNames = new Set();
            for (const ep of this.info.relayData.endpoints) {
                const name = ep.relayName || '';
                if (!name || seenRelayNames.has(name))
                    continue;
                seenRelayNames.add(name);
                try {
                    const relayData = [
                        {
                            relayName: name,
                            latency: ep.c2rRtt || 0,
                            addressBytes: ep.addressBytes
                        }
                    ];
                    const relayLatencyNode = buildRelayLatencyStanza(this.info.peerJid, callId, callCreator, relayData, destinationJids, meId);
                    await this.deps.lowLevelCoordinator.sendNode(relayLatencyNode);
                }
                catch (err) {
                    this.logger.error('error sending relaylatency', {
                        relayName: name,
                        message: toError(err).message
                    });
                }
            }
            if (!this.initialTransportSent) {
                try {
                    const basePeerJid = toUserJid(peerJid);
                    const transportNode = buildTransportStanza(basePeerJid, callId, callCreator, meId);
                    await this.deps.lowLevelCoordinator.sendNode(transportNode);
                    this.initialTransportSent = true;
                }
                catch (err) {
                    this.logger.error('error sending initial transport', {
                        message: toError(err).message
                    });
                }
            }
        }
    }
    async handleCallTransport(_node) {
        const nodeInfo = extractNodeInfo(_node);
        if (!nodeInfo)
            return;
        const relays = extractRelayEndpoints(nodeInfo.innerNode);
        if (relays.length > 0 && !this.sctpRelay.hasConnection()) {
            this.info.relayData = {
                ...this.info.relayData,
                endpoints: relays
            };
            await this.connectRelays(relays);
        }
    }
    async handleCallAck(node) {
        const ackType = node.attrs?.type;
        if (ackType !== 'offer')
            return;
        const error = node.attrs?.error;
        if (error) {
            this.logger.error('ack error', { callId: this.info.callId, error });
            return;
        }
        const { relays, participantJids, uuid, selfPid, peerPid, hbhKey } = parseRelayFromAck(node);
        if (relays.length > 0) {
            this.info.relayData = {
                endpoints: relays,
                participantJids,
                uuid,
                selfPid,
                peerPid,
                hbhKey
            };
            this.logger.debug('offer ack relays parsed', {
                callId: this.info.callId,
                relayCount: relays.length,
                participantCount: participantJids.length
            });
            const callKey = this.info.encryptionKey;
            if (participantJids.length > 0) {
                const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
                const meId = this.deps.authClient.getCurrentCredentials()?.meJid;
                const ourCredJid = meLid || meId || '';
                const ourBase = ourCredJid ? toUserJid(ourCredJid) : '';
                const ourDeviceJid = this.ensureDeviceJid(participantJids.find((jid) => {
                    const jidBase = toUserJid(jid);
                    return jidBase === ourBase && /:\d+@/.test(jid);
                }) || ourCredJid);
                const peerJids = participantJids.filter((jid) => {
                    const jidBase = toUserJid(jid);
                    return jidBase !== ourBase;
                });
                const peerDeviceJid = peerJids[0] ? this.ensureDeviceJid(peerJids[0]) : undefined;
                const newSelfSsrc = generateSecureSsrc(this.info.callId, ourDeviceJid);
                if (newSelfSsrc !== this.selfSsrc) {
                    this.selfSsrc = newSelfSsrc;
                    this.rtpSession = RtpSession.whatsappOpus(newSelfSsrc);
                }
                if (peerDeviceJid) {
                    const peerDeviceSsrc = generateSecureSsrc(this.info.callId, peerDeviceJid);
                    this.peerSsrcs = [peerDeviceSsrc];
                }
                if (callKey) {
                    this.initSrtpKeys();
                }
                else {
                    this.logger.media('no call_key, srtp not initialized', {
                        callId: this.info.callId
                    });
                }
            }
            if (this.info.isInitiator && !this.outgoingPreacceptSent) {
                try {
                    const preacceptNode = buildPreacceptStanza(this.info.peerJid, this.info.callId, this.info.callCreator);
                    await this.deps.lowLevelCoordinator.sendNode(preacceptNode);
                    this.outgoingPreacceptSent = true;
                }
                catch (err) {
                    this.logger.error('error sending preaccept (caller)', {
                        message: toError(err).message
                    });
                }
            }
            await this.connectRelays(relays);
            if (this.srtpSession &&
                this.rtpSession &&
                this.opusCodec &&
                this.sctpRelay.hasConnection()) {
                this.audioEngine.startSilenceCapture();
            }
        }
    }
    async handleCallRelaylatency(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const inner = nodeInfo.innerNode;
        const callId = inner.attrs?.['call-id'] || this.info.callId;
        const callCreator = inner.attrs?.['call-creator'] || this.info.callCreator;
        const teNodes = getNodeChildrenByTag(inner, 'te');
        if (teNodes.length === 0)
            return;
        const destinationJids = this.info.relayData?.participantJids || [];
        if (destinationJids.length > 0) {
            const forwardNode = buildRelaylatencyForwardStanza(peerJid, callId, callCreator, teNodes, destinationJids);
            try {
                await this.deps.lowLevelCoordinator.sendNode(forwardNode);
            }
            catch (err) {
                this.logger.error('error forwarding relaylatency', {
                    message: toError(err).message
                });
            }
        }
    }
    handleRelayElection(node) {
        const inner = getFirstNodeChild(node);
        if (!inner)
            return;
        let electedRelayIdx;
        if (inner.attrs?.['elected_relay_idx'] !== undefined) {
            const parsed = Number(inner.attrs['elected_relay_idx']);
            if (Number.isSafeInteger(parsed) && parsed >= 0)
                electedRelayIdx = parsed;
        }
        else if (inner.attrs?.['relay_id'] !== undefined) {
            const parsed = Number(inner.attrs['relay_id']);
            if (Number.isSafeInteger(parsed) && parsed >= 0)
                electedRelayIdx = parsed;
        }
        else if (inner.content instanceof Uint8Array) {
            const bytes = inner.content;
            if (bytes.length >= 4)
                electedRelayIdx = readUInt32BE(bytes, 0);
            else if (bytes.length > 0)
                electedRelayIdx = bytes[0];
        }
        if (electedRelayIdx !== undefined) {
            this.info.electedRelayIdx = electedRelayIdx;
            this.logger.debug('elected relay index', {
                callId: this.info.callId,
                electedRelayIdx
            });
        }
    }
    async handleCallMuteV2(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        try {
            const muteNode = buildMuteV2Stanza(peerJid, callId, callCreator, 0, meId);
            await this.deps.lowLevelCoordinator.sendNode(muteNode);
        }
        catch (err) {
            this.logger.error('error sending mute_v2 response', {
                message: toError(err).message
            });
        }
    }

    async handleCallVideo(node) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const inner = nodeInfo.innerNode;
        const state = Number(inner.attrs?.state ?? Number.NaN);
        if (!Number.isFinite(state))
            return;
        const peerJid = this.acceptedByJid || this.info.peerJid;
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        this.logger.media('inbound video state', { callId, state });
        switch (state) {
            case VideoState.UpgradeRequest:
            case VideoState.UpgradeRequestV2: {
                this.peerVideoUpgradePending = true;
                await this.enableVideoMidCall();
                try {
                    const accept = buildVideoStateStanza(peerJid, callId, callCreator, VideoState.UpgradeAccept, { dec: VideoDecAccept });
                    await this.deps.lowLevelCoordinator.sendNode(accept);
                }
                catch (err) {
                    this.logger.error('error sending video upgrade accept', { callId, message: toError(err).message });
                }
                this.peerVideoUpgradePending = false;
                this.info.mediaType = CallMediaType.Video;
                this.info.stateData.videoOff = false;
                this.delegate.emitState(this.info);
                this.delegate.emitVideoState?.(this.info, { active: true, upgrade: true, raw: state });
                break;
            }
            case VideoState.Stopped: {
                this.disableVideoMidCall({ keepSource: true });
                this.info.stateData.videoOff = true;
                this.delegate.emitState(this.info);
                this.delegate.emitVideoState?.(this.info, { active: false, upgrade: false, raw: state });
                break;
            }
            case VideoState.UpgradeReject:
            case VideoState.UpgradeCancel: {

                this.disableVideoMidCall({ keepSource: true });
                this.delegate.emitVideoState?.(this.info, { active: false, upgrade: false, raw: state });
                break;
            }
            case VideoState.Enabled: {
                this.delegate.emitVideoState?.(this.info, { active: true, upgrade: false, raw: state });
                break;
            }
            default:
                break;
        }
    }

    async startVideoMidCall() {
        const peerJid = this.acceptedByJid || this.info.peerJid;
        const request = buildVideoStateStanza(peerJid, this.info.callId, this.info.callCreator, VideoState.UpgradeRequestV2, { dec: VideoDecRequest });
        await this.deps.lowLevelCoordinator.sendNode(request);
        await this.enableVideoMidCall();
        this.info.mediaType = CallMediaType.Video;
        this.info.stateData.videoOff = false;
        this.delegate.emitState(this.info);
        this.delegate.emitVideoState?.(this.info, { active: true, upgrade: true, raw: VideoState.UpgradeRequestV2 });
    }
    async enableVideoMidCall() {
        if (this.videoRtpStream && this.videoSrtpSession)
            return;
        const creds = this.deps.authClient.getCurrentCredentials();
        const selfLid = creds?.meLid || creds?.meJid || '';
        if (!this.videoSsrc) {
            this.videoSsrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(selfLid), 2);
        }
        this.videoRtpStream = new VideoRtpStream(this.videoSsrc, videoRtpDurationSamples(this.videoEngine.frameDurationMs));

        if (this.srtpSession) {
            const meLid = creds?.meLid;
            const meId = creds?.meJid;
            const ourBase = toUserJid(meLid || meId || '');
            const participants = this.info.relayData?.participantJids || [];
            const ourDeviceJid = this.ensureDeviceJid(participants.find((jid) => toUserJid(jid) === ourBase && /:\d+@/.test(jid)) || meLid || meId || '');
            const peerDeviceJid = this.ensureDeviceJid(this.acceptedByJid || this.info.peerJid);
            try {
                const sendKeying = derivePerJidSrtpKey(this.info.encryptionKey, ourDeviceJid);
                const recvKeying = derivePerJidSrtpKey(this.info.encryptionKey, peerDeviceJid);
                this.videoSrtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
                this.videoRtcpSession = new SrtcpSendContext(sendKeying);
            }
            catch (err) {
                this.logger.error('video srtp key derivation failed', { callId: this.info.callId, message: toError(err).message });
            }
        }
        this.videoAssembler = new H264AccessUnitAssembler();

        if (!this.videoEngine.hasSource()) {
            try {
                await this.videoEngine.loadBlankSource();
            }
            catch (err) {
                this.logger.error('blank video fallback unavailable', { callId: this.info.callId, message: toError(err).message });
            }
        }
        if (this.sctpRelay.hasConnection()) {
            this.videoEngine.start();
        }
        this.logger.media('video enabled mid-call', {
            callId: this.info.callId,
            videoSsrc: `0x${this.videoSsrc.toString(16).toUpperCase()}`,
            source: this.videoEngine.sourceKind
        });
    }

    async stopVideoMidCall({ keepSource = false } = {}) {
        const peerJid = this.acceptedByJid || this.info.peerJid;
        try {
            const stop = buildVideoStateStanza(peerJid, this.info.callId, this.info.callCreator, VideoState.Stopped);
            await this.deps.lowLevelCoordinator.sendNode(stop);
        }
        catch (err) {
            this.logger.error('error sending video stop', { callId: this.info.callId, message: toError(err).message });
        }
        this.disableVideoMidCall({ keepSource });
        this.info.stateData.videoOff = true;
        this.delegate.emitState(this.info);
        this.delegate.emitVideoState?.(this.info, { active: false, upgrade: false, raw: VideoState.Stopped });
    }

    disableVideoMidCall({ keepSource = false } = {}) {
        this.videoEngine.stop({ keepSource });
        this.videoRtpStream = null;
        this.videoSrtpSession = null;
        this.videoRtcpSession = null;
        this.videoAssembler = null;
        this.info.mediaType = CallMediaType.Audio;
        this.logger.media('video disabled mid-call', { callId: this.info.callId, keptSource: keepSource });
    }
    handleCallTerminate() {
        try {
            this.info.applyTransition({
                type: 'terminated',
                reason: EndCallReason.UserEnded
            });
        }
        catch (err) {
            this.logger.trace('call transition skipped', { message: toError(err).message });
        }
        this.delegate.emitEnded(this.info);
        this.delegate.emitState(this.info);
        this.cleanup();
    }
    sendCapturedAudio(data) {
        const nowMs = Date.now();
        if (this.lastCapturedAtMs !== undefined) {
            const gapMs = nowMs - this.lastCapturedAtMs;

            if (gapMs > 300) {
                this.logger.warn('captured audio frame gap larger than expected', {
                    callId: this.info.callId,
                    gapMs,
                    audioSendCount: this.audioSendCount,
                    sctpBacklog: this.sctpRelay.getSendBacklog()
                });
            }
        }
        this.lastCapturedAtMs = nowMs;
        const hasRelay = this.sctpRelay.hasConnection();
        if (!this.rtpSession || !this.srtpSession || !this.opusCodec || !hasRelay) {
            this.audioDropCount++;
            if (this.audioDropCount === 1 || this.audioDropCount % 500 === 0) {
                const missing = [
                    !this.rtpSession && 'rtpSession',
                    !this.srtpSession && 'srtpSession',
                    !this.opusCodec && 'opusCodec',
                    !hasRelay && 'relayConnection'
                ]
                    .filter(Boolean)
                    .join(', ');
                this.logger.media('audio dropped', {
                    callId: this.info.callId,
                    dropCount: this.audioDropCount,
                    missing
                });
            }
            return;
        }
        for (let i = 0; i < data.length; i++) {
            if (!Number.isFinite(data[i])) {
                data[i] = 0;
            }
        }
        const frameSamples = this.encodeFrameSamples;
        if (!this.encodeBuffer) {
            if (!this.encodeBufferA) {
                this.encodeBufferA = new Float32Array(frameSamples);
                this.encodeBufferB = new Float32Array(frameSamples);
            }
            this.encodeBuffer = this.encodeBufferA;
            this.encodeBufferPos = 0;
        }
        let offset = 0;
        while (offset < data.length) {
            const toCopy = Math.min(data.length - offset, frameSamples - this.encodeBufferPos);
            this.encodeBuffer.set(data.subarray(offset, offset + toCopy), this.encodeBufferPos);
            this.encodeBufferPos += toCopy;
            offset += toCopy;
            if (this.encodeBufferPos < frameSamples)
                break;
            const frameData = this.encodeBuffer;
            this.encodeBuffer =
                frameData === this.encodeBufferA ? this.encodeBufferB : this.encodeBufferA;
            this.encodeBufferPos = 0;
            try {
                const opusFrame = this.opusCodec.encode(frameData);
                this.sendOpusFrame(opusFrame, false);
                this.realAudioSendCount++;
            }
            catch (err) {
                this.logger.error('encode error', {
                    callId: this.info.callId,
                    message: toError(err).message
                });
            }
        }
    }

    async loadVideo(videoPath) {
        if (this.info.mediaType !== CallMediaType.Video) {
            throw new Error(`Call ${this.info.callId} was not started with isVideo — no video SSRC/RTP stream to send on`);
        }
        await this.videoEngine.loadVideoFile(videoPath);
        // The video engine loops the file forever (-stream_loop -1) with no
        // way to detect "the video is done", so there's no natural point to
        // advance/end on video alone. Loop the paired audio track (loaded
        // from the same file just before this) to match, otherwise it plays
        // once and goes silent while the video keeps going.
        this.audioEngine.setLoopMode(true);

        if (this.sctpRelay.hasConnection()) {
            this.videoEngine.start();
        }
    }

    sendCapturedVideoAU(au, durationMs) {
        const hasRelay = this.sctpRelay.hasConnection();
        if (!this.videoRtpStream || !this.videoSrtpSession || !hasRelay) {
            this.videoDropCount++;
            if (this.videoDropCount === 1 || this.videoDropCount % 150 === 0) {
                const missing = [
                    !this.videoRtpStream && 'videoRtpStream',
                    !this.videoSrtpSession && 'videoSrtpSession',
                    !hasRelay && 'relayConnection'
                ].filter(Boolean).join(', ');
                this.logger.media('video access unit dropped', {
                    callId: this.info.callId, dropCount: this.videoDropCount, missing
                });
            }
            return;
        }
        try {

            const payload = buildAccessUnitPayload(au);
            if (!payload)
                return;
            const idr = auHasIDR(au);
            const mediaFrameInfo = idr ? VideoMediaFrameInfo.IDR : VideoMediaFrameInfo.Delta;
            this.videoRtpStream.setTimestampStride(videoRtpDurationSamples(durationMs));
            const chunks = packageH264NALU(payload);
            for (let i = 0; i < chunks.length; i++) {
                const header = this.videoRtpStream.nextPacket(i === chunks.length - 1, mediaFrameInfo);
                const srtpData = this.videoSrtpSession.protect(new RtpPacket(header, chunks[i]));
                this.sctpRelay.broadcast(toArrayBuffer(srtpData));
                this.videoOctetsSent = (this.videoOctetsSent + chunks[i].length) >>> 0;
            }
            this.videoSendCount++;
            if (idr)
                this.videoIdrSendCount++;

            if (idr || this.videoSendCount === 1 || this.videoSendCount % 150 === 0) {
                this.logger.media('video sent', {
                    callId: this.info.callId, sendCount: this.videoSendCount,
                    idrSentTotal: this.videoIdrSendCount,
                    auBytes: au.length, packets: chunks.length, idr
                });
            }
        }
        catch (err) {
            this.logger.error('error sending video', {
                callId: this.info.callId, message: toError(err).message
            });
        }
    }
    cleanup() {
        const opusStats = this.opusCodec?.getStats();
        this.logger.media('call stats', {
            callId: this.info.callId,
            relayPackets: this.relayPacketCount,
            recvOk: this.audioRecvCount,
            srtpErrors: this.srtpErrorCount,
            sent: this.audioSendCount,
            dropped: this.audioDropCount,
            opusOk: opusStats?.success ?? 0,
            opusErr: opusStats?.errors ?? 0,
            videoSent: this.videoSendCount,
            videoIdrSent: this.videoIdrSendCount,
            videoDropped: this.videoDropCount
        });
        this.audioEngine.setOnAudioFinished(null);
        this.audioEngine.stop();
        this.videoEngine.stop();
        this.sctpRelay.cleanup();
        if (this.rtcpTimer) {
            clearInterval(this.rtcpTimer);
            this.rtcpTimer = null;
        }
        if (this.opusCodec) {
            this.opusCodec.destroy();
            this.opusCodec = null;
        }
        this.rtpSession = null;
        this.srtpSession = null;
        this.audioRtcpSession = null;
        this.audioRtcpCname = null;
        this.audioOctetsSent = 0;
        this.videoRtpStream = null;
        this.videoSrtpSession = null;
        this.videoRtcpSession = null;
        this.videoRtcpCname = null;
        this.videoOctetsSent = 0;
        this.videoSsrc = 0;
        this.videoAssembler = null;
        this.peerVideoUpgradePending = false;
        this.mediaStartedAtMs = null;
        this.videoSendCount = 0;
        this.videoIdrSendCount = 0;
        this.videoDropCount = 0;
        this.audioSendCount = 0;
        this.audioDropCount = 0;
        this.audioRecvCount = 0;
        this.srtpErrorCount = 0;
        this.relayPacketCount = 0;
        this.stunResponseCount = 0;
        this.selfEchoCount = 0;
        this.lastRecvSeq = -1;
        this.recvSeqGaps = 0;
        this.actualPeerSsrc = null;
        this.ssrcResubscribed = false;
        this.recvRealCount = 0;
        this.recvDtxCount = 0;
        this.initialTransportSent = false;
        this.outgoingPreacceptSent = false;
        this.firstPacketSent = false;
        this.realAudioSendCount = 0;
        this.encodeBuffer = null;
        this.encodeBufferPos = 0;
        this.acceptedByJid = null;
    }
    get encodeFrameSamples() {
        return this.opusCodec?.getFrameSize() ?? 960;
    }
    get rtpTsDelta() {
        return this.encodeFrameSamples;
    }
    sendOpusFrame(opusFrame, isSilence) {
        if (!this.rtpSession || !this.srtpSession)
            return;
        try {
            let rtpPayload = opusFrame;
            const authPadding = SRTP_AUTH_TAG_LEN - SRTP_SEND_AUTH_TAG_LEN;
            if (authPadding > 0) {
                if (!this.authPaddingBuffer || this.authPaddingBuffer.length !== authPadding) {
                    this.authPaddingBuffer = new Uint8Array(authPadding);
                }
                rtpPayload = concatBytes([rtpPayload, this.authPaddingBuffer]);
            }
            const marker = !this.firstPacketSent;
            const tsDelta = this.rtpTsDelta;
            const rtpPacket = this.rtpSession.createPacketWithDuration(rtpPayload, tsDelta, marker);
            if (this.debeEnabled) {
                rtpPacket.header.extension = true;
                rtpPacket.header.extensionProfile = 0xdebe;
                rtpPacket.header.extensionData = WaCallMediaSession.EMPTY_BYTES;
            }
            if (!this.firstPacketSent) {
                this.firstPacketSent = true;
            }
            const srtpData = this.srtpSession.protect(rtpPacket);
            this.sctpRelay.broadcast(toArrayBuffer(srtpData));
            this.audioSendCount++;
            this.audioOctetsSent = (this.audioOctetsSent + rtpPayload.length) >>> 0;
            if (this.audioSendCount === 1 || this.audioSendCount % 500 === 0) {
                this.logger.media('audio sent', {
                    callId: this.info.callId,
                    sendCount: this.audioSendCount,
                    opusBytes: opusFrame.length,
                    srtpBytes: srtpData.length,
                    silence: isSilence,
                    sctpBacklog: this.sctpRelay.getSendBacklog()
                });
            }
        }
        catch (err) {
            this.logger.error('error sending audio', {
                callId: this.info.callId,
                message: toError(err).message
            });
        }
    }
    ensureDeviceJid(jid) {
        if (/:\d+@/.test(jid))
            return jid;
        return jid.replace('@', ':0@');
    }
    initSrtpKeys() {
        const callKey = this.info.encryptionKey;
        if (!callKey) {
            this.logger.media('no call_key, srtp not initialized', { callId: this.info.callId });
            return;
        }
        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid;
        const ourCredJid = meLid || meId || '';
        const ourBase = toUserJid(ourCredJid);
        const participants = this.info.relayData?.participantJids || [];
        const ourDeviceJid = this.ensureDeviceJid(participants.find((jid) => {
            const jBase = toUserJid(jid);
            return jBase === ourBase && /:\d+@/.test(jid);
        }) || ourCredJid);
        let rawPeerJid = this.acceptedByJid || this.info.peerJid;
        if (!this.acceptedByJid) {
            const peerFromParticipants = participants.find((jid) => {
                const jBase = toUserJid(jid);
                return jBase !== ourBase;
            });
            if (peerFromParticipants)
                rawPeerJid = peerFromParticipants;
        }
        const peerDeviceJid = this.ensureDeviceJid(rawPeerJid);
        try {
            const sendKeying = derivePerJidSrtpKey(callKey, ourDeviceJid);
            const recvKeying = derivePerJidSrtpKey(callKey, peerDeviceJid);
            this.srtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
            this.audioRtcpSession = new SrtcpSendContext(sendKeying);
            if (this.info.mediaType === CallMediaType.Video) {

                this.videoSrtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
                this.videoRtcpSession = new SrtcpSendContext(sendKeying);
            }
            this.startRtcpSenderReports();
            this.logger.debug('srtp per-jid keys initialized', {
                callId: this.info.callId,
                sendJid: ourDeviceJid,
                recvJid: peerDeviceJid
            });
        }
        catch (err) {
            this.logger.debug('srtp key derivation failed', {
                callId: this.info.callId,
                message: toError(err).message
            });
        }
    }

    startRtcpSenderReports() {
        if (this.rtcpTimer)
            clearInterval(this.rtcpTimer);
        if (!this.audioRtcpCname)
            this.audioRtcpCname = generateWhatsappRtcpCname();
        if (!this.videoRtcpCname)
            this.videoRtcpCname = generateWhatsappRtcpCname();
        this.rtcpTimer = setInterval(() => {
            if (!this.sctpRelay.hasConnection())
                return;
            const nowMs = Date.now();
            try {
                if (this.audioRtcpSession && this.selfSsrc) {
                    const stats = {
                        packetsSent: this.audioSendCount,
                        octetsSent: this.audioOctetsSent,
                        rtpTimestamp: this.rtpSession?.timestamp ?? 0
                    };
                    const plain = buildSenderReportWithSdes(this.selfSsrc, stats, nowMs, this.audioRtcpCname);
                    const protectedPacket = this.audioRtcpSession.protect(this.selfSsrc, plain);
                    this.sctpRelay.broadcast(toArrayBuffer(protectedPacket));
                }
                if (this.videoRtcpSession && this.videoSsrc && this.videoSendCount > 0) {
                    const stats = {
                        packetsSent: this.videoSendCount,
                        octetsSent: this.videoOctetsSent,
                        rtpTimestamp: this.videoRtpStream?.timestamp ?? 0
                    };
                    const plain = buildSenderReportWithSdes(this.videoSsrc, stats, nowMs, this.videoRtcpCname);
                    const protectedPacket = this.videoRtcpSession.protect(this.videoSsrc, plain);
                    this.sctpRelay.broadcast(toArrayBuffer(protectedPacket));
                }

                if (this.mediaStartedAtMs) {
                    const wallElapsedMs = nowMs - this.mediaStartedAtMs;
                    const audioElapsedMs = this.audioSendCount * 60;
                    const videoElapsedMs = this.videoSendCount * (1000 / this.videoEngine.frameRate);
                    this.logger.media('av sync check', {
                        callId: this.info.callId,
                        wallElapsedMs,
                        audioElapsedMs,
                        videoElapsedMs,
                        audioMinusWallMs: audioElapsedMs - wallElapsedMs,
                        videoMinusWallMs: Math.round(videoElapsedMs - wallElapsedMs)
                    });
                }
            }
            catch (err) {
                this.logger.debug('rtcp sender report failed', {
                    callId: this.info.callId,
                    message: toError(err).message
                });
            }
        }, 1500);
    }
    resetEncodeState() {
        this.encodeBuffer = null;
        this.encodeBufferPos = 0;
        this.realAudioSendCount = 0;
    }
    onRelayConnected() {
        if (this.info.stateData.state === CallState.Connecting) {
            try {
                this.info.applyTransition({ type: 'media_connected' });
                this.delegate.emitState(this.info);
                this.startMediaFlow();
                this.logger.media('relay connected, call active', { callId: this.info.callId });
            }
            catch (err) {
                this.logger.trace('call transition skipped', { message: toError(err).message });
            }
        }
    }
    onRelayData(data) {
        this.relayPacketCount++;
        if (isStunPacket(data)) {
            this.stunResponseCount++;
            return;
        }
        if (!isRtpPacket(data))
            return;
        const pt = data[1] & 0x7f;
        if (pt === PayloadType.H264) {
            this.onRelayVideoData(data);
            return;
        }
        if (!this.srtpSession || !this.opusCodec)
            return;
        if (pt !== 120)
            return;
        if (data.length >= 12) {
            const ssrc = ((data[8] << 24) | (data[9] << 16) | (data[10] << 8) | data[11]) >>> 0;
            if (ssrc === this.selfSsrc) {
                this.selfEchoCount++;
                return;
            }
            if (!this.ssrcResubscribed && this.actualPeerSsrc === null) {
                this.actualPeerSsrc = ssrc;
                const knownSsrc = this.peerSsrcs.includes(ssrc);
                if (!knownSsrc) {
                    this.peerSsrcs = [ssrc];
                    this.ssrcResubscribed = true;
                    this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
                    this.sctpRelay.resendSubscriptions();
                }
            }
        }
        try {
            const rtpPacket = this.srtpSession.unprotect(data);
            const opusPayload = rtpPacket.payload;
            this.audioRecvCount++;
            if (opusPayload.length === 0)
                return;
            const seq = rtpPacket.header.sequenceNumber;
            if (this.lastRecvSeq >= 0) {
                const expected = (this.lastRecvSeq + 1) & 0xffff;
                if (seq !== expected) {
                    const gap = ((seq - this.lastRecvSeq + 65536) % 65536) - 1;
                    this.recvSeqGaps += gap;
                }
            }
            this.lastRecvSeq = seq;
            const isDtx = opusPayload.length <= 2;
            if (isDtx)
                this.recvDtxCount++;
            else
                this.recvRealCount++;
            let audioData = this.opusCodec.decode(opusPayload);
            if (audioData.length > 0 && audioData.length < 960) {
                const padded = new Float32Array(960);
                padded.set(audioData);
                audioData = padded;
            }
            this.audioEngine.onPlaybackData(audioData);
            this.delegate.emitInboundAudio(this.info, audioData);
            if (this.audioRecvCount % 1500 === 0) {
                const stats = this.opusCodec.getStats();

                // trace level, sampled at %1500 (~every 30s) to avoid flooding.
                this.logger.trace('audio recv stats', {
                    callId: this.info.callId,
                    recvCount: this.audioRecvCount,
                    real: this.recvRealCount,
                    dtx: this.recvDtxCount,
                    decodeOk: stats.success,
                    decodeErr: stats.errors
                });
            }
        }
        catch (err) {
            this.srtpErrorCount++;
            if (this.srtpErrorCount <= 5) {
                const ssrc = data.length >= 12 ? readUInt32BE(data, 8) : 0;
                this.logger.debug('srtp recv error', {
                    callId: this.info.callId,
                    errorCount: this.srtpErrorCount,
                    message: toError(err).message,
                    ssrc: `0x${ssrc.toString(16)}`
                });
            }
        }
    }

    onRelayVideoData(data) {
        if (!this.videoSrtpSession || !this.videoAssembler)
            return;
        try {
            const rtpPacket = this.videoSrtpSession.unprotect(data);
            const [accessUnit, complete] = this.videoAssembler.push(rtpPacket.header.sequenceNumber, rtpPacket.header.marker, rtpPacket.payload);
            if (complete && accessUnit) {
                this.delegate.emitInboundVideo?.(this.info, accessUnit);
            }
        }
        catch (err) {
            this.srtpErrorCount++;
            if (this.srtpErrorCount <= 5) {
                this.logger.debug('video srtp recv error', {
                    callId: this.info.callId,
                    message: toError(err).message
                });
            }
        }
    }
    async connectRelays(endpoints) {
        this.logger.debug('connecting relays', {
            callId: this.info.callId,
            endpointCount: endpoints.length
        });
        const seen = new Set();
        const uniqueEndpoints = [];
        for (const ep of endpoints) {
            if ((ep.protocol ?? 0) !== 0)
                continue;
            const key = `${ep.ip}:${ep.port}`;
            if (!seen.has(key)) {
                seen.add(key);
                uniqueEndpoints.push(ep);
            }
        }
        const usable = uniqueEndpoints.filter((ep) => ep.key && ep.rawToken);

        const inbound = this.info.direction === CallDirection.Incoming;
        let chosen = null;
        if (inbound) {
            chosen = usable.find((ep) => ep.isFna) ?? null;
        }
        if (!chosen) {
            chosen =
                usable.find((ep) => !ep.isFna && parseInt(ep.authTokenId, 10) !== 0) ??
                usable.find((ep) => !ep.isFna) ??
                usable[0] ??
                null;
        }
        const WA_RELAY_PORT = 3478;
        const relays = chosen
            ? [
                  {
                      ip: chosen.ip,
                      port: WA_RELAY_PORT,
                      token: chosen.token,
                      authToken: chosen.authToken,
                      rawAuthToken: chosen.rawAuthToken,
                      rawToken: chosen.rawToken,
                      key: chosen.key,
                      relayId: chosen.relayId,
                      name: chosen.relayName || `${chosen.ip}:${WA_RELAY_PORT}`,
                      authTokenId: chosen.authTokenId,
                      isFna: chosen.isFna
                  }
              ]
            : [];
        if (relays.length === 0) {
            this.logger.error('no relay configs', { callId: this.info.callId });
            return;
        }
        this.logger.media('relay selected', {
            callId: this.info.callId,
            inbound,
            candidateCount: usable.length,
            chosen: relays[0].name,
            isFna: relays[0].isFna
        });
        this.sctpRelay.setSsrc(this.selfSsrc);
        if (this.info.mediaType === CallMediaType.Video) {
            this.sctpRelay.setVideoSsrc(this.videoSsrc);
        }
        this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
        try {
            await this.sctpRelay.configureRelays(relays);
            this.logger.debug('sctp relays configured', {
                callId: this.info.callId,
                connected: this.sctpRelay.getConnectedCount()
            });
        }
        catch (err) {
            this.logger.error('sctp relay error', {
                callId: this.info.callId,
                message: toError(err).message
            });
        }
    }
    startMediaFlow() {
        this.mediaStartedAtMs = Date.now();
        this.resetEncodeState();
        this.audioEngine.startPlayback();
        this.audioEngine.startCapture();

        setImmediate(() => this.videoEngine.start());
    }
}
