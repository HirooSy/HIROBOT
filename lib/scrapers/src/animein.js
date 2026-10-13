import axios from 'axios';
import http2 from 'http2';
import zlib from 'zlib';
import { pipeline } from 'stream/promises';
import * as fs from 'fs';
import * as path from 'path';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

export function getHeaders(variant = 0) {
    const headers = {
        'User-Agent': USER_AGENT,
        'Accept': 'video/mp4,video/webm,video/ogg,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9'
    };
    if (variant === 0) {
        headers['Referer'] = 'https://animeinweb.com/';
        headers['Origin'] = 'https://animeinweb.com';
    } else if (variant === 1) {
        headers['Referer'] = 'https://animeinweb.com/';
    }
    return headers;
}

// ============== API CLIENT ==============
export const apiClient = axios.create({
    baseURL: 'https://animeinweb.com/api/proxy',
    timeout: 15000,
    headers: {
        'x-proxy-secret': 'animein-secure-proxy-key-123',
        'User-Agent': USER_AGENT,
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://animeinweb.com/',
        'Origin': 'https://animeinweb.com'
    }
});

// ============== FUNCTIONS ==============
export async function searchAnime(keyword, page = 0) {
    try {
        const { data } = await apiClient.get('/3/2/explore/movie', {
            params: { keyword, page: String(page), sort: 'views' }
        });
        return data?.data?.movie || data?.movie || [];
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

async function explore(params) {
    try {
        const { data } = await apiClient.get('/3/2/explore/movie', { params });
        return data?.data?.movie || data?.movie || [];
    } catch (error) {
        console.error('Explore error:', error.message);
        return [];
    }
}

export function getLatest(page = 0) {
    return explore({ page: String(page), sort: 'latest', keyword: '' });
}

export function getPopular(page = 0) {
    return explore({ page: String(page), sort: 'views', keyword: '' });
}

export function getByGenre(genreId, page = 0, sort = 'views') {
    return explore({ page: String(page), sort, id_genre: genreId });
}

export async function getSchedule(day) {
    try {
        const { data } = await apiClient.get('/3/2/home/data', {
            params: { day: String(day).toUpperCase(), limit: 50 }
        });
        return data?.data?.today || [];
    } catch (error) {
        console.error('Get schedule error:', error.message);
        return [];
    }
}

let genreCache = { at: 0, list: [] };

export async function getGenres() {
    if (genreCache.list.length && Date.now() - genreCache.at < 6 * 60 * 60 * 1000) {
        return genreCache.list;
    }
    try {
        const { data } = await apiClient.get('/3/2/explore/genre');
        const list = data?.data?.genre || [];
        if (list.length) genreCache = { at: Date.now(), list };
        return list;
    } catch (error) {
        console.error('Get genres error:', error.message);
        return genreCache.list;
    }
}

const normalizeGenre = value => String(value || '').toLowerCase().replace(/[^a-z0-9]/g, '');

export async function findGenre(ref, { allowId = false } = {}) {
    const key = normalizeGenre(ref);
    if (!key) return null;
    const genres = await getGenres();
    return (allowId && genres.find(g => String(g.id) === String(ref).trim()))
        || genres.find(g => normalizeGenre(g.name) === key)
        || null;
}

export async function getDetail(animeId) {
    try {
        const { data } = await apiClient.get(`/3/2/movie/detail/${animeId}`);
        return data?.data;
    } catch (error) {
        console.error('Get detail error:', error.message);
        return null;
    }
}

export async function getEpisodes(animeId) {
    let allEpisodes = [];
    try {
        // Ambil page pertama dulu untuk tahu apakah perlu lanjut
        const { data } = await apiClient.get(`/3/2/movie/episode/${animeId}`, { params: { page: 0 } });
        const firstPage = data?.data?.episode || [];
        allEpisodes.push(...firstPage);

        if (firstPage.length >= 30) {
            // Fetch beberapa page berikutnya sekaligus secara paralel (batch),
            // bukan satu-satu dengan delay. Batch 5 page per gelombang.
            const BATCH_SIZE = 5;
            let page = 1;
            let keepGoing = true;

            while (keepGoing) {
                const pagesToFetch = Array.from({ length: BATCH_SIZE }, (_, i) => page + i);
                const results = await Promise.all(
                    pagesToFetch.map(p =>
                        apiClient.get(`/3/2/movie/episode/${animeId}`, { params: { page: p } })
                            .then(res => res.data?.data?.episode || [])
                            .catch(() => [])
                    )
                );

                for (const episodes of results) {
                    allEpisodes.push(...episodes);
                    if (episodes.length < 30) keepGoing = false;
                }

                page += BATCH_SIZE;
                // Safety cap agar tidak infinite loop kalau API selalu return 30
                if (page > 500) break;
            }
        }
    } catch (error) {
        console.error('Get episodes error:', error.message);
    }

    // Urutkan dari episode paling lama ke terbaru (episode 1 dulu),
    // karena API mengembalikan urutan terbaru → terlama per page.
    allEpisodes = allEpisodes
        .filter((ep, idx, arr) => arr.findIndex(e => e.id === ep.id) === idx) // dedupe kalau ada overlap antar page
        .sort((a, b) => {
            const numA = parseEpisodeNumber(a);
            const numB = parseEpisodeNumber(b);
            return numA - numB;
        });

    return allEpisodes;
}

// Ekstrak nomor episode dari title (format "Episode 1131") untuk pengurutan yang benar.
// key_time TIDAK dipakai karena isinya tanggal rilis, bukan nomor episode.
function parseEpisodeNumber(ep) {
    const source = ep.title || '';
    // Cari angka yang muncul setelah kata "Episode"/"Ep" jika ada, fallback ke angka pertama
    const withLabel = String(source).match(/(?:episode|ep)\s*(\d+(\.\d+)?)/i);
    if (withLabel) return parseFloat(withLabel[1]);

    const anyNumber = String(source).match(/(\d+(\.\d+)?)/);
    if (anyNumber) return parseFloat(anyNumber[1]);

    return 0;
}

export async function getStream(episodeId) {
    try {
        const { data } = await apiClient.get(`/3/2/episode/streamnew/${episodeId}`);
        return data?.data || data;
    } catch (error) {
        console.error('Get stream error:', error.message);
        return null;
    }
}

const CHROME_CIPHERS = [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA'
].join(':');

const CHROME_PROFILE = {
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    ch: '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="24"',
    mobile: '?0',
    platform: '"Windows"'
};

const h2Sessions = new Map();
const cookieJar = new Map();

function h2Session(origin) {
    let session = h2Sessions.get(origin);
    if (session && !session.closed && !session.destroyed) return session;
    session = http2.connect(origin, {
        ciphers: CHROME_CIPHERS,
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['h2'],
        settings: { headerTableSize: 65536, enablePush: false, initialWindowSize: 6291456, maxHeaderListSize: 262144 }
    });
    try { session.setLocalWindowSize(15663105); } catch (e) {}
    session.on('error', () => h2Sessions.delete(origin));
    session.on('close', () => h2Sessions.delete(origin));
    session.setTimeout(60000, () => session.close());
    h2Sessions.set(origin, session);
    return session;
}

function storeCookies(hostname, headers) {
    for (const line of [].concat(headers['set-cookie'] || [])) {
        const [pair] = line.split(';');
        const i = pair.indexOf('=');
        if (i > 0) cookieJar.set(`${hostname}|${pair.slice(0, i).trim()}`, pair.slice(i + 1).trim());
    }
}

function cookieFor(hostname) {
    return [...cookieJar.entries()]
        .filter(([key]) => key.startsWith(`${hostname}|`))
        .map(([key, value]) => `${key.slice(hostname.length + 1)}=${value}`)
        .join('; ');
}

function cdnHeaders(variant) {
    const headers = {
        'sec-ch-ua': CHROME_PROFILE.ch,
        'sec-ch-ua-mobile': CHROME_PROFILE.mobile,
        'sec-ch-ua-platform': CHROME_PROFILE.platform,
        'user-agent': CHROME_PROFILE.ua,
        'accept': '*/*',
        'sec-fetch-site': 'cross-site',
        'sec-fetch-mode': 'no-cors',
        'sec-fetch-dest': 'video',
        'accept-encoding': 'identity;q=1, *;q=0',
        'accept-language': 'en-US,en;q=0.9'
    };
    if (variant <= 1) headers['referer'] = 'https://animeinweb.com/';
    if (variant === 1) headers['origin'] = 'https://animeinweb.com';
    return headers;
}

async function readSnippet(stream, headers = {}, limit = 2048) {
    const encoding = String(headers['content-encoding'] || '');
    let source = stream;
    if (/br/i.test(encoding)) source = stream.pipe(zlib.createBrotliDecompress());
    else if (/gzip/i.test(encoding)) source = stream.pipe(zlib.createGunzip());
    else if (/deflate/i.test(encoding)) source = stream.pipe(zlib.createInflate());

    const chunks = [];
    let size = 0;
    await new Promise(resolve => {
        const timer = setTimeout(resolve, 5000);
        const done = () => { clearTimeout(timer); resolve(); };
        source.on('data', chunk => {
            chunks.push(chunk);
            size += chunk.length;
            if (size >= limit) done();
        });
        source.on('end', done);
        source.on('error', done);
        source.on('close', done);
    });
    try { stream.destroy(); } catch (e) {}
    return Buffer.concat(chunks).subarray(0, limit);
}

function h2Open(url, { range, variant = 0 } = {}, hops = 5) {
    return new Promise((resolve, reject) => {
        const target = new URL(url);
        if (target.protocol !== 'https:') return reject(new Error('HTTP/2 requires https'));

        let settled = false;
        const fail = error => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };

        const cookie = cookieFor(target.hostname);
        const request = h2Session(target.origin).request({
            ':method': 'GET',
            ':authority': target.host,
            ':scheme': 'https',
            ':path': target.pathname + target.search,
            ...cdnHeaders(variant),
            ...(range ? { range } : {}),
            ...(cookie ? { cookie } : {})
        });

        const timer = setTimeout(() => {
            request.close(http2.constants.NGHTTP2_CANCEL);
            fail(new Error('Connection timeout'));
        }, 30000);

        request.on('error', fail);
        request.on('response', async headers => {
            if (settled) return;
            clearTimeout(timer);
            settled = true;

            const status = headers[':status'];
            storeCookies(target.hostname, headers);

            if ([301, 302, 303, 307, 308].includes(status) && headers.location && hops > 0) {
                request.close(http2.constants.NGHTTP2_CANCEL);
                h2Open(new URL(headers.location, url).href, { range, variant }, hops - 1).then(resolve, reject);
                return;
            }

            if (status >= 400) {
                const error = new Error(`Request failed with status code ${status}`);
                error.response = { status, headers, data: await readSnippet(request, headers) };
                error.config = { url };
                reject(error);
                return;
            }

            request.setTimeout(120000, () => request.destroy(new Error('Download stalled')));
            resolve({
                status,
                headers,
                stream: request,
                abort: () => request.close(http2.constants.NGHTTP2_CANCEL)
            });
        });
        request.end();
    });
}

async function axiosOpen(url, { range, variant = 0 } = {}) {
    const response = await axios.get(url, {
        headers: { ...getHeaders(variant), ...(range ? { Range: range } : {}) },
        responseType: 'stream',
        timeout: 30000,
        validateStatus: () => true
    });

    if (response.status >= 400) {
        const error = new Error(`Request failed with status code ${response.status}`);
        error.response = {
            status: response.status,
            headers: response.headers,
            data: await readSnippet(response.data, response.headers)
        };
        error.config = { url };
        throw error;
    }

    return {
        status: response.status,
        headers: response.headers,
        stream: response.data,
        abort: () => response.data.destroy()
    };
}

async function openCdn(url, options) {
    try {
        return await h2Open(url, options);
    } catch (error) {
        if (error.response) throw error;
        return await axiosOpen(url, options);
    }
}

export async function getFileSize(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            // NOTE: animein's CDN returns 403 on HEAD requests. It only accepts
            // GET with a Range header (same as the old ghostfetch client did).
            const response = await openCdn(url, { range: 'bytes=0-1', variant: attempt });
            response.abort();

            const contentRange = response.headers['content-range'];
            if (contentRange) {
                return parseInt(contentRange.split('/')[1]);
            }

            const contentLength = response.headers['content-length'];
            if (contentLength) {
                return parseInt(contentLength);
            }
            return null;

        } catch (error) {
            console.error(`Attempt ${attempt + 1} getFileSize error:`, error.message);
            if (attempt < 2 && error.response?.status !== 403) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }
    return null;
}

// Checks free space on the partition holding `dirPath` and throws a clear
// error instead of letting the write stream die mid-download with ENOSPC.
async function assertEnoughDiskSpace(dirPath, neededBytes) {
    if (!neededBytes) return; // size unknown, can't pre-check, let it try
    try {
        const stats = await fs.promises.statfs(dirPath);
        const freeBytes = stats.bavail * stats.bsize;
        const MARGIN = 100 * 1024 * 1024; // keep 100MB headroom
        if (freeBytes < neededBytes + MARGIN) {
            throw new Error(
                `Not enough disk space: need ~${formatSize(neededBytes)}, only ${formatSize(freeBytes)} free`
            );
        }
    } catch (error) {
        if (error.message.startsWith('Not enough disk space')) throw error;
        // statfs unsupported on this platform/fs — skip the pre-check silently
    }
}

export function formatSize(bytes) {
    if (!bytes) return '?';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function describeHttpError(error) {
    const res = error.response;
    if (!res) return error.code || error.message;

    let host = '';
    try { host = new URL(error.config?.url || '').host; } catch (e) {}

    let body = '';
    try {
        const data = res.data;
        if (Buffer.isBuffer(data) || data instanceof ArrayBuffer) {
            body = Buffer.from(data).toString('utf8', 0, 300);
        } else if (typeof data === 'string') {
            body = data;
        } else if (data && typeof data[Symbol.asyncIterator] === 'function') {
            for await (const chunk of data) {
                body += chunk.toString('utf8');
                if (body.length >= 300) break;
            }
            data.destroy();
        }
    } catch (e) {}
    body = body.replace(/\s+/g, ' ').trim().slice(0, 120);

    const headers = res.headers || {};
    return [
        `HTTP ${res.status}`,
        host && `host=${host}`,
        headers['server'] && `server=${headers['server']}`,
        headers['cf-ray'] && `cf-ray=yes`,
        headers['content-type'] && `type=${String(headers['content-type']).split(';')[0]}`,
        body && `body="${body}"`
    ].filter(Boolean).join(' ');
}

export async function downloadEpisode(url, outputPath, knownSize) {
    // Pre-check free space so a huge file doesn't fill the disk mid-write.
    const expectedSize = knownSize !== undefined ? knownSize : await getFileSize(url);
    await assertEnoughDiskSpace(path.dirname(outputPath), expectedSize);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const response = await openCdn(url, { range: 'bytes=0-', variant: attempt });
            try {
                await pipeline(response.stream, fs.createWriteStream(outputPath));
            } catch (streamError) {
                response.abort();
                throw streamError;
            }

            return fs.statSync(outputPath).size;

        } catch (error) {
            lastError = error;
            error.detail = await describeHttpError(error);
            console.error(`Attempt ${attempt + 1} download error:`, error.detail);

            // Always remove the partial file, on every attempt including the last.
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (e) {}
            }

            // Disk being full won't fix itself on retry — bail out immediately
            // instead of burning two more attempts.
            if (error.code === 'ENOSPC') break;

            if (attempt < 2 && error.response?.status !== 403) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
    }
    throw lastError;
}