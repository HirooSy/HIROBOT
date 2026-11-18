import { createNoopLogger } from '../shim/core.js';
import { toError } from '../shim/util.js';
const MLOW_SAMPLE_RATE = 16_000;
const MLOW_CHANNELS = 1;
const FRAME_SIZE = 960;
const MAX_FRAME_SIZE = 1_920;
const APPLICATION_VOIP = 2048;
const SIGNAL_VOICE = 3001;
const CONCEAL_QUANTUM = MLOW_SAMPLE_RATE / 400;
const DEFAULT_BITRATE = 24_000;
const DEFAULT_MAX_CONCEAL_FRAMES = 5;
const MAX_LOSS_HINT = 20;
const SEQ_SPACE = 0x1_0000;
const SEQ_HALF = 0x8000;
export const MLOW_ENCODER_CTL = Object.freeze({
    SUBFRAME_IMPORTANCE: 4060,
    USE_SPEECH_ACTIVITY_FLATNESS: 4062,
    VAD_NON_BINARY: 4066,
    VAD_HIGHPASS_SHARPNESS: 4068
});
let wasmReady = null;
function loadMlowModule() {
    if (!wasmReady) {
        wasmReady = import('./audio-codec.js')
            .then(async (mod) => {
            const lib = mod;
            await lib.loadLibopus();
            return lib;
        })
            .catch((err) => {
            wasmReady = null;
            throw err;
        });
    }
    return wasmReady;
}
export class MLowCodec {
    encoder = null;
    decoder = null;
    frameSize = FRAME_SIZE;
    logger = createNoopLogger();
    decodeErrors = 0;
    decodeSuccess = 0;
    plcFrames = 0;
    fecFrames = 0;
    lateFrames = 0;
    concealCapped = 0;
    opts = {};
    packetLossPercent = 0;
    maxConcealFrames = DEFAULT_MAX_CONCEAL_FRAMES;
    lastSeq = -1;
    lastDecodedSamples = 0;
    pcmScratch = new Int16Array(FRAME_SIZE);
    lib = null;
    encoderOptions = null;
    silenceScratch = new Float32Array(MAX_FRAME_SIZE);
    constructor() { }
    static async create(opts = {}) {
        const codec = new MLowCodec();
        await codec.init(opts);
        return codec;
    }
    async init(opts) {
        this.opts = opts;
        this.logger = opts.logger ?? createNoopLogger();
        this.packetLossPercent = Math.min(MAX_LOSS_HINT, clampPercent(opts.packetLossPercent ?? 0));
        const requestedConcealFrames = opts.maxConcealFrames;
        this.maxConcealFrames = Math.max(0, Math.trunc(Number.isFinite(requestedConcealFrames)
            ? requestedConcealFrames
            : DEFAULT_MAX_CONCEAL_FRAMES));
        const lib = await loadMlowModule();
        this.lib = lib;
        if (!opts.encodeOnly) {
            this.decoder = await lib.createDecoder({
                channels: MLOW_CHANNELS,
                sampleRate: MLOW_SAMPLE_RATE,
                useSmpl: true,
                maxFrameSize: MAX_FRAME_SIZE
            });
        }
        if (opts.decodeOnly) {
            return;
        }
        try {
            this.encoderOptions = {
                channels: MLOW_CHANNELS,
                sampleRate: MLOW_SAMPLE_RATE,
                application: APPLICATION_VOIP,
                frameSize: FRAME_SIZE,
                useSmpl: true,
                dtx: opts.dtx ?? false,
                fec: opts.fec ?? true,
                packetLossPercent: this.packetLossPercent,
                bitrate: opts.bitrate ?? DEFAULT_BITRATE,
                complexity: opts.complexity ?? 5,
                signal: SIGNAL_VOICE
            };
            this.encoder = await lib.createEncoder(this.encoderOptions);
        }
        catch (err) {
            this.decoder?.free();
            this.decoder = null;
            throw err;
        }
        if (opts.tunables) {
            this.applyEncoderTunables(opts.tunables);
        }
    }
    encode(float32Audio) {
        if (!this.encoder) {
            throw new Error('[MLowCodec] encoder not initialized');
        }
        if (float32Audio.length !== this.frameSize) {
            throw new Error(`[MLowCodec] encode expects ${this.frameSize} samples, got ${float32Audio.length}`);
        }
        const pcm = this.pcmScratch;
        for (let i = 0; i < pcm.length; i++) {
            const sample = Math.max(-1, Math.min(1, float32Audio[i]));
            pcm[i] = Math.round(sample * 32_767);
        }
        return this.encoder.encode(pcm, { frameSize: this.frameSize });
    }
    decode(mlowFrame) {
        if (!this.decoder) {
            throw new Error('[MLowCodec] decoder not initialized');
        }
        if (mlowFrame === null) {
            return this.conceal(this.concealFrameSize());
        }
        const decoded = this.tryDecode(mlowFrame);
        return decoded ?? this.silence(this.concealFrameSize());
    }
    decodeSequenced(seq, packet, onFrame) {
        if (!this.decoder) {
            throw new Error('[MLowCodec] decoder not initialized');
        }
        if (packet.length === 0) {
            return;
        }
        const current = seq & 0xffff;
        if (this.lastSeq >= 0) {
            const delta = (current - this.lastSeq + SEQ_SPACE) % SEQ_SPACE;
            if (delta === 0 || delta >= SEQ_HALF) {
                this.lateFrames++;
                return;
            }
            if (delta > 1) {
                this.concealGap(delta - 1, packet, onFrame);
            }
        }
        const decoded = this.tryDecode(packet);
        if (decoded === null) {
            this.lastSeq = (current - 1 + SEQ_SPACE) % SEQ_SPACE;
            return;
        }
        this.lastSeq = current;
        onFrame(decoded);
    }
    resetSequence() {
        this.lastSeq = -1;
        this.lastDecodedSamples = 0;
    }
    setExpectedPacketLossPercent(percent) {
        const next = Math.min(MAX_LOSS_HINT, clampPercent(percent));
        if (next === this.packetLossPercent) {
            return;
        }
        this.packetLossPercent = next;
        if (!this.encoder) {
            return;
        }
        try {
            this.encoder.setPacketLossPercent(next);
        }
        catch (err) {
            this.logger.warn('mlow packet loss percent rejected', {
                percent: next,
                message: toError(err).message
            });
        }
    }
    getExpectedPacketLossPercent() {
        return this.packetLossPercent;
    }
    applyEncoderTunables(tunables) {
        if (!this.encoder) {
            throw new Error('[MLowCodec] encoder not initialized');
        }
        this.opts = { ...this.opts, tunables };
        this.writeCtl(MLOW_ENCODER_CTL.SUBFRAME_IMPORTANCE, tunables.subframeImportance);
        this.writeCtl(MLOW_ENCODER_CTL.USE_SPEECH_ACTIVITY_FLATNESS, tunables.useSpeechActivityFlatness);
        this.writeCtl(MLOW_ENCODER_CTL.VAD_NON_BINARY, tunables.vadNonBinary);
        this.writeCtl(MLOW_ENCODER_CTL.VAD_HIGHPASS_SHARPNESS, tunables.vadHighpassSharpness);
    }
    getStats() {
        return {
            success: this.decodeSuccess,
            errors: this.decodeErrors,
            plc: this.plcFrames,
            fec: this.fecFrames,
            late: this.lateFrames,
            concealCapped: this.concealCapped
        };
    }
    getFrameSize() {
        return this.frameSize;
    }
    getFrameDurationMs() {
        return (this.frameSize / MLOW_SAMPLE_RATE) * 1000;
    }
    getSampleRate() {
        return MLOW_SAMPLE_RATE;
    }
    getMaxConcealFrames() {
        return this.maxConcealFrames;
    }
    async reset() {
        this.destroy();
        await this.init(this.opts);
        this.decodeErrors = 0;
        this.decodeSuccess = 0;
        this.plcFrames = 0;
        this.fecFrames = 0;
        this.lateFrames = 0;
        this.concealCapped = 0;
        this.resetSequence();
    }
    destroy() {
        this.encoder?.free();
        this.decoder?.free();
        this.encoder = null;
        this.decoder = null;
    }
    concealGap(missing, nextPacket, onFrame) {
        const limit = this.maxConcealFrames;
        const frames = missing > limit ? limit : missing;
        if (frames < missing) {
            this.concealCapped++;
        }
        if (frames <= 0) {
            return;
        }
        const frameSize = this.concealFrameSize();
        for (let i = 0; i < frames - 1; i++) {
            onFrame(this.conceal(frameSize));
        }
        onFrame(this.recoverPrevious(nextPacket, frameSize));
    }
    tryDecode(mlowFrame) {
        if (!this.decoder) {
            return null;
        }
        try {
            const audio = this.decoder.decodeFloat(mlowFrame);
            this.decodeSuccess++;
            if (audio.length > 0) {
                this.lastDecodedSamples = audio.length;
            }
            return audio;
        }
        catch (err) {
            this.decodeErrors++;
            return null;
        }
    }
    recoverPrevious(nextPacket, frameSize) {
        if (!this.decoder) {
            return this.silence(frameSize);
        }
        try {
            const recovered = this.decoder.decodeFloat(nextPacket, {
                decodeFec: true,
                frameSize
            });
            this.fecFrames++;
            return recovered;
        }
        catch (err) {
            return this.conceal(frameSize);
        }
    }
    conceal(frameSize) {
        if (!this.decoder) {
            return this.silence(frameSize);
        }
        try {
            const concealed = this.decoder.decodePacketLossFloat(frameSize);
            this.plcFrames++;
            return concealed;
        }
        catch (err) {
            return this.silence(frameSize);
        }
    }
    concealFrameSize() {
        const last = this.lastDecodedSamples;
        if (last <= 0) {
            return this.frameSize;
        }
        const quantized = Math.round(last / CONCEAL_QUANTUM) * CONCEAL_QUANTUM;
        if (quantized < CONCEAL_QUANTUM) {
            return CONCEAL_QUANTUM;
        }
        return quantized > MAX_FRAME_SIZE ? MAX_FRAME_SIZE : quantized;
    }
    silence(frameSize) {
        const size = frameSize > MAX_FRAME_SIZE ? MAX_FRAME_SIZE : frameSize;
        return this.silenceScratch.subarray(0, size);
    }
    writeCtl(request, value) {
        if (value === undefined || !this.encoder) {
            return;
        }
        try {
            this.encoder.encoderCtl(request, value);
        }
        catch (err) {
            this.logger.warn('mlow encoder ctl rejected', {
                request,
                value,
                message: toError(err).message
            });
        }
    }
}
function clampPercent(value) {
    if (!Number.isFinite(value)) {
        return 0;
    }
    const rounded = Math.round(value);
    if (rounded < 0) {
        return 0;
    }
    return rounded > 100 ? 100 : rounded;
}
