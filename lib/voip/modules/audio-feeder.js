import { spawn } from "node:child_process";
const LOW_WATERMARK_CHUNKS = 16;
const MAX_QUEUED_CHUNKS = 1024;
const DEFAULT_WARMUP_MS = 500;
const MAX_DECODE_BYTES = 128 * 1024 * 1024;
const MAX_STDERR_CHARS = 16 * 1024;
// Cap on how many chunks the scheduler will flush in one go to catch up
// after falling behind — 25 chunks at 20ms/chunk is 500ms of audio sent in
// one tick, enough to absorb a real stall without ever dumping an
// unbounded amount of buffered audio at once.
const MAX_CATCH_UP_CHUNKS = 25;
export class AudioFeeder {
    sampleRate;
    channels;
    framesPerChunk;
    onChunk;
    source;
    #queue = [];
    #emitTimer = null;
    #nextEmitAtMs = 0;
    #warmupUntilMs = 0;
    #stoppedManually = false;
    #decodedBuffer = null;
    #decodePosition = 0;
    #decoding = false;
    droppedChunks = 0;
    underflowChunks = 0;
    bytesProduced = 0;
    chunksEmitted = 0;
    constructor(sampleRate, channels, framesPerChunk, onChunk, source = "silence", onFinished) {
        this.sampleRate = sampleRate;
        this.channels = channels;
        this.framesPerChunk = framesPerChunk;
        this.onChunk = onChunk;
        this.source = source;
        this.onFinished = onFinished;
    }
    start = () => {
        if (this.#decoding || this.#decodedBuffer)
            return;
        const chunkSamples = this.framesPerChunk * this.channels;
        const chunkIntervalMs = (this.framesPerChunk / this.sampleRate) * 1000;
        this.#stoppedManually = false;
        this.#nextEmitAtMs = 0;
        if (!this.source || this.source === "silence") {
            this.#warmupUntilMs = 0;
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
            return;
        }
        this.#warmupUntilMs = Date.now() + DEFAULT_WARMUP_MS;
        this.#decoding = true;
        this.#decodeSourceToBuffer(chunkSamples)
            .then((buffer) => {
            this.#decoding = false;
            if (this.#stoppedManually)
                return;
            this.#decodedBuffer = buffer;
            this.#decodePosition = 0;
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
        })
            .catch((err) => {
            this.#decoding = false;
            console.error(`[AudioFeeder] decode failed (source=${this.source}): ${err?.message || err}`);
            if (!this.#stoppedManually)
                this.onFinished?.();
        });
    };
    stop = () => {
        this.#stoppedManually = true;
        if (this.#emitTimer) {
            clearTimeout(this.#emitTimer);
            this.#emitTimer = null;
        }
        this.#queue = [];
        this.#decodedBuffer = null;
        this.#decodePosition = 0;
        this.#warmupUntilMs = 0;
    };
    #decodeSourceToBuffer = (chunkSamples) => {
        return new Promise((resolve, reject) => {
            const inputArgs = this.source.startsWith("lavfi:")
                ? ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)]
                : ["-i", this.source];
            const proc = spawn("ffmpeg", [
                "-hide_banner",
                "-loglevel", "warning",
                ...inputArgs,
                "-f", "f32le",
                "-ac", String(this.channels),
                "-ar", String(this.sampleRate),
                "pipe:1",
            ]);
            const chunks = [];
            let decodedBytes = 0;
            let stderr = "";
            let aborted = false;
            proc.stdout.on("data", (chunk) => {
                if (aborted)
                    return;
                decodedBytes += chunk.length;
                if (decodedBytes > MAX_DECODE_BYTES) {
                    aborted = true;
                    proc.kill("SIGKILL");
                    reject(new Error(`ffmpeg output exceeded ${MAX_DECODE_BYTES} bytes: ${this.source}`));
                    return;
                }
                chunks.push(chunk);
            });
            proc.stderr.on("data", (chunk) => {
                stderr = (stderr + chunk.toString()).slice(0, MAX_STDERR_CHARS);
            });
            proc.on("error", (err) => {
                if (aborted)
                    return;
                reject(new Error(`ffmpeg spawn error: ${err?.message || err}`));
            });
            proc.on("exit", (code) => {
                if (aborted)
                    return;
                const cleanExit = code === 0 || code === null;
                if (!cleanExit) {
                    reject(new Error(`ffmpeg exited with code=${code}: ${stderr.trim()}`));
                    return;
                }
                const pcmBytes = Buffer.concat(chunks);
                const usableFloats = Math.floor(pcmBytes.length / 4 / chunkSamples) * chunkSamples;
                const buffer = new Float32Array(usableFloats);
                buffer.set(new Float32Array(pcmBytes.buffer, pcmBytes.byteOffset, usableFloats));
                this.bytesProduced += usableFloats * 4;
                resolve(buffer);
            });
        });
    };
    #scheduleNext = (chunkSamples, chunkIntervalMs) => {
        if (this.#stoppedManually)
            return;
        const now = Date.now();
        if (this.#nextEmitAtMs === 0)
            this.#nextEmitAtMs = now;
        const delayMs = Math.max(0, this.#nextEmitAtMs - now);
        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            if (this.#queue.length < LOW_WATERMARK_CHUNKS && Date.now() < this.#warmupUntilMs) {
                this.#nextEmitAtMs = Date.now() + 10;
                this.#scheduleNext(chunkSamples, chunkIntervalMs);
                return;
            }
            // setTimeout only guarantees a MINIMUM delay, not an exact one —
            // under any CPU load (GC pause, another process, event loop
            // backlog) each tick can land a few ms late. Left uncorrected,
            // those small lags accumulate tick after tick and the schedule
            // drifts further and further behind real time, which is heard
            // as audio falling out of sync / stuttering over the course of
            // a call. Catch up by flushing every chunk interval that's
            // already due (capped, so a huge stall doesn't dump minutes of
            // audio at once) instead of only ever advancing by one.
            const behindMs = Date.now() - this.#nextEmitAtMs;
            const catchUpChunks = behindMs > chunkIntervalMs * 2
                ? Math.min(Math.floor(behindMs / chunkIntervalMs), MAX_CATCH_UP_CHUNKS)
                : 1;
            for (let i = 0; i < catchUpChunks; i++) {
                const finished = this.#flushOne(chunkSamples);
                this.#nextEmitAtMs += chunkIntervalMs;
                if (finished)
                    return;
            }
            this.#scheduleNext(chunkSamples, chunkIntervalMs);
        }, delayMs);
    };
    #flushOne = (chunkSamples) => {
        if (!this.source || this.source === "silence") {
            this.chunksEmitted += 1;
            this.onChunk(new Float32Array(chunkSamples));
            return false;
        }
        if (!this.#decodedBuffer)
            return false;
        if (this.#decodePosition >= this.#decodedBuffer.length) {
            if (!this.#stoppedManually)
                this.onFinished?.();
            return true;
        }
        const nextChunk = this.#decodedBuffer.subarray(this.#decodePosition, this.#decodePosition + chunkSamples);
        this.#decodePosition += chunkSamples;
        this.chunksEmitted += 1;
        this.onChunk(nextChunk);
        return false;
    };
}
