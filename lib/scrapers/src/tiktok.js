import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { randomUUID } from 'crypto';
import axios from 'axios';

const execAsync = promisify(exec);

const SSSTIK = 'https://ssstik.io';
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

function ssstikHeaders(extra = {}) {
    return {
        'User-Agent': UA,
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'sec-ch-ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
        'sec-ch-ua-mobile': '?1',
        'sec-ch-ua-platform': '"Android"',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'Origin': SSSTIK,
        'Referer': `${SSSTIK}/id`,
        ...extra
    };
}

function mediaHeaders(extra = {}) {
    return {
        'User-Agent': UA,
        'Accept': 'video/mp4,video/webm,video/*;q=0.9,*/*;q=0.8',
        'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
        'Referer': `${SSSTIK}/`,
        'sec-fetch-dest': 'video',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-site': 'cross-site',
        ...extra
    };
}

const jar = new Map();

function cookieHeader() {
    return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

function saveCookies(headers) {
    for (const sc of [].concat(headers?.['set-cookie'] || [])) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
}

const bodyText = (data) => typeof data === 'string' ? data : JSON.stringify(data ?? '');

function isBlocked(res) {
    const body = bodyText(res.data).slice(0, 4000);
    return res.headers?.['cf-mitigated'] === 'challenge' ||
        /Just a moment|challenge-platform|cf_chl|captcha/i.test(body);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function request(config, label, attempts = 3) {
    let lastErr;
    for (let i = 1; i <= attempts; i++) {
        try {
            const cookie = cookieHeader();
            const res = await axios({
                timeout: 20000,
                validateStatus: () => true,
                ...config,
                headers: { ...config.headers, ...(cookie ? { Cookie: cookie } : {}) }
            });
            saveCookies(res.headers);
            if (res.status < 400) return res;

            const reason = isBlocked(res) ? ' (kena challenge/captcha)' : '';
            lastErr = new Error(`${label} HTTP ${res.status}${reason}`);
            lastErr.status = res.status;
            if (![403, 429, 503].includes(res.status)) break;
        } catch (e) {
            lastErr = e;
        }
        if (i < attempts) await sleep(1000 * i + Math.random() * 500);
    }
    throw lastErr;
}

export function isLink(text) {
    return text?.match(/https?:\/\/\S+/gi) || null;
}

const decodeEntities = (s = '') => s
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>');

async function resolveTikTokUrl(link) {
    const isShort = /^https?:\/\/(vt|vm)\.tiktok\.com\/|^https?:\/\/(www\.)?tiktok\.com\/t\//i.test(link);
    if (!isShort) return link;
    try {
        const res = await axios({
            method: 'GET',
            url: link,
            maxRedirects: 10,
            responseType: 'stream',
            timeout: 15000,
            validateStatus: () => true,
            headers: { 'User-Agent': UA, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' }
        });
        const finalUrl = res.request?.res?.responseUrl || link;
        res.data?.destroy?.();
        const u = new URL(finalUrl);
        return `${u.origin}${u.pathname}`;
    } catch {
        return link;
    }
}

export function parseSsstikHtml(html = '') {
    const urls = [...html.matchAll(/(?:href|src)="(https:\/\/tikcdn\.io\/ssstik\/[^"]+)"/g)]
        .map(m => decodeEntities(m[1]));
    const music = urls.find(u => /\/ssstik\/m\//.test(u));
    const photos = [...new Set(urls.filter(u => /\/ssstik\/p\//.test(u)))];
    const videos = [...new Set(urls.filter(u => !/\/ssstik\/[mp]\//.test(u)))];

    const cover = html.match(/url\((https:\/\/tikcdn\.io\/ssstik\/p\/[^)]+)\)/);
    const direct = html.match(/data-directurl="([^"]+)"/);
    const nick = html.match(/<h2>([^<]+)<\/h2>/);
    const caption = html.match(/<p class="maintext">([^<]*)<\/p>/);

    return {
        videos,
        music,
        photos,
        cover: cover ? decodeEntities(cover[1]) : null,
        directUrl: direct ? decodeEntities(direct[1]) : null,
        nickname: nick ? decodeEntities(nick[1]).trim() : '',
        caption: caption ? decodeEntities(caption[1]).trim() : ''
    };
}

async function fetchHdLink(directUrl) {
    try {
        const res = await request({
            method: 'GET',
            url: new URL(directUrl, SSSTIK).href,
            headers: ssstikHeaders({ 'Accept': '*/*', 'HX-Request': 'true', 'HX-Current-URL': `${SSSTIK}/id` })
        }, 'ssstik hd');
        const m = bodyText(res.data).replace(/\\\//g, '/').match(/https:\/\/tikcdn\.io\/ssstik\/[^"'\s<>]+/);
        if (!m) return null;
        const url = decodeEntities(m[0]);
        return /\/ssstik\/[mp]\//.test(url) ? null : url;
    } catch {
        return null;
    }
}

export async function tiktok(url) {
    const link = isLink(url);
    if (!link) throw new Error('Invalid URL');
    const target = link[0];

    const page = await request({
        method: 'GET',
        url: `${SSSTIK}/id`,
        headers: ssstikHeaders({ 'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', 'sec-fetch-site': 'none' })
    }, 'ssstik page');
    const pageHtml = bodyText(page.data);
    const tt = pageHtml.match(/name="tt"\s+value="([^"]+)"/)?.[1] ||
        pageHtml.match(/tt\s*[:=]\s*['"]([A-Za-z0-9_-]+)['"]/)?.[1];
    if (!tt) throw new Error('ssstik token not found (page changed or blocked)');

    const res = await request({
        method: 'POST',
        url: `${SSSTIK}/abc?url=dl`,
        data: new URLSearchParams({ id: target, locale: 'id', tt }).toString(),
        headers: ssstikHeaders({
            'Accept': '*/*',
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'HX-Request': 'true',
            'HX-Target': 'target',
            'HX-Current-URL': `${SSSTIK}/id`
        })
    }, 'ssstik API');

    const parsed = parseSsstikHtml(bodyText(res.data));
    const resolved = await resolveTikTokUrl(target);
    const uniqueId = resolved.match(/\/@([^/]+)/)?.[1] || '';
    const author = { nickname: parsed.nickname, unique_id: uniqueId };

    if (parsed.photos.length) {
        return { title: parsed.caption, author, images: parsed.photos, music: parsed.music, cover: parsed.cover };
    }
    if (!parsed.videos.length) {
        throw new Error('ssstik did not return a download link (possibly captcha or unsupported link)');
    }

    const hd = parsed.directUrl ? await fetchHdLink(parsed.directUrl) : null;
    const videos = [...new Set([hd, ...parsed.videos].filter(Boolean))];
    return {
        title: parsed.caption,
        author,
        play: videos[0],
        hdplay: hd || undefined,
        videos,
        music: parsed.music,
        cover: parsed.cover
    };
}

function normalizeVideoUrl(url) {
    if (/^https?:\/\//i.test(url)) return url;
    return `${SSSTIK}${url.startsWith('/') ? '' : '/'}${url}`;
}

const isVideoBuffer = (buf) => Buffer.isBuffer(buf) && buf.length > 12 &&
    (buf.toString('ascii', 4, 8) === 'ftyp' || buf.readUInt32BE(0) === 0x1A45DFA3);

export async function tiktokBoostVolume(source) {
    const list = [...new Set((Array.isArray(source) ? source : [source])
        .filter(Boolean).map(normalizeVideoUrl))];
    if (!list.length) throw new Error('Video URL is empty or unavailable from ssstik');

    let videoBuffer = null;
    const problems = [];
    for (const fixedUrl of list) {
        try {
            const res = await request({
                method: 'GET',
                url: fixedUrl,
                responseType: 'arraybuffer',
                headers: mediaHeaders()
            }, 'ssstik video');
            const buf = Buffer.from(res.data);
            if (isVideoBuffer(buf)) {
                videoBuffer = buf;
                break;
            }
            problems.push(`not a video (${res.headers?.['content-type'] || 'unknown'})`);
        } catch (e) {
            problems.push(e.message);
        }
    }
    if (!videoBuffer) throw new Error(`No valid video from ssstik: ${problems.join('; ')}`);

    const id = randomUUID();
    const tmpIn  = join(tmpdir(), `tt_in_${id}.mp4`);
    const tmpOut = join(tmpdir(), `tt_out_${id}.mp4`);
    await writeFile(tmpIn, videoBuffer);
    try {
        await execAsync(`ffmpeg -i "${tmpIn}" -filter:a "volume=4.0" -c:v copy "${tmpOut}" -y`);
        return await readFile(tmpOut);
    } finally {
        await Promise.allSettled([unlink(tmpIn), unlink(tmpOut)]);
    }
}
