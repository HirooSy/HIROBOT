import * as pureimage from 'pureimage';
import { PassThrough } from 'stream';
import sharp from 'sharp';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

function withTimeout(promise, ms, label) {
    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timeout after ${ms}ms: ${label}`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

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

let emojiMapPromise = null;

function addEmojiEntryToMap(map, entry) {
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
            }
        }
        emojiMapPromise = null;
        return null;
    })();

    return emojiMapPromise;
}

function guessFilename(codePoints) {
    const keepFe0f = codePoints.includes(ZWJ) || codePoints.includes(KEYCAP);
    const filenameCodePoints = keepFe0f
        ? codePoints
        : codePoints.filter(c => c !== FE0F);
    return `${filenameCodePoints.map(toHex4).join('-')}.png`;
}

function toUnifiedHex(codePoint) {
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

            const flattenedBuffer = await sharp(Buffer.from(rawData))
                .flatten({ background: '#ffffff' })
                .png()
                .toBuffer();

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
    return await sharp(buffer).blur(3).png().toBuffer();
}

let cachedFontPath = null;
const FONT_FAMILY = 'BratFont';

function getFontDir() {
    const dir = join(process.cwd(), process.env.TMP || 'data');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return dir;
}

const FONT_SIGNATURES = [
    Buffer.from([0x00, 0x01, 0x00, 0x00]),
    Buffer.from('OTTO', 'ascii'),
    Buffer.from('true', 'ascii'),
    Buffer.from('ttcf', 'ascii')
];

function looksLikeFontFile(buffer) {
    return FONT_SIGNATURES.some(sig => buffer.slice(0, sig.length).equals(sig));
}

async function getGoogleFont() {
    if (cachedFontPath) return cachedFontPath;

    const fontPath = join(getFontDir(), 'brat-font.ttf');

    if (existsSync(fontPath)) {
        try {
            const existing = await readFile(fontPath);
            if (existing.byteLength >= 10000 && looksLikeFontFile(existing)) {
                cachedFontPath = fontPath;
                return fontPath;
            }
        } catch (e) {
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

let fontHandle = null;

function warmUpFont() {
    if (!fontHandle || !fontHandle.font) {
        throw new Error('Font warm-up failed: fontHandle.font is not set after load()');
    }
    fontHandle.font.stringToGlyphs('a');
    fontHandle.font.getPath('a', 0, 10, 20);
}

let fontRegistrationPromise = null;

async function ensureFontRegistered() {
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

const WIDTH = 512, HEIGHT = 512, MARGIN = 25, WORD_SPACING = 25;

export async function generateBratImage(text) {
    await ensureFontRegistered();

    const words = text.split(' ');
    const wordSegs = await Promise.all(words.map(w => parseSegments(w)));
    const { emojiImages, failures } = await loadEmojiImages(wordSegs);

    const canvas = pureimage.make(WIDTH, HEIGHT);
    const ctx = canvas.getContext('2d');

    await drawBratFrame(ctx, wordSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING);
    const buffer = await applyBlur(canvas);

    return { buffer, failures };
}

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

        const buffer = await readFile(outputPath);

        return { buffer, failures };
    } finally {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
    }
}