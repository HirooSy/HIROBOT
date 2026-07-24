/*
 * lib/scraper/ai-image.js — ImageGPT.org text-to-image generator scraper
 * base : https://imagegpt.org/
 *
 * Guest-mode generation (no account/registration needed — this matches
 * imagegpt.org's own public design: unauthenticated visitors get free
 * daily credits via a guest_id cookie). Uses a spoofed IP header to help
 * avoid per-IP rate limiting on the free tier, same technique as the
 * project's other guest-mode scrapers.
 *
 * NOTE: Image *editing* on imagegpt.org requires a verified account (email
 * OTP or Google sign-in) — that's a deliberate gate on their end, not
 * something this scraper works around. Editing stays on the existing
 * nanobanana.im scraper (lib/scraper/nano.js) instead.
 */

import axios from 'axios';

const BASE_URL = 'https://imagegpt.org';
const DEFAULT_MODEL = 'nano-banana-2'; // model imagegpt.org's own UI defaults to
const REQ_TIMEOUT = 30000;

function generateRandomIP() {
    // Ranges roughly corresponding to real residential/mobile ISP blocks,
    // used only to vary the spoofed IP header per request.
    const ranges = [
        [1, 1], [2, 2], [5, 5], [23, 23], [27, 27], [31, 31], [36, 36], [37, 37], [39, 39], [42, 42],
        [46, 46], [49, 49], [50, 50], [60, 60], [114, 114], [117, 117], [118, 118], [119, 119], [120, 120],
        [121, 121], [122, 122], [123, 123], [124, 124], [125, 125], [126, 126], [180, 180], [182, 182], [183, 183]
    ];
    const range = ranges[Math.floor(Math.random() * ranges.length)];
    return [
        range[0],
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256),
        Math.floor(Math.random() * 256)
    ].join('.');
}

function spoofedHeaders(spoofedIp, extra = {}) {
    return {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 9; CPH2083 Build/PPR1.180610.011) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.179 Mobile Safari/537.36',
        'Referer': `${BASE_URL}/app/photo/generator`,
        'X-Forwarded-For': spoofedIp,
        'X-Real-IP': spoofedIp,
        'Client-IP': spoofedIp,
        'True-Client-IP': spoofedIp,
        'X-Originating-IP': spoofedIp,
        'X-Cluster-Client-IP': spoofedIp,
        'Forwarded': `for=${spoofedIp}`,
        ...extra
    };
}

async function getGuestId(spoofedIp) {
    const res = await axios.get(`${BASE_URL}/app/photo/generator`, {
        headers: spoofedHeaders(spoofedIp),
        timeout: REQ_TIMEOUT
    });
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
        for (const c of setCookie) {
            const match = c.match(/guest_id=([^;]+)/);
            if (match) return match[1];
        }
    }
    return null;
}

// Mapping aspect ratio -> width/height, mengikuti pilihan yang tersedia di
// UI imagegpt.org (1:1, 16:9, 9:16, 4:3, 3:4, 21:9). Ukurannya pakai rasio
// matematis standar (kelipatan 8, sisi terpanjang ~1024-1344px) yang lazim
// dipakai model image-gen — bukan hasil capture exact dari network request
// mereka, jadi mungkin tidak identik 1:1 dengan yang server mereka pakai,
// tapi rasionya tetap benar.
const ASPECT_RATIOS = {
    '1:1':  { width: 1024, height: 1024 },
    '16:9': { width: 1344, height: 768 },
    '9:16': { width: 768,  height: 1344 },
    '4:3':  { width: 1152, height: 896 },
    '3:4':  { width: 896,  height: 1152 },
    '21:9': { width: 1536, height: 640 }
};

// Style yang tersedia di UI imagegpt.org (dropdown "Style").
const VALID_STYLES = ['none', 'photorealistic', 'cinematic', 'portrait', 'product', 'anime', 'fantasy', '3d-render', 'vintage'];

function resolveAspectRatio(aspectRatio) {
    return ASPECT_RATIOS[aspectRatio] || ASPECT_RATIOS['1:1'];
}

function resolveStyle(style) {
    const s = (style || 'none').toLowerCase().trim();
    return VALID_STYLES.includes(s) ? s : 'none';
}

/**
 * Generate gambar dari prompt teks lewat imagegpt.org (text-to-image, guest
 * mode — tidak perlu login/akun).
 * @param {string} prompt - Deskripsi/prompt gambar (Bahasa Inggris untuk hasil terbaik).
 * @param {object} [opts]
 * @param {string} [opts.model] - Model ID, default 'nano-banana-2'.
 * @param {string} [opts.negativePrompt] - Hal yang mau dihindari di hasil.
 * @param {string} [opts.aspectRatio] - '1:1' (default), '16:9', '9:16', '4:3', '3:4', atau '21:9'.
 * @param {string} [opts.style] - 'none' (default), 'photorealistic', 'cinematic', 'portrait', 'product', 'anime', 'fantasy', '3d-render', atau 'vintage'.
 * @param {number} [opts.numImages] - Jumlah gambar, default 1.
 * @returns {Promise<string[]>} Array URL gambar hasil generate.
 */
export async function generateImage(prompt, opts = {}) {
    const {
        model = DEFAULT_MODEL,
        negativePrompt = '',
        aspectRatio = '1:1',
        style = 'none',
        numImages = 1
    } = opts;

    if (!prompt) throw new Error('Prompt tidak boleh kosong.');

    const { width, height } = resolveAspectRatio(aspectRatio);
    const resolvedStyle = resolveStyle(style);

    const spoofedIp = generateRandomIP();
    const guestId = await getGuestId(spoofedIp);
    const cookie = guestId ? `guest_id=${guestId};` : '';

    const body = {
        prompt,
        negative_prompt: negativePrompt,
        model,
        style: resolvedStyle,
        width,
        height,
        num_images: numImages,
        quality: 'auto'
    };

    const res = await axios.post(`${BASE_URL}/api/generate`, body, {
        headers: spoofedHeaders(spoofedIp, {
            'Content-Type': 'application/json',
            'Cookie': cookie
        }),
        timeout: REQ_TIMEOUT,
        validateStatus: () => true
    });

    if (res.status !== 200) {
        throw new Error(`ImageGPT API error ${res.status}: ${JSON.stringify(res.data)}`);
    }

    const data = res.data;
    if (!data?.success || !Array.isArray(data.images) || data.images.length === 0) {
        throw new Error(`Generate gagal: ${JSON.stringify(data)}`);
    }

    return data.images;
}
