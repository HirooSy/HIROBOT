import { EventEmitter } from 'node:events';
import { createNoopLogger } from '../shim/core.js';
import { isLidJid } from '../shim/protocol.js';
import { hasNodeChild } from '../shim/transport.js';
import { resolvePositive, toError } from '../shim/util.js';
import { generateCallKey } from '../crypto/encryption.js';
import { WaAudioEngine } from '../media/WaAudioEngine.js';
import { parseRelayFromAck } from '../relay/relay-ack.js';
import { buildOfferStanza, decryptCallKey, extractNodeInfo, generateCallId } from '../signaling/signaling.js';
import { CallDirection, CallMediaType, CallState, EndCallReason } from '../types.js';
import { CallInfo } from './call-state.js';
import { WaCallMediaSession } from './WaCallMediaSession.js';
const DEFAULT_MAX_CONCURRENT_CALLS = 1;
export class WaCallManager extends EventEmitter {
    deps;
    stores;
    logger;
    maxConcurrentCalls;
    calls = new Map();
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
        const session = this.createSession(info);
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
        this.logger.debug('outgoing offer sent', { callId, peerJid });
        return callId;
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
    async loadAudio(callId, audioPath) {
        const session = this.getSessionOrThrow(callId);
        await session.loadAudio(audioPath);
    }
    async loadVideo(callId, videoPath) {
        const session = this.getSessionOrThrow(callId);
        await session.loadVideo(videoPath);
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
                this.logger.debug('duplicate offer for active call, ignoring', { callId });
                return;
            }
            existing.cleanup();
            this.calls.delete(callId);
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
                catch (transitionErr) {
                    this.logger.trace('failed-activation transition skipped', {
                        message: toError(transitionErr).message
                    });
                }
                this.emit('call_ended', info);
                this.emitState(info);
                session.cleanup();
                this.calls.delete(callId);
                await this.maybeUnblockWaitingCalls();
                return;
            }
        }
        else {
            this.logger.debug('incoming call waiting, at capacity', {
                callId,
                peerJid,
                maxConcurrentCalls: this.maxConcurrentCalls
            });
        }
        this.emit('call_incoming', info);
        this.emitState(info);
        this.logger.debug('incoming call', {
            callId,
            peerJid,
            callCreator,
            isVideo,
            relayCount: relays.length,
            acceptBlocked: atCapacity
        });
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
    async handleCallTerminate(node) {
        const session = this.resolveSessionFromNode(node);
        if (!session)
            return;
        session.handleCallTerminate();
        this.calls.delete(session.callId);
        await this.maybeUnblockWaitingCalls();
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
        const session = new WaCallMediaSession({
            deps: this.deps,
            logger: sessionLogger,
            info,
            delegate: {
                emitState: (call) => this.emitState(call),
                emitIncoming: (call) => this.emit('call_incoming', call),
                emitEnded: (call) => this.emit('call_ended', call),
                emitInboundAudio: (call, pcm) => this.emit('call_inbound_audio', call, pcm),
                emitOutboundAudioFinished: (call) => this.emit('call_outbound_audio_finished', call)
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
            this.logger.debug('stanza missing call-id, ignored');
            return null;
        }
        const session = this.calls.get(nodeInfo.callId);
        if (!session) {
            this.logger.debug('no session for call-id', { callId: nodeInfo.callId });
            return null;
        }
        return session;
    }
    resolveSessionForOfferAck(node) {
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
        this.logger.debug('offer ack could not be routed', {
            callId: callId ?? null,
            candidateCount: outgoing.length
        });
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
        catch (err) {
            this.logger.trace('lid resolution failed', { message: toError(err).message });
        }
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
        await session.initMedia(selfLid, session.info.peerJid);
        await session.sendIncomingPreaccept(session.info.peerJid);
        await session.sendIncomingRelayLatency();
        this.emitState(session.info);
        this.logger.debug('waiting incoming call unblocked', { callId: session.callId });
    }
}
