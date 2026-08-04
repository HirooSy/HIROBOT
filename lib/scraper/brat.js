import { sticker } from '../sticker.js';
import * as pureimage from 'pureimage';
import { PassThrough } from 'stream';
import { Jimp } from 'jimp';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import axios from 'axios';

const execAsync = promisify(exec);
const { default: { Image } } = await import('node-webpmux');

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ==================== Emoji parsing & fetching ====================

const PNG_CDN = 'https://unpkg.com/emoji-datasource-apple@16.0.0/img/apple/64/';
const PNG_CDN_FALLBACK = 'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/img/apple/64/';
const EMOJI_JSON_URLS = [
    'https://unpkg.com/emoji-datasource-apple@16.0.0/emoji.json',
    'https://cdn.jsdelivr.net/npm/emoji-datasource-apple@16.0.0/emoji.json'
];

const ZWJ = 0x200D;
const FE0F = 0xFE0F;
const KEYCAP = 0x20E3;
const EXT_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /\p{Regional_Indicator}/u;
const TAG_CHARS = /[\u{E0020}-\u{E007F}]/u;

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

function isEmojiCluster(cluster) {
    return (
        EXT_PICTOGRAPHIC.test(cluster) ||
        REGIONAL_INDICATOR.test(cluster) ||
        cluster.includes('\u20E3') ||
        TAG_CHARS.test(cluster)
    );
}

function toHex4(codePoint) {
    return codePoint.toString(16).padStart(4, '0');
}

// --- Official filename lookup ---
// emoji-datasource's "image" filename does NOT follow a consistent rule about
// keeping/dropping FE0F (e.g. "2764-fe0f.png" keeps it, "261d.png" drops it
// even though both emoji have FE0F in their "unified" codepoint sequence).
// So instead of guessing, we fetch the real emoji.json once and build a
// lookup table keyed by the actual codepoint sequences (unified + non_qualified
// + skin variations), mapped to their real filenames.
let emojiMapPromise = null;

function addEmojiEntryToMap(map, entry) {
    // Some entries in emoji.json don't actually have Apple artwork (has_img_apple
    // false) even though "image" is filled in with a shared filename from another
    // platform's set. Using that filename against the Apple CDN 404s. Skip those.
    if (entry.has_img_apple === false) return;
    if (entry.unified) map.set(entry.unified.toUpperCase(), entry.image);
    if (entry.non_qualified) map.set(entry.non_qualified.toUpperCase(), entry.image);
    if (entry.skin_variations) {
        for (const variation of Object.values(entry.skin_variations)) {
            addEmojiEntryToMap(map, variation);
        }
    }
}

async function getEmojiMap() {
    if (emojiMapPromise) return emojiMapPromise;

    emojiMapPromise = (async () => {
        for (const url of EMOJI_JSON_URLS) {
            try {
                const response = await withTimeout(axios({
                    method: 'GET',
                    url,
                    responseType: 'json',
                    timeout: 10000,
                    validateStatus: (status) => status === 200
                }), 12000, 'emoji.json download');

                const map = new Map();
                for (const entry of response.data) {
                    addEmojiEntryToMap(map, entry);
                }
                return map;
            } catch (e) {
                // try the next CDN
            }
        }
        emojiMapPromise = null;
        return null;
    })();

    return emojiMapPromise;
}

// Fallback heuristic used only if emoji.json couldn't be loaded.
function guessFilename(codePoints) {
    const keepFe0f = codePoints.includes(ZWJ) || codePoints.includes(KEYCAP);
    const filenameCodePoints = keepFe0f
        ? codePoints
        : codePoints.filter(c => c !== FE0F);
    return `${filenameCodePoints.map(toHex4).join('-')}.png`;
}

function toUnifiedHex(codePoint) {
    // emoji.json's "unified"/"non_qualified" fields pad BMP codepoints to at
    // least 4 hex digits (e.g. "00A9"), while codePoint.toString(16) alone
    // would produce "a9" and never match.
    return codePoint.toString(16).toUpperCase().padStart(4, '0');
}

async function clusterToEmojiUrl(cluster) {
    const codePoints = [...cluster].map(c => c.codePointAt(0));
    const key = codePoints.map(toUnifiedHex).join('-');
    const withoutFe0fKey = codePoints
        .filter(c => c !== FE0F)
        .map(toUnifiedHex)
        .join('-');

    const emojiMap = await getEmojiMap();
    let filename = null;
    let isKnown = false;
    if (emojiMap) {
        filename = emojiMap.get(key) || emojiMap.get(withoutFe0fKey) || null;
        isKnown = !!filename;
    }
    if (!filename) {
        filename = guessFilename(codePoints);
    }

    return {
        filename,
        url: `${PNG_CDN}${filename}`,
        fallbackUrl: `${PNG_CDN_FALLBACK}${filename}`,
        // If emoji.json loaded fine but this cluster wasn't in it at all, it's
        // most likely a very recently-added Unicode emoji that the datasource
        // (emoji-datasource-apple, capped at Emoji 16.0) doesn't include yet -
        // a data gap, not a network failure.
        likelyTooNew: !!emojiMap && !isKnown
    };
}

export async function parseSegments(str) {
    if (!str) return [{ type: 'text', value: str }];

    const segments = [];
    let currentText = '';

    for (const { segment: cluster } of segmenter.segment(str)) {
        if (isEmojiCluster(cluster)) {
            if (currentText) {
                segments.push({ type: 'text', value: currentText });
                currentText = '';
            }
            const { filename, url, fallbackUrl, likelyTooNew } = await clusterToEmojiUrl(cluster);
            segments.push({
                type: 'emoji',
                value: cluster,
                key: filename,
                url,
                fallbackUrl,
                likelyTooNew
            });
        } else {
            currentText += cluster;
        }
    }

    if (currentText) {
        segments.push({ type: 'text', value: currentText });
    }

    return segments;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchOnce(url) {
    const response = await axios({
        method: 'GET',
        url,
        responseType: 'arraybuffer',
        timeout: 8000,
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
            'Accept': 'image/png,image/*;q=0.8,*/*;q=0.5'
        },
        validateStatus: (status) => status === 200
    });

    const contentType = response.headers['content-type'] || '';
    if (!contentType.includes('image')) {
        throw new Error(`Unexpected content-type "${contentType}" (server likely returned an error page, not a PNG)`);
    }
    return response.data;
}

async function fetchEmojiPng(urls) {
    // unpkg lazily unpacks npm tarballs at the edge, so a rarely-requested
    // file can 404 on the very first hit and then succeed moments later once
    // it's warmed up. Retry each URL once with a short delay before giving up
    // on it and moving to the next CDN, instead of failing immediately.
    let lastError;
    for (const url of urls) {
        try {
            return await fetchOnce(url);
        } catch (e) {
            lastError = e;
        }
        try {
            await sleep(700);
            return await fetchOnce(url);
        } catch (e) {
            lastError = e;
        }
    }
    throw lastError;
}

export async function loadEmojiImages(wordSegs) {
    const emojiSegs = new Map(
        wordSegs.flat().filter(s => s.type === 'emoji').map(s => [s.key, s])
    );
    const emojiImages = new Map();
    const failures = [];

    await Promise.all([...emojiSegs.values()].map(async seg => {
        try {
            const rawData = await fetchEmojiPng([seg.url, seg.fallbackUrl]);

            const jimpImg = await Jimp.read(Buffer.from(rawData));
            const { data } = jimpImg.bitmap;
            for (let i = 0; i < data.length; i += 4) {
                const alpha = data[i + 3] / 255;
                data[i] = Math.round(data[i] * alpha + 255 * (1 - alpha));
                data[i + 1] = Math.round(data[i + 1] * alpha + 255 * (1 - alpha));
                data[i + 2] = Math.round(data[i + 2] * alpha + 255 * (1 - alpha));
                data[i + 3] = 255;
            }
            const flattenedBuffer = await jimpImg.getBuffer('image/png');

            const stream = new PassThrough();
            stream.end(flattenedBuffer);
            const img = await pureimage.decodePNGFromStream(stream);
            emojiImages.set(seg.key, img);
        } catch (e) {
            failures.push({ emoji: seg.value, url: seg.url, message: e.message, likelyTooNew: seg.likelyTooNew });
        }
    }));

    if (emojiSegs.size > 0 && emojiImages.size === 0) {
        if (failures.every(f => f.likelyTooNew)) {
            const list = failures.map(f => f.emoji).join(' ');
            throw new Error(`This emoji (${list}) is probably too new and not yet supported by the emoji data used by the bot.`);
        }
        const first = failures[0];
        throw new Error(`All emoji failed to load from the CDN (${failures.length} failed). Example: ${first.url} -> ${first.message}`);
    }

    return { emojiImages, failures };
}

// ==================== Layout & drawing ====================

// Pengukuran & penggambaran teks TIDAK lagi lewat ctx.font/ctx.fillText/
// ctx.measureText. Lihat komentar besar di atas ensureFontRegistered()
// untuk alasannya - intinya pureimage.registerFont() + ctx.font itu
// mencocokkan font lewat sebuah registry string-keyed internal ke
// pureimage yang di environment ini selalu gagal ketemu (walau
// download+registrasi font-nya sendiri sukses tanpa error). Jadi kita
// pakai langsung objek font opentype.js yang dikembalikan oleh
// registerFont(...).font setelah di-load, dan gambar/ukur teks sendiri -
// persis logika internal pureimage, tapi tanpa lewat registry yang rusak
// itu.
function measureTextDirect(text, fsize) {
    const font = fontHandle.font;
    const glyphs = font.stringToGlyphs(text);
    let advance = 0;
    glyphs.forEach(g => { advance += g.advanceWidth; });
    return (advance / font.unitsPerEm) * fsize;
}

function drawTextDirect(ctx, text, x, y, fsize) {
    const path = fontHandle.font.getPath(text, x, y, fsize);
    ctx.beginPath();
    path.commands.forEach(cmd => {
        switch (cmd.type) {
            case 'M': ctx.moveTo(cmd.x, cmd.y); break;
            case 'Q': ctx.quadraticCurveTo(cmd.x1, cmd.y1, cmd.x, cmd.y); break;
            case 'L': ctx.lineTo(cmd.x, cmd.y); break;
            case 'C': ctx.bezierCurveTo(cmd.x1, cmd.y1, cmd.x2, cmd.y2, cmd.x, cmd.y); break;
            case 'Z':
                ctx.closePath();
                ctx.fill();
                ctx.beginPath();
                break;
        }
    });
}

function measureSegs(ctx, segs, emojiSize, fontSize) {
    return segs.reduce((total, seg) =>
        total + (seg.type === 'text' ? measureTextDirect(seg.value, fontSize) : emojiSize), 0);
}

export function buildFailureWarning(failures) {
    const tooNew = failures.filter(f => f.likelyTooNew);
    const other = failures.filter(f => !f.likelyTooNew);

    const parts = [];
    if (tooNew.length > 0) {
        parts.push(`${tooNew.map(f => f.emoji).join(' ')} is probably too new and not yet supported`);
    }
    if (other.length > 0) {
        parts.push(`${other.map(f => f.emoji).join(' ')} failed to load from the CDN`);
    }

    return `⚠️ ${failures.length} emoji didn't show up in the sticker: ${parts.join('; ')}`;
}

function buildLines(ctx, wordSegs, width, margin, wordSpacing, fontSize) {
    let lines = [];
    let lineWords = [];
    let lineWidth = 0;

    for (let i = 0; i < wordSegs.length; i++) {
        const ww = measureSegs(ctx, wordSegs[i], fontSize, fontSize);

        if (ww > width - 2 * margin) return null;

        const testWidth = lineWidth + (lineWords.length > 0 ? wordSpacing : 0) + ww;
        if (testWidth < width - 2 * margin || lineWords.length === 0) {
            lineWords.push(i);
            lineWidth = testWidth;
        } else {
            lines.push([...lineWords]);
            lineWords = [i];
            lineWidth = ww;
        }
    }
    if (lineWords.length) lines.push([...lineWords]);
    return lines;
}

function calcLayout(ctx, wordSegs, width, height, margin, wordSpacing, startFontSize = 110) {
    let fontSize = startFontSize;
    const lineHeightMultiplier = 1.3;

    while (fontSize > 8) {
        const lines = buildLines(ctx, wordSegs, width, margin, wordSpacing, fontSize);
        if (lines && lines.length * fontSize * lineHeightMultiplier <= height - 2 * margin) {
            return { lines, fontSize, lineHeight: fontSize * lineHeightMultiplier };
        }
        fontSize -= 2;
    }
    return {
        lines: buildLines(ctx, wordSegs, width, margin, wordSpacing, fontSize) || [],
        fontSize,
        lineHeight: fontSize * lineHeightMultiplier
    };
}

async function drawBratFrame(ctx, wordSegs, emojiImages, width, height, margin, wordSpacing) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    const { lines, fontSize, lineHeight } = calcLayout(ctx, wordSegs, width, height, margin, wordSpacing);
    const emojiSize = fontSize;
    let y = (height - lines.length * lineHeight) / 2;

    for (const lineWordIdxs of lines) {
        const totalW = lineWordIdxs.reduce((sum, wi) =>
            sum + measureSegs(ctx, wordSegs[wi], emojiSize, fontSize), 0);
        const space = lineWordIdxs.length > 1
            ? (width - 2 * margin - totalW) / (lineWordIdxs.length - 1)
            : 0;

        let x = margin;
        for (const wi of lineWordIdxs) {
            for (const s of wordSegs[wi]) {
                if (s.type === 'text') {
                    ctx.fillStyle = '#000000';
                    drawTextDirect(ctx, s.value, x, y + fontSize, fontSize);
                    x += measureTextDirect(s.value, fontSize);
                } else {
                    const img = emojiImages.get(s.key);
                    if (img) ctx.drawImage(img, 0, 0, img.width, img.height, x, y, emojiSize, emojiSize);
                    x += emojiSize;
                }
            }
            x += space;
        }
        y += lineHeight;
    }
}

async function canvasToPngBuffer(canvas) {
    const stream = new PassThrough();
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    const done = new Promise((resolve, reject) => {
        stream.on('end', resolve);
        stream.on('error', reject);
    });
    await withTimeout(pureimage.encodePNGToStream(canvas, stream), 15000, 'PNG encode');
    await withTimeout(done, 15000, 'PNG stream end event');
    return Buffer.concat(chunks);
}

async function applyBlur(canvas) {
    const buffer = await canvasToPngBuffer(canvas);
    const image = await Jimp.read(buffer);
    image.blur(3);
    return await image.getBuffer('image/png');
}

async function addExif(buffer, categories = [''], extra = {}) {
    const img = new Image();
    const json = {
        'sticker-pack-id': 'bot',
        'sticker-pack-name': '',
        'sticker-pack-publisher': '',
        'emojis': categories,
        ...extra
    };
    let exifAttr = Buffer.from([
        0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
    let exif = Buffer.concat([exifAttr, jsonBuffer]);
    exif.writeUIntLE(jsonBuffer.length, 14, 4);
    await img.load(buffer);
    img.exif = exif;
    return await img.save(null);
}

let cachedFontPath = null;
const FONT_FAMILY = 'BratFont';

function getFontDir() {
    const dir = join(process.cwd(), process.env.TMP || 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

// TrueType/OpenType asli selalu diawali salah satu signature ini. Kalau
// tidak cocok, kemungkinan besar yang kedownload itu bukan font (misalnya
// halaman error/HTML dari GitHub) walaupun ukurannya kebetulan lolos, dan
// itu yang bikin opentype gagal parse lalu error samar seperti
// "Cannot read properties of null (reading 'stringToGlyphs')" saat dipakai
// gambar nanti.
const FONT_SIGNATURES = [
    Buffer.from([0x00, 0x01, 0x00, 0x00]), // TrueType
    Buffer.from('OTTO', 'ascii'),           // OpenType (CFF)
    Buffer.from('true', 'ascii'),           // Mac TrueType
    Buffer.from('ttcf', 'ascii')            // TrueType Collection
];

function looksLikeFontFile(buffer) {
    return FONT_SIGNATURES.some(sig => buffer.slice(0, sig.length).equals(sig));
}

async function getGoogleFont() {
    if (cachedFontPath) return cachedFontPath;

    const fontPath = join(getFontDir(), 'brat-font.ttf');

    // Kalau file dari download sebelumnya sudah ada di disk & masih valid,
    // pakai itu saja - hindari download ulang tiap kali module ini
    // di-reload (misal reconnect tunnel/hot-reload plugin).
    if (existsSync(fontPath)) {
        try {
            const existing = await readFile(fontPath);
            if (existing.byteLength >= 10000 && looksLikeFontFile(existing)) {
                cachedFontPath = fontPath;
                return fontPath;
            }
        } catch (e) {
            // file rusak/nggak kebaca, lanjut download ulang di bawah
        }
    }

    const fontUrl = 'https://github.com/HirooSy/HirooSy/raw/refs/heads/main/arial.ttf';

    const response = await withTimeout(axios({
        method: 'GET',
        url: fontUrl,
        responseType: 'arraybuffer',
        timeout: 10000,
        validateStatus: (status) => status === 200
    }), 12000, 'Arial ttf download');

    const data = response.data ? Buffer.from(response.data) : null;

    if (!data || data.byteLength < 10000) {
        throw new Error(`Downloaded font looks invalid (size=${data ? data.byteLength : 0} bytes)`);
    }
    if (!looksLikeFontFile(data)) {
        throw new Error(`Downloaded file is not a valid font (bad signature, content-type: ${response.headers['content-type'] || 'unknown'})`);
    }

    await writeFile(fontPath, data);
    cachedFontPath = fontPath;
    return fontPath;
}

// `fontHandle` is the RegisteredFont object returned by
// pureimage.registerFont(). After fontHandle.load() resolves,
// fontHandle.font is the parsed opentype.js Font instance.
//
// IMPORTANT: we deliberately do NOT use ctx.font / ctx.fillText /
// ctx.measureText anywhere in this file anymore. Those all go through
// pureimage's internal font-family registry (a plain object keyed by the
// family string, populated by registerFont() and read back by
// ctx.font's "family" lookup). In this environment that lookup was
// always failing - "WARNING. Can't find font family { family: 'BratFont' }"
// - on every single call, even right after a fresh, successful
// registerFont()+load() with a byte-for-byte valid .ttf on disk. That
// combination (load succeeds, but the family can never be found again)
// only makes sense if the ctx created by pureimage.make() and the
// registerFont() call end up talking to two different copies of
// pureimage's internal registry - which does happen in some setups where
// pureimage or opentype.js end up duplicated in node_modules, or where a
// bot framework's hot-reload/plugin-cache-busting machinery causes this
// module to be re-evaluated against a stale copy of pureimage.
//
// Rather than depend on that registry at all, we keep a direct reference
// to the loaded opentype Font object (fontHandle.font) and do our own
// text measuring (font.stringToGlyphs) and glyph-path drawing
// (font.getPath) - see measureTextDirect/drawTextDirect above. This is
// exactly what pureimage's own text.js does internally, just without the
// broken family-name indirection in the middle.
let fontHandle = null;

function warmUpFont() {
    if (!fontHandle || !fontHandle.font) {
        throw new Error('Font warm-up failed: fontHandle.font is not set after load()');
    }
    // Force any lazy parsing issues to surface here (inside the retry
    // loop below) instead of on the first real user request.
    fontHandle.font.stringToGlyphs('a');
    fontHandle.font.getPath('a', 0, 10, 20);
}

let fontRegistrationPromise = null;

async function ensureFontRegistered() {
    // Dedup concurrent calls, but re-register every time this resolves
    // fresh (no permanent "already done" skip) - registration itself is
    // cheap since it just reads the .ttf already cached on disk, not a
    // re-download from the network.
    if (fontRegistrationPromise) return fontRegistrationPromise;

    const maxAttempts = 3;

    fontRegistrationPromise = (async () => {
        let lastError;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const forceRedownload = attempt > 1;
                if (forceRedownload) cachedFontPath = null;
                const fontPath = await getGoogleFont();
                const font = pureimage.registerFont(fontPath, FONT_FAMILY);
                await withTimeout(font.load(), 15000, 'Font registration/load');
                fontHandle = font;
                warmUpFont();
                return;
            } catch (e) {
                lastError = e;
                cachedFontPath = null;
                fontHandle = null;
                if (attempt < maxAttempts) await sleep(1000 * attempt);
            }
        }
        throw lastError;
    })();

    try {
        return await fontRegistrationPromise;
    } finally {
        fontRegistrationPromise = null;
    }
}

// ==================== High-level generation ====================

const WIDTH = 512, HEIGHT = 512, MARGIN = 25, WORD_SPACING = 25;

// Menghasilkan sticker gambar brat dari text. Return { buffer, failures }.
export async function generateBratImage(text) {
    await ensureFontRegistered();

    const words = text.split(' ');
    const wordSegs = await Promise.all(words.map(w => parseSegments(w)));
    const { emojiImages, failures } = await loadEmojiImages(wordSegs);

    const canvas = pureimage.make(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    await drawBratFrame(ctx, wordSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING);
    const blurredBuffer = await applyBlur(canvas);
    const stickerBuf = await sticker(blurredBuffer, false, false, false);
    const buffer = await addExif(stickerBuf);

    return { buffer, failures };
}

// Menghasilkan sticker video (webp animasi) brat dari text. Return { buffer, failures }.
export async function generateBratVideo(text) {
    await ensureFontRegistered();

    const words = text.split(' ');
    const wordSegs = await Promise.all(words.map(w => parseSegments(w)));

    const tmpDir = join(tmpdir(), `bratv_${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    try {
        const fps = 10;
        const frameDuration = 0.5;
        const repeatCount = Math.round(fps * frameDuration);
        const { emojiImages, failures } = await loadEmojiImages(wordSegs);

        for (let i = 0; i < words.length; i++) {
            const slicedSegs = wordSegs.slice(0, i + 1);
            const canvas = pureimage.make(WIDTH, HEIGHT);
            const ctx = canvas.getContext('2d');

            await drawBratFrame(ctx, slicedSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING);
            const blurredBuffer = await applyBlur(canvas);

            for (let r = 0; r < repeatCount; r++) {
                const frameIndex = i * repeatCount + r;
                const framePath = join(tmpDir, `frame_${String(frameIndex).padStart(5, '0')}.png`);
                await writeFile(framePath, blurredBuffer);
            }
        }

        const outputPath = join(tmpDir, 'brat.webp');
        await withTimeout(
            execAsync(
                `ffmpeg -framerate ${fps} -i "${join(tmpDir, 'frame_%05d.png')}" -vf "scale=512:512" -loop 0 "${outputPath}" -y`
            ),
            30000,
            'ffmpeg encode'
        );

        const webpBuffer = await readFile(outputPath);
        const buffer = await addExif(webpBuffer);

        return { buffer, failures };
    } finally {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
}

// Sengaja TIDAK ada pre-load font di top-level module ini lagi.
// Sebelumnya ada `await ensureFontRegistered()` yang jalan otomatis saat
// file ini di-import. Karena itu top-level await, ES module loader akan
// nge-block sampai promise itu selesai - kalau loader plugin bot
// meng-import semua plugin secara berurutan (umum di banyak framework
// bot WhatsApp), maka SELURUH proses startup ikut macet menunggu
// download+registrasi font ini, bukan cuma command .brat. Sekarang font
// baru didownload & diregistrasi pas command-nya sendiri dipanggil
// (lewat ensureFontRegistered() di dalam generateBratImage /
// generateBratVideo di atas), jadi startup bot tidak ikut ketahan.
