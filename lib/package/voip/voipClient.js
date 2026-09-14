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
    #activeCall = null;
    constructor(config) {
        this.#config = config;
        if (!config?.existingSocket) {
            throw new Error('VoipClient requires { existingSocket }: VOIP always runs on the main bot session now, there is no standalone-device mode.');
        }
    }
    connect = async () => {
        if (this.#coordinator && this.#sock === this.#config.existingSocket) {

            return;
        }
        this.#sock = this.#config.existingSocket;
        const { deps, stores } = await createVoipDeps(this.#sock);
        const logger = createConsoleLogger(this.#config.voipLogLevel ?? 'warn');
        const emitter = new EventEmitter();
        const ctx = createVoipCtx(this.#sock, deps, stores, logger, emitter);
        this.#coordinator = new WaVoipCoordinator(ctx, {
            maxConcurrentCalls: 1,
            logLevel: this.#config.voipLogLevel ?? 'warn'
        });
    };
    call = async (phoneNumber, opts = {}) => {
        if (!this.#sock || !this.#coordinator)
            throw new Error('Not connected. Call connect() first.');
        if (this.#activeCall)
            throw new Error('A call is already active.');
        const durationMs = opts.durationMs ?? 120_000;
        const peerJid = await resolvePeerLid(this.#sock, phoneNumber);
        const audioFile = opts.audioSource && opts.audioSource !== 'silence' ? opts.audioSource : undefined;
        const callId = await this.#coordinator.startCall({
            peerJid,
            isVideo: !!opts.isVideo,
            audioFile,
            videoConfig: opts.videoConfig
        });

        if (audioFile) {
            try {
                await this.#coordinator.loadAudio(callId, audioFile);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load audio "${audioFile}" for call ${callId}:`, e?.message || e);
            }
        }
        if (opts.isVideo && opts.videoSource) {
            try {
                await this.#coordinator.loadVideo(callId, opts.videoSource);
            } catch (e) {
                console.error(`[ VOIP ] Failed to load video "${opts.videoSource}" for call ${callId}:`, e?.message || e);
            }
        }
        const call = new ActiveCall(this.#coordinator, callId, durationMs);
        this.#activeCall = call;

        call.coordinator = this.#coordinator;
        const onState = (info) => call._onState(info);
        const onEnded = (info) => call._onEnded(info);
        const onError = (err) => call._onError(err);
        this.#coordinator.on('call_state', onState);
        this.#coordinator.on('call_ended', onEnded);
        this.#coordinator.on('call_error', onError);
        call.once('ended', () => {
            this.#coordinator?.off('call_state', onState);
            this.#coordinator?.off('call_ended', onEnded);
            this.#coordinator?.off('call_error', onError);
            if (this.#activeCall === call)
                this.#activeCall = null;
        });
        return call;
    };
    disconnect = () => {
        try {
            this.#activeCall?.end();
        }
        catch { }
        try {
            this.#coordinator?.dispose();
        }
        catch { }
        this.#sock = null;
        this.#coordinator = null;
    };
}
