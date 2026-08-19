import { spawn } from "node:child_process";
import os from "node:os";

const MAX_QUEUED_FRAMES = 5000;
const DEFAULT_FPS = 12;

const FFMPEG_THREADS = 1;

export class VideoFeeder {
    source;
    targetWidth;
    targetHeight;
    targetFps;
    onFrame;
    onFinished;
    onError;
    #proc = null;
    #pending = Buffer.alloc(0);
    #queue = [];
    #emitTimer = null;
    #stoppedManually = false;
    #sawFirstFrame = false;
    #firstFrameLoggedAt = null;
    #startedAt = 0;
    #lastOverflowLogAt = 0;
    #overflowCount = 0;
    #exitCode = null;
    #exitCleanly = null;
    #finalized = false;
    framesProduced = 0;
    framesEmitted = 0;

    constructor(source, targetWidth, targetHeight, targetFps, onFrame, onFinished, onError) {
        this.source = source;
        this.targetWidth = targetWidth || 320;
        this.targetHeight = targetHeight || 240;
        this.targetFps = targetFps || DEFAULT_FPS;
        this.onFrame = onFrame;
        this.onFinished = onFinished;
        this.onError = onError;
    }

    start = () => {
        if (this.#proc) return;
        this.#startedAt = Date.now();
        const inputArgs = this.#resolveInputArgs();

        const keyframeIntervalFrames = this.targetFps * 1;

        const targetBitrateKbps = Math.max(300, Math.min(1500, Math.round((this.targetWidth * this.targetHeight * this.targetFps) / 1000 * 0.15)));
        const bufsizeKbps = targetBitrateKbps * 2;
        const ffmpegArgs = [
            "-hide_banner",
            "-loglevel", "warning",
            "-threads", String(FFMPEG_THREADS),
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
            "-b:v", `${targetBitrateKbps}k`,
            "-maxrate", `${targetBitrateKbps}k`,
            "-bufsize", `${bufsizeKbps}k`,

            "-x264-params", `threads=1:keyint=${keyframeIntervalFrames}:min-keyint=${keyframeIntervalFrames}:scenecut=0:nal-hrd=cbr`,

            "-flush_packets", "1",
            "-f", "h264",
            "pipe:1",
        ];

        this.#proc = spawn("nice", ["-n", "19", "ffmpeg", ...ffmpegArgs]);
        this.#proc.stdout.on("data", (chunk) => {
            this.#pending = Buffer.concat([this.#pending, chunk]);
            this.#extractAccessUnits();
        });
        this.#proc.stderr.on("data", (chunk) => {
            console.error(`[VideoFeeder] stderr: ${chunk.toString().trim()}`);
        });
        this.#proc.on("error", (err) => {
            console.error(`[VideoFeeder] ffmpeg spawn error: ${err?.message || err}`);
        });
        this.#proc.on("exit", (code, signal) => {
            const cleanExit = code === 0 || code === null;
            if (!cleanExit) {
                console.error(`[VideoFeeder] ffmpeg exited with code=${code} signal=${signal || 'none'} (source=${this.source})`);
            }

            if (this.#pending.length > 0) {
                this.#queue.push(this.#pending);
                this.#pending = Buffer.alloc(0);
            }
            this.#exitCode = code;
            this.#exitCleanly = cleanExit;
            this.#proc = null;

            if (this.#queue.length === 0) {
                this.#finalizeIfDone();
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
        this.#pending = Buffer.alloc(0);
        this.#queue = [];
        if (!this.#proc) return Promise.resolve();

        return new Promise((resolve) => {
            this.#proc.once("exit", () => resolve());
            this.#proc.kill("SIGTERM");
            setTimeout(() => {
                this.#proc?.kill("SIGKILL");
                resolve();
            }, 500);
        });
    };

    #resolveInputArgs = () => {
        if (this.source.startsWith("lavfi:")) {
            return ["-f", "lavfi", "-i", this.source.slice("lavfi:".length)];
        }

        return ["-i", this.source];
    };

    #extractAccessUnits = () => {
        const NALU_TYPE_MASK = 0x1f;

        const FRAME_BOUNDARY_TYPES = new Set([1, 5]);
        let searchFrom = 0;
        while (true) {
            const scStart = this.#findStartCode(this.#pending, searchFrom);
            if (scStart === -1) break;
            const scLen = this.#pending[scStart + 2] === 1 ? 3 : 4;
            const naluStart = scStart + scLen;
            if (naluStart >= this.#pending.length) break;
            const naluType = this.#pending[naluStart] & NALU_TYPE_MASK;
            if (FRAME_BOUNDARY_TYPES.has(naluType) && scStart > 0) {

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
            this.#overflowCount += 1;
            const now = Date.now();
            if (now - this.#lastOverflowLogAt > 2000) {
                this.#lastOverflowLogAt = now;
                this.#overflowCount = 0;
            }
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
        if (!accessUnit) {
            this.#finalizeIfDone();
            return;
        }
        this.framesEmitted += 1;
        const isKeyFrame = !this.#sawFirstFrame || this.#containsSps(accessUnit);
        this.#sawFirstFrame = true;
        this.onFrame(accessUnit, isKeyFrame);
        if (this.#queue.length === 0 && !this.#proc) {
            this.#finalizeIfDone();
        }
    };

    #finalizeIfDone = () => {
        if (this.#finalized) return;
        if (this.#proc) return; 
        if (this.#queue.length > 0) return; 
        this.#finalized = true;
        if (this.#stoppedManually) {
            if (this.#exitCleanly === false && !this.#sawFirstFrame) {
                this.onError?.(new Error(`ffmpeg killed (stopped) with code=${this.#exitCode} before producing any frames`));
            }
            return;
        }
        if (this.#exitCleanly === false && !this.#sawFirstFrame) {
            this.onError?.(new Error(`ffmpeg exited with code=${this.#exitCode} before producing any frames`));
            return;
        }
        this.onFinished?.();
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
