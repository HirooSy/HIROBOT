import { jimp } from '../../utils/canvas.js';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import axios from 'axios';

const execAsync = promisify(exec);

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

            const flattenedBuffer = await (await jimp.read(Buffer.from(rawData)))
                .flatten('#ffffff')
                .getBuffer('image/png');

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

async function renderBratFrame(wordSegs, emojiImages, width, height, margin, wordSpacing, fontPath, familyName) {
    const { lines, fontSize, lineHeight } = calcLayout(wordSegs, width, height, margin, wordSpacing);
    const emojiSize = fontSize;
    const boxHeight = Math.ceil(lineHeight);
    let y = (height - lines.length * lineHeight) / 2;

    const layers = [];
    const resizedEmojiCache = new Map();

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
                    const ink = loadedFont.ttf.renderInk(s.value, fontSize);   // kerning aktif, sama seperti Pango

                    // Tambahkan offset pada teks agar sejajar dengan emoji
                    const textYOffset = 8;
                    if (ink.width > 0) layers.push({ bitmap: ink, left: Math.round(x), top: Math.round(y + textYOffset) });
                    x += ink.width;
                } else {
                    const base64 = emojiImages.get(s.key);
                    if (base64) {
                        let resized = resizedEmojiCache.get(s.key);
                        if (!resized) {
                            resized = await jimp.resize(Buffer.from(base64, 'base64'),
                                Math.round(emojiSize), Math.round(emojiSize), { out: 'png' });
                            resizedEmojiCache.set(s.key, resized);
                        }
                        // Emoji di posisi y tanpa offset
                        layers.push({
                            input: resized,
                            left: Math.round(x),
                            top: Math.round(y)
                        });
                    }
                    x += emojiSize;
                }
            }
            x += space;
        }
        y += lineHeight;
    }

    // Buat gambar dasar dengan composite
    const base = jimp.create(width, height, '#ffffff');
    for (const l of layers) {
        const src = l.bitmap ? jimp.fromRaw({ ...l.bitmap, channels: 4 }) : await jimp.read(l.input);
        base.composite(src, l.left, l.top);
    }

    // Terapkan blur dengan sigma 4
    return await base.blur(4).getBuffer('image/png', { alpha: false });
}

let loadedFont = null;
let loadedFontKey = null;
const FONT_RETRY_MS = 60 * 1000;

function warmUpFont() {
    if (!loadedFont || !loadedFont.metrics) {
        throw new Error('Font not ready yet');
    }
    const w = measureText(loadedFont.metrics, 'a', 20);
    if (!Number.isFinite(w) || w <= 0) {
        throw new Error(`Invalid font (width=${w})`);
    }
}

// Font brat: pakai FONT_SOURCE (path atau URL .ttf/.woff) kalau diisi,
// kalau tidak / gagal dimuat pakai font bawaan canvas.js.
async function ensureFontRegistered() {
    const source = String(global.settings?.font?.source || '').trim();
    const key = source || 'builtin';
    if (loadedFont && loadedFontKey === key &&
        (!loadedFont.fallback || Date.now() - loadedFont.at < FONT_RETRY_MS)) return;

    let ttf = null, fallback = false;
    if (source) {
        try {
            ttf = await jimp.loadFontFace(source);
        } catch (e) {
            fallback = true;
            console.error(`[brat] font "${source}" failed to load: ${e.message}. Using the built-in font.`);
        }
    }
    if (!ttf) ttf = jimp.getBuiltinFont({ bold: false });

    loadedFont = {
        metrics: {
            unitsPerEm: ttf.unitsPerEm,
            familyName: source && !fallback ? source : 'builtin',
            getGlyphIndex: cp => ttf.glyphIndex(cp),
            getAdvanceWidth: g => ttf.advance[g] || 0
        },
        path: null,
        ttf,
        fallback,
        at: Date.now()
    };
    loadedFontKey = key;
    warmUpFont();
}

const WIDTH = 512, HEIGHT = 512, MARGIN = 25, WORD_SPACING = 25;

export async function generateBratImage(text) {
    await ensureFontRegistered();

    const words = text.split(' ');
    const wordSegs = await Promise.all(words.map(w => parseSegments(w)));
    const { emojiImages, failures } = await loadEmojiImages(wordSegs);

    const buffer = await renderBratFrame(
        wordSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING,
        loadedFont.path, loadedFont.metrics.familyName || 'sans-serif'
    );

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
        const familyName = loadedFont.metrics.familyName || 'sans-serif';

        for (let i = 0; i < words.length; i++) {
            const slicedSegs = wordSegs.slice(0, i + 1);
            const blurredBuffer = await renderBratFrame(
                slicedSegs, emojiImages, WIDTH, HEIGHT, MARGIN, WORD_SPACING,
                loadedFont.path, familyName
            );

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