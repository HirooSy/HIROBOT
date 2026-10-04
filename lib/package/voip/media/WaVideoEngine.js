import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createNoopLogger } from '../shim/core.js';
import { toBytesView, toError } from '../shim/util.js';
import { TEXT_DECODER } from '../bytes.js';
import { DEFAULT_VIDEO_CONFIG } from '../types.js';
import { auHasIDR } from './h264.js';
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

function pickH264Level(width, height, frameRate) {
    const mbs = Math.ceil(width / 16) * Math.ceil(height / 16);
    const mbps = mbs * frameRate;
    if (mbs <= 1620 && mbps <= 40500) return '3.0';
    if (mbs <= 3600 && mbps <= 108000) return '3.1';
    if (mbs <= 5120 && mbps <= 216000) return '3.2';
    return '4.0';
}
const align16 = (n) => Math.max(16, Math.ceil(n / 16) * 16);

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
    waitingForKeyFrame = true;

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
        const outW = align16(this.width);
        const outH = align16(this.height);
        const scaleFilter = `scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2,setsar=1`;

        const keyframeIntervalFrames = Math.max(1, Math.round(this.frameRate));
        const kbpsCap = 600;
        const targetBitrateKbps = Math.max(200, Math.min(kbpsCap, Math.round((outW * outH * this.frameRate) / 1000 * 0.08)));
        const bufsizeKbps = Math.max(60, Math.round(targetBitrateKbps * 0.25));
        const level = pickH264Level(outW, outH, this.frameRate);
        const inputArgs = this.sourceKind === 'blank'

            ? ['-f', 'lavfi', '-re', '-i', `color=c=black:s=${outW}x${outH}:r=${this.frameRate}`]
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
            '-level', level,
            '-preset', 'veryfast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-bf', '0',
            '-b:v', `${targetBitrateKbps}k`,
            '-maxrate', `${targetBitrateKbps}k`,
            '-bufsize', `${bufsizeKbps}k`,
            '-x264-params', `aud=1:repeat-headers=1:keyint=${keyframeIntervalFrames}:min-keyint=${keyframeIntervalFrames}:scenecut=0:rc-lookahead=0:sync-lookahead=0:open-gop=0:ref=1`,
            '-f', 'h264',
            'pipe:1'
        ];
        const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.pending = new Uint8Array(0);
        this.accessUnitsSent = 0;
        this.waitingForKeyFrame = true;
        this.running = true;
        this._deliberateStop = false;
        this.logger.warn('[DIAG] ffmpeg video process started', {
            pid: proc.pid, frameRate: this.frameRate, width: outW, height: outH, level, bitrateKbps: targetBitrateKbps
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
        for (let k = 0; k < audPositions.length - 1; k++) {
            const au = data.subarray(audPositions[k], audPositions[k + 1]);
            this.emitAccessUnit(au);
        }
        this.pending = data.slice(audPositions[audPositions.length - 1]);
    }

    emitAccessUnit(au) {
        if (this.waitingForKeyFrame) {
            if (!auHasIDR(au))
                return;
            this.waitingForKeyFrame = false;
        }
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
