import { createNoopLogger } from '../shim/core.js';
import { toError } from '../shim/util.js';
const MLOW_SAMPLE_RATE = 16_000;
const MLOW_CHANNELS = 1;
const FRAME_SIZE = 960;
const MAX_FRAME_SIZE = 1_920;
const APPLICATION_VOIP = 2048;
const SIGNAL_VOICE = 3001;
const CONCEAL_QUANTUM = MLOW_SAMPLE_RATE / 400;
const DEFAULT_BITRATE = 15_000;
const DEFAULT_COMPLEXITY = 5;
const DEFAULT_MAX_CONCEAL_FRAMES = 5;
const MAX_LOSS_HINT = 5;
const SPEECH_TOC_MASK = 0xf8;
const SPEECH_TOC_60MS = 0x50;
const TINY_FRAME_BYTES = 18;
const RENEW_MIN_RMS = 120;
const RENEW_MIN_GAP_FRAMES = 4;
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
    spareEncoder = null;
    spareBuilding = false;
    generation = 0;
    frameIndex = 0;
    lastRenewFrame = -1000;
    renewCount = 0;
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
        this.decoder = await lib.createDecoder({
            channels: MLOW_CHANNELS,
            sampleRate: MLOW_SAMPLE_RATE,
            useSmpl: true,
            maxFrameSize: MAX_FRAME_SIZE
        });
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
                complexity: opts.complexity ?? DEFAULT_COMPLEXITY,
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
        this.frameIndex = 0;
        this.lastRenewFrame = -1000;
        this.prepareSpare();
        this.logger.warn('[MLOW] encoder ready', {
            vadRenew: true,
            bitrate: this.encoderOptions.bitrate,
            lossHintCap: MAX_LOSS_HINT
        });
    }
    prepareSpare() {
        if (this.spareEncoder || this.spareBuilding || !this.lib || !this.encoderOptions) {
            return;
        }
        const generation = this.generation;
        this.spareBuilding = true;
        const options = { ...this.encoderOptions, packetLossPercent: this.packetLossPercent };
        this.lib.createEncoder(options).then((enc) => {
            this.spareBuilding = false;
            if (generation !== this.generation) {
                enc.free();
                return;
            }
            const tunables = this.opts?.tunables;
            if (tunables) {
                this.writeCtlOn(enc, MLOW_ENCODER_CTL.SUBFRAME_IMPORTANCE, tunables.subframeImportance);
                this.writeCtlOn(enc, MLOW_ENCODER_CTL.USE_SPEECH_ACTIVITY_FLATNESS, tunables.useSpeechActivityFlatness);
                this.writeCtlOn(enc, MLOW_ENCODER_CTL.VAD_NON_BINARY, tunables.vadNonBinary);
                this.writeCtlOn(enc, MLOW_ENCODER_CTL.VAD_HIGHPASS_SHARPNESS, tunables.vadHighpassSharpness);
            }
            this.spareEncoder = enc;
        }, (err) => {
            this.spareBuilding = false;
            this.logger.warn('mlow spare encoder unavailable', { message: toError(err).message });
        });
    }
    renewEncoder(pcm, original) {
        const spare = this.spareEncoder;
        this.spareEncoder = null;
        const kept = Uint8Array.from(original);
        try {
            const alt = spare.encode(pcm, { frameSize: this.frameSize });
            if (alt.length > 0 && (alt[0] & SPEECH_TOC_MASK) === SPEECH_TOC_60MS) {
                const out = Uint8Array.from(alt);
                const old = this.encoder;
                this.encoder = spare;
                try {
                    spare.setPacketLossPercent(this.packetLossPercent);
                }
                catch { }
                try {
                    old.free();
                }
                catch { }
                this.renewCount++;
                this.lastRenewFrame = this.frameIndex;
                if (this.renewCount === 1 || this.renewCount % 20 === 0) {
                    this.logger.warn('[MLOW] encoder renewed: frame came out with VAD off', {
                        renewCount: this.renewCount,
                        frame: this.frameIndex,
                        tocBefore: kept[0],
                        tocAfter: out[0]
                    });
                }
                this.prepareSpare();
                return out;
            }
            spare.free();
        }
        catch (err) {
            this.logger.warn('mlow encoder renew failed', { message: toError(err).message });
            try {
                spare.free();
            }
            catch { }
        }
        this.prepareSpare();
        return kept;
    }
    encode(float32Audio) {
        if (!this.encoder) {
            throw new Error('[MLowCodec] encoder not initialized');
        }
        if (float32Audio.length !== this.frameSize) {
            throw new Error(`[MLowCodec] encode expects ${this.frameSize} samples, got ${float32Audio.length}`);
        }
        const pcm = this.pcmScratch;
        let sumSq = 0;
        for (let i = 0; i < pcm.length; i++) {
            const sample = Math.max(-1, Math.min(1, float32Audio[i]));
            const v = Math.round(sample * 32_767);
            pcm[i] = v;
            sumSq += v * v;
        }
        const packet = this.encoder.encode(pcm, { frameSize: this.frameSize });
        this.frameIndex++;
        if (packet.length > TINY_FRAME_BYTES &&
            (packet[0] & SPEECH_TOC_MASK) !== SPEECH_TOC_60MS &&
            this.spareEncoder &&
            this.frameIndex - this.lastRenewFrame >= RENEW_MIN_GAP_FRAMES &&
            Math.sqrt(sumSq / pcm.length) >= RENEW_MIN_RMS) {
            return this.renewEncoder(pcm, packet);
        }
        return packet;
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
                this.logger.trace('mlow packet arrived out of order', {
                    seq: current,
                    lastSeq: this.lastSeq
                });
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
            concealCapped: this.concealCapped,
            vadRenew: this.renewCount
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
        this.renewCount = 0;
        this.resetSequence();
    }
    destroy() {
        if (this.frameIndex > 0) {
            this.logger.warn('[MLOW] call summary', {
                frames: this.frameIndex,
                renewed: this.renewCount,
                renewedPct: Math.round((1000 * this.renewCount) / this.frameIndex) / 10
            });
        }
        this.generation++;
        this.spareBuilding = false;
        this.spareEncoder?.free();
        this.spareEncoder = null;
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
            this.logger.trace('mlow concealment capped', { missing, frames });
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
            this.logger.trace('mlow decode failed', { message: toError(err).message });
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
            this.logger.trace('mlow fec decode failed, concealing instead', {
                message: toError(err).message
            });
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
            this.logger.trace('mlow concealment failed', { message: toError(err).message });
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
    writeCtlOn(enc, request, value) {
        if (value === undefined || !enc) {
            return;
        }
        try {
            enc.encoderCtl(request, value);
        }
        catch (err) {
            this.logger.warn('mlow spare ctl rejected', { request, message: toError(err).message });
        }
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
