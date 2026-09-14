import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createNoopLogger } from '../shim/core.js';
import { toBytesView, toError } from '../shim/util.js';
import { TEXT_DECODER } from '../bytes.js';
import { DEFAULT_VIDEO_CONFIG } from '../types.js';
const FFMPEG_BIN = 'ffmpeg';
const MAX_STDERR_CHARS = 16 * 1024;

const MAX_PENDING_BYTES = 8 * 1024 * 1024;
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
        if (available)
            ffmpegProbeCache.set(bin, available);
    }
    return available;
}
function startCodeLen(data, offset) {
    if (offset + 3 < data.length &&
        data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 0 && data[offset + 3] === 1) {
        return 4;
    }
    if (offset + 2 < data.length && data[offset] === 0 && data[offset + 1] === 0 && data[offset + 2] === 1) {
        return 3;
    }
    return 0;
}
function createSelfCorrectingInterval(callback, intervalMs) {
    let expected = Date.now() + intervalMs;
    let timer = null;
    let stopped = false;
    function tick() {
        if (stopped) return;
        callback();
        expected += intervalMs;
        const drift = Date.now() - expected;
        timer = setTimeout(tick, Math.max(0, intervalMs - drift));
    }
    timer = setTimeout(tick, intervalMs);
    return {
        clear() {
            stopped = true;
            if (timer) clearTimeout(timer);
        }
    };
}

export class WaVideoEngine {
    logger;
    videoSender = null;
    proc = null;
    width;
    height;
    frameRate;
    frameDurationMs;
    running = false;
    pending = new Uint8Array(0);
    accessUnitsSent = 0;
    videoPath = null;

    sourceKind = null;
    emitQueue = [];
    emitTimer = null;
    constructor(config = {}) {
        const c = { ...DEFAULT_VIDEO_CONFIG, ...config };
        this.logger = config.logger ?? createNoopLogger();
        this.width = c.width;
        this.height = c.height;
        this.frameRate = c.frameRate;
        this.frameDurationMs = 1000 / this.frameRate;
    }
    setVideoSender(sender) {
        this.videoSender = sender;
    }
    isRunning() {
        return this.running;
    }
    hasSource() {
        return this.sourceKind !== null;
    }

    async loadVideoFile(videoPath) {
        this.logger.debug('loading video file', { videoPath });
        try {
            await access(videoPath);
        }
        catch {
            throw new Error(`File not found: ${videoPath}`);
        }
        if (!(await hasFfmpeg(FFMPEG_BIN))) {
            throw new Error('ffmpeg not found on PATH (install ffmpeg to load video files)');
        }
        this.videoPath = videoPath;
        this.sourceKind = 'file';
    }

    async loadBlankSource() {
        if (!(await hasFfmpeg(FFMPEG_BIN))) {
            throw new Error('ffmpeg not found on PATH (install ffmpeg for the black-screen video fallback)');
        }
        this.sourceKind = 'blank';
    }

    start(startOffsetMs = 0) {
        if (!this.sourceKind || this.proc)
            return;
        const scaleFilter = `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2`;

        const keyframeIntervalFrames = Math.max(1, this.frameRate);
        const targetBitrateKbps = Math.max(200, Math.min(600, Math.round((this.width * this.height * this.frameRate) / 1000 * 0.08)));
        const bufsizeKbps = targetBitrateKbps * 2;
        // Audio capture starts synchronously the moment the call's media
        // flow begins, but this engine has to spawn its own ffmpeg process
        // first - that startup latency (plus any event-loop delay before
        // this function even runs) meant video was always a fixed amount
        // of wall-clock time behind audio, from the first frame onward,
        // with nothing to ever correct it. Seeking the input by that same
        // amount with -ss makes video start reading from the point in the
        // file it *should* be at by now, so it catches up to where audio
        // already is instead of running perpetually behind it. Not applied
        // to the blank/black-screen fallback - there's no "correct
        // position" in an infinite color source.
        const seekArgs = (this.sourceKind === 'file' && startOffsetMs > 0)
            ? ['-ss', (startOffsetMs / 1000).toFixed(3)]
            : [];
        const inputArgs = this.sourceKind === 'blank'

            ? ['-f', 'lavfi', '-re', '-i', `color=c=black:s=${this.width}x${this.height}:r=${this.frameRate}`]
            : [...seekArgs, '-stream_loop', '-1', '-re', '-i', this.videoPath];

        const args = [
            '-hide_banner', '-loglevel', 'error',
            ...inputArgs,
            '-an',
            '-vf', scaleFilter,
            '-r', String(this.frameRate),
            '-c:v', 'libx264',
            '-threads', '1',
            '-profile:v', 'baseline',
            '-level', '3.0',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-bf', '0',
            '-b:v', `${targetBitrateKbps}k`,
            '-maxrate', `${targetBitrateKbps}k`,
            '-bufsize', `${bufsizeKbps}k`,
            '-x264-params', `aud=1:repeat-headers=1:keyint=${keyframeIntervalFrames}:min-keyint=${keyframeIntervalFrames}:scenecut=0:rc-lookahead=0:sync-lookahead=0:nal-hrd=cbr`,
            '-f', 'h264',
            'pipe:1'
        ];
        const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.pending = new Uint8Array(0);
        this.accessUnitsSent = 0;
        this.running = true;
        this.emitQueue = [];
        if (this.emitTimer)
            this.emitTimer.clear();
        this.emitTimer = createSelfCorrectingInterval(() => this.drainEmitQueue(), this.frameDurationMs);
        let stderr = '';
        proc.stdout?.on('data', (chunk) => {
            try {
                this.onData(toBytesView(chunk));
            }
            catch (err) {
                this.logger.error('video stream parse error', { message: toError(err).message });
            }
        });
        proc.stderr?.on('data', (chunk) => {
            stderr = (stderr + TEXT_DECODER.decode(chunk)).slice(-MAX_STDERR_CHARS);
        });
        proc.on('error', (err) => {
            this.logger.error('ffmpeg video process error', { message: err.message });
            this.running = false;
        });
        proc.on('close', (code) => {
            if (this.proc === proc)
                this.proc = null;
            this.running = false;
            if (code !== 0 && code !== null) {
                this.logger.debug('ffmpeg video process exited', { code, stderr: stderr.trim() });
            }
        });
        this.logger.media('video source starting', {
            source: this.sourceKind, videoPath: this.videoPath, width: this.width, height: this.height, fps: this.frameRate
        });
    }

    onData(chunk) {
        const merged = new Uint8Array(this.pending.length + chunk.length);
        merged.set(this.pending, 0);
        merged.set(chunk, this.pending.length);
        this.pending = merged;
        if (this.pending.length > MAX_PENDING_BYTES) {
            this.logger.debug('video pending buffer exceeded cap without a second AUD, dropping', {
                bytes: this.pending.length
            });
            this.pending = new Uint8Array(0);
            return;
        }
        const audPositions = [];
        let i = 0;
        const data = this.pending;
        while (i < data.length) {
            const sc = startCodeLen(data, i);
            if (sc > 0) {
                const naluStart = i + sc;
                if (naluStart < data.length && (data[naluStart] & 0x1f) === 9) {
                    audPositions.push(i);
                }
                i += sc;
                continue;
            }
            i++;
        }
        if (audPositions.length < 2)
            return;
        for (let k = 0; k < audPositions.length - 1; k++) {
            const au = data.subarray(audPositions[k], audPositions[k + 1]);
            this.emitQueue.push(au);
        }
        this.pending = data.slice(audPositions[audPositions.length - 1]);
    }
    drainEmitQueue() {
        // ffmpeg encodes/writes to its stdout pipe at roughly real-time
        // pace (-re), but Node only actually reads that pipe whenever the
        // event loop gets to it. If reading is delayed - even by a couple
        // seconds, e.g. while the relay/DTLS/SRTP handshake around call
        // start is doing its own synchronous work - ffmpeg keeps encoding
        // the whole time, and all of that backlog arrives at once the
        // moment Node finally reads the pipe.
        //
        // Draining it one frame per frameDurationMs made that backlog play
        // out as several real seconds of sped-up/skipped video instead of
        // looking normal immediately. Instead, while there's a backlog,
        // this emits CATCH_UP_RATE frames per tick (still one at a time
        // via emitAccessUnit, not as a single dump) so a few seconds of
        // backlog clears in a few hundred ms, then drops back to exactly
        // one frame per tick as soon as the backlog is gone - so there's
        // no sustained sped-up playback once steady state is reached.
        if (this.emitQueue.length === 0)
            return;
        const CATCH_UP_RATE = 4;
        const MAX_QUEUE_SECONDS = 3;
        const MAX_QUEUE = Math.round(this.frameRate * MAX_QUEUE_SECONDS);
        if (this.emitQueue.length > MAX_QUEUE) {
            this.emitQueue = this.emitQueue.slice(-MAX_QUEUE);
        }
        const framesThisTick = this.emitQueue.length > 1 ? CATCH_UP_RATE : 1;
        for (let i = 0; i < framesThisTick; i++) {
            const au = this.emitQueue.shift();
            if (!au) break;
            this.emitAccessUnit(au);
        }
    }
    emitAccessUnit(au) {
        this.accessUnitsSent++;
        if (this.videoSender) {
            try {
                this.videoSender.sendCapturedVideoAU(au, this.frameDurationMs);
            }
            catch (err) {
                this.logger.trace('captured video send failed', { message: toError(err).message });
            }
        }
        if (this.accessUnitsSent === 1 || this.accessUnitsSent % 300 === 0) {
            this.logger.trace('video access unit emitted', {
                count: this.accessUnitsSent, bytes: au.length
            });
        }
    }

    stop({ keepSource = false } = {}) {
        this.running = false;
        if (this.proc) {
            try {
                this.proc.kill('SIGKILL');
            }
            catch (err) {
                this.logger.trace('ffmpeg video kill failed', { message: toError(err).message });
            }
            this.proc = null;
        }
        if (this.emitTimer) {
            this.emitTimer.clear();
            this.emitTimer = null;
        }
        this.emitQueue = [];
        this.pending = new Uint8Array(0);
        if (!keepSource) {
            this.videoPath = null;
            this.sourceKind = null;
        }
    }
}
