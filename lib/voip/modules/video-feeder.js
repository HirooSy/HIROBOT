import { spawn } from "node:child_process";
import os from "node:os";

// Sebelumnya kita asumsikan ffmpeg akan mengalir sesuai kecepatan -re
// (real-time), jadi queue kecil (30 frame) dianggap cukup sebagai buffer
// jitter. Terbukti salah: di server produksi, ffmpeg (bahkan langsung
// dari shell, di luar Node.js sama sekali) men-decode+encode video 17
// detik dalam ~4 detik — jauh lebih cepat dari real-time meski -re
// dipasang. Jadi queue HARUS bisa menampung seluruh video (bukan cuma
// buffer jitter kecil), dan Node.js sendiri yang bertanggung jawab penuh
// atas pacing pengiriman lewat #scheduleNext. Limit ini sekarang cuma
// pengaman ekstrem (video sangat panjang) supaya heap tidak tanpa batas,
// bukan mekanisme pacing seperti sebelumnya.
const MAX_QUEUED_FRAMES = 5000;
const DEFAULT_FPS = 12;

// Dikunci ke 1 (bukan dinamis berdasar CPU count) supaya ffmpeg tidak
// merebut lebih dari satu core sekaligus dari Node.js/audio scheduling —
// server punya banyak core (12), tapi tetap ada 1 event loop Node.js
// yang harus tetap responsif untuk audio; membiarkan ffmpeg pakai lebih
// dari 1 thread meningkatkan risiko core yang dipakai Node.js ikut
// terganggu oleh scheduler OS di bawah tekanan.
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

        // Keyframe tiap 1 detik supaya recovery cepat kalau ada paket drop.
        const keyframeIntervalFrames = this.targetFps * 1;
        // Bitrate dinaikkan (multiplier 0.3 -> 1.0, floor 150 -> 300kbps)
        // untuk kualitas gambar lebih tajam di resolusi yang sama
        // (160x120). Ini aman untuk CPU karena bitrate cuma pengaruh ke
        // ukuran data terkompresi, bukan jumlah piksel yang perlu
        // diproses encoder — beda dengan menaikkan resolusi/fps yang
        // menaikkan beban CPU secara signifikan.
        // Multiplier diturunkan (1.0 -> 0.15) karena sekarang dipakai
        // juga untuk resolusi lebih besar (360p) — formula lama pas untuk
        // 160x120 (hasil ~300kbps) tapi di 640x360 akan menghasilkan
        // ~4.6Mbps yang terlalu tinggi untuk video call kecil ini.
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
            // x264-params threads DIPAKSA 1 (bukan FFMPEG_THREADS/2). Dengan
            // threads>1, x264 memakai slice-based parallelism yang memecah
            // SETIAP frame jadi beberapa slice NAL terpisah (masing-masing
            // ber-type 1/5), sehingga parser NALU sederhana kita di bawah
            // (yang menganggap tiap NAL type 1/5 = satu frame baru) salah
            // menghitung SETIAP slice sebagai frame tersendiri — persis
            // 2x lipat jumlah frame asli saat threads=2. Ini akar sebenarnya
            // dari video yang terlihat sangat lambat/tidak sinkron audio:
            // frame count yang salah bikin drip-feed di kecepatan targetFps
            // memutar-ulang jauh lebih banyak "frame" (sebagian cuma slice
            // duplikat) daripada durasi video sebenarnya.
            "-x264-params", `threads=1:keyint=${keyframeIntervalFrames}:min-keyint=${keyframeIntervalFrames}:scenecut=0:nal-hrd=cbr`,
            // Tanpa ini, ffmpeg menahan output di internal buffer sampai
            // penuh (~256KB) sebelum menulis ke pipe sekaligus dalam satu
            // letupan besar — bukan mengalir merata sesuai -re real-time
            // seperti yang diharapkan. Itulah sebab sesungguhnya video
            // terlihat "diam lalu meloncat": puluhan frame masuk stdout
            // bersamaan, jauh melebihi kapasitas queue, lalu langsung
            // dibuang oleh overflow. flush_packets memaksa tiap paket
            // ditulis segera setelah di-encode, sehingga kecepatan yang
            // sampai ke Node.js benar-benar mengikuti -re, bukan menumpuk
            // dulu di buffer OS/ffmpeg.
            "-flush_packets", "1",
            "-f", "h264",
            "pipe:1",
        ];

        console.error(`[VideoFeeder] spawning: ffmpeg ${ffmpegArgs.join(' ')}`);
        // Dijalankan lewat 'nice -n 10' supaya OS scheduler memprioritaskan
        // proses Node.js (termasuk AudioFeeder's setTimeout scheduling) di
        // atas ffmpeg saat keduanya berebut CPU. Tanpa ini, ffmpeg video
        // yang terus-menerus encode (tanpa -re, secepat CPU mengizinkan)
        // bisa membuat event loop Node.js sedikit tersendat, menyebabkan
        // audio yang seharusnya lancar jadi terdengar patah/robotic —
        // meski audio-feeder.js sendiri tidak diubah sama sekali.
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
            console.error(`[VideoFeeder] ffmpeg process exit: framesProduced=${this.framesProduced} framesEmitted=${this.framesEmitted} elapsedMs=${Date.now() - this.#startedAt}, ${this.#queue.length} frame(s) still queued to drip-feed`);

            if (this.#pending.length > 0) {
                this.#queue.push(this.#pending);
                this.#pending = Buffer.alloc(0);
            }
            this.#exitCode = code;
            this.#exitCleanly = cleanExit;
            this.#proc = null;
            // TIDAK memanggil drain sinkron di sini. #scheduleNext() sudah
            // berjalan sejak start() dan akan terus mengirim isi #queue
            // satu-satu di kecepatan targetFps sampai habis — persis
            // seperti saat ffmpeg masih hidup. ffmpeg exit cuma berarti
            // "tidak akan ada frame baru masuk queue lagi", bukan sinyal
            // untuk mengirim semua sisa queue sekaligus. Mengirim ratusan
            // frame secara sinkron ke WASM dalam satu tick itu yang
            // sebelumnya bikin call langsung terputus/crash.
            //
            // onFinished/onError juga TIDAK dipanggil di sini kalau masih
            // ada isi queue — itu baru dipanggil oleh #flushOne() setelah
            // queue benar-benar kosong, supaya "video selesai" itu berarti
            // "semua frame sudah terkirim", bukan "ffmpeg proses sudah mati".
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
        // -re DIHAPUS: terbukti tidak reliable di server produksi (ffmpeg
        // 7.1.4 di server tetap decode+encode jauh lebih cepat dari
        // real-time meski -re dipasang, terverifikasi langsung dari
        // shell di luar Node.js). Pacing sekarang sepenuhnya ditangani
        // Node.js lewat #scheduleNext + queue besar di bawah, bukan
        // mengandalkan ffmpeg menahan laju baca input.
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
        if (this.framesProduced === 1) {
            console.error(`[VideoFeeder] first access unit produced after ${Date.now() - this.#startedAt}ms (size=${accessUnit.length})`);
        }
        if (this.#queue.length >= MAX_QUEUED_FRAMES) {
            this.#overflowCount += 1;
            const now = Date.now();
            if (now - this.#lastOverflowLogAt > 2000) {
                console.error(`[VideoFeeder] queue overflow x${this.#overflowCount} in last window (produced=${this.framesProduced} emitted=${this.framesEmitted} elapsedMs=${now - this.#startedAt}) — ffmpeg producing faster than emit rate`);
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
        if (this.framesEmitted === 1) {
            console.error(`[VideoFeeder] first frame emitted to WASM after ${Date.now() - this.#startedAt}ms`);
        }
        const isKeyFrame = !this.#sawFirstFrame || this.#containsSps(accessUnit);
        this.#sawFirstFrame = true;
        this.onFrame(accessUnit, isKeyFrame);
        if (this.#queue.length === 0 && !this.#proc) {
            this.#finalizeIfDone();
        }
    };

    // Dipanggil setelah queue benar-benar kosong DAN ffmpeg sudah exit —
    // ini titik yang benar untuk memberi tahu caller bahwa video "selesai
    // diputar", bukan saat proses ffmpeg exit (saat itu mungkin masih
    // ratusan frame antri untuk dikirim).
    #finalizeIfDone = () => {
        if (this.#finalized) return;
        if (this.#proc) return; // ffmpeg masih hidup, belum benar2 selesai
        if (this.#queue.length > 0) return; // masih ada sisa untuk dikirim
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
