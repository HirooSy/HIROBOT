import { WA_MESSAGE_TAGS } from './shim/protocol.js';
import { WaCallManager } from './call/WaCallManager.js';
import { routeCallAck, routeCallReceipt, routeCallStanza } from './signaling/bridge.js';
export class WaVoipCoordinator {
    manager;
    deps;
    logger;
    unregisterHandlers = [];
    constructor(ctx, options = {}) {
        this.deps = ctx.deps;
        this.logger = ctx.logger.child({ scope: 'voip' }, { level: options.logLevel });
        this.manager = new WaCallManager({
            deps: ctx.deps,
            stores: ctx.stores,
            logger: this.logger,
            maxConcurrentCalls: options.maxConcurrentCalls
        });
        this.registerIncomingHandlers(ctx);
        this.wireClientEvents(ctx);
    }
    async startCall(options) {
        return this.manager.startCall(options);
    }
    async acceptCall(callId) {
        return this.manager.acceptCall(callId);
    }
    async rejectCall(callId, reason) {
        return this.manager.rejectCall(callId, reason);
    }
    async endCall(callId, reason) {
        return this.manager.endCall(callId, reason);
    }
    async loadAudio(callId, audioPath) {
        return this.manager.loadAudio(callId, audioPath);
    }
    async loadVideo(callId, videoPath) {
        return this.manager.loadVideo(callId, videoPath);
    }
    setMute(callId, muted) {
        this.manager.setMute(callId, muted);
    }
    setExternalAudioMode(callId, enabled) {
        this.manager.setExternalAudioMode(callId, enabled);
    }
    feedLiveAudio(callId, data) {
        return this.manager.feedLiveAudio(callId, data);
    }
    getLiveBufferMs(callId) {
        return this.manager.getLiveBufferMs(callId);
    }
    getFeedWatermarksMs() {
        return this.manager.getFeedWatermarksMs();
    }
    getCall(callId) {
        return this.manager.getCall(callId);
    }
    getCalls() {
        return this.manager.getCalls();
    }
    on(event, listener) {
        this.manager.on(event, listener);
        return this;
    }
    off(event, listener) {
        this.manager.off(event, listener);
        return this;
    }
    once(event, listener) {
        this.manager.once(event, listener);
        return this;
    }
    dispose() {
        for (const unregister of this.unregisterHandlers.splice(0)) {
            unregister();
        }
        this.manager.destroy();
    }
    registerIncomingHandlers(ctx) {
        this.unregisterHandlers.push(ctx.registerIncomingHandler({
            tag: 'call',
            prepend: true,
            handler: async (node) => {
                const tag = await routeCallStanza(this.manager, this.deps, node, this.logger);
                return tag !== null;
            }
        }), ctx.registerIncomingHandler({
            tag: WA_MESSAGE_TAGS.ACK,
            prepend: true,
            handler: async (node) => {
                if (node.attrs.class !== 'call') {
                    return false;
                }
                await routeCallAck(this.manager, node);
                return true;
            }
        }), ctx.registerIncomingHandler({
            tag: WA_MESSAGE_TAGS.RECEIPT,
            prepend: true,
            handler: async (node) => routeCallReceipt(this.deps, node)
        }));
    }
    wireClientEvents(ctx) {
        this.manager.on('call_state', (call) => {
            ctx.emit('voip_call_state', call);
        });
        this.manager.on('call_incoming', (call) => {
            ctx.emit('voip_call_incoming', call);
        });
        this.manager.on('call_ended', (call) => {
            ctx.emit('voip_call_ended', call);
        });
        this.manager.on('call_inbound_audio', (call, pcm) => {
            ctx.emit('voip_call_inbound_audio', { call, pcm });
        });
        this.manager.on('call_outbound_audio_finished', (call) => {
            ctx.emit('voip_call_outbound_audio_finished', call);
        });
        this.manager.on('call_error', (error) => {
            ctx.emit('voip_call_error', error);
        });
    }
}
