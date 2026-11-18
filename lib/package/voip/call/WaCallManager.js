import { EventEmitter } from 'node:events';
import { createNoopLogger } from '../shim/core.js';
import { isLidJid } from '../shim/protocol.js';
import { findNodeChild, hasNodeChild } from '../shim/transport.js';
import { resolvePositive, toError } from '../shim/util.js';
import { generateCallKey } from '../crypto/encryption.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { buildCallLinkCreateStanza, buildCallLinkJoinStanza, buildCallLinkQueryStanza, buildCallLinkUrl, buildInitialGroupOfferStanza, buildOfferStanza, callJidFor, decryptCallKey, extractNodeInfo, generateCallId, generateCallStanzaId, GroupCapability, parseCallLink, parseCallLinkCreateAck, parseCallLinkJoinAck, parseCallLinkQueryAck, parseGroupInviteSnapshot } from '../signaling/signaling.js';
import { CallDirection, CallMediaType, CallState, EndCallReason } from '../types.js';
import { CallInfo } from './call-state.js';
import { listUserDevices, resolveUserLid, stripDevice, WaCallMediaSession, WaGroupCallSession } from './WaCallMediaSession.js';
const DEFAULT_MAX_CONCURRENT_CALLS = 1;
export class WaCallManager extends EventEmitter {
    deps;
    stores;
    logger;
    maxConcurrentCalls;
    calls = new Map();
    pendingGroupEvents = new Map();
    linkRequests = new Map();
    linkJoinsInFlight = 0;
    constructor(config) {
        super();
        this.deps = config.deps;
        this.stores = config.stores;
        this.logger = config.logger ?? createNoopLogger();
        this.maxConcurrentCalls = resolvePositive(config.maxConcurrentCalls, DEFAULT_MAX_CONCURRENT_CALLS, 'maxConcurrentCalls');
    }
    async startCall(options) {
        if (this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
        const callId = generateCallId();
        const mediaType = options.isVideo ? CallMediaType.Video : CallMediaType.Audio;
        const creds = this.deps.authClient.getCurrentCredentials();
        const callCreator = creds?.meLid || creds?.meJid || '';
        const peerJid = await this.resolvePeerLid(options.peerJid);
        const info = CallInfo.newOutgoing(callId, peerJid, callCreator, mediaType);
        const callKey = generateCallKey();
        info.encryptionKey = callKey;
        const session = this.createSession(info, { videoConfig: options.videoConfig });
        try {
            session.resetOutgoingFlags();
            const selfLid = creds?.meLid || creds?.meJid || '';
            await session.initMedia(selfLid, peerJid);
            const offerStanza = await buildOfferStanza(this.deps, this.stores, callId, callKey, peerJid, options.isVideo ?? false, this.logger.child({ component: 'signaling' }));
            await this.deps.lowLevelCoordinator.sendNode(offerStanza);
        }
        catch (err) {
            session.cleanup();
            this.calls.delete(callId);
            throw err;
        }
        info.applyTransition({ type: 'offer_sent' });
        this.emitState(info);
        return callId;
    }
    assertCapacity() {
        if (this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
    }
    async startGroupCall(options) {
        this.assertCapacity();
        const callId = generateCallId();
        const mediaType = options.isVideo ? CallMediaType.Video : CallMediaType.Audio;
        const creds = this.deps.authClient.getCurrentCredentials();
        const selfLid = creds?.meLid || creds?.meJid || '';
        const selfUser = stripDevice(selfLid);
        const targets = [...new Set((await Promise.all([...new Set(options.targets ?? [])].map((target) => resolveUserLid(this.deps, target)))).map(stripDevice))].filter((lid) => lid !== selfUser);
        if (targets.length < 2) {
            throw new Error('a group call needs at least two participants besides yourself');
        }
        const participants = [{ jid: selfUser, devices: [{ jid: selfLid, capabilityVersion: 1, capability: GroupCapability.offer }] }];
        for (const lid of targets) {
            const devices = await listUserDevices(this.deps, lid);
            if (devices.length === 0) {
                throw new Error(`no reachable devices for ${lid}`);
            }
            participants.push({ jid: lid, devices: devices.map((jid) => ({ jid })) });
        }
        const info = CallInfo.newGroupOutgoing(callId, callJidFor(callId), selfLid, mediaType, options.groupJid);
        const session = this.createSession(info, { videoConfig: options.videoConfig });
        try {
            await session.initMedia(selfLid);
            const stanza = buildInitialGroupOfferStanza({ callId, creator: selfLid, groupJid: options.groupJid, participants, video: options.isVideo ?? false });
            stanza.attrs.id = generateCallStanzaId();
            session.offerStanzaId = stanza.attrs.id;
            await this.deps.lowLevelCoordinator.sendNode(stanza);
        }
        catch (err) {
            session.cleanup();
            this.calls.delete(callId);
            throw err;
        }
        info.applyTransition({ type: 'offer_sent' });
        this.emitState(info);
        return callId;
    }
    async createCallLink(options = {}) {
        const media = options.isVideo ? 'video' : 'audio';
        const response = await this.deps.lowLevelCoordinator.query(buildCallLinkCreateStanza(media, generateCallStanzaId()), 30000);
        const link = parseCallLinkCreateAck(response);
        return { token: link.token, media: link.media, isVideo: link.media === 'video', url: buildCallLinkUrl(link.token, link.media) };
    }
    async queryCallLink(tokenOrUrl, options = {}) {
        const { token, media: linkMedia } = parseCallLink(tokenOrUrl);
        const media = options.isVideo === undefined ? linkMedia ?? 'audio' : options.isVideo ? 'video' : 'audio';
        const response = await this.deps.lowLevelCoordinator.query(buildCallLinkQueryStanza(token, media, generateCallStanzaId()), 30000);
        const preview = parseCallLinkQueryAck(response);
        return { ...preview, isVideo: preview.media === 'video', url: buildCallLinkUrl(preview.token, preview.media) };
    }
    async joinCallLink(tokenOrUrl, options = {}) {
        this.assertCapacity();
        const { token, media: linkMedia } = parseCallLink(tokenOrUrl);
        const media = options.isVideo === undefined ? linkMedia ?? 'audio' : options.isVideo ? 'video' : 'audio';
        const creds = this.deps.authClient.getCurrentCredentials();
        const selfLid = creds?.meLid || creds?.meJid || '';
        this.linkJoinsInFlight++;
        try {
            const response = await this.deps.lowLevelCoordinator.query(buildCallLinkJoinStanza(token, media, generateCallStanzaId()), 30000);
            const result = parseCallLinkJoinAck(response);
            const info = CallInfo.newLinkJoin(result.callId, callJidFor(result.callId), selfLid, media === 'video' ? CallMediaType.Video : CallMediaType.Audio, token);
            info.callCreator = result.callCreator;
            info.linkUrl = buildCallLinkUrl(token, media);
            const session = this.createSession(info, { videoConfig: options.videoConfig });
            try {
                await session.initMedia(selfLid);
                await session.beginLinkJoin(result);
                await this.flushGroupEvents(result.callId);
            }
            catch (err) {
                session.cleanup();
                this.calls.delete(result.callId);
                throw err;
            }
            return result.callId;
        }
        finally {
            this.linkJoinsInFlight--;
            if (this.linkJoinsInFlight === 0) {
                this.pendingGroupEvents.clear();
            }
        }
    }
    async getCallLink(callId) {
        const info = this.getCall(callId);
        if (!info) {
            throw new Error(`Unknown call ${callId}`);
        }
        if (info.linkUrl) {
            return info.linkUrl;
        }
        if (!this.linkRequests.has(callId)) {
            this.linkRequests.set(callId, this.createCallLink({ isVideo: info.mediaType === CallMediaType.Video })
                .then((link) => {
                info.linkUrl = link.url;
                return link.url;
            })
                .finally(() => this.linkRequests.delete(callId)));
        }
        return this.linkRequests.get(callId);
    }
    getGroupSessionOrThrow(callId) {
        const session = this.getSessionOrThrow(callId);
        if (!(session instanceof WaGroupCallSession)) {
            throw new Error(`Call ${callId} is not a group call`);
        }
        return session;
    }
    async addGroupParticipant(callId, target) {
        await this.getGroupSessionOrThrow(callId).addParticipant(target);
    }
    async ringGroupParticipant(callId, target) {
        await this.getGroupSessionOrThrow(callId).ringParticipant(target);
    }
    async setApprovalRequired(callId, enabled) {
        await this.getGroupSessionOrThrow(callId).setApprovalRequired(enabled);
    }
    async admitParticipant(callId, jid) {
        await this.getGroupSessionOrThrow(callId).admitParticipant(jid);
    }
    async denyParticipant(callId, jid) {
        await this.getGroupSessionOrThrow(callId).denyParticipant(jid);
    }
    getParticipants(callId) {
        return this.getGroupSessionOrThrow(callId).getParticipants();
    }
    bufferGroupEvent(node, method) {
        const callId = extractNodeInfo(node)?.callId;
        if (!callId || this.linkJoinsInFlight === 0) {
            return;
        }
        const queue = this.pendingGroupEvents.get(callId) ?? [];
        queue.push({ node, method });
        this.pendingGroupEvents.set(callId, queue);
    }
    async flushGroupEvents(callId) {
        const queue = this.pendingGroupEvents.get(callId) ?? [];
        this.pendingGroupEvents.delete(callId);
        const session = this.calls.get(callId);
        for (const { node, method } of queue) {
            await session?.[method]?.(node);
        }
    }
    async handleGroupUpdate(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session) {
            this.bufferGroupEvent(node, 'handleGroupUpdate');
            return;
        }
        await session.handleGroupUpdate?.(node);
    }
    async handleGroupEncRekey(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session) {
            this.bufferGroupEvent(node, 'handleGroupEncRekey');
            return;
        }
        await session.handleGroupEncRekey?.(node);
    }
    handleWaitingRoomUpdate(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session) {
            this.bufferGroupEvent(node, 'handleWaitingRoomUpdate');
            return;
        }
        session.handleWaitingRoomUpdate?.(node);
    }
    async handleGroupOffer(nodeInfo) {
        const callId = nodeInfo.callId;
        let snapshot;
        try {
            snapshot = parseGroupInviteSnapshot(nodeInfo.innerNode);
        }
        catch (err) {
            this.logger.warn('group invite parse failed', { callId, message: toError(err).message });
            return;
        }
        const callCreator = nodeInfo.innerNode.attrs?.['call-creator'];
        const mediaType = hasNodeChild(nodeInfo.innerNode, 'video') ? CallMediaType.Video : CallMediaType.Audio;
        const info = CallInfo.newGroupIncoming(callId, callJidFor(callId), callCreator, undefined, mediaType, snapshot.groupJid);
        const atCapacity = this.activeCallCount >= this.maxConcurrentCalls;
        const session = this.createSession(info, { acceptBlocked: atCapacity });
        session.inviteSnapshot = snapshot;
        if (!atCapacity) {
            try {
                await this.activateGroupInvite(session);
            }
            catch (err) {
                this.logger.error('incoming group call activation failed', { callId, message: toError(err).message });
                try {
                    info.applyTransition({ type: 'terminated', reason: EndCallReason.Failed });
                }
                catch { }
                this.emit('call_ended', info);
                this.emitState(info);
                session.cleanup();
                this.calls.delete(callId);
                await this.maybeUnblockWaitingCalls();
                return;
            }
        }
        this.emit('call_incoming', info);
        this.emitState(info);
    }
    async activateGroupInvite(session) {
        const creds = this.deps.authClient.getCurrentCredentials();
        await session.initMedia(creds?.meLid || creds?.meJid || '');
        await session.sendIncomingPreaccept();
        if (session.inviteSnapshot) {
            await session.processGroupSnapshot(session.inviteSnapshot);
        }
    }
    async acceptCall(callId) {
        const session = this.getSessionOrThrow(callId);
        if (!session.info.canAccept) {
            throw new Error(`Call ${callId} cannot be accepted in state ${session.info.stateData.state}`);
        }
        await session.acceptCall();
    }
    async rejectCall(callId, reason = EndCallReason.Declined) {
        const session = this.getSessionOrThrow(callId);
        await session.rejectCall(reason);
        this.calls.delete(callId);
        await this.maybeUnblockWaitingCalls();
    }
    async endCall(callId, reason = EndCallReason.UserEnded) {
        const session = this.calls.get(callId);
        if (!session || session.info.isEnded)
            return;
        await session.endCall(reason);
        this.calls.delete(callId);
        await this.maybeUnblockWaitingCalls();
    }
    setMute(callId, muted) {
        const session = this.calls.get(callId);
        session?.setMute(muted);
    }
    async setHandRaised(callId, raised) {
        const session = this.getSessionOrThrow(callId);
        await session.setHandRaised(raised);
    }
    async setScreenShare(callId, sharing) {
        const session = this.getSessionOrThrow(callId);
        await session.setScreenShare(sharing);
    }
    sendReaction(callId, reaction) {
        const session = this.getSessionOrThrow(callId);
        return session.sendReaction(reaction);
    }
    async loadAudio(callId, audioPath) {
        const session = this.getSessionOrThrow(callId);
        await session.loadAudio(audioPath);
    }
    async loadVideo(callId, videoPath) {
        const session = this.getSessionOrThrow(callId);
        await session.loadVideo(videoPath);
    }

    async enableVideoMidCall(callId) {
        const session = this.getSessionOrThrow(callId);
        await session.enableVideoMidCall();
    }
    async disableVideoMidCall(callId, options) {
        const session = this.getSessionOrThrow(callId);
        session.disableVideoMidCall(options);
    }

    async startVideoMidCall(callId) {
        const session = this.getSessionOrThrow(callId);
        await session.startVideoMidCall();
    }
    async stopVideoMidCall(callId, options) {
        const session = this.getSessionOrThrow(callId);
        await session.stopVideoMidCall(options);
    }
    async swapVideoSource(callId, videoPath) {
        const session = this.getSessionOrThrow(callId);
        await session.swapVideoSource(videoPath);
    }
    setExternalAudioMode(callId, enabled) {
        const session = this.getSessionOrThrow(callId);
        session.setExternalAudioMode(enabled);
    }
    feedLiveAudio(callId, data) {
        const session = this.calls.get(callId);
        return session?.feedLiveAudio(data) ?? 0;
    }
    getLiveBufferMs(callId) {
        const session = this.calls.get(callId);
        return session?.getLiveBufferMs() ?? 0;
    }
    getFeedWatermarksMs() {
        return WaAudioEngine.feedWatermarksMs();
    }
    getCall(callId) {
        return this.calls.get(callId)?.info ?? null;
    }
    getCalls() {
        const result = [];
        for (const session of this.calls.values()) {
            result.push(session.info);
        }
        return result;
    }
    async handleCallOffer(node, peerJid) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo?.callId)
            return;
        const callId = nodeInfo.callId;
        const existing = this.calls.get(callId);
        if (existing) {
            if (!existing.info.isEnded) {
                return;
            }
            existing.cleanup();
            this.calls.delete(callId);
        }
        if (findNodeChild(nodeInfo.innerNode, 'group_info')) {
            await this.handleGroupOffer(nodeInfo);
            return;
        }
        const callCreator = nodeInfo.innerNode.attrs?.['call-creator'] || peerJid;
        const isVideo = hasNodeChild(nodeInfo.innerNode, 'video');
        const callKey = await decryptCallKey(this.deps, nodeInfo.innerNode, peerJid, this.logger.child({ component: 'signaling' }));
        const { relays, participantJids, uuid, selfPid, peerPid, hbhKey } = parseRelayFromAck(nodeInfo.innerNode);
        const mediaType = isVideo ? CallMediaType.Video : CallMediaType.Audio;
        const info = CallInfo.newIncoming(callId, peerJid, callCreator, undefined, mediaType);
        if (callKey) {
            info.encryptionKey = callKey;
        }
        if (relays.length > 0) {
            info.relayData = {
                endpoints: relays,
                participantJids,
                uuid,
                selfPid,
                peerPid,
                hbhKey
            };
        }
        const atCapacity = this.activeCallCount >= this.maxConcurrentCalls;
        const session = this.createSession(info, { acceptBlocked: atCapacity });
        if (!atCapacity) {
            try {
                const creds = this.deps.authClient.getCurrentCredentials();
                const selfLid = creds?.meLid || creds?.meJid || '';
                await session.initMedia(selfLid, peerJid);
                await session.sendIncomingPreaccept(peerJid);
                await session.sendIncomingRelayLatency();
            }
            catch (err) {
                this.logger.error('incoming call activation failed', {
                    callId,
                    message: toError(err).message
                });
                try {
                    info.applyTransition({ type: 'terminated', reason: EndCallReason.Failed });
                }
                catch { }
                this.emit('call_ended', info);
                this.emitState(info);
                session.cleanup();
                this.calls.delete(callId);
                await this.maybeUnblockWaitingCalls();
                return;
            }
        }
        this.emit('call_incoming', info);
        this.emitState(info);
    }
    async handleCallAccept(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallAccept(node, peerJid);
    }
    async handleCallPreaccept(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallPreaccept(node, peerJid);
    }
    async handleCallTransport(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallTransport(node);
    }
    async handleCallAck(node) {
        if (['link_create', 'link_query', 'link_join'].includes(node.attrs?.type)) {
            return;
        }
        const session = this.resolveSessionForOfferAck(node);
        if (!session)
            return;
        await session.handleCallAck(node);
    }
    async handleCallRelaylatency(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallRelaylatency(node, peerJid);
    }
    handleRelayElection(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleRelayElection(node);
    }
    async handleCallMuteV2(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallMuteV2(node, peerJid);
    }
    handleCallUserAction(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallUserAction(node, peerJid);
    }
    handleCallRaiseHand(node, peerJid) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallRaiseHand(node, peerJid);
    }
    handleCallScreenShare(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallScreenShare(node);
    }
    async handleCallVideo(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        await session.handleCallVideo(node);
    }
    async handleCallTerminate(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        if (session.handleCallTerminate(node) === false) {
            return;
        }
        this.calls.delete(session.callId);
        await this.maybeUnblockWaitingCalls();
    }
    notifyReconnecting() {
        for (const session of this.calls.values()) {
            if (session.info.isActive && !session.info.isEnded) {
                session.delegate.emitReconnecting(session.info, { attempt: 0, max: 0 });
            }
        }
    }
    notifyReconnected() {
        for (const session of this.calls.values()) {
            if (session.info.isActive && !session.info.isEnded && !session.reconnecting) {
                session.delegate.emitReconnected(session.info);
            }
        }
    }
    destroy() {
        for (const session of this.calls.values()) {
            session.cleanup();
        }
        this.calls.clear();
        this.removeAllListeners();
    }
    get activeCallCount() {
        let count = 0;
        for (const session of this.calls.values()) {
            if (!session.info.isEnded && !session.info.isAcceptBlocked)
                count++;
        }
        return count;
    }
    createSession(info, options = {}) {
        const prior = this.calls.get(info.callId);
        if (prior) {
            if (!prior.info.isEnded) {
                throw new Error(`call ${info.callId} already exists`);
            }
            prior.cleanup();
            this.calls.delete(info.callId);
        }
        const acceptBlocked = options.acceptBlocked ?? false;
        if (!acceptBlocked && this.activeCallCount >= this.maxConcurrentCalls) {
            throw new Error(`max concurrent calls reached (${this.maxConcurrentCalls})`);
        }
        if (acceptBlocked) {
            info.stateData.acceptBlocked = true;
        }
        const sessionLogger = this.logger.child({ callId: info.callId });
        const session = new (info.isGroup ? WaGroupCallSession : WaCallMediaSession)({
            deps: this.deps,
            logger: sessionLogger,
            info,
            videoConfig: options.videoConfig,
            delegate: {
                emitState: (call) => this.emitState(call),
                emitIncoming: (call) => this.emit('call_incoming', call),
                emitEnded: (call) => this.emit('call_ended', call),
                emitInboundAudio: (call, pcm) => this.emit('call_inbound_audio', call, pcm),
                emitPeerMute: (call, muted) => this.emit('call_peer_mute', call, muted),
                emitHandRaise: (call, participantJid, raised) => this.emit('call_hand_raise', call, participantJid, raised),
                emitCallReaction: (call, reaction) => this.emit('call_reaction', call, reaction),
                emitScreenShare: (call, share) => this.emit('call_screen_share', call, share),
                emitOutboundAudioFinished: (call) => this.emit('call_outbound_audio_finished', call),
                emitReconnecting: (call, detail) => this.emit('call_reconnecting', call, detail),
                emitReconnected: (call) => this.emit('call_reconnected', call),

                emitVideoState: (call, videoState) => this.emit('call_video_state', call, videoState),

                emitInboundVideo: (call, au, participantJid) => this.emit('call_inbound_video', call, au, participantJid),
                emitGroupState: (call, state) => this.emit('call_group_state', call, state),
                emitWaitingRoom: (call, room) => this.emit('call_waiting_room', call, room),
                emitParticipantAudio: (call, participantJid, pcm) => this.emit('call_participant_audio', call, participantJid, pcm)
            }
        });
        this.calls.set(info.callId, session);
        return session;
    }
    getSessionOrThrow(callId) {
        const session = this.calls.get(callId);
        if (!session) {
            throw new Error(`No call with id ${callId}`);
        }
        return session;
    }
    resolveSessionFromNode(node) {
        const nodeInfo = extractNodeInfo(node);
        if (!nodeInfo?.callId) {
            return null;
        }
        const session = this.calls.get(nodeInfo.callId);
        if (!session) {
            return null;
        }
        return session;
    }
    resolveSessionForOfferAck(node) {
        const stanzaId = node.attrs?.id;
        if (stanzaId) {
            for (const session of this.calls.values()) {
                if (session.offerStanzaId === stanzaId) {
                    return session;
                }
            }
        }
        const callId = node.attrs?.['call-id'];
        if (callId) {
            const session = this.calls.get(callId);
            if (session)
                return session;
        }
        const outgoing = [];
        for (const session of this.calls.values()) {
            if (session.info.isInitiator && !session.info.isEnded) {
                const state = session.info.stateData.state;
                if (state === CallState.Initiating || state === CallState.Ringing) {
                    outgoing.push(session);
                }
            }
        }
        if (outgoing.length === 1)
            return outgoing[0];

        return null;
    }
    emitState(call) {
        this.emit('call_state', call);
    }
    async resolvePeerLid(peerJid) {
        if (isLidJid(peerJid))
            return peerJid;
        try {
            const [mapped] = await this.deps.signalDeviceSync.queryLidsByPhoneJids([peerJid]);
            if (mapped?.lidJid)
                return mapped.lidJid;
        }
        catch { }
        return peerJid;
    }
    async maybeUnblockWaitingCalls() {
        while (this.activeCallCount < this.maxConcurrentCalls) {
            const waiting = [...this.calls.values()].find((session) => session.info.direction === CallDirection.Incoming &&
                session.info.isRinging &&
                session.info.isAcceptBlocked);
            if (!waiting)
                break;
            await this.activateWaitingIncoming(waiting);
        }
    }
    async activateWaitingIncoming(session) {
        session.info.stateData.acceptBlocked = false;
        const creds = this.deps.authClient.getCurrentCredentials();
        const selfLid = creds?.meLid || creds?.meJid || '';
        if (session.info.isGroup) {
            await this.activateGroupInvite(session);
            this.emitState(session.info);
            return;
        }
        await session.initMedia(selfLid, session.info.peerJid);
        await session.sendIncomingPreaccept(session.info.peerJid);
        await session.sendIncomingRelayLatency();
        this.emitState(session.info);
    }
}
