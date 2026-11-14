import { toUserJid } from '../shim/protocol.js';
import { getFirstNodeChild, getNodeChildrenByTag } from '../shim/transport.js';
import { toError, uint8TimingSafeEqual } from '../shim/util.js';
import { concatBytes, EMPTY_BYTES, readUInt32BE, toArrayBuffer } from '../bytes.js';
import { derivePerJidSrtpKey } from '../crypto/encryption.js';
import { SrtpSession } from '../crypto/srtp.js';
import { SrtcpSendContext } from '../crypto/rtcp.js';
import { deriveWasmRelayStreamSsrcs, generateSecureSsrc } from '../crypto/ssrc.js';
import { WaAppDataStream } from '../app-data/WaAppDataStream.js';
import { buildScreenShareStanza, parseScreenShareNode, WA_SCREEN_SHARE_STATE } from '../signaling/screen-share.js';
import { MLowCodec } from '../media/mlow-codec.js';
import { RtpSession, RtpPacket, VideoRtpStream, VideoMediaFrameInfo, videoRtpDurationSamples } from '../media/rtp.js';
import { auHasIDR, buildAccessUnitPayload, packageH264NALU, H264AccessUnitAssembler } from '../media/h264.js';
import { buildSenderReportWithSdes, generateWhatsappRtcpCname } from '../media/rtcp.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { WaVideoEngine } from '../media/WaVideoEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { isRtpPacket, isStunPacket } from '../relay/stun.js';
import { WaManualRelay } from '../relay/WaManualRelay.js';
import { buildAcceptReceiptStanza, buildAcceptStanza, buildMuteV2Stanza, buildPreacceptStanza, buildRaiseHandStanza, buildRejectStanza, buildRelaylatencyForwardStanza, buildRelayLatencyStanza, buildTerminateStanza, buildTransportStanza, buildVideoStateStanza, decryptCallKey, extractNodeInfo, extractRelayEndpoints, needsDecryption, parseMuteV2, parseRaiseHandState, VideoDecAccept, VideoDecRequest, VideoState } from '../signaling/signaling.js';
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
    answeredRelays = new Map();
    announcedRelayNames = new Set();
    relayLatencyOpened = false;
    selfSsrc = 0;
    selfSsrcJid = '';
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
    reconnecting = false;

    videoSsrc = 0;
    videoRtpStream = null;
    videoSrtpSession = null;
    videoEngine;
    videoSendCount = 0;
    videoKeyframeRequired = false;
    videoFlushSeen = 0;
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
    mediaFlowStarted = false;

    peerVideoUpgradePending = false;
    peerVideoActive = false;
    peerVideoJids = new Set();
    videoAssembler = null;
    appDataStream = null;
    appDataSrtpSession = null;
    peerAppDataSsrcs = new Set();
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
        this.sctpRelay.on('relay_answered', (detail) => {
            this.onRelayAnswered(detail);
        });
        this.sctpRelay.on('relay_receive', (relayInfo) => {
            this.onRelayData(relayInfo.data);
        });
        this.sctpRelay.on('relay_lost', (detail) => {
            if (!detail.anyOpen)
                this.markReconnecting({ attempt: 0, max: detail.max });
        });
        this.sctpRelay.on('relay_retrying', (detail) => {
            if (!detail.anyOpen)
                this.markReconnecting({ attempt: detail.attempt, max: detail.max });
        });
        this.sctpRelay.on('relay_recovered', () => {
            if (!this.reconnecting || !this.sctpRelay.hasConnection())
                return;
            this.reconnecting = false;
            this.delegate.emitReconnected(this.info);
        });
        this.sctpRelay.on('relay_failed', (detail) => {
            if (!detail.anyOpen)
                this.endCall(EndCallReason.Failed).catch(() => { });
        });
    }
    get callId() {
        return this.info.callId;
    }
    markReconnecting(detail) {
        this.reconnecting = true;
        this.delegate.emitReconnecting(this.info, detail);
    }
    onDecodedAudio = (pcm) => {
        this.audioEngine.onPlaybackData(pcm);
        this.delegate.emitInboundAudio?.(this.info, pcm);
    };
    async initMedia(selfLid, peerJid) {
        const ssrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(selfLid));
        this.rtpSession = RtpSession.whatsappOpus(ssrc);
        this.selfSsrc = ssrc;
        this.selfSsrcJid = this.ensureDeviceJid(selfLid);
        const peerSsrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(peerJid));
        this.peerSsrcs = [peerSsrc];
        this.opusCodec = await MLowCodec.create({ logger: this.logger.child({ component: 'mlow' }) });
        if (this.info.mediaType === CallMediaType.Video) {
            this.videoSsrc = generateSecureSsrc(this.info.callId, this.ensureDeviceJid(selfLid), 2);
            this.videoRtpStream = new VideoRtpStream(this.videoSsrc, videoRtpDurationSamples(this.videoEngine.frameDurationMs));
            this.videoAssembler = new H264AccessUnitAssembler();
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
        await this.audioEngine.loadSource(audioPath);
        this.resetEncodeState();
    }
    setExternalAudioMode(enabled) {
        this.audioEngine.setExternalMode(enabled);
        if (enabled) {
            this.resetEncodeState();
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
    onRelayAnswered(detail) {
        if (!detail?.name || this.answeredRelays.has(detail.name))
            return;
        this.answeredRelays.set(detail.name, detail.rttMs);
        if (this.relayLatencyOpened) {
            void this.announceRelayLatency();
        }
    }
    async announceRelayLatency(isEligible = (ep) => this.answeredRelays.has(ep.relayName)) {
        if (!this.info.relayData)
            return;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const destinationJids = this.info.relayData.participantJids || [];
        for (const ep of this.info.relayData.endpoints) {
            const name = ep.relayName || '';
            if (!name || ep.ip.includes(':') || this.announcedRelayNames.has(name) || !isEligible(ep))
                continue;
            this.announcedRelayNames.add(name);
            try {
                const relayData = [
                    {
                        relayName: name,
                        latency: ep.c2rRtt ?? this.answeredRelays.get(name) ?? 0,
                        addressBytes: ep.addressBytes
                    }
                ];
                const relayLatencyNode = buildRelayLatencyStanza(this.info.peerJid, callId, callCreator, relayData, destinationJids, meId);
                await this.deps.lowLevelCoordinator.sendNode(relayLatencyNode);
            }
            catch (err) {
                this.announcedRelayNames.delete(name);
                this.logger.error('error sending relaylatency', {
                    relayName: name,
                    message: toError(err).message
                });
            }
        }
    }
    async sendIncomingRelayLatency() {
        if (!this.info.relayData)
            return;
        this.relayLatencyOpened = true;
        const dialed = new Set(this.selectRelayEndpoints(this.info.relayData.endpoints)
            .slice(0, this.sctpRelay.maxActiveRelays)
            .map((ep) => ep.relayName));
        await this.announceRelayLatency((ep) => dialed.size === 0 || dialed.has(ep.relayName) || this.answeredRelays.has(ep.relayName));
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
        catch { }
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const meLid = this.deps.authClient.getCurrentCredentials()?.meLid;
        const ourJid = meLid || meId;
        const ourBase = ourJid ? toUserJid(ourJid) : '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        const acceptingDeviceJid = peerJid;
        this.acceptedByJid = acceptingDeviceJid;
        if (this.actualPeerSsrc !== null) {
            this.ensureDeviceJid(acceptingDeviceJid);
        }
        else {
            const peerDeviceJidForSsrc = this.ensureDeviceJid(acceptingDeviceJid);
            const acceptSsrc = generateSecureSsrc(callId, peerDeviceJidForSsrc);
            this.peerSsrcs = [acceptSsrc];
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
                setTimeout(() => {
                    if (this.info.stateData.state === CallState.Ended) {
                        return;
                    }
                    this.startMediaFlow();
                }, 3000);
            }
            catch { }
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
            this.relayLatencyOpened = true;
            await this.announceRelayLatency();
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
                const peerCandidate = peerJids.find((jid) => /:\d+@/.test(jid) && !/:0@/.test(jid)) || peerJids[0];
                const peerDeviceJid = peerCandidate ? this.ensureDeviceJid(peerCandidate) : undefined;
                const newSelfSsrc = generateSecureSsrc(this.info.callId, ourDeviceJid);
                if (newSelfSsrc !== this.selfSsrc) {
                    this.selfSsrc = newSelfSsrc;
                    this.selfSsrcJid = ourDeviceJid;
                    this.rtpSession = RtpSession.whatsappOpus(newSelfSsrc);
                }
                if (peerDeviceJid) {
                    const peerDeviceSsrc = generateSecureSsrc(this.info.callId, peerDeviceJid);
                    this.peerSsrcs = [peerDeviceSsrc];
                }
                if (callKey) {
                    this.initSrtpKeys();
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
        }
    }
    async handleCallMuteV2(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const meId = this.deps.authClient.getCurrentCredentials()?.meJid ?? '';
        const callId = this.info.callId;
        const callCreator = this.info.callCreator;
        if (!this.isOwnAccountJid(peerJid)) {
            const payload = parseMuteV2(nodeInfo.innerNode);
            if (!payload.isRequest && payload.muted !== null && this.info.stateData.peerAudioMuted !== payload.muted) {
                this.info.stateData.peerAudioMuted = payload.muted;
                this.delegate.emitPeerMute?.(this.info, payload.muted);
            }
        }
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
    isOwnAccountJid(jid) {
        const creds = this.deps.authClient.getCurrentCredentials();
        const user = toUserJid(jid);
        return ((!!creds?.meLid && user === toUserJid(creds.meLid)) ||
            (!!creds?.meJid && user === toUserJid(creds.meJid)));
    }
    get videoSendActive() {
        return !!(this.videoRtpStream && this.videoSrtpSession);
    }
    async setHandRaised(raised) {
        if (!this.info.isActive)
            return;
        if (this.info.stateData.handRaised === raised)
            return;
        const node = buildRaiseHandStanza(this.acceptedByJid ?? this.info.peerJid, this.info.callId, this.info.callCreator, raised);
        try {
            await this.deps.lowLevelCoordinator.sendNode(node);
        }
        catch (err) {
            this.logger.warn('raise hand send failed', {
                raised,
                message: toError(err).message
            });
            throw err;
        }
        this.info.applyTransition({ type: 'hand_raise_changed', raised });
        this.delegate.emitState(this.info);
    }
    async setScreenShare(sharing) {
        if (!this.info.isActive)
            return;
        if (this.info.stateData.screenSharing === sharing)
            return;
        if (sharing && !this.videoSendActive) {
            throw new Error(`Call ${this.info.callId} carries no video to share the screen on`);
        }
        const peerDeviceJid = this.acceptedByJid ?? this.info.peerJid;
        const state = sharing ? WA_SCREEN_SHARE_STATE.Started : WA_SCREEN_SHARE_STATE.Stopped;
        try {
            await this.deps.lowLevelCoordinator.sendNode(buildScreenShareStanza(peerDeviceJid, this.info.callId, this.info.callCreator, state));
        }
        catch (err) {
            this.logger.warn('screen share request failed', {
                sharing,
                message: toError(err).message
            });
            throw err;
        }
        this.info.applyTransition({ type: 'screen_share_changed', sharing });
        this.delegate.emitState(this.info);
    }
    handleCallUserAction(node, peerJid) {
        this.applyPeerRaiseHand(node, peerJid);
    }
    handleCallRaiseHand(node, peerJid) {
        this.applyPeerRaiseHand(node, peerJid);
    }
    applyPeerRaiseHand(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        if (this.isOwnAccountJid(peerJid))
            return;
        const raised = parseRaiseHandState(nodeInfo.innerNode);
        if (raised === null)
            return;
        const raisedHands = this.info.raisedHands;
        if (raisedHands.has(peerJid) === raised)
            return;
        if (raised) {
            if (raisedHands.size >= 64)
                return;
            raisedHands.add(peerJid);
        }
        else {
            raisedHands.delete(peerJid);
        }
        this.delegate.emitHandRaise?.(this.info, peerJid, raised);
    }
    handleCallScreenShare(node) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo)
            return;
        const share = parseScreenShareNode(nodeInfo.innerNode);
        if (!share)
            return;
        this.info.peerScreenShare = share;
        this.delegate.emitScreenShare?.(this.info, share);
        this.delegate.emitState(this.info);
    }
    sendReaction(reaction) {
        if (!this.appDataStream || !this.appDataSrtpSession)
            return false;
        if (!this.info.isActive)
            return false;
        return this.appDataStream.sendReaction(reaction);
    }
    openAppDataStream(selfDeviceJid) {
        const ssrc = generateSecureSsrc(this.info.callId, selfDeviceJid, 6);
        this.appDataStream?.close();
        this.appDataStream = new WaAppDataStream({
            logger: this.logger.child({ component: 'app-data' }),
            ssrc,
            sendPacket: (packet) => {
                if (!this.appDataSrtpSession)
                    return false;
                return this.sctpRelay.broadcast(toArrayBuffer(this.appDataSrtpSession.protect(packet)));
            }
        });
    }
    trackPeerAppDataSsrcs(deviceJids) {
        for (const jid of deviceJids) {
            if (!jid)
                continue;
            if (this.peerAppDataSsrcs.size >= 16)
                break;
            this.peerAppDataSsrcs.add(generateSecureSsrc(this.info.callId, this.ensureDeviceJid(jid), 6));
        }
    }
    onAppDataPacket(data, payloadType, ssrc) {
        const stream = this.appDataStream;
        if (!stream || !this.appDataSrtpSession)
            return;
        try {
            const packet = this.appDataSrtpSession.unprotect(data);
            stream.observeInboundPayloadType(payloadType);
            for (const reaction of stream.receive(packet.payload, ssrc)) {
                this.delegate.emitCallReaction?.(this.info, reaction);
            }
        }
        catch { }
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
        const sourceJid = nodeInfo.peerJid || peerJid;
        const setPeerVideo = (on) => {
            const before = this.peerVideoJids.size;
            if (on)
                this.peerVideoJids.add(sourceJid);
            else
                this.peerVideoJids.delete(sourceJid);
            this.peerVideoActive = this.peerVideoJids.size > 0;
            return { before, after: this.peerVideoJids.size };
        };
        switch (state) {
            case VideoState.UpgradeRequest:
            case VideoState.UpgradeRequestV2: {
                setPeerVideo(true);
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
                this.delegate.emitVideoState?.(this.info, { active: true, upgrade: true, raw: state, jid: sourceJid });
                break;
            }
            case VideoState.Disabled:
            case VideoState.Stopped: {
                const { before, after } = setPeerVideo(false);
                if (state === VideoState.Disabled && before === after)
                    break;
                this.delegate.emitVideoState?.(this.info, {
                    active: false,
                    upgrade: false,
                    raw: state,
                    direction: 'inbound',
                    jid: sourceJid,
                    allOff: before > 0 && after === 0
                });
                break;
            }
            case VideoState.UpgradeReject:
            case VideoState.UpgradeCancel: {
                this.disableVideoMidCall({ keepSource: true });
                this.delegate.emitVideoState?.(this.info, { active: false, upgrade: false, raw: state });
                break;
            }
            case VideoState.Enabled: {
                setPeerVideo(true);
                this.delegate.emitVideoState?.(this.info, { active: true, upgrade: false, raw: state, direction: 'inbound', jid: sourceJid });
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
    }

    async swapVideoSource(videoPath) {
        if (this.info.mediaType !== CallMediaType.Video) {
            throw new Error(`Call ${this.info.callId} has no active video stream to swap`);
        }
        this.videoEngine.stop({ keepSource: false });
        await this.videoEngine.loadVideoFile(videoPath);
        this.audioEngine.setLoopMode(true);
        this.videoEngine.start();
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
    }
    handleCallTerminate() {
        try {
            this.info.applyTransition({
                type: 'terminated',
                reason: EndCallReason.UserEnded
            });
        }
        catch { }
        this.delegate.emitEnded(this.info);
        this.delegate.emitState(this.info);
        this.cleanup();
    }
    sendCapturedAudio(data) {
        const hasRelay = this.sctpRelay.hasConnection();
        if (!this.rtpSession || !this.srtpSession || !this.opusCodec || !hasRelay) {
            this.audioDropCount++;
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
        this.audioEngine.setLoopMode(true);

        if (this.mediaFlowStarted && this.sctpRelay.hasConnection()) {
            this.videoEngine.start();
        }
    }

    sendCapturedVideoAU(au, durationMs) {
        const hasRelay = this.sctpRelay.hasConnection();
        if (!this.videoRtpStream || !this.videoSrtpSession || !hasRelay) {
            this.videoDropCount++;
            return;
        }
        try {
            const payload = buildAccessUnitPayload(au);
            if (!payload)
                return;
            const idr = auHasIDR(au);
            const flushesBefore = this.sctpRelay.getVideoFlushCount();
            if (flushesBefore !== this.videoFlushSeen) {
                this.videoFlushSeen = flushesBefore;
                this.videoKeyframeRequired = true;
            }
            if (this.videoKeyframeRequired && !idr)
                return;
            const mediaFrameInfo = idr ? VideoMediaFrameInfo.IDR : VideoMediaFrameInfo.Delta;
            this.videoRtpStream.setTimestampStride(videoRtpDurationSamples(durationMs));
            const chunks = packageH264NALU(payload);
            for (let i = 0; i < chunks.length; i++) {
                const header = this.videoRtpStream.nextPacket(i === chunks.length - 1, mediaFrameInfo);
                const srtpData = this.videoSrtpSession.protect(new RtpPacket(header, chunks[i]));
                this.sctpRelay.broadcast(toArrayBuffer(srtpData));
                this.videoOctetsSent = (this.videoOctetsSent + chunks[i].length) >>> 0;
            }
            const flushesAfter = this.sctpRelay.getVideoFlushCount();
            if (flushesAfter !== flushesBefore) {
                this.videoFlushSeen = flushesAfter;
                this.videoKeyframeRequired = true;
            }
            else if (idr) {
                this.videoKeyframeRequired = false;
            }
            this.videoSendCount++;
            if (idr)
                this.videoIdrSendCount++;
        }
        catch (err) {
            this.logger.error('error sending video', {
                callId: this.info.callId, message: toError(err).message
            });
        }
    }
    cleanup() {
        this.audioEngine.setOnAudioFinished(null);
        this.audioEngine.stop();
        this.videoEngine.stop();
        this.sctpRelay.cleanup();
        this.answeredRelays.clear();
        this.announcedRelayNames.clear();
        this.relayLatencyOpened = false;
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
        this.appDataStream?.close();
        this.appDataStream = null;
        this.appDataSrtpSession = null;
        this.peerAppDataSsrcs.clear();
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
        this.peerVideoActive = false;
        this.peerVideoJids.clear();
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
            this.appDataSrtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
            this.openAppDataStream(ourDeviceJid);
            this.peerAppDataSsrcs.clear();
            this.trackPeerAppDataSsrcs([peerDeviceJid, ...participants.filter((jid) => toUserJid(jid) !== ourBase)]);
            this.audioRtcpSession = new SrtcpSendContext(sendKeying);
            if (this.info.mediaType === CallMediaType.Video) {
                this.videoSrtpSession = new SrtpSession(sendKeying, recvKeying, SRTP_SEND_AUTH_TAG_LEN, SRTP_RECV_AUTH_TAG_LEN);
                this.videoRtcpSession = new SrtcpSendContext(sendKeying);
            }
            this.startRtcpSenderReports();
        }
        catch { }
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
            }
            catch { }
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
                if (!this.acceptedByJid) {
                    return;
                }
                setTimeout(() => {
                    if (this.info.stateData.state === CallState.Ended) {
                        return;
                    }
                    this.startMediaFlow();
                }, 3000);
            }
            catch { }
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
        if (this.peerAppDataSsrcs.size > 0 && data.length >= 12) {
            const appDataSsrc = readUInt32BE(data, 8);
            if (this.peerAppDataSsrcs.has(appDataSsrc)) {
                this.onAppDataPacket(data, pt, appDataSsrc);
                return;
            }
        }
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
                    this.opusCodec.resetSequence();
                    this.lastRecvSeq = -1;
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
                const gap = ((seq - this.lastRecvSeq + 65536) % 65536) - 1;
                if (gap > 0 && gap < 0x8000)
                    this.recvSeqGaps += gap;
            }
            this.lastRecvSeq = seq;
            const isDtx = opusPayload.length <= 2;
            if (isDtx)
                this.recvDtxCount++;
            else
                this.recvRealCount++;
            this.opusCodec.decodeSequenced(seq, opusPayload, this.onDecodedAudio);
            if (this.audioRecvCount % 100 === 0) {
                const w = (this.lossWindow ??= { gaps: 0, pkts: 0 });
                const gaps = this.recvSeqGaps - w.gaps;
                const pkts = this.audioRecvCount - w.pkts;
                w.gaps = this.recvSeqGaps;
                w.pkts = this.audioRecvCount;
                const lossPct = pkts + gaps > 0 ? Math.min(100, Math.round((100 * gaps) / (pkts + gaps))) : 0;
                this.opusCodec.setExpectedPacketLossPercent(lossPct);
            }
        }
        catch (err) {
            this.srtpErrorCount++;
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
        }
    }
    selectRelayEndpoints(endpoints) {
        const seen = new Set();
        const uniqueEndpoints = [];
        for (const ep of endpoints) {
            if ((ep.protocol ?? 0) !== 0 || ep.ip.includes(':'))
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
        const ordered = chosen ? [chosen] : [];
        const orderedAddresses = new Set(chosen ? [chosen.ip] : []);
        for (const ep of usable) {
            if (ordered.length >= 4)
                break;
            if (orderedAddresses.has(ep.ip))
                continue;
            orderedAddresses.add(ep.ip);
            ordered.push(ep);
        }
        return ordered;
    }
    async connectRelays(endpoints) {
        const ordered = this.selectRelayEndpoints(endpoints);
        const relays = ordered.map((ep) => ({
            ip: ep.ip,
            port: ep.port || 3478,
            token: ep.token,
            authToken: ep.authToken,
            rawAuthToken: ep.rawAuthToken,
            rawToken: ep.rawToken,
            key: ep.key,
            relayId: ep.relayId,
            name: ep.relayName || `${ep.ip}:${ep.port || 3478}`,
            authTokenId: ep.authTokenId,
            isFna: ep.isFna
        }));
        if (relays.length === 0) {
            this.logger.error('no relay configs', { callId: this.info.callId });
            return;
        }
        this.sctpRelay.setParticipantIds(this.info.relayData?.selfPid, this.info.relayData?.peerPid);
        this.sctpRelay.setSsrc(this.selfSsrc);
        this.sctpRelay.setStreamSsrcs(this.selfSsrcJid ? deriveWasmRelayStreamSsrcs(this.info.callId, this.selfSsrcJid) : null);
        if (this.info.mediaType === CallMediaType.Video) {
            this.sctpRelay.setVideoSsrc(this.videoSsrc);
        }
        this.sctpRelay.setSubscriptionSsrc(this.peerSsrcs[0] ?? 0);
        try {
            await this.sctpRelay.configureRelays(relays);
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
        this.mediaFlowStarted = true;
        this.resetEncodeState();
        this.audioEngine.startPlayback();
        this.audioEngine.startCapture();

        this.videoEngine.start();
    }
}
