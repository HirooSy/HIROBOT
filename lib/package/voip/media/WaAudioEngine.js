import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createNoopLogger } from '../shim/core.js';
import { TEXT_DECODER } from '../bytes.js';
import { DEFAULT_AUDIO_CONFIG } from '../types.js';
const FFMPEG_BIN = 'ffmpeg';
const MAX_DECODE_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
const ffmpegProbeCache = new Map();
function probeBinary(bin) {
    return new Promise((resolve) => {
        execFile(bin, ['-version'], { timeout: 5_000 }, (err) => resolve(!err));
    });
}
async function hasFfmpeg(bin) {
    let available = ffmpegProbeCache.get(bin);
    if (available === undefined) {
        available = await probeBinary(bin);
        if (available) {
            ffmpegProbeCache.set(bin, available);
        }
    }
    return available;
}
function createSelfCorrectingInterval(callback, intervalMs) {
    let expected = performance.now() + intervalMs;
    let timer = null;
    let stopped = false;
    function tick() {
        if (stopped) return;
        if (performance.now() - expected > intervalMs * 3) {
            expected = performance.now();
        }
        callback();
        expected += intervalMs;
        timer = setTimeout(tick, Math.max(0, expected - performance.now()));
    }
    timer = setTimeout(tick, intervalMs);
    return {
        clear() {
            stopped = true;
            if (timer) clearTimeout(timer);
        }
    };
}
export class WaAudioEngine {
    logger;
    audioSender = null;
    audioBuffer = null;
    audioScale = 1;
    audioPosition = 0;
    audioFinished = false;
    onAudioFinished = null;
    playbackInterval = null;
    captureInterval = null;
    circularBuffer;
    bufferWritePos = 0;
    bufferReadPos = 0;
    bufferLength = 0;
    sampleRate;
    captureChunkSize;
    maxBuffer;
    outputSize;
    intervalMs;
    silenceMode = false;
    externalMode = false;
    loopMode = false;
    liveWritePos = 0;
    extStarted = false;
    extPreBufferSize;
    extTargetBuffer;
    extHighWater;
    extMaxBuffer;
    streamPreBufferSize;
    streamHighWater;
    captureChunkBuffer;
    silenceChunkBuffer;
    playbackOutputBuffer;
    streamProc = null;
    streamMode = false;
    streamEnded = false;
    streamPaused = false;
    streamToken = 0;
    streamQueue = [];
    streamCarry = Buffer.alloc(0);
    constructor(config = {}) {
        const c = { ...DEFAULT_AUDIO_CONFIG, ...config };
        this.logger = config.logger ?? createNoopLogger();
        this.sampleRate = c.sampleRate;
        this.captureChunkSize = c.captureChunkSize;
        this.maxBuffer = c.maxBufferSize;
        this.outputSize = c.playbackOutputSize;
        this.intervalMs = c.intervalMs;
        this.circularBuffer = new Float32Array(this.maxBuffer);
        this.captureChunkBuffer = new Float32Array(this.captureChunkSize);
        this.silenceChunkBuffer = new Float32Array(this.captureChunkSize);
        this.playbackOutputBuffer = new Float32Array(this.outputSize);
        this.extPreBufferSize = Math.floor(this.sampleRate * 0.06);
        this.extTargetBuffer = Math.floor(this.sampleRate * 0.06);
        this.extHighWater = Math.floor(this.sampleRate * 0.2);
        this.extMaxBuffer = Math.floor(this.sampleRate);
        this.streamPreBufferSize = Math.floor(this.sampleRate * 0.3);
        this.streamHighWater = Math.floor(this.sampleRate * 0.6);
        this.streamMaxBacklog = Math.floor(this.sampleRate * 1);
    }
    setAudioSender(sender) {
        this.audioSender = sender;
    }
    setLoopMode(enabled) {
        this.loopMode = enabled;
    }
    setOnAudioFinished(callback) {
        this.onAudioFinished = callback;
    }
    setExternalMode(enabled) {
        this.stopStream();
        this.externalMode = enabled;
        this.extStarted = false;
        if (enabled) {
            this.audioBuffer = new Float32Array(this.extMaxBuffer);
            this.audioScale = 1;
            this.audioPosition = 0;
            this.liveWritePos = 0;
            this.audioFinished = false;
        }
    }
    isExternalMode() {
        return this.externalMode;
    }
    feedExternalAudio(data) {
        if (!this.externalMode || !this.audioBuffer)
            return 0;
        let incoming = data;
        if (incoming.length > this.extMaxBuffer) {
            incoming = incoming.subarray(incoming.length - this.extMaxBuffer);
        }
        if (this.liveWritePos + incoming.length > this.audioBuffer.length) {
            const unconsumed = this.liveWritePos - this.audioPosition;
            if (unconsumed > 0 && this.audioPosition > 0) {
                this.audioBuffer.copyWithin(0, this.audioPosition, this.liveWritePos);
            }
            this.liveWritePos = Math.max(0, unconsumed);
            this.audioPosition = 0;
        }
        const overflow = this.liveWritePos + incoming.length - this.extMaxBuffer;
        if (overflow > 0) {
            const drop = Math.min(overflow, this.liveWritePos);
            if (drop > 0) {
                this.audioBuffer.copyWithin(0, drop, this.liveWritePos);
                this.liveWritePos -= drop;
            }
        }
        this.audioBuffer.set(incoming, this.liveWritePos);
        this.liveWritePos += incoming.length;
        return ((this.liveWritePos - this.audioPosition) / this.sampleRate) * 1000;
    }
    getLiveBufferMs() {
        if (!this.externalMode || !this.audioBuffer)
            return 0;
        return ((this.liveWritePos - this.audioPosition) / this.sampleRate) * 1000;
    }
    static feedWatermarksMs() {
        return {
            pauseMs: 120,
            resumeMs: 60
        };
    }
    isAudioFinished() {
        return this.audioFinished;
    }
    async loadSource(source) {
        if (WaAudioEngine.isRemoteSource(source)) {
            this.startStream(source);
            return;
        }
        await this.loadAudioFile(source);
    }
    static isRemoteSource(source) {
        return /^https?:\/\//i.test(String(source));
    }
    async loadAudioFile(audioPath) {
        this.setExternalMode(false);
        try {
            await access(audioPath);
        }
        catch {
            throw new Error(`File not found: ${audioPath}`);
        }
        if (!(await hasFfmpeg(FFMPEG_BIN))) {
            throw new Error('ffmpeg not found on PATH (install ffmpeg to load audio files)');
        }
        this.audioBuffer = null;
        this.audioBuffer = await this.decodeWithFFmpeg(audioPath);
        this.audioScale = 1 / 32768;
        this.audioPosition = 0;
        this.audioFinished = false;
    }
    async decodeWithFFmpeg(inputPath) {
        return new Promise((resolve, reject) => {
            const proc = spawn(FFMPEG_BIN, [
                '-hide_banner',
                '-loglevel',
                'error',
                '-i',
                inputPath,
                '-ac',
                '1',
                '-ar',
                String(this.sampleRate),
                '-acodec',
                'pcm_s16le',
                '-f',
                's16le',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            let pcm = Buffer.allocUnsafeSlow(1 << 20);
            let decodedBytes = 0;
            let stderr = '';
            let aborted = false;
            proc.stdout?.on('data', (chunk) => {
                if (aborted)
                    return;
                decodedBytes += chunk.length;
                if (decodedBytes > MAX_DECODE_BYTES) {
                    aborted = true;
                    proc.kill('SIGKILL');
                    reject(new Error(`ffmpeg output exceeded ${MAX_DECODE_BYTES} bytes: ${inputPath}`));
                    return;
                }
                if (decodedBytes > pcm.length) {
                    const grown = Buffer.allocUnsafeSlow(Math.max(pcm.length * 2, decodedBytes));
                    pcm.copy(grown, 0, 0, decodedBytes - chunk.length);
                    pcm = grown;
                }
                chunk.copy(pcm, decodedBytes - chunk.length);
            });
            proc.stderr?.on('data', (chunk) => {
                stderr = (stderr + TEXT_DECODER.decode(chunk)).slice(0, MAX_STDERR_CHARS);
            });
            proc.on('error', (err) => reject(new Error(`ffmpeg not available (install ffmpeg on PATH): ${err.message}`)));
            proc.on('close', (code) => {
                if (aborted)
                    return;
                if (code !== 0) {
                    reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
                    return;
                }
                const exact = pcm.length - decodedBytes > 1048576 ? Buffer.from(pcm.subarray(0, decodedBytes - (decodedBytes % 2))) : pcm;
                resolve(new Int16Array(exact.buffer, exact.byteOffset, (exact === pcm ? decodedBytes : exact.length) >> 1));
                pcm = null;
            });
        });
    }
    generateTestTone(frequency = 440, duration = 3, amplitude = 0.3) {
        const samples = this.sampleRate * duration;
        this.audioBuffer = new Float32Array(samples);
        this.audioScale = 1;
        this.audioPosition = 0;
        this.audioFinished = false;
        for (let i = 0; i < samples; i++) {
            const t = i / this.sampleRate;
            this.audioBuffer[i] = Math.sin(2 * Math.PI * frequency * t) * amplitude;
        }
    }
    startStream(source) {
        this.setExternalMode(true);
        this.streamMode = true;
        const token = this.streamToken;
        const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
        if (WaAudioEngine.isRemoteSource(source)) {
            args.push('-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0', '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
        }
        if (/\.m3u8/i.test(source))
            args.push('-live_start_index', '-1');
        args.push('-i', source, '-vn', '-map', '0:a:0', '-ac', '1', '-ar', String(this.sampleRate), '-acodec', 'pcm_s16le', '-f', 's16le', 'pipe:1');
        const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'ignore'] });
        this.streamProc = proc;
        const markEnded = () => {
            if (token === this.streamToken) {
                this.streamEnded = true;
            }
        };
        proc.stdout.on('data', (chunk) => {
            if (token !== this.streamToken) {
                return;
            }
            this.streamQueue.push(this.toStreamSamples(chunk));
            this.pumpStream();
        });
        proc.on('error', markEnded);
        proc.on('close', markEnded);
    }
    stopStream() {
        this.streamToken++;
        if (this.streamProc) {
            this.streamProc.kill('SIGKILL');
            this.streamProc = null;
        }
        this.streamMode = false;
        this.streamEnded = false;
        this.streamPaused = false;
        this.streamQueue = [];
        this.streamCarry = Buffer.alloc(0);
    }
    toStreamSamples(chunk) {
        const bytes = this.streamCarry.length > 0 ? Buffer.concat([this.streamCarry, chunk]) : chunk;
        const usable = bytes.length - (bytes.length % 2);
        const samples = new Float32Array(usable / 2);
        for (let i = 0; i < samples.length; i++) {
            samples[i] = bytes.readInt16LE(i * 2) / 32768;
        }
        this.streamCarry = Buffer.from(bytes.subarray(usable));
        return samples;
    }
    pumpStream() {
        const proc = this.streamProc;
        if (!proc) {
            return;
        }
        while (this.streamQueue.length > 0) {
            const room = this.streamHighWater - (this.liveWritePos - this.audioPosition);
            if (room <= 0) {
                break;
            }
            const head = this.streamQueue[0];
            const take = Math.min(head.length, room);
            this.feedExternalAudio(head.subarray(0, take));
            if (take < head.length) {
                this.streamQueue[0] = head.subarray(take);
            }
            else {
                this.streamQueue.shift();
            }
        }
        let queued = 0;
        for (const chunk of this.streamQueue)
            queued += chunk.length;
        if (queued > this.streamMaxBacklog) {
            proc.stdout?.pause();
        }
        else {
            proc.stdout?.resume();
        }
    }
    isStreamFinished() {
        if (this.audioFinished) {
            return true;
        }
        if (!this.streamEnded || this.streamQueue.length > 0 || this.audioPosition < this.liveWritePos) {
            return false;
        }
        this.audioFinished = true;
        const token = this.streamToken;
        setTimeout(() => {
            if (token === this.streamToken && this.onAudioFinished) {
                this.onAudioFinished();
            }
        }, 0);
        return true;
    }
    startPlayback() {
        if (this.playbackInterval) {
            return;
        }
        this.resetBuffer();
        this.playbackInterval = createSelfCorrectingInterval(() => {
            this.readFromBuffer(this.outputSize);
        }, this.intervalMs);
    }
    stopPlayback() {
        if (this.playbackInterval) {
            this.playbackInterval.clear();
            this.playbackInterval = null;
        }
    }
    onPlaybackData(audioData) {
        this.writeToBuffer(audioData);
    }
    startSilenceCapture() {
        if (this.captureInterval) {
            return;
        }
        this.silenceMode = true;
        this.captureInterval = createSelfCorrectingInterval(() => {
            if (this.audioSender) {
                try {
                    this.audioSender.sendCapturedAudio(this.silenceChunkBuffer);
                }
                catch { }
            }
        }, this.intervalMs);
    }
    startCapture() {
        if (this.captureInterval && this.silenceMode) {
            this.captureInterval.clear();
            this.captureInterval = null;
        }
        if (this.captureInterval) {
            return;
        }
        this.silenceMode = false;
        if (this.streamMode) {
            this.extStarted = this.liveWritePos - this.audioPosition >= this.streamPreBufferSize;
        }
        else if (this.externalMode) {
            this.audioPosition = Math.max(0, this.liveWritePos - this.extPreBufferSize);
            const available = this.liveWritePos - this.audioPosition;
            this.extStarted = available >= this.extPreBufferSize;
        }
        else {
            this.audioPosition = 0;
        }
        this.captureInterval = createSelfCorrectingInterval(() => {
            const chunk = this.getNextChunk();
            if (this.audioSender) {
                try {
                    this.audioSender.sendCapturedAudio(chunk);
                }
                catch { }
            }
        }, this.intervalMs);
    }
    stopCapture() {
        if (this.captureInterval) {
            this.captureInterval.clear();
            this.captureInterval = null;
        }
    }
    stop() {
        this.stopPlayback();
        this.stopCapture();
        this.stopStream();
    }
    release() {
        this.stop();
        this.audioBuffer = null;
        this.audioPosition = 0;
        this.liveWritePos = 0;
        this.resetBuffer();
    }
    hasAudio() {
        return this.audioBuffer !== null && this.audioBuffer.length > 0;
    }
    resetBuffer() {
        this.bufferWritePos = 0;
        this.bufferReadPos = 0;
        this.bufferLength = 0;
    }
    writeToBuffer(data) {
        for (let i = 0; i < data.length && this.bufferLength < this.maxBuffer; i++) {
            this.circularBuffer[this.bufferWritePos] = data[i];
            this.bufferWritePos = (this.bufferWritePos + 1) % this.maxBuffer;
            this.bufferLength++;
        }
    }
    readFromBuffer(count) {
        this.playbackOutputBuffer.fill(0);
        for (let i = 0; i < count; i++) {
            if (this.bufferLength > 0) {
                this.playbackOutputBuffer[i] = this.circularBuffer[this.bufferReadPos];
                this.bufferReadPos = (this.bufferReadPos + 1) % this.maxBuffer;
                this.bufferLength--;
            }
        }
        return this.playbackOutputBuffer;
    }
    getNextChunk() {
        if (!this.audioBuffer) {
            return this.silenceChunkBuffer;
        }
        if (this.streamMode) {
            this.pumpStream();
            if (this.isStreamFinished()) {
                return this.silenceChunkBuffer;
            }
        }
        const endPos = this.externalMode ? this.liveWritePos : this.audioBuffer.length;
        if (endPos === 0 || (this.audioFinished && !this.externalMode)) {
            return this.silenceChunkBuffer;
        }
        if (this.externalMode) {
            const available = endPos - this.audioPosition;
            const preBuffer = this.streamMode ? this.streamPreBufferSize : this.extPreBufferSize;
            if (!this.extStarted) {
                if (available < preBuffer && !this.streamEnded) {
                    return this.silenceChunkBuffer;
                }
                this.extStarted = true;
            }
            if (this.streamMode) {
                if (available < this.captureChunkSize && !this.streamEnded) {
                    this.extStarted = false;
                    return this.silenceChunkBuffer;
                }
            }
            else if (available > this.extHighWater) {
                this.audioPosition = endPos - this.extTargetBuffer;
            }
            if (this.audioPosition >= endPos) {
                return this.silenceChunkBuffer;
            }
        }
        this.captureChunkBuffer.fill(0);
        for (let i = 0; i < this.captureChunkSize; i++) {
            if (this.audioPosition >= endPos) {
                if (this.loopMode && !this.externalMode && endPos > 0) {
                    this.audioPosition = 0;
                    if (this.audioPosition >= endPos) break;
                    continue;
                }
                if (!this.externalMode && !this.audioFinished) {
                    this.audioFinished = true;
                    if (this.onAudioFinished) {
                        const cb = this.onAudioFinished;
                        setTimeout(() => cb(), 0);
                    }
                }
                break;
            }
            this.captureChunkBuffer[i] = this.audioBuffer[this.audioPosition] * this.audioScale;
            this.audioPosition++;
        }
        return this.captureChunkBuffer;
    }
}
