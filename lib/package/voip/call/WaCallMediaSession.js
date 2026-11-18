import { parseSignalAddressFromJid, toUserJid } from '../shim/protocol.js';
import { getFirstNodeChild, getNodeChildrenByTag } from '../shim/transport.js';
import { toError, uint8TimingSafeEqual } from '../shim/util.js';
import { concatBytes, EMPTY_BYTES, readUInt32BE, TEXT_ENCODER, toArrayBuffer } from '../bytes.js';
import { derivePerJidSrtpKey, generateCallKey } from '../crypto/encryption.js';
import { SrtpContext, SrtpSession } from '../crypto/srtp.js';
import { SrtcpSendContext } from '../crypto/rtcp.js';
import { deriveWasmRelayStreamSsrcs, formatParticipantId, generateSecureSsrc } from '../crypto/ssrc.js';
import { WaAppDataStream } from '../app-data/WaAppDataStream.js';
import { buildScreenShareStanza, parseScreenShareNode, WA_SCREEN_SHARE_STATE } from '../signaling/screen-share.js';
import { MLowCodec } from '../media/mlow-codec.js';
import { RtpSession, RtpPacket, VideoRtpStream, VideoMediaFrameInfo, videoRtpDurationSamples } from '../media/rtp.js';
import { auHasIDR, buildAccessUnitPayload, packageH264NALU, H264AccessUnitAssembler } from '../media/h264.js';
import { buildSenderReportWithSdes, generateWhatsappRtcpCname } from '../media/rtcp.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { WaVideoEngine } from '../media/WaVideoEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { buildGroupAllocateForRelay, isRtpPacket, isStunPacket } from '../relay/stun.js';
import { WaManualRelay } from '../relay/WaManualRelay.js';
import { buildAcceptReceiptStanza, buildAcceptStanza, buildGroupAcceptStanza, buildGroupEncRekeyStanza, buildGroupInviteOfferStanza, buildGroupPreacceptStanza, buildGroupTerminateStanza, buildWaitingRoomRequestStanza, callJidFor, encodeWAMessage, generateCallStanzaId, parseGroupEncRekey, parseGroupUpdate, parseInitialGroupAck, parseWaitingRoomUpdate, buildMuteV2Stanza, buildPreacceptStanza, buildRaiseHandStanza, buildRejectStanza, buildRelaylatencyForwardStanza, buildRelayLatencyStanza, buildTerminateStanza, buildTransportStanza, buildVideoStateStanza, decryptCallKey, extractNodeInfo, extractRelayEndpoints, needsDecryption, parseMuteV2, parseRaiseHandState, VideoDecAccept, VideoDecRequest, VideoState } from '../signaling/signaling.js';
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
            logger: this.logger.child({ component: 'sctp' }),
            maxActiveRelays: options.maxActiveRelays
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
        this.opusCodec = await MLowCodec.create({ logger: this.logger.child({ component: 'mlow' }), fec: true });
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
        this.audioEngine.release();
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

export async function resolveUserLid(deps, jid) {
    const raw = String(jid ?? '').trim();
    if (!raw) {
        throw new Error('participant is required');
    }
    const normalized = raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
    if (normalized.endsWith('@lid')) {
        return normalized;
    }
    const [mapped] = await deps.signalDeviceSync.queryLidsByPhoneJids([normalized]);
    if (!mapped?.lidJid?.endsWith('@lid')) {
        throw new Error(`no LID mapping found for ${normalized}`);
    }
    return mapped.lidJid;
}
export async function listUserDevices(deps, lid) {
    const devices = await deps.signalDeviceSync.getDevices([lid]);
    return [...new Set(devices.filter(Boolean))];
}
export function stripDevice(jid) {
    return String(jid).replace(/:\d+@/, '@');
}
function unwrapGroupForwarding(data) {
    if (data.length === 0 || data[0] !== 0x09) {
        return data;
    }
    const headerBytes = { 2: 8, 4: 12, 7: 18 }[data[1]];
    if (!headerBytes || data.length < headerBytes + 12 || data[headerBytes] >> 6 !== 2) {
        return null;
    }
    return data.subarray(headerBytes);
}
function joinFloats(left, right) {
    const merged = new Float32Array(left.length + right.length);
    merged.set(left, 0);
    merged.set(right, left.length);
    return merged;
}
export class GroupAudioMixer {
    chunkSamples = 160;
    frameSamples = 960;
    streams = new Map();
    allowed = new Set();
    rosterApplied = false;
    framePending = new Float32Array(0);
    add(participantId, pcm) {
        if (!participantId || pcm.length === 0) {
            return false;
        }
        if (this.rosterApplied && !this.allowed.has(participantId)) {
            return false;
        }
        let queue = this.streams.get(participantId);
        if (!queue) {
            queue = { pending: new Float32Array(0), started: false };
            this.streams.set(participantId, queue);
        }
        const maxSamples = this.frameSamples * 4;
        if (pcm.length >= maxSamples) {
            queue.pending = pcm.slice(pcm.length - maxSamples);
            return true;
        }
        const merged = joinFloats(queue.pending, pcm);
        queue.pending = merged.length > maxSamples ? merged.slice(merged.length - maxSamples) : merged;
        return true;
    }
    retain(participantIds) {
        this.allowed = new Set(participantIds.filter(Boolean));
        this.rosterApplied = true;
        for (const participantId of [...this.streams.keys()]) {
            if (!this.allowed.has(participantId)) {
                this.streams.delete(participantId);
            }
        }
    }
    mixChunk() {
        const mixed = new Float32Array(this.chunkSamples);
        let contributed = false;
        for (const participantId of [...this.streams.keys()].sort()) {
            const queue = this.streams.get(participantId);
            if (!queue.started) {
                if (queue.pending.length < this.frameSamples * 2) {
                    continue;
                }
                queue.started = true;
            }
            if (queue.pending.length < this.chunkSamples) {
                queue.started = false;
                continue;
            }
            for (let i = 0; i < mixed.length; i++) {
                mixed[i] += queue.pending[i];
            }
            queue.pending = queue.pending.subarray(this.chunkSamples);
            contributed = true;
        }
        if (!contributed) {
            return null;
        }
        for (let i = 0; i < mixed.length; i++) {
            mixed[i] = Math.max(-1, Math.min(1, mixed[i]));
        }
        return mixed;
    }
    pushChunk(chunk) {
        this.framePending = joinFloats(this.framePending, chunk);
        if (this.framePending.length < this.frameSamples) {
            return null;
        }
        const frame = this.framePending.slice(0, this.frameSamples);
        this.framePending = this.framePending.slice(this.frameSamples);
        return frame;
    }
    reset() {
        this.streams.clear();
        this.allowed.clear();
        this.rosterApplied = false;
        this.framePending = new Float32Array(0);
    }
}
class GroupReceiver {
    audioCtx = null;
    videoCtx = null;
    appDataCtx = null;
    codec = null;
    closed = false;
    constructor(callId, participantId, deviceJid, pid, logger) {
        this.participantId = participantId;
        this.deviceJid = deviceJid;
        this.pid = pid;
        this.audioSsrc = generateSecureSsrc(callId, participantId, 0);
        this.videoSsrc = generateSecureSsrc(callId, participantId, 2);
        this.appDataSsrc = generateSecureSsrc(callId, participantId, 6);
        this.assembler = new H264AccessUnitAssembler();
        MLowCodec.create({ logger, fec: false, decodeOnly: true })
            .then((codec) => {
            if (this.closed) {
                codec.destroy();
                return;
            }
            this.codec = codec;
        })
            .catch(() => { });
    }
    install(rawKey, tagLength) {
        const keying = derivePerJidSrtpKey(rawKey, this.participantId);
        if (this.audioCtx) {
            this.audioCtx.rekey(keying);
            this.videoCtx.rekey(keying);
            this.appDataCtx.rekey(keying);
            return;
        }
        this.audioCtx = new SrtpContext(keying, tagLength);
        this.videoCtx = new SrtpContext(keying, tagLength);
        this.appDataCtx = new SrtpContext(keying, tagLength);
    }
    close() {
        this.closed = true;
        this.codec?.destroy();
        this.codec = null;
    }
}
export class WaGroupCallSession extends WaCallMediaSession {
    roster = null;
    rosterTransactionId = null;
    epoch = null;
    pendingEpochs = new Map();
    receivers = new Map();
    audioBySsrc = new Map();
    videoBySsrc = new Map();
    appDataBySsrc = new Map();
    selfParticipantId = '';
    selfPid = 0;
    warpTagLength = 4;
    groupEndpoints = [];
    relayConfigured = false;
    subscribedPids = '';
    offerStanzaId = null;
    inviteSnapshot = null;
    mixer = new GroupAudioMixer();
    mixTimer = null;
    heartbeatTimer = null;
    constructor(options) {
        super({ ...options, maxActiveRelays: 1 });
        this.info.peerJid = callJidFor(this.info.callId);
        this.acceptedByJid = this.info.peerJid;
        this.sctpRelay.setAllocateBuilder((relayInfo, candidate, transactionId) => this.buildGroupAllocate(relayInfo, candidate, transactionId));
    }
    get callJid() {
        return callJidFor(this.info.callId);
    }
    async initMedia(selfLid) {
        const selfId = formatParticipantId(selfLid);
        this.selfParticipantId = selfId;
        this.selfSsrcJid = selfId;
        this.selfSsrc = generateSecureSsrc(this.info.callId, selfId, 0);
        this.rtpSession = RtpSession.whatsappOpus(this.selfSsrc);
        this.opusCodec = await MLowCodec.create({ logger: this.logger.child({ component: 'mlow' }), fec: true, encodeOnly: true });
        this.videoSsrc = generateSecureSsrc(this.info.callId, selfId, 2);
        if (this.info.mediaType === CallMediaType.Video) {
            this.videoRtpStream = new VideoRtpStream(this.videoSsrc, videoRtpDurationSamples(this.videoEngine.frameDurationMs));
            this.videoAssembler = new H264AccessUnitAssembler();
        }
    }
    async sendIncomingPreaccept() {
        await this.deps.lowLevelCoordinator.sendNode(buildGroupPreacceptStanza(this.info.callId, this.info.callCreator, this.info.mediaType === CallMediaType.Video));
    }
    async sendIncomingRelayLatency() { }
    async acceptCall() {
        if (!this.info.canAccept) {
            throw new Error(`Call ${this.info.callId} cannot be accepted in state ${this.info.stateData.state}`);
        }
        this.info.applyTransition({ type: 'local_accepted' });
        this.delegate.emitState(this.info);
        await this.deps.lowLevelCoordinator.sendNode(buildGroupAcceptStanza(this.info.callId, this.info.callCreator));
        await this.maybeStartMedia();
    }
    async rejectCall(reason = EndCallReason.Declined) {
        this.info.applyTransition({ type: 'local_rejected', reason });
        this.delegate.emitState(this.info);
        try {
            await this.deps.lowLevelCoordinator.sendNode({
                tag: 'call',
                attrs: { to: this.callJid, id: generateCallStanzaId() },
                content: [{ tag: 'reject', attrs: { 'call-id': this.info.callId, 'call-creator': this.info.callCreator } }]
            });
        }
        catch (err) {
            this.logger.warn('reject send failed', { message: toError(err).message });
        }
        this.cleanup();
    }
    async endCall(reason = EndCallReason.UserEnded) {
        if (this.info.isEnded) {
            return;
        }
        this.info.applyTransition({ type: 'terminated', reason });
        this.delegate.emitEnded(this.info);
        this.delegate.emitState(this.info);
        try {
            await this.deps.lowLevelCoordinator.sendNode(buildGroupTerminateStanza(this.info.callId, this.info.callCreator));
        }
        catch (err) {
            this.logger.warn('terminate send failed', { message: toError(err).message });
        }
        await new Promise((resolve) => setTimeout(resolve, 400));
        this.cleanup();
    }
    handleCallTerminate(node) {
        const participant = node?.attrs?.participant;
        if (participant && toUserJid(participant) !== toUserJid(this.info.callCreator)) {
            return false;
        }
        return super.handleCallTerminate();
    }
    async handleCallAccept() {
        if (this.info.stateData.state === CallState.Ringing) {
            try {
                this.info.applyTransition({ type: 'remote_accepted' });
                this.delegate.emitState(this.info);
            }
            catch { }
        }
        await this.maybeStartMedia();
    }
    async handleCallPreaccept() { }
    async handleCallTransport() { }
    async handleCallRelaylatency() { }
    handleRelayElection() { }
    handleCallUserAction(node) {
        this.applyPeerRaiseHand(node, node.attrs?.participant || node.attrs?.from);
    }
    handleCallRaiseHand(node) {
        this.applyPeerRaiseHand(node, node.attrs?.participant || node.attrs?.from);
    }
    async handleCallAck(node) {
        if (node.attrs?.type && node.attrs.type !== 'offer') {
            return;
        }
        if (node.attrs?.error) {
            this.logger.warn('group offer rejected', { error: node.attrs.error });
            await this.endCall(EndCallReason.Failed);
            return;
        }
        let update;
        try {
            update = parseInitialGroupAck(node);
        }
        catch (err) {
            this.logger.warn('group offer ack parse failed', { message: toError(err).message });
            return;
        }
        if (update) {
            await this.processGroupSnapshot(update);
        }
    }
    async handleGroupUpdate(node) {
        let update;
        try {
            update = parseGroupUpdate(getFirstNodeChild(node));
        }
        catch (err) {
            this.logger.warn('group update parse failed', { message: toError(err).message });
            return;
        }
        await this.processGroupSnapshot(update);
    }
    async handleGroupEncRekey(node) {
        const inner = getFirstNodeChild(node);
        let rekey;
        try {
            rekey = parseGroupEncRekey(inner);
        }
        catch (err) {
            this.logger.warn('group rekey parse failed', { message: toError(err).message });
            return;
        }
        const rawKey = await decryptCallKey(this.deps, inner, node.attrs?.participant || node.attrs?.from, this.logger);
        if (!rawKey) {
            this.logger.warn('group rekey could not be decrypted', { transactionId: rekey.transactionId });
            return;
        }
        if (this.applyEpoch(rekey.transactionId, rawKey)) {
            this.refreshRelayAllocation();
            await this.maybeStartMedia();
        }
    }
    handleWaitingRoomUpdate(node) {
        let room;
        try {
            room = parseWaitingRoomUpdate(getFirstNodeChild(node));
        }
        catch (err) {
            this.logger.warn('waiting room update parse failed', { message: toError(err).message });
            return;
        }
        this.info.waitingRoom = room;
        this.delegate.emitWaitingRoom?.(this.info, room);
        this.delegate.emitState(this.info);
    }
    async beginLinkJoin(result) {
        if (result.waitingRoom) {
            this.info.waitingRoom = result.waitingRoom;
        }
        if (result.group) {
            this.info.applyTransition({ type: 'group_joined' });
            this.delegate.emitState(this.info);
            await this.processGroupSnapshot(result.group);
            return;
        }
        this.info.applyTransition({ type: 'waiting_room_entered' });
        this.delegate.emitState(this.info);
        this.delegate.emitWaitingRoom?.(this.info, this.info.waitingRoom);
        this.startWaitingHeartbeat();
    }
    startWaitingHeartbeat() {
        this.stopWaitingHeartbeat();
        this.heartbeatTimer = setInterval(() => {
            if (this.info.stateData.state !== CallState.WaitingRoom) {
                this.stopWaitingHeartbeat();
                return;
            }
            this.sendWaitingRoomRequest('heartbeat', { type: 'waiting_room' }).catch(() => { });
        }, 10000);
        this.heartbeatTimer.unref?.();
    }
    stopWaitingHeartbeat() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }
    async sendWaitingRoomRequest(tag, attrs, children) {
        await this.deps.lowLevelCoordinator.sendNode(buildWaitingRoomRequestStanza(tag, this.info.callId, this.info.callCreator, generateCallStanzaId(), attrs, children));
    }
    async setApprovalRequired(enabled) {
        await this.sendWaitingRoomRequest('waiting_room_toggle', { enabled: enabled ? '1' : '0' });
    }
    async admitParticipant(jid) {
        const lid = await resolveUserLid(this.deps, jid);
        await this.sendWaitingRoomRequest('waiting_room_admit', {}, [{ tag: 'user', attrs: { jid: lid } }]);
    }
    async denyParticipant(jid) {
        const lid = await resolveUserLid(this.deps, jid);
        await this.sendWaitingRoomRequest('waiting_room_deny', {}, [{ tag: 'user', attrs: { jid: lid } }]);
    }
    async addParticipant(target) {
        await this.inviteParticipant(target, false);
    }
    async ringParticipant(target) {
        await this.inviteParticipant(target, true);
    }
    async inviteParticipant(target, ring) {
        if (!this.roster) {
            throw new Error('the call roster is not available yet');
        }
        const lid = stripDevice(await resolveUserLid(this.deps, target));
        if (lid === stripDevice(this.selfParticipantId)) {
            throw new Error('this account is already in its own call');
        }
        const entry = this.roster.participants.find((participant) => stripDevice(participant.jid) === lid);
        if (ring && !entry) {
            throw new Error('participant is not in the call roster');
        }
        if (ring && entry.state === 'connected') {
            throw new Error('participant is already connected');
        }
        if (!ring && entry) {
            throw new Error('participant is already in the call roster');
        }
        const participants = ring ? this.roster.participants.filter((participant) => participant.state === 'connected') : this.roster.participants;
        if (participants.length === 0) {
            throw new Error('the call has no connected participants');
        }
        const targetDevices = await listUserDevices(this.deps, lid);
        if (targetDevices.length === 0) {
            throw new Error(`no reachable devices for ${lid}`);
        }
        const stanza = buildGroupInviteOfferStanza({
            callId: this.info.callId,
            to: lid,
            creator: this.info.callCreator,
            targetDevices,
            participants,
            video: this.info.mediaType === CallMediaType.Video
        });
        stanza.attrs.id = generateCallStanzaId();
        await this.deps.lowLevelCoordinator.sendNode(stanza);
    }
    getParticipants() {
        return this.info.groupState?.participants ?? [];
    }
    applyGroupUpdate(update) {
        if (this.rosterTransactionId !== null && update.transactionId <= this.rosterTransactionId) {
            return false;
        }
        const next = new Map();
        let selfPid = this.selfPid;
        for (const participant of update.participants) {
            if (participant.state !== 'connected') {
                continue;
            }
            for (const device of participant.devices) {
                if (!device.jid || device.pid === undefined) {
                    continue;
                }
                const participantId = formatParticipantId(device.jid);
                if (participantId === this.selfParticipantId) {
                    selfPid = device.pid;
                    continue;
                }
                const receiver = this.receivers.get(participantId) ?? new GroupReceiver(this.info.callId, participantId, device.jid, device.pid, this.logger.child({ component: 'mlow' }));
                receiver.pid = device.pid;
                next.set(participantId, receiver);
            }
        }
        for (const [participantId, receiver] of this.receivers) {
            if (!next.has(participantId)) {
                receiver.close();
            }
        }
        this.receivers = next;
        this.selfPid = selfPid;
        this.audioBySsrc = new Map([...next.values()].map((receiver) => [receiver.audioSsrc, receiver]));
        this.videoBySsrc = new Map([...next.values()].map((receiver) => [receiver.videoSsrc, receiver]));
        this.appDataBySsrc = new Map([...next.values()].map((receiver) => [receiver.appDataSsrc, receiver]));
        this.roster = update;
        this.rosterTransactionId = update.transactionId;
        this.mixer.retain([...next.keys()]);
        const ready = [...this.pendingEpochs.keys()].filter((transactionId) => transactionId <= update.transactionId).sort((a, b) => b - a);
        if (ready.length > 0) {
            const newest = ready[0];
            const rawKey = this.pendingEpochs.get(newest);
            for (const transactionId of this.pendingEpochs.keys()) {
                if (transactionId <= newest) {
                    this.pendingEpochs.delete(transactionId);
                }
            }
            if (!this.epoch || newest > this.epoch.transactionId) {
                this.installEpoch(newest, rawKey);
            }
        }
        if (this.epoch) {
            for (const receiver of next.values()) {
                receiver.install(this.epoch.rawKey, this.warpTagLength);
            }
        }
        return true;
    }
    applyEpoch(transactionId, rawKey) {
        if (this.rosterTransactionId === null || transactionId > this.rosterTransactionId) {
            this.pendingEpochs.set(transactionId, rawKey);
            while (this.pendingEpochs.size > 8) {
                this.pendingEpochs.delete(Math.min(...this.pendingEpochs.keys()));
            }
            return false;
        }
        if (this.epoch && transactionId <= this.epoch.transactionId) {
            return false;
        }
        this.installEpoch(transactionId, rawKey);
        return true;
    }
    installEpoch(transactionId, rawKey) {
        this.epoch = { transactionId, rawKey };
        this.info.encryptionKey = rawKey;
        const keying = derivePerJidSrtpKey(rawKey, this.selfParticipantId);
        if (this.srtpSession) {
            this.srtpSession.rekey(keying);
            this.appDataSrtpSession.rekey(keying);
            this.audioRtcpSession.rekey(keying);
            this.videoSrtpSession?.rekey(keying);
            this.videoRtcpSession?.rekey(keying);
        }
        else {
            this.srtpSession = new SrtpContext(keying, this.warpTagLength);
            this.appDataSrtpSession = new SrtpContext(keying, this.warpTagLength);
            this.audioRtcpSession = new SrtcpSendContext(keying);
            this.openAppDataStream(this.selfParticipantId);
            this.startRtcpSenderReports();
        }
        if (this.videoRtpStream && !this.videoSrtpSession) {
            this.videoSrtpSession = new SrtpContext(keying, this.warpTagLength);
            this.videoRtcpSession = new SrtcpSendContext(keying);
        }
        for (const receiver of this.receivers.values()) {
            receiver.install(rawKey, this.warpTagLength);
        }
    }
    async distributeEpoch(update) {
        const rawKey = generateCallKey();
        const targets = [...this.receivers.values()].map((receiver) => receiver.deviceJid);
        if (targets.length > 0) {
            try {
                await this.deps.sessionResolver.ensureSessionsBatch(targets);
            }
            catch (err) {
                this.logger.warn('group rekey session setup failed', { message: toError(err).message });
            }
            for (const result of await Promise.allSettled(targets.map(async (jid) => {
                const { type, ciphertext } = await this.deps.signalProtocol.encryptMessage(parseSignalAddressFromJid(jid), await encodeWAMessage({ call: { callKey: rawKey } }));
                await this.deps.lowLevelCoordinator.sendNode(buildGroupEncRekeyStanza({
                    callId: this.info.callId,
                    to: jid,
                    creator: this.info.callCreator,
                    transactionId: update.transactionId,
                    encType: type,
                    ciphertext
                }));
            }))) {
                if (result.status === 'rejected') {
                    this.logger.warn('group rekey delivery failed', { message: toError(result.reason).message });
                }
            }
        }
        this.applyEpoch(update.transactionId, rawKey);
    }
    async processGroupSnapshot(update) {
        if (this.info.isEnded || !this.applyGroupUpdate(update)) {
            return;
        }
        if (update.relay) {
            this.applyGroupRelay(update.relay);
        }
        this.info.groupState = {
            transactionId: update.transactionId,
            media: update.media,
            groupJid: update.groupJid,
            joinable: update.joinable,
            connectedLimit: update.connectedLimit,
            participants: update.participants.map((participant) => ({
                jid: participant.jid,
                pn: participant.pn,
                state: participant.state,
                type: participant.type,
                isSelf: stripDevice(participant.jid) === stripDevice(this.selfParticipantId),
                devices: participant.devices.map((device) => ({ jid: device.jid, pid: device.pid, platform: device.platform }))
            }))
        };
        this.advanceJoinState();
        this.delegate.emitGroupState?.(this.info, this.info.groupState);
        this.delegate.emitState(this.info);
        if (update.rekeyRequested) {
            await this.distributeEpoch(update);
        }
        else if (!this.epoch && this.info.linkToken && this.receivers.size === 0 && this.groupEndpoints.length > 0) {
            this.applyEpoch(update.transactionId, generateCallKey());
        }
        this.refreshRelayAllocation(!!update.relay);
        await this.maybeStartMedia();
    }
    advanceJoinState() {
        const state = this.info.stateData.state;
        try {
            if (state === CallState.WaitingRoom) {
                this.stopWaitingHeartbeat();
                this.info.applyTransition({ type: 'group_joined' });
            }
            else if (state === CallState.Ringing && this.receivers.size > 0) {
                this.info.applyTransition({ type: 'remote_accepted' });
            }
        }
        catch { }
    }
    applyGroupRelay(relay) {
        if (relay.selfPid !== undefined) {
            this.selfPid = relay.selfPid;
        }
        if (relay.warpMiTagLength) {
            this.warpTagLength = relay.warpMiTagLength;
        }
        const { relays } = parseRelayFromAck({ content: [relay.node] });
        if (relays.length > 0) {
            this.groupEndpoints = relays;
        }
    }
    currentPids() {
        return [...new Set([...this.receivers.values()].map((receiver) => receiver.pid))].sort((a, b) => a - b);
    }
    buildGroupAllocate(relayInfo, candidate, transactionId) {
        return buildGroupAllocateForRelay(relayInfo.rawToken, {
            streamSsrcs: deriveWasmRelayStreamSsrcs(this.info.callId, this.selfParticipantId),
            appDataSsrc: generateSecureSsrc(this.info.callId, this.selfParticipantId, 6),
            hbhFecSsrcs: [generateSecureSsrc(this.info.callId, this.selfParticipantId, 7), generateSecureSsrc(this.info.callId, this.selfParticipantId, 8)],
            pids: this.currentPids()
        }, TEXT_ENCODER.encode(relayInfo.key), candidate.ip, candidate.port, transactionId, { relayedAddress: candidate.form });
    }
    refreshRelayAllocation(credentialsChanged = false) {
        if (!this.relayConfigured || this.groupEndpoints.length === 0) {
            return;
        }
        const pids = this.currentPids().join(',');
        if (pids === this.subscribedPids && !credentialsChanged) {
            return;
        }
        this.subscribedPids = pids;
        this.connectRelays(this.groupEndpoints).catch(() => { });
    }
    async maybeStartMedia() {
        const state = this.info.stateData.state;
        if (this.relayConfigured || !this.epoch || this.groupEndpoints.length === 0) {
            return;
        }
        if (state !== CallState.Connecting && state !== CallState.Active) {
            return;
        }
        this.subscribedPids = this.currentPids().join(',');
        await this.connectRelays(this.groupEndpoints);
    }
    async connectRelays(endpoints) {
        const relays = this.selectRelayEndpoints(endpoints).map((ep) => ({
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
            this.logger.error('no usable group relay endpoints', { callId: this.info.callId });
            return;
        }
        this.sctpRelay.setParticipantIds(this.selfPid, 0);
        this.sctpRelay.setSsrc(this.selfSsrc);
        this.sctpRelay.setStreamSsrcs(deriveWasmRelayStreamSsrcs(this.info.callId, this.selfParticipantId));
        this.sctpRelay.setSubscriptionSsrc(0);
        if (this.relayConfigured) {
            this.sctpRelay.refreshRelays(relays);
            return;
        }
        this.relayConfigured = true;
        try {
            await this.sctpRelay.configureRelays(relays);
        }
        catch (err) {
            this.logger.error('group relay error', { callId: this.info.callId, message: toError(err).message });
        }
    }
    onRelayConnected() {
        if (this.info.stateData.state === CallState.Connecting) {
            try {
                this.info.applyTransition({ type: 'media_connected' });
                this.delegate.emitState(this.info);
            }
            catch { }
        }
        if (!this.mediaFlowStarted && this.epoch && this.info.stateData.state === CallState.Active) {
            this.startMediaFlow();
        }
    }
    startMediaFlow() {
        super.startMediaFlow();
        this.startMixer();
    }
    startMixer() {
        if (this.mixTimer) {
            return;
        }
        this.mixTimer = setInterval(() => {
            if (this.receivers.size < 2) {
                return;
            }
            for (let i = 0; i < 2; i++) {
                const chunk = this.mixer.mixChunk();
                if (!chunk) {
                    return;
                }
                const frame = this.mixer.pushChunk(chunk);
                if (frame) {
                    this.onDecodedAudio(frame);
                }
            }
        }, 10);
        this.mixTimer.unref?.();
    }
    onRelayData(data) {
        this.relayPacketCount++;
        const packet = unwrapGroupForwarding(data);
        if (!packet) {
            return;
        }
        if (isStunPacket(packet)) {
            this.stunResponseCount++;
            return;
        }
        if (!isRtpPacket(packet) || packet.length < 12) {
            return;
        }
        const payloadType = packet[1] & 0x7f;
        if (payloadType >= 72 && payloadType <= 76) {
            return;
        }
        const ssrc = readUInt32BE(packet, 8);
        if (ssrc === this.selfSsrc) {
            this.selfEchoCount++;
            return;
        }
        const audioReceiver = this.audioBySsrc.get(ssrc);
        if (audioReceiver) {
            this.onGroupAudio(audioReceiver, packet, payloadType);
            return;
        }
        const videoReceiver = this.videoBySsrc.get(ssrc);
        if (videoReceiver) {
            this.onGroupVideo(videoReceiver, packet);
            return;
        }
        const appDataReceiver = this.appDataBySsrc.get(ssrc);
        if (appDataReceiver) {
            this.onGroupAppData(appDataReceiver, packet, payloadType, ssrc);
        }
    }
    onGroupAudio(receiver, data, payloadType) {
        if (payloadType !== 120 || !receiver.audioCtx || !receiver.codec) {
            return;
        }
        try {
            const packet = receiver.audioCtx.unprotect(data);
            this.audioRecvCount++;
            if (packet.payload.length === 0) {
                return;
            }
            receiver.codec.decodeSequenced(packet.header.sequenceNumber, packet.payload, (pcm) => this.onParticipantAudio(receiver, pcm));
        }
        catch {
            this.srtpErrorCount++;
        }
    }
    onParticipantAudio(receiver, pcm) {
        this.delegate.emitParticipantAudio?.(this.info, receiver.participantId, pcm);
        if (this.receivers.size > 1) {
            this.mixer.add(receiver.participantId, pcm);
            return;
        }
        this.onDecodedAudio(pcm);
    }
    onGroupVideo(receiver, data) {
        if (!receiver.videoCtx) {
            return;
        }
        try {
            const packet = receiver.videoCtx.unprotect(data);
            const [accessUnit, complete] = receiver.assembler.push(packet.header.sequenceNumber, packet.header.marker, packet.payload);
            if (complete && accessUnit) {
                this.delegate.emitInboundVideo?.(this.info, accessUnit, receiver.participantId);
            }
        }
        catch {
            this.srtpErrorCount++;
        }
    }
    onGroupAppData(receiver, data, payloadType, ssrc) {
        const stream = this.appDataStream;
        if (!stream || !receiver.appDataCtx) {
            return;
        }
        try {
            const packet = receiver.appDataCtx.unprotect(data);
            stream.observeInboundPayloadType(payloadType);
            for (const reaction of stream.receive(packet.payload, ssrc)) {
                this.delegate.emitCallReaction?.(this.info, { ...reaction, participantJid: receiver.deviceJid });
            }
        }
        catch { }
    }
    async enableVideoMidCall() {
        if (this.videoRtpStream && this.videoSrtpSession) {
            return;
        }
        this.videoRtpStream = new VideoRtpStream(this.videoSsrc, videoRtpDurationSamples(this.videoEngine.frameDurationMs));
        this.videoAssembler = new H264AccessUnitAssembler();
        if (this.epoch) {
            const keying = derivePerJidSrtpKey(this.epoch.rawKey, this.selfParticipantId);
            this.videoSrtpSession = new SrtpContext(keying, this.warpTagLength);
            this.videoRtcpSession = new SrtcpSendContext(keying);
        }
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
    cleanup() {
        this.stopWaitingHeartbeat();
        if (this.mixTimer) {
            clearInterval(this.mixTimer);
            this.mixTimer = null;
        }
        for (const receiver of this.receivers.values()) {
            receiver.close();
        }
        this.receivers.clear();
        this.audioBySsrc.clear();
        this.videoBySsrc.clear();
        this.appDataBySsrc.clear();
        this.pendingEpochs.clear();
        this.mixer.reset();
        this.relayConfigured = false;
        super.cleanup();
        this.acceptedByJid = this.info.peerJid;
    }
}
