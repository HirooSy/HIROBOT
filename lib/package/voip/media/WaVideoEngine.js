import { execFile, spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { createNoopLogger } from '../shim/core.js';
import { toBytesView, toError } from '../shim/util.js';
import { TEXT_DECODER } from '../bytes.js';
import { DEFAULT_VIDEO_CONFIG } from '../types.js';
const FFMPEG_BIN = 'ffmpeg';
const MAX_STDERR_CHARS = 16 * 1024;
// Safety cap mirroring meowcaller's rtp.maxAccessUnitBytes — if we somehow never
// see a second AUD (e.g. a stream ffmpeg didn't actually insert delimiters into)
// this stops us from buffering an unbounded amount of video forever.
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
/**
 * Streams a video file into WhatsApp-ready H.264 access units.
 *
 * meowcaller (and the whatsapp-rust wire format it follows) doesn't encode
 * video itself — the caller supplies already-encoded Annex-B access units
 * (see video.go's doc comment). Since this bot has no camera, ffmpeg fills
 * that role: it transcodes/loops the given file to a constant-framerate,
 * baseline-profile H.264 elementary stream with Access Unit Delimiters
 * inserted (`aud=1`), which is what lets us split the stream into per-frame
 * access units downstream (media/h264.js strips the AUD NALs back out before
 * packetizing, matching meowcaller's videoSender).
 *
 * `-re` paces ffmpeg's own reads to the input's real playback rate, so
 * access units naturally arrive here at roughly the right cadence without
 * this class needing its own timer — the same reason WaAudioEngine instead
 * uses a JS-side interval is that PCM has no equivalent "real-time" producer
 * once decoded; here ffmpeg IS the pacing.
 */
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
        return this.videoPath !== null;
    }
    /**
     * Validates the file (and ffmpeg's presence) and records it — does NOT spawn
     * ffmpeg yet. Spawning happens on start(), which the call session defers until
     * the relay is actually connected (see WaCallMediaSession.startMediaFlow): the
     * first access unit ffmpeg ever produces is always the IDR keyframe, and
     * spawning here immediately (as this method used to) meant that keyframe was
     * very often produced — and silently dropped by sendCapturedVideoAU, since
     * there was no relay to send it on yet — before the call was ever ready to
     * carry it.
     */
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
    }
    /** Spawns ffmpeg for the previously loaded source. No-ops if none was loaded. */
    start() {
        if (!this.videoPath || this.proc)
            return;
        const videoPath = this.videoPath;
        const scaleFilter = `scale=${this.width}:${this.height}:force_original_aspect_ratio=decrease,pad=${this.width}:${this.height}:(ow-iw)/2:(oh-ih)/2`;
        // Keyframe interval + bitrate control: previously unset, meaning libx264's
        // default GOP (~250 frames, well over a minute at 15fps) was in effect. Video
        // sending only actually starts once the relay is connected (see
        // WaCallMediaSession — loadVideo() now just records the path; startMediaFlow()
        // is what calls startFile()/start ffmpeg), but ANY frame produced before that
        // instant still gets silently dropped by sendCapturedVideoAU, and the very
        // first frame ffmpeg ever produces is always the IDR. With no periodic
        // keyframe after that, a single mistimed drop meant the peer never received
        // a decodable frame for the rest of the call — matching "video ga muncul"
        // exactly. keyint=fps*1 (a fresh IDR every ~1s) makes that self-healing
        // within a second regardless of when the relay actually finishes connecting.
        // Bitrate/CBR params mirror the old known-working wasm-engine reference
        // (modules/video-feeder.js) so the relay sees a predictable, modest stream.
        const keyframeIntervalFrames = this.frameRate * 1;
        const targetBitrateKbps = Math.max(300, Math.min(1500, Math.round((this.width * this.height * this.frameRate) / 1000 * 0.15)));
        const bufsizeKbps = targetBitrateKbps * 2;
        const args = [
            '-hide_banner', '-loglevel', 'error',
            '-stream_loop', '-1',
            '-re',
            '-i', videoPath,
            '-an',
            '-vf', scaleFilter,
            '-r', String(this.frameRate),
            '-c:v', 'libx264',
            '-profile:v', 'baseline',
            '-level', '3.0',
            '-preset', 'ultrafast',
            '-tune', 'zerolatency',
            '-pix_fmt', 'yuv420p',
            '-bf', '0',
            '-b:v', `${targetBitrateKbps}k`,
            '-maxrate', `${targetBitrateKbps}k`,
            '-bufsize', `${bufsizeKbps}k`,
            '-x264-params', `aud=1:repeat-headers=1:keyint=${keyframeIntervalFrames}:min-keyint=${keyframeIntervalFrames}:scenecut=0:nal-hrd=cbr`,
            '-f', 'h264',
            'pipe:1'
        ];
        const proc = spawn(FFMPEG_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        this.proc = proc;
        this.pending = new Uint8Array(0);
        this.accessUnitsSent = 0;
        this.running = true;
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
        this.logger.debug('video file loading started', {
            videoPath, width: this.width, height: this.height, fps: this.frameRate
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
    stop() {
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
        this.pending = new Uint8Array(0);
    }
}
