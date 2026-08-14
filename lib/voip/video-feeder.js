import { spawn } from "node:child_process";

const MAX_QUEUED_FRAMES = 15;
const DEFAULT_FPS = 8;

/**
 * Reads a video source (file path or URL) via ffmpeg, re-encoding it to raw
 * H.264 Annex-B (start-code prefixed NAL units) and grouping consecutive
 * NALUs into per-frame access units, matching what WhatsApp's WASM VoIP
 * engine expects from onEncodedVideoDataFromJsForStream (see
 * WAWebVoipWebCodecsEncoder in the official client, which configures its
 * VideoEncoder with avc: { format: "annexb" }).
 *
 * Unlike AudioFeeder (fixed-size PCM chunks paced by sample rate), video
 * frames are variable-length and paced by fps — one onFrame call per access
 * unit, not a fixed byte chunk.
 */
export class VideoFeeder {
    source;
    targetWidth;
    targetHeight;
    targetFps;
    onFrame;
    onFinished;
    #proc = null;
    #pending = Buffer.alloc(0);
    #queue = [];
    #emitTimer = null;
    #stoppedManually = false;
    #sawFirstFrame = false;
    framesProduced = 0;
    framesEmitted = 0;

    constructor(source, targetWidth, targetHeight, targetFps, onFrame, onFinished) {
        this.source = source;
        this.targetWidth = targetWidth || 320;
        this.targetHeight = targetHeight || 240;
        this.targetFps = targetFps || DEFAULT_FPS;
        this.onFrame = onFrame;
        this.onFinished = onFinished;
    }

    start = () => {
        if (this.#proc) return;
        const inputArgs = this.#resolveInputArgs();
        // -profile:v baseline + -level 3.0 keeps the stream decodable by the
        // widest range of phone hardware decoders. -bf 0 (no B-frames) keeps
        // decode order == presentation order, which matters since we're not
        // implementing a DTS/PTS reordering layer here. -x264-params
        // keyint/min-keyint force a predictable keyframe cadence so we always
        // know which access units are keyframes without deeper bitstream
        // parsing than "did we see an SPS/PPS in this access unit".
        this.#proc = spawn("ffmpeg", [
            "-hide_banner",
            "-loglevel", "error",
            ...inputArgs,
            "-an",
            "-vf", `scale=${this.targetWidth}:${this.targetHeight}:force_original_aspect_ratio=decrease,pad=${this.targetWidth}:${this.targetHeight}:(ow-iw)/2:(oh-ih)/2,fps=${this.targetFps}`,
            "-c:v", "libx264",
            "-profile:v", "baseline",
            "-level", "3.0",
            "-preset", "ultrafast",
            "-tune", "zerolatency",
            "-bf", "0",
            "-pix_fmt", "yuv420p",
            "-x264-params", `keyint=${this.targetFps * 2}:min-keyint=${this.targetFps * 2}:scenecut=0`,
            "-f", "h264",
            "pipe:1",
        ]);
        this.#proc.stdout.on("data", (chunk) => {
            this.#pending = Buffer.concat([this.#pending, chunk]);
            this.#extractAccessUnits();
        });
        this.#proc.stderr.on("data", (chunk) => {
            console.error(`[VideoFeeder] ${chunk.toString().trim()}`);
        });
        this.#proc.on("error", (err) => {
            console.error(`[VideoFeeder] ffmpeg spawn error: ${err?.message || err}`);
        });
        this.#proc.on("exit", (code) => {
            const cleanExit = code === 0 || code === null;
            if (!cleanExit) {
                console.error(`[VideoFeeder] ffmpeg exited with code=${code} (source=${this.source})`);
            }
            // Flush whatever's left in #pending as one final access unit —
            // ffmpeg's stdout can end mid-NALU-boundary-detection with no
            // trailing start code to trigger the last emit.
            if (this.#pending.length > 0) {
                this.#queue.push(this.#pending);
                this.#pending = Buffer.alloc(0);
            }
            this.#proc = null;
            this.#drainQueueSync();
            if (cleanExit && !this.#stoppedManually) {
                this.onFinished?.();
            }
        });
        this.#scheduleNext();
    };

    stop = () => {
        this.#stoppedManually = true;
        if (this.#emitTimer) {
            clearTimeout(this.#emitTimer);
            this.#emitTimer = null;
        }
        this.#proc?.kill("SIGTERM");
        this.#proc = null;
        this.#pending = Buffer.alloc(0);
        this.#queue = [];
    };

    #resolveInputArgs = () => {
        if (this.source.startsWith("lavfi:")) {
            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
        }
        return ["-i", this.source];
    };

    // Splits the raw Annex-B byte stream into per-frame access units. One
    // access unit = all NAL units from one start code up to (but not
    // including) the next VCL slice NALU's start code that begins a NEW
    // frame — i.e. SPS+PPS+IDR-slice stay together as one keyframe access
    // unit, matching what a real H.264 encoder emits as one "encoded chunk"
    // per frame (mirroring EncodedVideoChunk from WebCodecs).
    #extractAccessUnits = () => {
        const NALU_TYPE_MASK = 0x1f;
        // 1 = non-IDR slice, 5 = IDR slice — both are new-frame boundaries.
        // 7 = SPS, 8 = PPS — these prefix a keyframe's slice, not a boundary
        // on their own.
        const FRAME_BOUNDARY_TYPES = new Set([1, 5]);
        let searchFrom = 0;
        while (true) {
            const scStart = this.#findStartCode(this.#pending, searchFrom);
            if (scStart === -1) break;
            const scLen = this.#pending[scStart + 2] === 1 ? 3 : 4;
            const naluStart = scStart + scLen;
            if (naluStart >= this.#pending.length) break; // wait for more data
            const naluType = this.#pending[naluStart] & NALU_TYPE_MASK;
            if (FRAME_BOUNDARY_TYPES.has(naluType) && scStart > 0) {
                // Everything before this start code is one complete access unit.
                this.#pushAccessUnit(this.#pending.subarray(0, scStart));
                this.#pending = this.#pending.subarray(scStart);
                searchFrom = 0;
                continue;
            }
            searchFrom = naluStart;
        }
    };

    #findStartCode = (buf, from) => {
        for (let i = from; i < buf.length - 3; i++) {
            if (buf[i] === 0 && buf[i + 1] === 0) {
                if (buf[i + 2] === 1) return i;
                if (buf[i + 2] === 0 && buf[i + 3] === 1) return i;
            }
        }
        return -1;
    };

    #pushAccessUnit = (accessUnit) => {
        if (accessUnit.length === 0) return;
        this.framesProduced += 1;
        if (this.#queue.length >= MAX_QUEUED_FRAMES) {
            // Drop oldest rather than the newest — for live-ish playback,
            // catching up to "now" matters more than not skipping a frame.
            this.#queue.shift();
        }
        this.#queue.push(Buffer.from(accessUnit));
    };

    #scheduleNext = () => {
        if (!this.#proc && this.#queue.length === 0) return;
        const intervalMs = 1000 / this.targetFps;
        this.#emitTimer = setTimeout(() => {
            this.#emitTimer = null;
            this.#flushOne();
            this.#scheduleNext();
        }, intervalMs);
    };

    #flushOne = () => {
        const accessUnit = this.#queue.shift();
        if (!accessUnit) return; // no underflow padding for video — just skip the tick
        this.framesEmitted += 1;
        const isKeyFrame = !this.#sawFirstFrame || this.#containsSps(accessUnit);
        this.#sawFirstFrame = true;
        this.onFrame(accessUnit, isKeyFrame);
    };

    // Drains any frames left in the queue synchronously after ffmpeg exits,
    // so a short clip's tail frames aren't silently lost waiting on a timer
    // that will never fire again meaningfully.
    #drainQueueSync = () => {
        while (this.#queue.length > 0) {
            this.#flushOne();
        }
    };

    #containsSps = (accessUnit) => {
        const NALU_TYPE_MASK = 0x1f;
        let i = 0;
        while (i < accessUnit.length - 3) {
            if (accessUnit[i] === 0 && accessUnit[i + 1] === 0) {
                let scLen = 0;
                if (accessUnit[i + 2] === 1) scLen = 3;
                else if (accessUnit[i + 2] === 0 && accessUnit[i + 3] === 1) scLen = 4;
                if (scLen > 0) {
                    const naluStart = i + scLen;
                    if (naluStart < accessUnit.length && (accessUnit[naluStart] & NALU_TYPE_MASK) === 7) {
                        return true;
                    }
                    i = naluStart;
                    continue;
                }
            }
            i++;
        }
        return false;
    };
}
