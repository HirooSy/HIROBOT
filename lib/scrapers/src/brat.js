import sharp from 'sharp';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

function parseFont(buf) {
    const numTables = buf.readUInt16BE(4)
    const tables = {}
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16
        const tag = buf.toString('latin1', rec, rec + 4)
        const offset = buf.readUInt32BE(rec + 8)
        const length = buf.readUInt32BE(rec + 12)
        tables[tag] = { offset, length }
    }

    const req = ['head', 'hhea', 'hmtx', 'maxp', 'cmap']
    for (const t of req) {
        if (!tables[t]) throw new Error(`Font tidak punya tabel wajib "${t}"`)
    }

    const unitsPerEm = buf.readUInt16BE(tables.head.offset + 18)
    const numberOfHMetrics = buf.readUInt16BE(tables.hhea.offset + 34)
    const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4)

    const advanceWidths = new Array(numGlyphs)
    const hmtxOff = tables.hmtx.offset
    let lastAdvance = 0
    for (let g = 0; g < numGlyphs; g++) {
        if (g < numberOfHMetrics) {
            lastAdvance = buf.readUInt16BE(hmtxOff + g * 4)
        }
        advanceWidths[g] = lastAdvance
    }

    const cmap = parseCmap(buf, tables.cmap.offset)

    return {
        unitsPerEm,
        getGlyphIndex(codePoint) {
            return cmap.get(codePoint) || 0
        },
        getAdvanceWidth(glyphIndex) {
            return advanceWidths[glyphIndex] || advanceWidths[0] || 0
        }
    }
}

function parseCmap(buf, cmapOffset) {
    const numSubtables = buf.readUInt16BE(cmapOffset + 2)
    let bestOffset = -1
    let bestScore = -1

    for (let i = 0; i < numSubtables; i++) {
        const rec = cmapOffset + 4 + i * 8
        const platformID = buf.readUInt16BE(rec)
        const encodingID = buf.readUInt16BE(rec + 2)
        const offset = buf.readUInt32BE(rec + 4)

        let score = 0
        if (platformID === 3 && encodingID === 10) score = 5
        else if (platformID === 0 && encodingID >= 4) score = 5
        else if (platformID === 3 && encodingID === 1) score = 4
        else if (platformID === 0) score = 3
        else if (platformID === 1 && encodingID === 0) score = 1

        if (score > bestScore) {
            bestScore = score
            bestOffset = cmapOffset + offset
        }
    }

    if (bestOffset === -1) throw new Error('cmap: tidak ada subtable unicode yang didukung')

    const format = buf.readUInt16BE(bestOffset)
    const map = new Map()

    if (format === 4) {
        const segCountX2 = buf.readUInt16BE(bestOffset + 6)
        const segCount = segCountX2 / 2
        const endCodeOff = bestOffset + 14
        const startCodeOff = endCodeOff + segCountX2 + 2
        const idDeltaOff = startCodeOff + segCountX2
        const idRangeOffOff = idDeltaOff + segCountX2

        for (let s = 0; s < segCount; s++) {
            const endCode = buf.readUInt16BE(endCodeOff + s * 2)
            const startCode = buf.readUInt16BE(startCodeOff + s * 2)
            const idDelta = buf.readInt16BE(idDeltaOff + s * 2)
            const idRangeOffset = buf.readUInt16BE(idRangeOffOff + s * 2)
            if (startCode === 0xFFFF && endCode === 0xFFFF) continue

            for (let c = startCode; c <= endCode && c !== 0xFFFF; c++) {
                let glyphIndex
                if (idRangeOffset === 0) {
                    glyphIndex = (c + idDelta) & 0xFFFF
                } else {
                    const glyphIndexAddr = idRangeOffOff + s * 2 + idRangeOffset + (c - startCode) * 2
                    glyphIndex = buf.readUInt16BE(glyphIndexAddr)
                    if (glyphIndex !== 0) glyphIndex = (glyphIndex + idDelta) & 0xFFFF
                }
                if (glyphIndex !== 0) map.set(c, glyphIndex)
            }
        }
    } else if (format === 12) {
        const numGroups = buf.readUInt32BE(bestOffset + 12)
        for (let g = 0; g < numGroups; g++) {
            const rec = bestOffset + 16 + g * 12
            const startCharCode = buf.readUInt32BE(rec)
            const endCharCode = buf.readUInt32BE(rec + 4)
            const startGlyphID = buf.readUInt32BE(rec + 8)
            for (let c = startCharCode; c <= endCharCode; c++) {
                map.set(c, startGlyphID + (c - startCharCode))
            }
        }
    } else {
        throw new Error(`cmap format ${format} tidak didukung (cuma format 4 dan 12)`)
    }

    return map
}

function measureText(font, text, fontSize) {
    const scale = fontSize / font.unitsPerEm
    let total = 0
    for (const ch of text) {
        const codePoint = ch.codePointAt(0)
        const glyphIndex = font.getGlyphIndex(codePoint)
        total += font.getAdvanceWidth(glyphIndex)
    }
    return total * scale
}

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

            emojiImages.set(seg.key, flattenedBuffer.toString('base64'));
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
    return measureText(loadedFont.metrics, text, fsize);
}

function measureSegs(segs, emojiSize, fontSize) {
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

function buildLines(wordSegs, width, margin, wordSpacing, fontSize) {
    let lines = [];
    let lineWords = [];
    let lineWidth = 0;

    for (let i = 0; i < wordSegs.length; i++) {
        const ww = measureSegs(wordSegs[i], fontSize, fontSize);

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

function calcLayout(wordSegs, width, height, margin, wordSpacing, startFontSize = 110) {
    let fontSize = startFontSize;
    const lineHeightMultiplier = 1.3;

    while (fontSize > 8) {
        const lines = buildLines(wordSegs, width, margin, wordSpacing, fontSize);
        if (lines && lines.length * fontSize * lineHeightMultiplier <= height - 2 * margin) {
            return { lines, fontSize, lineHeight: fontSize * lineHeightMultiplier };
        }
        fontSize -= 2;
    }
    return {
        lines: buildLines(wordSegs, width, margin, wordSpacing, fontSize) || [],
        fontSize,
        lineHeight: fontSize * lineHeightMultiplier
    };
}

function escapeXml(str) {
    return str
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function buildBratFrameSvg(wordSegs, emojiImages, width, height, margin, wordSpacing) {
    const { lines, fontSize, lineHeight } = calcLayout(wordSegs, width, height, margin, wordSpacing);
    const emojiSize = fontSize;
    let y = (height - lines.length * lineHeight) / 2;

    const elements = [];

    for (const lineWordIdxs of lines) {
        const totalW = lineWordIdxs.reduce((sum, wi) =>
            sum + measureSegs(wordSegs[wi], emojiSize, fontSize), 0);
        const space = lineWordIdxs.length > 1
            ? (width - 2 * margin - totalW) / (lineWordIdxs.length - 1)
            : 0;

        let x = margin;
        for (const wi of lineWordIdxs) {
            for (const s of wordSegs[wi]) {
                if (s.type === 'text') {
                    elements.push(
                        `<text x="${x}" y="${y + fontSize}" font-family="BratFont" font-size="${fontSize}" fill="#000000">${escapeXml(s.value)}</text>`
                    );
                    x += measureTextDirect(s.value, fontSize);
                } else {
                    const base64 = emojiImages.get(s.key);
                    if (base64) {
                        elements.push(
                            `<image x="${x}" y="${y}" width="${emojiSize}" height="${emojiSize}" xlink:href="data:image/png;base64,${base64}"/>`
                        );
                    }
                    x += emojiSize;
                }
            }
            x += space;
        }
        y += lineHeight;
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
        `<defs><style>@font-face { font-family: 'BratFont'; src: url(data:font/ttf;base64,${loadedFont.base64}) format('truetype'); }</style></defs>` +
        `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>` +
        elements.join('') +
        `</svg>`;
}

async function applyBlur(svg) {
    return await sharp(Buffer.from(svg)).blur(3).png().toBuffer();
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

let loadedFont = null;

function warmUpFont() {
    if (!loadedFont || !loadedFont.metrics) {
        throw new Error('Font warm-up failed: loadedFont.metrics is not set after parseFont()');
    }
    const w = measureText(loadedFont.metrics, 'a', 20);
    if (!Number.isFinite(w) || w <= 0) {
        throw new Error(`Font warm-up failed: measureText returned an invalid width (${w})`);
    }
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
                const fontBuffer = await readFile(fontPath);
                const metrics = parseFont(fontBuffer);
                loadedFont = { metrics, base64: fontBuffer.toString('base64') };
                warmUpFont();
                return;
            } catch (e) {
                lastError = e;
                cachedFontPath = null;
                loadedFont = null;
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

    const svg = buildBratFrameSvg(wordSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING);
    const buffer = await applyBlur(svg);

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
            const svg = buildBratFrameSvg(slicedSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING);
            const blurredBuffer = await applyBlur(svg);

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