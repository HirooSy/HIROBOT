import { EventEmitter } from 'node:events';
import { WaVoipCoordinator } from './WaVoipCoordinator.js';
import { createVoipDeps } from './voip-deps.js';
import { createConsoleLogger } from './shim/core.js';

async function resolvePeerLid(sock, target) {
    const raw = String(target || '').trim();
    if (!raw)
        throw new Error('resolvePeerLid: target is required');
    if (raw.endsWith('@lid'))
        return raw;
    const pnJid = raw.includes('@') ? raw : `${raw.replace(/\D/g, '')}@s.whatsapp.net`;
    const lid = await sock.signalRepository.lidMapping?.getLIDForPN(pnJid);
    return lid || pnJid;
}
function createVoipCtx(sock, deps, stores, logger, emitter) {
    return {
        deps,
        stores,
        logger,
        registerIncomingHandler({ tag, prepend, handler }) {
            const listener = (node) => {
                Promise.resolve(handler(node)).catch((err) => {
                    logger.error('voip incoming handler failed', { tag, message: err?.message });
                });
            };
            const key = `CB:${tag}`;
            const ws = sock.ws;
            if (prepend && typeof ws.prependListener === 'function') {
                ws.prependListener(key, listener);
            }
            else {
                ws.on(key, listener);
            }
            return () => {
                try {
                    ws.off(key, listener);
                }
                catch { }
            };
        },
        emit(event, payload) {
            emitter.emit(event, payload);
        }
    };
}
export class ActiveCall extends EventEmitter {
    callId;
    #coordinator;
    #endResolver;
    #endPromise;
    #endTimer = null;
    #ended = false;
    #connectedEmitted = false;
    constructor(coordinator, callId, durationMs) {
        super();
        this.callId = callId;
        this.#coordinator = coordinator;
        this.#endPromise = new Promise((res) => { this.#endResolver = res; });
        if (durationMs > 0)
            this.#endTimer = setTimeout(() => this.end(), durationMs);
    }
    _onState(call) {
        if (call.callId !== this.callId)
            return;
        if (call.isRinging)
            this.emit('ringing');
        if (call.isActive && !this.#connectedEmitted) {
            this.#connectedEmitted = true;
            this.emit('connected');
        }
    }
    _onEnded(call) {
        if (call.callId !== this.callId)
            return;
        this._forceEnd(call.stateData?.endReason ?? 'ended');
    }
    _onError(err) {
        this.emit('error', err);
    }
    setMute = (muted) => this.#coordinator.setMute(this.callId, !!muted);
    raiseHand = (raised = true) => this.#coordinator.setHandRaised(this.callId, !!raised);
    shareScreen = (sharing = true) => this.#coordinator.setScreenShare(this.callId, !!sharing);
    react = (emoji) => this.#coordinator.sendReaction(this.callId, emoji);
    upgradeToVideo = () => this.#coordinator.startVideoMidCall(this.callId);
    addParticipant = (target) => this.#coordinator.addGroupParticipant(this.callId, target);
    ringParticipant = (target) => this.#coordinator.ringGroupParticipant(this.callId, target);
    setApprovalRequired = (enabled) => this.#coordinator.setApprovalRequired(this.callId, !!enabled);
    admit = (jid) => this.#coordinator.admitParticipant(this.callId, jid);
    deny = (jid) => this.#coordinator.denyParticipant(this.callId, jid);
    get isGroup() {
        return !!this.#coordinator.getCall(this.callId)?.isGroup;
    }
    get participants() {
        return this.#coordinator.getCall(this.callId)?.groupState?.participants ?? [];
    }
    get waitingRoom() {
        return this.#coordinator.getCall(this.callId)?.waitingRoom ?? null;
    }
    end = async () => {
        if (this.#ended)
            return;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        try {
            await this.#coordinator.endCall(this.callId);
        }
        catch (e) {
            this._forceEnd('ended');
            throw e;
        }
    };
    waitForEnd = () => this.#endPromise;
    get connected() {
        return this.#connectedEmitted;
    }
    get ended() {
        return this.#ended;
    }
    _forceEnd = (reason) => {
        if (this.#ended)
            return;
        this.#ended = true;
        if (this.#endTimer) {
            clearTimeout(this.#endTimer);
            this.#endTimer = null;
        }
        this.emit('ended', reason);
        this.#endResolver(reason);
    };
}
export class VoipClient {
    #config;
    #sock = null;
    #coordinator = null;
    #activeCalls = new Map();
    #offSocketClose = null;
    #connecting = null;
    #boundEv = null;
    #logger = null;
    #signalingDown = false;
    #watchTimer = null;
    #deadlineTimer = null;
    constructor(config) {
        this.#config = config;
        if (!config?.existingSocket) {
            throw new Error('VoipClient requires { existingSocket }: VOIP always runs on the main bot session now, there is no standalone-device mode.');
        }
    }
    get coordinator() {
        return this.#coordinator;
    }
    get activeCalls() {
        return [...this.#activeCalls.values()];
    }
    connect = () => {
        if (this.#signalingDown)
            return Promise.reject(new Error('Connection is reconnecting, try again once it is restored.'));
        if (this.#coordinator && this.#sock === this.#config.existingSocket) {
            return Promise.resolve();
        }
        if (!this.#connecting) {
            this.#connecting = this.#setup().finally(() => {
                this.#connecting = null;
            });
        }
        return this.#connecting;
    };
    #setup = async () => {
        this.#sock = this.#config.existingSocket;
        const { deps, stores } = await createVoipDeps(this.#sock);
        const logger = createConsoleLogger(this.#config.voipLogLevel ?? 'warn');
        this.#logger = logger;
        const emitter = new EventEmitter();
        const ctx = createVoipCtx(this.#sock, deps, stores, logger, emitter);
        this.#coordinator = new WaVoipCoordinator(ctx, {
            maxConcurrentCalls: this.#config.maxConcurrentCalls ?? 1,
            logLevel: this.#config.voipLogLevel ?? 'warn'
        });
        this.#listenForSocket();
    };
    #listenForSocket() {
        const ev = this.#sock.ev;
        const onUpdate = (update) => this.#onConnectionUpdate(update);
        ev?.on?.('connection.update', onUpdate);
        this.#boundEv = ev;
        this.#offSocketClose = () => {
            try {
                ev?.off?.('connection.update', onUpdate);
            }
            catch { }
        };
    }
    #onConnectionUpdate(update) {
        if (update?.connection === 'open') {
            this.#restoreSignaling();
            return;
        }
        if (update?.connection !== 'close')
            return;
        const statusCode = update?.lastDisconnect?.error?.output?.statusCode
            ?? update?.lastDisconnect?.error?.output?.payload?.statusCode;
        if ([401, 403, 411, 440, 500].includes(statusCode) && !(statusCode === 500 && /^WebSocket Error/i.test(String(update?.lastDisconnect?.error?.message || '')))) {
            this.#logger?.warn('voip: socket closed for good, tearing down active calls', { statusCode });
            this.#teardown('connection_closed');
            return;
        }
        if (this.#signalingDown)
            return;
        this.#logger?.warn('voip: socket closed, keeping active calls until it reconnects');
        this.#suspendSignaling();
    }
    #suspendSignaling() {
        this.#signalingDown = true;
        this.#offSocketClose?.();
        this.#offSocketClose = null;
        this.#coordinator?.suspendIncoming();
        this.#coordinator?.notifyReconnecting();
        this.#watchTimer = setInterval(() => this.#watchSocket(), 50);
        this.#deadlineTimer = setTimeout(() => this.#teardown('connection_closed'), 120_000);
    }
    #watchSocket() {
        if (!this.#signalingDown || !this.#sock || this.#sock.ev === this.#boundEv)
            return;
        this.#listenForSocket();
        this.#coordinator?.suspendIncoming();
        this.#coordinator?.resumeIncoming();
    }
    #restoreSignaling() {
        if (!this.#signalingDown)
            return;
        this.#clearSignalingState();
        this.#coordinator?.notifyReconnected();
    }
    #clearSignalingState() {
        this.#signalingDown = false;
        clearInterval(this.#watchTimer);
        clearTimeout(this.#deadlineTimer);
        this.#watchTimer = null;
        this.#deadlineTimer = null;
    }
    #teardown(reason) {
        const calls = [...this.#activeCalls.values()];
        this.#activeCalls.clear();
        this.#offSocketClose?.();
        this.#offSocketClose = null;
        this.#clearSignalingState();
        for (const call of calls) {
            try {
                call._forceEnd(reason);
            }
            catch { }
        }
        try {
            this.#coordinator?.dispose();
        }
        catch { }
        this.#sock = null;
        this.#coordinator = null;
        this.#boundEv = null;
    }
    call = async (phoneNumber, opts = {}) => {
        const coordinator = this.#coordinator;
        if (!this.#sock || !coordinator)
            throw new Error('Not connected. Call connect() first.');
        const durationMs = opts.durationMs ?? 120_000;
        const peerJid = await resolvePeerLid(this.#sock, phoneNumber);
        const audioFile = opts.audioSource && opts.audioSource !== 'silence' ? opts.audioSource : undefined;
        const callId = await coordinator.startCall({
            peerJid,
            isVideo: !!opts.isVideo,
            audioFile,
            videoConfig: opts.videoConfig
        });
        if (this.#coordinator !== coordinator) {
            throw new Error('Connection closed while placing the call.');
        }
        if (audioFile) {
            try {
                await coordinator.loadAudio(callId, audioFile);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load audio "${audioFile}" for call ${callId}:`, e?.message || e);
            }
        }
        if (opts.isVideo && opts.videoSource) {
            try {
                await coordinator.loadVideo(callId, opts.videoSource);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load video "${opts.videoSource}" for call ${callId}:`, e?.message || e);
            }
        }
        if (this.#coordinator !== coordinator) {
            throw new Error('Connection closed while placing the call.');
        }
        return this.#track(coordinator, callId, durationMs);
    };
    #loadGroupMedia = async (coordinator, callId, opts) => {
        const audioFile = opts.audioSource && opts.audioSource !== 'silence' ? opts.audioSource : undefined;
        if (audioFile) {
            try {
                await coordinator.loadAudio(callId, audioFile);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load audio "${audioFile}" for call ${callId}:`, e?.message || e);
            }
        }
        if (opts.videoSource) {
            try {
                await coordinator.loadVideo(callId, opts.videoSource);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load video "${opts.videoSource}" for call ${callId}:`, e?.message || e);
            }
        }
        if (this.#coordinator !== coordinator) {
            throw new Error('Connection closed while placing the call.');
        }
        const call = this.#track(coordinator, callId, opts.durationMs ?? 0);
        setImmediate(() => {
            const info = coordinator.getCall(callId);
            if (info && !call.ended) {
                call._onState(info);
            }
        });
        return call;
    };
    groupCall = async (targets, opts = {}) => {
        const coordinator = this.#coordinator;
        if (!this.#sock || !coordinator)
            throw new Error('Not connected. Call connect() first.');
        const callId = await coordinator.startGroupCall({
            targets,
            groupJid: opts.groupJid,
            isVideo: !!opts.isVideo,
            videoConfig: opts.videoConfig
        });
        return this.#loadGroupMedia(coordinator, callId, opts);
    };
    createLink = async (opts = {}) => {
        const coordinator = this.#coordinator;
        if (!this.#sock || !coordinator)
            throw new Error('Not connected. Call connect() first.');
        return coordinator.createCallLink({ isVideo: !!opts.isVideo });
    };
    queryLink = async (linkOrToken, opts = {}) => {
        const coordinator = this.#coordinator;
        if (!this.#sock || !coordinator)
            throw new Error('Not connected. Call connect() first.');
        return coordinator.queryCallLink(linkOrToken, { isVideo: opts.isVideo });
    };
    joinLink = async (linkOrToken, opts = {}) => {
        const coordinator = this.#coordinator;
        if (!this.#sock || !coordinator)
            throw new Error('Not connected. Call connect() first.');
        const callId = await coordinator.joinCallLink(linkOrToken, {
            isVideo: opts.isVideo,
            videoConfig: opts.videoConfig
        });
        return this.#loadGroupMedia(coordinator, callId, opts);
    };
    #track = (coordinator, callId, durationMs) => {
        const call = new ActiveCall(coordinator, callId, durationMs);
        this.#activeCalls.set(callId, call);
        call.coordinator = coordinator;
        const onState = (info) => call._onState(info);
        const onEnded = (info) => call._onEnded(info);
        const onError = (err) => {
            if (err?.callId && err.callId !== callId)
                return;
            call._onError(err);
        };
        coordinator.on('call_state', onState);
        coordinator.on('call_ended', onEnded);
        coordinator.on('call_error', onError);
        const forwarded = [
            ['call_peer_mute', 'peer_mute', (c, muted) => [muted]],
            ['call_hand_raise', 'hand_raise', (c, jid, raised) => [{ jid, raised }]],
            ['call_reaction', 'reaction', (c, reaction) => [reaction]],
            ['call_screen_share', 'screen_share', (c, share) => [share]],
            ['call_video_state', 'peer_video', (c, change) => [change]],
            ['call_inbound_audio', 'inbound_audio', (c, pcm) => [pcm]],
            ['call_inbound_video', 'inbound_video', (c, frame, participantJid) => [frame, participantJid]],
            ['call_group_state', 'group_state', (c, state) => [state]],
            ['call_waiting_room', 'waiting_room', (c, room) => [room]],
            ['call_participant_audio', 'participant_audio', (c, participantJid, pcm) => [participantJid, pcm]],
            ['call_outbound_audio_finished', 'audio_finished', () => []],
            ['call_reconnecting', 'reconnecting', (c, detail) => [detail]],
            ['call_reconnected', 'reconnected', () => []]
        ].map(([source, target, shape]) => {
            const listener = (info, ...rest) => {
                if (info?.callId === callId)
                    call.emit(target, ...shape(info, ...rest));
            };
            coordinator.on(source, listener);
            return [source, listener];
        });
        call.once('ended', () => {
            for (const [source, listener] of forwarded)
                coordinator.off(source, listener);
            coordinator.off('call_state', onState);
            coordinator.off('call_ended', onEnded);
            coordinator.off('call_error', onError);
            if (this.#activeCalls.get(callId) === call)
                this.#activeCalls.delete(callId);
        });
        return call;
    };
    answer = async (callId, opts = {}) => {
        const coordinator = this.#coordinator;
        if (!this.#sock || !coordinator)
            throw new Error('Not connected. Call connect() first.');
        const info = coordinator.getCall(callId);
        if (!info)
            throw new Error(`Unknown call ${callId}.`);
        if (!info.canAccept)
            throw new Error(`Call ${callId} cannot be accepted right now.`);
        const call = this.#track(coordinator, callId, opts.durationMs ?? 0);
        try {
            await coordinator.acceptCall(callId);
        }
        catch (err) {
            call._forceEnd('failed');
            throw err;
        }
        const audioFile = opts.audioSource && opts.audioSource !== 'silence' ? opts.audioSource : undefined;
        if (audioFile) {
            try {
                await coordinator.loadAudio(callId, audioFile);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load audio "${audioFile}" for call ${callId}:`, e?.message || e);
            }
        }
        if (opts.videoSource) {
            try {
                await coordinator.loadVideo(callId, opts.videoSource);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load video "${opts.videoSource}" for call ${callId}:`, e?.message || e);
            }
        }
        return call;
    };
    disconnect = () => {
        for (const call of this.#activeCalls.values()) {
            try {
                call.end()?.catch?.(() => { });
            }
            catch { }
        }
        this.#teardown('disconnected');
    };
}
