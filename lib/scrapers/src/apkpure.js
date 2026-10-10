import axios from 'axios';
import * as cheerio from 'cheerio';
import http2 from 'http2';
import zlib from 'zlib';
import fs from 'fs';
import { pipeline } from 'stream/promises';

const BASE = 'https://apkpure.com';

const CONFIG = {
    proxy: '',
    spoofIP: true
};
const UA_POOL = [
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const rnd = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

export function randomUA() {
    return pick(UA_POOL);
}

export function randomIP() {
    while (true) {
        const a = rnd(1, 223), b = rnd(0, 255), c = rnd(0, 255), d = rnd(1, 254);
        if (a === 10 || a === 127 || a === 0) continue;
        if (a === 172 && b >= 16 && b <= 31) continue;
        if (a === 192 && b === 168) continue;
        if (a === 169 && b === 254) continue;
        if (a === 100 && b >= 64 && b <= 127) continue;
        return `${a}.${b}.${c}.${d}`;
    }
}

export function buildHeaders(extra = {}) {
    const ip = randomIP();
    const spoof = !CONFIG.spoofIP ? {} : {
        'X-Forwarded-For': ip, 'X-Real-IP': ip, 'X-Originating-IP': ip, 'X-Client-IP': ip,
        'Client-IP': ip, 'True-Client-IP': ip, 'CF-Connecting-IP': ip, 'Forwarded': `for=${ip}`
    };
    return {
        'User-Agent': randomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': pick(['en-US,en;q=0.9', 'id-ID,id;q=0.9,en;q=0.8', 'en-GB,en;q=0.9']),
        'Referer': BASE + '/',
        ...spoof,
        ...extra
    };
}

let _agent;
async function getAgent() {
    if (!CONFIG.proxy) return undefined;
    if (_agent) return _agent;
    try {
        const { HttpsProxyAgent } = await import('https-proxy-agent');
        _agent = new HttpsProxyAgent(CONFIG.proxy);
        return _agent;
    } catch {
        throw new Error('CONFIG.proxy is set but the package is missing. Run: npm i https-proxy-agent');
    }
}

function isChallenge(res) {
    const body = typeof res.data === 'string' ? res.data.slice(0, 4000) : '';
    return res.headers?.['cf-mitigated'] === 'challenge' ||
        (res.status === 403 || res.status === 503) && /Just a moment|challenge-platform|cf_chl/i.test(body);
}

const H2_PROFILES = [
    { ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
      ch: '"Chromium";v="137", "Not/A)Brand";v="24"', mobile: '?1', platform: '"Android"' },
    { ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      ch: '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="24"', mobile: '?0', platform: '"Windows"' },
    { ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
      ch: '"Chromium";v="137", "Google Chrome";v="137", "Not/A)Brand";v="24"', mobile: '?0', platform: '"macOS"' }
];
const H2_PROFILE = pick(H2_PROFILES);

const CHROME_CIPHERS = [
    'TLS_AES_128_GCM_SHA256', 'TLS_AES_256_GCM_SHA384', 'TLS_CHACHA20_POLY1305_SHA256',
    'ECDHE-ECDSA-AES128-GCM-SHA256', 'ECDHE-RSA-AES128-GCM-SHA256',
    'ECDHE-ECDSA-AES256-GCM-SHA384', 'ECDHE-RSA-AES256-GCM-SHA384',
    'ECDHE-ECDSA-CHACHA20-POLY1305', 'ECDHE-RSA-CHACHA20-POLY1305',
    'ECDHE-RSA-AES128-SHA', 'ECDHE-RSA-AES256-SHA',
    'AES128-GCM-SHA256', 'AES256-GCM-SHA384', 'AES128-SHA', 'AES256-SHA'
].join(':');

const _h2Sessions = new Map();
const _jar = new Map();

function h2Session(origin) {
    let ses = _h2Sessions.get(origin);
    if (ses && !ses.closed && !ses.destroyed) return ses;
    ses = http2.connect(origin, {
        ciphers: CHROME_CIPHERS,
        minVersion: 'TLSv1.2',
        ALPNProtocols: ['h2'],
        settings: { headerTableSize: 65536, enablePush: false, initialWindowSize: 6291456, maxHeaderListSize: 262144 }
    });
    try { ses.setLocalWindowSize(15663105); } catch (_) {  }
    ses.on('error', () => _h2Sessions.delete(origin));
    ses.on('close', () => _h2Sessions.delete(origin));
    ses.setTimeout(60000, () => ses.close());
    _h2Sessions.set(origin, ses);
    return ses;
}

function decode(buf, enc) {
    try {
        if (/br/i.test(enc)) return zlib.brotliDecompressSync(buf);
        if (/gzip/i.test(enc)) return zlib.gunzipSync(buf);
        if (/deflate/i.test(enc)) return zlib.inflateSync(buf);
    } catch (_) {  }
    return buf;
}

function saveCookies(hostname, headers) {
    for (const sc of [].concat(headers['set-cookie'] || [])) {
        const [kv] = sc.split(';');
        const i = kv.indexOf('=');
        if (i > 0) _jar.set(`${hostname}|${kv.slice(0, i).trim()}`, kv.slice(i + 1).trim());
    }
}

function h2Once(url, opts = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const cookie = [..._jar.entries()].filter(([k]) => k.startsWith(u.hostname + '|')).map(([k, v]) => `${k.split('|')[1]}=${v}`).join('; ');
        let site = 'none';
        if (opts.referer) {
            const r = new URL(opts.referer);
            const root = (h) => h.split('.').slice(-2).join('.');
            site = r.host === u.host ? 'same-origin' : root(r.hostname) === root(u.hostname) ? 'same-site' : 'cross-site';
        }
        const req = h2Session(u.origin).request({
            ':method': 'GET',
            ':authority': u.host,
            ':scheme': 'https',
            ':path': u.pathname + u.search,
            'sec-ch-ua': H2_PROFILE.ch,
            'sec-ch-ua-mobile': H2_PROFILE.mobile,
            'sec-ch-ua-platform': H2_PROFILE.platform,
            'upgrade-insecure-requests': '1',
            'user-agent': H2_PROFILE.ua,
            'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
            'sec-fetch-site': site,
            'sec-fetch-mode': 'navigate',
            'sec-fetch-user': '?1',
            'sec-fetch-dest': 'document',
            ...(opts.referer ? { referer: opts.referer } : {}),
            'accept-encoding': 'gzip, deflate, br',
            'accept-language': 'en-US,en;q=0.9',
            ...(cookie ? { cookie } : {})
        });
        const chunks = [];
        let status = 0, headers = {}, done = false;
        const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v); };
        const timer = setTimeout(() => { req.close(http2.constants.NGHTTP2_CANCEL); finish(reject, new Error('h2 timeout')); }, 25000);
        req.on('response', (h) => {
            status = h[':status'];
            headers = h;
            saveCookies(u.hostname, h);
            if (opts.headOnly) {
                req.close(http2.constants.NGHTTP2_CANCEL);
                finish(resolve, { status, headers, data: '' });
            }
        });
        req.on('data', (c) => { if (!opts.headOnly) chunks.push(c); });
        req.on('end', () => {
            const body = decode(Buffer.concat(chunks), String(headers['content-encoding'] || '')).toString('utf8');
            finish(resolve, { status, headers, data: body });
        });
        req.on('error', (e) => finish(reject, e));
        req.end();
    });
}

async function h2Trace(startUrl, referer, maxHops = 8) {
    const trail = [];
    let url = startUrl;
    for (let i = 0; i < maxHops; i++) {
        const r = await h2Once(url, { headOnly: true, referer });
        trail.push(`${r.status} ${new URL(url).host}`);
        if ([301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
            url = new URL(r.headers.location, url).href;
            continue;
        }
        return { url, status: r.status, headers: r.headers, trail };
    }
    throw Object.assign(new Error('Too many redirects'), { trail });
}

async function h2Get(url, hops = 5) {
    let res = await h2Once(url);
    while (hops-- > 0 && [301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
        url = new URL(res.headers.location, url).href;
        res = await h2Once(url);
    }
    return res;
}

async function getHtml(url) {
    if (!CONFIG.proxy) {
        try {
            const r = await h2Get(url);
            if (r.status < 400 && !isChallenge(r)) return r.data;
        } catch (_) {  }
    }

    const res = await axios.get(url, {
        headers: buildHeaders(),
        httpsAgent: await getAgent(),
        proxy: false,
        timeout: 30000,
        maxRedirects: 5,
        validateStatus: () => true
    });

    if (isChallenge(res)) {
        const err = new Error('APKPure blocked the request with a Cloudflare challenge (HTTP ' + res.status + ')');
        err.cloudflare = true;
        throw err;
    }
    if (res.status >= 400 || typeof res.data !== 'string') throw new Error('HTTP ' + res.status + ' from ' + url);
    return res.data;
}

const abs = (u) => !u ? '' : u.startsWith('//') ? 'https:' + u : u.startsWith('/') ? BASE + u : u;
const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();

function parseAppPath(href) {
    const m = (href || '').split('?')[0].match(/^(?:https?:\/\/apkpure\.com)?\/([^/]+)\/([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+)\/?$/);
    return m ? { slug: m[1], pkg: m[2] } : null;
}

async function apkpureSearch(query, limit = 10) {
    if (!query) throw new Error('Empty query');
    const html = await getHtml(`${BASE}/search?q=${encodeURIComponent(query)}&t=`);
    const $ = cheerio.load(html);

    const results = [];
    const seen = new Set();

    $('a[href]').each((_, el) => {
        const a = $(el);
        const info = parseAppPath(a.attr('href'));
        if (!info || seen.has(info.pkg)) return;

        const title = clean(
            a.find('.p1, .first-info .p1, .name, .title, h2, h3').first().text() ||
            a.attr('title') || a.find('img').attr('alt') || a.text()
        );
        if (!title) return;

        seen.add(info.pkg);
        const img = a.find('img').first();
        results.push({
            title,
            slug: info.slug,
            pkg: info.pkg,
            url: `${BASE}/${info.slug}/${info.pkg}`,
            icon: abs(img.attr('data-src') || img.attr('src') || ''),
            developer: clean(a.find('.p2, .developer, .dev').first().text()),
            rating: clean(a.find('.score, .rating, .star').first().text())
        });
    });

    return results.slice(0, limit);
}

async function aptoideSearch(query, limit = 10) {
    const { data } = await axios.get('https://ws75.aptoide.com/api/7/apps/search', {
        params: { query, limit },
        headers: { 'User-Agent': randomUA(), Accept: 'application/json' },
        httpsAgent: await getAgent(),
        proxy: false,
        timeout: 20000
    });
    const list = data?.datalist?.list || [];
    return list.filter(a => a?.package).slice(0, limit).map(a => ({
        title: a.name,
        slug: 'app',
        pkg: a.package,
        url: `${BASE}/app/${a.package}`,
        icon: a.icon || '',
        developer: a.developer?.name || '',
        rating: a.stats?.rating?.avg ? String(Number(a.stats.rating.avg).toFixed(1)) : ''
    }));
}

export async function apkSearch(query, limit = 10) {
    if (!query) throw new Error('Empty query');
    try {
        const r = await apkpureSearch(query, limit);
        if (r.length) return r;
    } catch (e) {
        if (!e.cloudflare && !/HTTP 4|HTTP 5/.test(e.message)) throw e;
    }
    return await aptoideSearch(query, limit);
}

export async function apkDetail(input) {
    const { slug, pkg } = resolveTarget(input);
    const url = `${BASE}/${slug}/${pkg}`;
    const $ = cheerio.load(await getHtml(url));

    const meta = (p) => $(`meta[property="${p}"]`).attr('content') || '';
    const title = clean($('h1').first().text() || meta('og:title'));

    const info = {};
    $('.additional li, .details-sdk, .info-list li, .ny-down li, dl, table tr').each((_, el) => {
        const t = clean($(el).text());
        const m = t.match(/^(Latest Version|Version|Size|Updated on|Update|Requires Android|Android OS|Category|Installs|Content Rating|Developer|Available on)\s*[:\-]?\s*(.+)$/i);
        if (m && !info[m[1].toLowerCase()]) info[m[1].toLowerCase()] = m[2];
    });

    const version =
        info['latest version'] || info['version'] ||
        clean($('.details-sdk span, .version, [class*="version"]').first().text()) || '';

    return {
        title,
        pkg,
        slug,
        url,
        icon: meta('og:image'),
        description: clean(meta('og:description') || $('meta[name="description"]').attr('content')),
        version,
        size: info['size'] || '',
        updated: info['updated on'] || info['update'] || '',
        android: info['requires android'] || info['android os'] || '',
        developer: info['developer'] || clean($('.developer a, [class*="developer"]').first().text()),
        info
    };
}

export async function apkDownload(input, type = 'auto', version = 'latest') {
    const { slug, pkg } = resolveTarget(input);
    const pageUrl = `${BASE}/${slug}/${pkg}/download?utm_content=1008`;
    const types = /^auto$/i.test(type) ? ['XAPK', 'APK'] : [type.toUpperCase()];

    const probe = async (link, referer) => {
        try {
            const res = await axios.get(link, {
                headers: buildHeaders({ Referer: referer, Range: 'bytes=0-0', Accept: '*/*' }),
                httpsAgent: await getAgent(),
                proxy: false,
                maxRedirects: 10,
                timeout: 30000,
                responseType: 'stream',
                validateStatus: s => s < 400
            });
            const ct = String(res.headers['content-type'] || '');
            const cd = res.headers['content-disposition'] || '';
            const range = res.headers['content-range']?.split('/')[1];
            const out = {
                url: res.request?.res?.responseUrl || res.config?.url || link,
                name: decodeURIComponent((cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1] || ''),
                size: Number(range || res.headers['content-length'] || 0),
                html: /text\/html/i.test(ct)
            };
            res.data.destroy();
            return out.html ? null : out;
        } catch (_) { return null; }
    };

    const trails = [];
    const viaH2 = async (link) => {
        if (CONFIG.proxy) return null;
        try {
            const r = await h2Trace(link, pageUrl);
            trails.push(r.trail.join(' > '));
            if (r.status !== 200 || /text\/html/i.test(String(r.headers['content-type'] || ''))) return null;
            const fin = new URL(r.url);
            const cd = String(r.headers['content-disposition'] || '');
            const name = decodeURIComponent((cd.match(/filename\*?=(?:UTF-8'')?"?([^";]+)"?/i) || [])[1] || '') || fin.searchParams.get('filename') || '';
            const size = Number(r.headers['content-length'] || fin.searchParams.get('full_size') || 0);
            return { url: r.url, name, size };
        } catch (e) {
            trails.push('error: ' + e.message);
            return null;
        }
    };

    let link = '', t = types[0], info = null;

    for (const ty of types) {
        const l = `https://d.apkpure.com/b/${ty}/${pkg}?version=${version}`;
        info = await viaH2(l) || await probe(l, pageUrl);
        if (info) { link = l; t = ty; break; }
    }

    if (!info) {
        try {
            const $ = cheerio.load(await getHtml(pageUrl));
            const href = abs(
                $('#download_link').attr('href') ||
                $('a.download-start-btn').attr('href') ||
                $('a[href*="d.apkpure.com"]').first().attr('href') ||
                $('a[href*="/b/APK/"], a[href*="/b/XAPK/"]').first().attr('href') ||
                ''
            );
            if (href) {
                link = href;
                info = await viaH2(href) || await probe(href, pageUrl) || { url: href, name: '', size: 0 };
                t = /\/b\/(X?APK)\//i.exec(href)?.[1]?.toUpperCase() || t;
            }
        } catch (_) {  }
    }

    if (!info) throw new Error('Download link not found or blocked [' + (trails.join(' | ') || 'no response') + ']. Check the package name or try again later');

    const ext = /\.(xapk|apk|apks)(\?|$)/i.exec(info.name || info.url)?.[1]?.toLowerCase() || t.toLowerCase();
    return {
        pkg, slug, type: ext === 'apk' ? 'APK' : ext.toUpperCase(),
        pageUrl, link, url: info.url,
        fileName: info.name || `${pkg}.${ext}`,
        size: info.size
    };
}

function resolveTarget(input) {
    if (!input) throw new Error('Empty input');
    input = String(input).trim();

    const fromUrl = input.match(/apkpure\.(?:com|net)\/([^/?#]+)\/([a-zA-Z0-9_.]+)/);
    if (fromUrl) return { slug: fromUrl[1], pkg: fromUrl[2] };

    const sp = input.match(/^([^/\s]+)\/([a-zA-Z0-9_.]+)$/);
    if (sp) return { slug: sp[1], pkg: sp[2] };

    if (/^[a-zA-Z0-9_]+(\.[a-zA-Z0-9_]+)+$/.test(input)) {
        return { slug: 'app', pkg: input };
    }
    throw new Error('Unrecognized format. Use an APKPure URL or a package name (e.g. com.whatsapp)');
}

export async function apkFetchFile(dl, dest, maxBytes = 0) {
    const urls = [...new Set([dl.url, dl.link].filter(Boolean))];
    let lastErr;
    for (const url of urls) {
        try {
            const res = await axios.get(url, {
                headers: buildHeaders({ Referer: dl.pageUrl, Accept: '*/*' }),
                httpsAgent: await getAgent(),
                proxy: false,
                responseType: 'stream',
                timeout: 60000,
                maxRedirects: 10,
                validateStatus: s => s < 400
            });
            if (/text\/html/i.test(String(res.headers['content-type'] || ''))) {
                res.data.destroy();
                throw new Error('Download blocked (received an HTML page instead of a file)');
            }
            const len = Number(res.headers['content-length'] || 0);
            if (maxBytes && len > maxBytes) {
                res.data.destroy();
                throw new Error('File too large (' + formatSize(len) + ')');
            }
            await pipeline(res.data, fs.createWriteStream(dest));
            return fs.statSync(dest).size;
        } catch (e) {
            lastErr = e;
            fs.promises.unlink(dest).catch(() => {});
        }
    }
    throw lastErr || new Error('Download failed');
}

export function formatSize(b) {
    if (!b) return '-';
    const u = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
    return `${b.toFixed(2)} ${u[i]}`;
}