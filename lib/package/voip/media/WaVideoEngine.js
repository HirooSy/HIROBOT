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

    start() {
        if (!this.sourceKind || this.proc)
            return;
        const scaleFilter = `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2`;

        const keyframeIntervalFrames = Math.max(1, this.frameRate);
        const targetBitrateKbps = Math.max(200, Math.min(600, Math.round((this.width * this.height * this.frameRate) / 1000 * 0.08)));
        const bufsizeKbps = targetBitrateKbps * 2;
        const inputArgs = this.sourceKind === 'blank'

            ? ['-f', 'lavfi', '-re', '-i', `color=c=black:s=${this.width}x${this.height}:r=${this.frameRate}`]
            : ['-stream_loop', '-1', '-re', '-i', this.videoPath];

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
        this._deliberateStop = false;
        this.logger.warn('[DIAG] ffmpeg video process started', {
            pid: proc.pid, frameRate: this.frameRate, width: this.width, height: this.height
        });
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
                this.logger.error('ffmpeg video process exited unexpectedly', { code, stderr: stderr.trim() });
            }
            // If this wasn't a deliberate stop() and we still have a
            // source to play, ffmpeg died on its own mid-call (crash,
            // killed by the OS, etc) - without restarting it here, video
            // would silently freeze for the rest of the call with nothing
            // in our own code showing anything wrong (the RTP/relay path
            // just stops receiving new access units to send).
            if (!this._deliberateStop && this.sourceKind) {
                const now = Date.now();
                if (!this._restartWindowStartedAt || now - this._restartWindowStartedAt > 60_000) {
                    this._restartWindowStartedAt = now;
                    this._restartCount = 0;
                }
                this._restartCount = (this._restartCount ?? 0) + 1;
                if (this._restartCount > 5) {
                    this.logger.error('video encoder crash-looped, giving up on auto-restart', {
                        source: this.sourceKind, videoPath: this.videoPath, restartCount: this._restartCount
                    });
                    return;
                }
                this.logger.error('restarting video encoder after unexpected exit', {
                    source: this.sourceKind, videoPath: this.videoPath, restartCount: this._restartCount
                });
                this.start();
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
        // Send each complete access unit immediately, with no intermediate
        // queue or timer - ffmpeg's -re flag is what paces this data to
        // real-time, so Node's job here is to be a transparent pipe, not
        // to re-pace already-correctly-timed output. This matches the
        // reference implementation (meowcaller): the video sender does no
        // internal buffering at all - it fragments and sends whatever
        // access unit it's given, the instant it's given it, and leaves
        // all pacing to the source. Buffering and resending on our own
        // clock (as this used to do) can only ever drift from ffmpeg's
        // actual pacing, never improve on it - that mismatch is what
        // caused video to run ahead of, or skip content relative to, its
        // own audio track, and occasionally stall entirely under load.
        for (let k = 0; k < audPositions.length - 1; k++) {
            const au = data.subarray(audPositions[k], audPositions[k + 1]);
            this.emitAccessUnit(au);
        }
        this.pending = data.slice(audPositions[audPositions.length - 1]);
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
        this._deliberateStop = true;
        this.running = false;
        if (this.proc) {
            this.logger.warn('[DIAG] ffmpeg video process stopping', { pid: this.proc.pid });
            try {
                this.proc.kill('SIGKILL');
            }
            catch (err) {
                this.logger.trace('ffmpeg video kill failed', { message: toError(err).message });
            }
            this.proc = null;
        }
        this.pending = new Uint8Array(0);
        if (!keepSource) {
            this.videoPath = null;
            this.sourceKind = null;
        }
    }
}
