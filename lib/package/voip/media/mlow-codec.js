const MLOW_SAMPLE_RATE = 16_000;
const MLOW_CHANNELS = 1;
const FRAME_SIZE = 960;
const MAX_FRAME_SIZE = 1_920;
const APPLICATION_VOIP = 2048;
const SIGNAL_VOICE = 3001;
let wasmReady = null;
function loadMlowModule() {
    if (!wasmReady) {
        wasmReady = import('libmlow-wasm')
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
    decodeErrors = 0;
    decodeSuccess = 0;
    plcFrames = 0;
    opts = {};
    constructor() { }
    static async create(opts = {}) {
        const codec = new MLowCodec();
        await codec.init(opts);
        return codec;
    }
    async init(opts) {
        this.opts = opts;
        const lib = await loadMlowModule();
        this.decoder = await lib.createDecoder({
            channels: MLOW_CHANNELS,
            sampleRate: MLOW_SAMPLE_RATE,
            useSmpl: true,
            maxFrameSize: MAX_FRAME_SIZE
        });
        try {
            this.encoder = await lib.createEncoder({
                channels: MLOW_CHANNELS,
                sampleRate: MLOW_SAMPLE_RATE,
                application: APPLICATION_VOIP,
                frameSize: FRAME_SIZE,
                useSmpl: true,
                dtx: true,
                fec: opts.fec ?? false,
                bitrate: opts.bitrate ?? 25_000,
                complexity: opts.complexity ?? 9,
                signal: SIGNAL_VOICE
            });
        }
        catch (err) {
            this.decoder?.free();
            this.decoder = null;
            throw err;
        }
    }
    encode(float32Audio) {
        if (!this.encoder) {
            throw new Error('[MLowCodec] encoder not initialized');
        }
        const pcm = new Int16Array(float32Audio.length);
        for (let i = 0; i < float32Audio.length; i++) {
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
            this.plcFrames++;
            return this.decoder.decodePacketLossFloat(this.frameSize);
        }
        try {
            const audio = this.decoder.decodeFloat(mlowFrame, { frameSize: this.frameSize });
            this.decodeSuccess++;
            return audio;
        }
        catch {
            this.decodeErrors++;
            return this.silence();
        }
    }
    silence() {
        return new Float32Array(this.frameSize);
    }
    getStats() {
        return {
            success: this.decodeSuccess,
            errors: this.decodeErrors,
            plc: this.plcFrames
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
    async reset() {
        this.destroy();
        await this.init(this.opts);
        this.decodeErrors = 0;
        this.decodeSuccess = 0;
        this.plcFrames = 0;
    }
    destroy() {
        this.encoder?.free();
        this.decoder?.free();
        this.encoder = null;
        this.decoder = null;
    }
}
