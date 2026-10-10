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
            if (prepend && typeof sock.ws.prependListener === 'function') {
                sock.ws.prependListener(key, listener);
            }
            else {
                sock.ws.on(key, listener);
            }
            return () => {
                try {
                    sock.ws.off(key, listener);
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
        const emitter = new EventEmitter();
        const ctx = createVoipCtx(this.#sock, deps, stores, logger, emitter);
        this.#coordinator = new WaVoipCoordinator(ctx, {
            maxConcurrentCalls: this.#config.maxConcurrentCalls ?? 1,
            logLevel: this.#config.voipLogLevel ?? 'warn'
        });
        const sock = this.#sock;
        const onUpdate = (update) => {
            if (update?.connection !== 'close')
                return;
            if (this.#sock !== sock)
                return;
            logger.warn('voip: socket closed, tearing down active calls');
            this.#teardown('connection_closed');
        };
        sock.ev?.on?.('connection.update', onUpdate);
        this.#offSocketClose = () => {
            try {
                sock.ev?.off?.('connection.update', onUpdate);
            }
            catch { }
        };
    };
    #teardown(reason) {
        const calls = [...this.#activeCalls.values()];
        this.#activeCalls.clear();
        this.#offSocketClose?.();
        this.#offSocketClose = null;
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
            ['call_inbound_video', 'inbound_video', (c, frame) => [frame]],
            ['call_outbound_audio_finished', 'audio_finished', () => []]
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
