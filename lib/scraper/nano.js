/*
 * lib/scraper/nano.js — Nano Banana (text-to-image & image-to-image) scraper
 * base : https://nanobanana.im/
 *
 * Digabung dari nano-generate.js + nano-editimage.js — keduanya share alur
 * auth (tempmail + magic link) dan endpoint task yang sama. Bedanya cuma di
 * field `image_urls`: kosong buat generate murni dari teks, diisi URL
 * gambar sumber buat edit (image-to-image).
 */

import axios from 'axios';

const HEADERS = {
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'id,en;q=0.9',
    origin: 'https://nanobanana.im',
};

const REQ_TIMEOUT = 15000; // 15s per request, avoids hanging connections
const MAIL_POLL_INTERVAL = 3000;
const MAIL_POLL_MAX_TRIES = 40; // ~2 min max wait for magic link
const TASK_POLL_INTERVAL = 4000;
const TASK_POLL_MAX_TRIES = 45; // ~3 min max wait for image

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function mergeCookies(existing, setCookieArr) {
    if (!setCookieArr || !setCookieArr.length) return existing;
    return [...existing, ...setCookieArr];
}

function cookieHeaderFrom(cookies) {
    return cookies.map((c) => c.split(';')[0]).join('; ');
}

async function getMagicLink(email) {
    for (let i = 0; i < MAIL_POLL_MAX_TRIES; i++) {
        try {
            const res = await axios.get(
                `https://api.tempmail.ing/api/emails/${encodeURIComponent(email)}`,
                { headers: HEADERS, timeout: REQ_TIMEOUT }
            );
            const emails = res.data?.emails;
            if (res.data?.success && emails?.length) {
                const text = emails[0].text || emails[0].html || '';
                const match = text.match(
                    /https:\/\/nanobanana\.im\/api\/auth\/magic-link\/verify\?token=[^\s"']+/
                );
                if (match) return match[0];
            }
        } catch (_) {
            // ignore transient errors, keep polling
        }
        await delay(MAIL_POLL_INTERVAL);
    }
    throw new Error('Timeout menunggu magic link masuk.');
}

/**
 * Bikin session baru yang sudah login (tempmail + magic link), dipakai
 * bareng oleh nanobanana() dan nanoEditImage().
 */
async function createAuthedSession() {
    // 1. temp email
    const mailRes = await axios.post(
        'https://api.tempmail.ing/api/generate',
        {},
        { headers: HEADERS, timeout: REQ_TIMEOUT }
    );
    if (!mailRes.data?.success) throw new Error('Gagal membuat tempmail.');
    const email = mailRes.data.email.address;

    const session = axios.create({ headers: HEADERS, timeout: REQ_TIMEOUT });
    let cookies = [];

    // 2. init session cookies
    const initRes = await session.get('https://nanobanana.im/');
    cookies = mergeCookies(cookies, initRes.headers['set-cookie']);
    let cookieHeader = cookieHeaderFrom(cookies);

    // 3. request magic link
    const magicRes = await session.post(
        'https://nanobanana.im/api/auth/sign-in/magic-link',
        { email, callbackURL: '/' },
        { headers: { Cookie: cookieHeader } }
    );
    if (!magicRes.data?.status) throw new Error('Gagal mengirim magic link.');

    // 4. wait for + verify magic link
    const link = await getMagicLink(email);
    const verifyRes = await session.get(link, {
        headers: { Cookie: cookieHeader },
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
    });
    cookies = mergeCookies(cookies, verifyRes.headers['set-cookie']);
    cookieHeader = cookieHeaderFrom(cookies);

    // 5. refresh session cookies once (only if new ones set)
    const homeRes = await session.get('https://nanobanana.im/', {
        headers: { Cookie: cookieHeader },
    });
    cookies = mergeCookies(cookies, homeRes.headers['set-cookie']);
    cookieHeader = cookieHeaderFrom(cookies);

    return { session, cookieHeader };
}

/**
 * Buat task gambar (generate atau edit tergantung image_urls) dan polling
 * sampai hasilnya jadi. Dipakai bareng oleh nanobanana() dan nanoEditImage().
 */
async function createAndPollTask(session, cookieHeader, payload) {
    const taskRes = await session.post(
        'https://nanobanana.im/api/img/nano-banana5',
        payload,
        { headers: { Cookie: cookieHeader } }
    );

    const taskId = taskRes.data?.taskId;
    if (!taskId) {
        throw new Error('Gagal membuat task gambar. Cek turnstileToken atau session.');
    }

    for (let i = 0; i < TASK_POLL_MAX_TRIES; i++) {
        const checkRes = await session.post(
            'https://nanobanana.im/api/img/nano-banana5/taskResult',
            { taskId },
            { headers: { Cookie: cookieHeader } }
        );
        if (checkRes.data?.status === 1) {
            // API bisa balikin 1 gambar (imgAfterSrc: string) atau lebih dari
            // satu tergantung struktur respons — coba beberapa kemungkinan
            // field secara defensif, selalu normalisasi jadi array URL.
            const d = checkRes.data;
            const raw = d.imgAfterSrcs || d.images || d.imgAfterSrc || d.results;
            const urls = Array.isArray(raw) ? raw : [raw];
            return urls.filter(Boolean);
        }
        await delay(TASK_POLL_INTERVAL);
    }
    throw new Error('Timeout menunggu hasil gambar.');
}

/**
 * Generate gambar dari prompt teks lewat nanobanana.im (text-to-image).
 * @param {string} prompt - Prompt teks untuk generate gambar.
 * @param {object} [opts]
 * @returns {Promise<string[]>} Array URL gambar hasil generate.
 */
export async function nanobanana(prompt, opts = {}) {
    const {
        dimension = 'auto',
        aspect_ratio = 'auto',
        num_images = '1',
        size = '2K',
        resolution = '2K',
        output_format = 'png',
        turnstileToken = '',
    } = opts;

    const { session, cookieHeader } = await createAuthedSession();

    return createAndPollTask(session, cookieHeader, {
        prompt,
        dimension,
        aspect_ratio,
        image_urls: [],
        num_images,
        batchSize: 1,
        turnstileToken,
        skipVerification: false,
        image_path: 'hero',
        size,
        resolution,
        output_format,
    });
}

/**
 * Edit gambar yang sudah ada berdasarkan instruksi teks (image-to-image)
 * lewat nanobanana.im — pakai endpoint yang sama dengan nanobanana(), cuma
 * `image_urls` diisi URL gambar sumber.
 * @param {string} imageUrl - URL gambar sumber yang mau diedit (harus bisa
 *   diakses publik, mis. hasil upload ke Discord CDN/hosting lain).
 * @param {string} prompt - Instruksi edit dalam teks (mis. "add glasses to the character").
 * @param {object} [opts]
 * @returns {Promise<string[]>} Array URL gambar hasil edit.
 */
export async function nanoEditImage(imageUrl, prompt, opts = {}) {
    const {
        dimension = 'auto',
        aspect_ratio = 'auto',
        num_images = '1',
        size = '2K',
        resolution = '2K',
        output_format = 'png',
        turnstileToken = '',
    } = opts;

    const { session, cookieHeader } = await createAuthedSession();

    return createAndPollTask(session, cookieHeader, {
        prompt,
        dimension,
        aspect_ratio,
        image_urls: [imageUrl],
        num_images,
        batchSize: 1,
        turnstileToken,
        skipVerification: false,
        image_path: 'hero',
        size,
        resolution,
        output_format,
    });
}
