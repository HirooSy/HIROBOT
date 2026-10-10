import { default as axios } from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { tmpdir } from 'os';
import http2 from 'http2';
import { img2pdf, ZipFile } from '../../lib/utils/converter.js';

const e621 = global.scraper.e621;

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = '/usr/bin/ffmpeg';

function getTmpDir() {
    const TMP_DIR = path.join(process.cwd(), 'data', 'tmp');
    try {
        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.accessSync(TMP_DIR, fs.constants.W_OK);
        return TMP_DIR;
    } catch (e) {
        console.error('[e621] Gagal buat folder tmp:', e);
        return './tmp';
    }
}

function cleanupTmp(tmpDir) {
    try {
        const oldFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('tmp_'));
        for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        }
    } catch {}
}

async function convertToMp4(fileUrl, inputExt) {
    const tmpDir = getTmpDir();
    cleanupTmp(tmpDir);

    const ts = Date.now();
    const tmpInput = path.join(tmpDir, `tmp_in_${ts}.${inputExt}`);
    const tmpOutput = path.join(tmpDir, `tmp_out_${ts}.mp4`);

    const headers = e621.getHeaders();
    const res = await axios.get(fileUrl, {
        responseType: 'stream',
        headers: headers,
        timeout: 60000
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpInput);
        res.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    if (!fs.existsSync(tmpInput) || fs.statSync(tmpInput).size === 0) {
        throw new Error('Download failed, input file is empty');
    }

    try {
        await execFileAsync(FFMPEG_PATH, [
            '-y',
            '-i', tmpInput,
            '-movflags', 'faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-f', 'mp4',
            tmpOutput
        ]);
    } catch (err) {
        throw new Error(`ffmpeg error: ${err.message}`);
    }

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
        throw new Error('Conversion failed, output file is empty or not found');
    }

    return tmpOutput;
}

function mapE621Post(post) {
    if (!post) return null;
    return {
        id: post.id,
        url: post.file?.url || null,
        pageUrl: `https://e621.net/posts/${post.id}`,
        previewUrl: post.preview?.url || post.sample?.url || null,
        ext: post.file?.ext || 'unknown',
        size: post.file?.size || 0,
        rating: post.rating || '?',
        favCount: post.fav_count || 0,
        tags: post.tags || {}
    };
}

const PAGE_SIZE = 30;

async function searchTagsAccurate(keywords, page) {
    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: keywords, limit: PAGE_SIZE, page },
            headers: e621.getHeaders(),
            timeout: 15000
        });
        const raw = res.data?.posts || [];
        if (!raw.length) return { posts: [], hasNext: false };
        const hasNext = raw.length >= PAGE_SIZE;
        return { posts: raw.map(mapE621Post), hasNext };
    } catch (error) {
        console.error('[e621] tagsSearch error:', error.message);
        return { posts: [], hasNext: false };
    }
}

async function fetchAllPoolPosts(poolId) {
    const info = await e621.getPoolInfo(poolId);
    if (!info || !info.postIds.length) return null;

    const chunkSize = 100;
    const allPosts = [];
    for (let i = 0; i < info.postIds.length; i += chunkSize) {
        const idsChunk = info.postIds.slice(i, i + chunkSize);
        try {
            const res = await axios.get('https://e621.net/posts.json', {
                params: { tags: `id:${idsChunk.join(',')}`, limit: idsChunk.length },
                headers: e621.getHeaders(),
                timeout: 20000
            });
            const byId = new Map((res.data?.posts || []).map(p => [p.id, mapE621Post(p)]));
            for (const id of idsChunk) {
                const post = byId.get(id);
                if (post) allPosts.push(post);
            }
        } catch (error) {
            console.error('[e621] fetchAllPoolPosts chunk error:', error.message);
        }
    }
    return { info, posts: allPosts };
}

const STATIC_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp'];
const MAX_DLALL_POSTS = 200;

async function buildPoolPdf(posts) {
    const urls = posts.filter(p => p.url).map(p => p.url);
    return img2pdf(urls);
}

async function buildPoolZip(posts) {
    const zip = new ZipFile();
    for (const post of posts) {
        if (!post.url) continue;
        try {
            const res = await axios.get(post.url, {
                responseType: 'arraybuffer',
                headers: e621.getHeaders(),
                timeout: 30000
            });
            zip.file(`${post.id}.${post.ext || 'bin'}`, Buffer.from(res.data));
        } catch (error) {
            console.error('[e621] zip fetch error for post', post.id, error.message);
        }
    }
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

const ratingMap = { s: 'Safe', q: 'Questionable', e: 'Explicit' };

if (!global.e621SearchState) global.e621SearchState = {};

const SEARCH_STATE_TTL = 15 * 60 * 1000;

function cleanupSearchState() {
    const now = Date.now();
    for (const key of Object.keys(global.e621SearchState)) {
        if (now - global.e621SearchState[key].timestamp > SEARCH_STATE_TTL) {
            delete global.e621SearchState[key];
        }
    }
}

function buildPostCaption(post) {
    return `*#${post.id}*
${post.favCount} Favorites • ${ratingMap[post.rating] || post.rating}${(post.tags.character || []).length >= 1 ? `\n- *Character:* ${(post.tags.character || []).map(v => `${v}`).join(', ')}` : ''}
- *Species:* ${(post.tags.species || []).map(v => `${v}`).join(', ')}
- *Artist:* ${(post.tags.artist || []).map(v => `${v}`).join(', ')}
- *Tags:* ${global.readmore || ' '}
> ${(post.tags.general || []).map(v => `${v}`).join(', ')}`;
}

async function sende621Post(conn, chat, post, quoted) {
    if (!post.url) {
        const caption = buildPostCaption(post);
        return conn.sendMessage(chat, {
            text: `Media file for this post isn't available (e621 didn't expose a direct file URL - it may be restricted or deleted).\n\n${caption}\n${post.pageUrl || ''}`
        }, quoted ? { quoted } : {});
    }

    const caption = buildPostCaption(post);

    if (post.ext === 'gif') {
        const tmpPath = await convertToMp4(post.url, 'gif');
        try {
            if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
                await conn.sendMessage(chat, {
                    video: fs.readFileSync(tmpPath),
                    gifPlayback: true,
                    caption
                }, quoted ? { quoted } : {});
            } else {
                throw new Error('Processed file is invalid.');
            }
        } finally {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
        return;
    }

    if (post.ext === 'webm') {
        return conn.sendMessage(chat, {
            document: { url: post.url },
            mimetype: 'video/webm',
            fileName: `e621_${post.id}.webm`,
            caption
        }, quoted ? { quoted } : {});
    }

    if (post.ext === 'mp4') {
        return conn.sendMessage(chat, { video: { url: post.url }, caption }, quoted ? { quoted } : {});
    }

    return conn.sendMessage(chat, { image: { url: post.url }, caption }, quoted ? { quoted } : {});
}

const IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const VIDEO_EXTS = ['webm', 'mp4'];
const LABELED_EXTS = ['webm', 'mp4', 'gif'];
const PREVIEW_CONCURRENCY = 25;
const GRID_COLUMNS = 3;
const PREVIEW_UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

const escapeHtml = (str = '') => String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function createFetcher() {
    const sessions = new Map();
    let h2Broken = false;

    const getSession = (origin) => {
        let session = sessions.get(origin);
        if (session && !session.closed && !session.destroyed) return session;
        session = http2.connect(origin);
        session.on('error', () => sessions.delete(origin));
        session.on('close', () => sessions.delete(origin));
        sessions.set(origin, session);
        return session;
    };

    const headers = { 'user-agent': PREVIEW_UA, 'accept': 'image/*,*/*', 'referer': 'https://e621.net/' };

    const viaHttp2 = (url) => new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = getSession(u.origin).request({ ':path': u.pathname + u.search, ...headers });
        const chunks = [];
        let status = 0;
        let type = '';
        const timer = setTimeout(() => {
            req.close(http2.constants.NGHTTP2_CANCEL);
            reject(new Error('timeout'));
        }, 15000);
        req.on('response', (h) => {
            status = h[':status'];
            type = h['content-type'] || '';
        });
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            clearTimeout(timer);
            if (status === 200) return resolve({ data: Buffer.concat(chunks), type });
            reject(Object.assign(new Error(`HTTP ${status}`), { response: { status } }));
        });
        req.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        req.end();
    });

    const viaAxios = async (url) => {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': PREVIEW_UA, 'Accept': 'image/*,*/*', 'Referer': 'https://e621.net/' },
            timeout: 15000
        });
        return { data: res.data, type: res.headers?.['content-type'] || '' };
    };

    return {
        async get(url) {
            if (!h2Broken) {
                try {
                    return await viaHttp2(url);
                } catch (e) {
                    if (e.response?.status >= 400) throw e;
                    h2Broken = true;
                }
            }
            return viaAxios(url);
        },
        close() {
            for (const session of sessions.values()) session.close();
            sessions.clear();
        }
    };
}

async function fetchToFile(url, file, fetcher) {
    const res = await fetcher.get(url);
    if (!res.data?.length) throw new Error('empty response');
    fs.writeFileSync(file, res.data);
    const mime = String(res.type || '').split(';')[0].trim();
    return /^image\//i.test(mime) ? mime : 'image/jpeg';
}

async function firstFrame(input, output) {
    const args = ['-y'];
    if (/^https?:\/\//i.test(input)) {
        args.push('-user_agent', e621.getHeaders()['User-Agent'], '-headers', 'Referer: https://e621.net/\r\n');
    }
    args.push('-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', output);
    await execFileAsync(FFMPEG_PATH, args, { timeout: 30000 });
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('empty frame');
}

async function savePreview(post, dir, idx, fetcher) {
    const ext = (post.ext || '').toLowerCase();
    const base = path.join(dir, `e621_${idx}`);

    if (post.previewUrl) {
        const file = `${base}.img`;
        const mime = await fetchToFile(post.previewUrl, file, fetcher);
        return { file, mime };
    }

    const out = `${base}.jpg`;
    if ((VIDEO_EXTS.includes(ext) || ext === 'gif') && post.url) {
        await firstFrame(post.url, out);
        return { file: out, mime: 'image/jpeg' };
    }

    if (IMAGE_EXTS.includes(ext) && post.url) {
        const raw = `${base}_raw`;
        try {
            await fetchToFile(post.url, raw, fetcher);
            await firstFrame(raw, out);
        } finally {
            if (fs.existsSync(raw)) fs.unlinkSync(raw);
        }
        return { file: out, mime: 'image/jpeg' };
    }

    throw new Error('no preview source');
}

const SHRINK_ABOVE_BYTES = 8 * 1024;

async function shrinkIfLarge(result, dir, idx) {
    if (!result || fs.statSync(result.file).size <= SHRINK_ABOVE_BYTES) return result;
    const out = path.join(dir, `e621_${idx}_s.jpg`);
    try {
        await execFileAsync(FFMPEG_PATH, ['-y', '-i', result.file, '-frames:v', '1', '-vf', 'scale=150:150:force_original_aspect_ratio=increase,crop=150:150', '-q:v', '12', out], { timeout: 20000 });
        if (fs.existsSync(out) && fs.statSync(out).size > 0) {
            fs.unlinkSync(result.file);
            return { file: out, mime: 'image/jpeg' };
        }
    } catch (e) {}
    return result;
}

async function downloadPreviews(posts, dir) {
    const results = new Array(posts.length).fill(null);
    results.failures = [];
    const failures = results.failures;
    const fetcher = createFetcher();
    let cursor = 0;
    const worker = async () => {
        while (cursor < posts.length) {
            const i = cursor++;
            try {
                results[i] = await shrinkIfLarge(await savePreview(posts[i], dir, i, fetcher), dir, i);
            } catch (e) {
                results[i] = null;
                failures.push(`#${i + 1}: ${e.response?.status ? 'HTTP ' + e.response.status : (e.message || e)}`);
            }
        }
    };
    try {
        await Promise.all(Array.from({ length: Math.min(PREVIEW_CONCURRENCY, posts.length) }, worker));
    } finally {
        fetcher.close();
    }
    return results;
}

function localImgSrc({ file, mime }) {
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
}

const RATING_COLORS = { s: '#34c759', q: '#ffcc00', e: '#ff3b30' };

function formatFav(n) {
    n = Number(n) || 0;
    return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n);
}

function buildPreviewHtml(posts, previews) {
    const cells = posts.map((post, i) => {
        const ext = (post.ext || '').toLowerCase();
        const preview = previews[i];
        const num = i + 1;
        const rating = String(post.rating || '?').toLowerCase();
        const color = RATING_COLORS[rating] || '#8e8e93';
        const tag = LABELED_EXTS.includes(ext) ? `<span class="tag">${ext.toUpperCase()}</span>` : '';
        const media = preview
            ? `<img src="${localImgSrc(preview)}" alt="${num}">`
            : `<div class="empty">${escapeHtml((post.ext || '?').toUpperCase())}</div>`;
        return `
    <div class="cell">
      <div class="thumb">
        ${media}
        <span class="num">${num}</span>
        ${tag}
      </div>
      <div class="status"><span class="heart">&#9829;&#xFE0E;</span> <span class="count">${formatFav(post.favCount)}</span> <span class="count">-</span> <span style="color:${color}">${escapeHtml(rating.toUpperCase())}</span></div>
    </div>`;
    }).join('');

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { padding: 8px; font-family: sans-serif; background: transparent; }
  .grid { display: grid; grid-template-columns: repeat(${GRID_COLUMNS}, 1fr); gap: 8px; }
  .cell { border-radius: 10px; overflow: hidden; background: #1c1c1e; }
  .thumb { position: relative; aspect-ratio: 1 / 1; background: rgba(128,128,128,.2); }
  .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .empty { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; font-size: 10px; font-weight: 400; color: #fff; opacity: .6; }
  .num { position: absolute; top: 5px; left: 5px; min-width: 20px; padding: 1px 6px; border-radius: 10px; background: rgba(0,0,0,.6); color: #fff; font-size: 10px; font-weight: 400; text-align: center; }
  .tag { position: absolute; top: 5px; right: 5px; padding: 1px 5px; border-radius: 5px; background: rgba(0,0,0,.6); color: #fff; font-size: 9px; font-weight: 400; letter-spacing: .3px; }
  .status { padding: 4px 4px; text-align: center; font-size: 10px; font-weight: 400; white-space: nowrap; }
  .heart { color: #ff3b30; }
  .count { color: #fff; }
</style>
</head>
<body>
  <div class="grid">${cells}
  </div>
</body>
</html>`;
}

async function sendGallery(conn, m, { type, keywords, poolId, label, posts, page, hasNext, command }) {
    cleanupSearchState();
    const token = `${(m.sender || '').split('@')[0]}_${Date.now().toString(36)}`;
    global.e621SearchState[token] = { type, keywords, poolId, posts, page, timestamp: Date.now() };

    const rows = posts.map((post, i) => ({
        header: `${i + 1}. #${post.id}`,
        title: `${ratingMap[post.rating] || post.rating} · ${(post.ext || '?').toUpperCase()} · ${post.favCount} favs`,
        description: '',
        id: `.${command} get ${token} ${i}`
    }));

    const navFlow = [];
    if (type === 'pool') navFlow.push({ text: 'Download All', id: `.${command} dlall ${token}` });
    if (page > 1) navFlow.push({ text: '◀︎Prev', id: `.${command} page ${token} ${page - 1}` });
    if (hasNext) navFlow.push({ text: '▶︎Next', id: `.${command} page ${token} ${page + 1}` });

    const caption = `- ${label}\n- *Page:* ${page}\n- *Showing:* ${posts.length}\n\nChoose the number you want to download.`;
    const nativeFlow = [{ text: '\u0000', sections: [{ rows }] }, ...navFlow];

    const dir = fs.mkdtempSync(path.join(tmpdir(), 'e621_'));
    try {
        const previews = await downloadPreviews(posts, dir);
        const okCount = previews.filter(Boolean).length;

        try {
            const html = buildPreviewHtml(posts, previews);
            await conn.aiRich()
                .setTitle(`e621 — ${String(keywords || label).replace(/[*_]/g, '')}`)
                .addHtml(html)
                .send(m.chat, { quoted: m });
        } catch (err) {
            await m.reply(`Preview gagal dikirim: ${err.message || err}`);
        }
        if (okCount === 0) {
            await m.reply(`Preview gambar gagal di-download (0/${posts.length}). ${previews.failures[0] || ''}`.trim());
        }

        await conn.sendButton(m.chat, {
            text: caption,
            footer: 'e621',
            nativeFlow
        }, m);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

let handler = async (m, { conn, text, command }) => {
    if (!text) return m.reply(`How to use:\n.e621 <keywords>\n.e621 <post url>\n.e621 <pool url>`);

    const [sub, ...rest] = text.trim().split(' ');

    try {
        if (sub === 'get') {
            const token = rest[0];
            const index = Number(rest[1]);
            const state = global.e621SearchState[token];
            if (!state) return m.reply('This search result has expired, please search again.');
            const post = state.posts[index];
            if (!post) return m.reply('Post not found.');

            await m.react('⬇️');
            try {
                await sende621Post(conn, m.chat, post, m);
                await m.react('✅');
            } catch (err) {
                await m.react('❌');
                await m.reply(`Failed to download: ${err.message || err}`);
            }
            return;
        }

        if (sub === 'page') {
            const token = rest[0];
            const targetPage = Math.max(1, Number(rest[1]) || 1);
            const state = global.e621SearchState[token];
            if (!state) return m.reply('This search result has expired, please search again.');

            let posts, hasNext, label;
            if (state.type === 'pool') {
                const poolPage = await e621.getPoolPage(state.poolId, targetPage);
                if (!poolPage || !poolPage.posts.length) return m.reply(`No posts on page ${targetPage}.`);
                posts = poolPage.posts;
                hasNext = poolPage.totalPages > targetPage;
                label = `*Pool:* ${poolPage.name}`;
            } else {
                const { posts: fetchedPosts, hasNext: fetchedHasNext } = await searchTagsAccurate(state.keywords, targetPage);
                if (!fetchedPosts.length) return m.reply(`No results on page ${targetPage}.`);
                posts = fetchedPosts;
                hasNext = fetchedHasNext;
                label = `*Query:* ${state.keywords}`;
            }

            await sendGallery(conn, m, {
                type: state.type,
                keywords: state.keywords,
                poolId: state.poolId,
                label,
                posts,
                page: targetPage,
                hasNext,
                command
            });
            return;
        }

        if (sub === 'dlall') {
            const token = rest[0];
            const state = global.e621SearchState[token];
            if (!state || state.type !== 'pool') return m.reply('Download All is only available for pool galleries, or this session has expired.');

            await m.react('📦');
            try {
                const all = await fetchAllPoolPosts(state.poolId);
                if (!all || !all.posts.length) throw new Error('Failed to fetch pool contents.');

                let posts = all.posts;
                const truncated = posts.length > MAX_DLALL_POSTS;
                if (truncated) posts = posts.slice(0, MAX_DLALL_POSTS);

                const isAllStaticImage = posts.every(p => STATIC_IMAGE_EXTS.includes((p.ext || '').toLowerCase()));
                const truncNote = truncated ? ` (limited to first ${MAX_DLALL_POSTS})` : '';

                if (isAllStaticImage) {
                    const pdfBuffer = await buildPoolPdf(posts);
                    await conn.sendMessage(m.chat, {
                        document: pdfBuffer,
                        mimetype: 'application/pdf',
                        fileName: `e621-pool_${state.poolId}.pdf`,
                        caption: `Pool #${state.poolId} — ${posts.length} images${truncNote} (PDF)`
                    }, { quoted: m });
                } else {
                    const zipBuffer = await buildPoolZip(posts);
                    await conn.sendMessage(m.chat, {
                        document: zipBuffer,
                        mimetype: 'application/zip',
                        fileName: `e621-pool_${state.poolId}.zip`,
                        caption: `Pool #${state.poolId} — ${posts.length} files${truncNote}`
                    }, { quoted: m });
                }
                await m.react('✅');
            } catch (err) {
                await m.react('❌');
                await m.reply(`Failed to download all: ${err.message || err}`);
            }
            return;
        }

        const poolMatch = text.match(/^https?:\/\/e621\.net\/pools\/(\d+)/i);
        if (poolMatch) {
            const poolId = poolMatch[1];
            const page = 1;

            const poolPage = await e621.getPoolPage(poolId, page);
            if (!poolPage) return m.reply('Pool not found or invalid URL.');
            if (!poolPage.posts.length) return m.reply('This pool has no posts.');

            await sendGallery(conn, m, {
                type: 'pool',
                poolId,
                label: `*Pool:* ${poolPage.name}`,
                posts: poolPage.posts,
                page,
                hasNext: poolPage.totalPages > page,
                command
            });
            return;
        }

        if (/^(https?:\/\/[^\s]+)$/i.test(text)) {
            const post = await e621.getPost(text);
            if (!post) return m.reply('Post not found or invalid URL.');

            if (post.size > 300 * 1024 * 1024) {
                return m.reply(`File is too large (${(post.size / 1024 / 1024).toFixed(1)} MB), maximum 300MB.\n${post.pageUrl || text}`);
            }

            return sende621Post(conn, m.chat, post, m);
        }

        let keywords = text;
        let page = 1;

        const pageMatch = text.match(/^(.+?)\s*\|\s*page\s*(\d+)$/i);
        if (pageMatch) {
            keywords = pageMatch[1].trim();
            page = Math.max(1, parseInt(pageMatch[2]));
        }

        const { posts, hasNext } = await searchTagsAccurate(keywords, page);
        if (!posts.length) return m.reply(`No results found${page > 1 ? ` on page ${page}` : ''}.`);

        await sendGallery(conn, m, {
            type: 'search',
            keywords,
            label: `*Query:* ${keywords}`,
            posts,
            page,
            hasNext,
            command
        });

    } catch (e) {
        m.error = e;
        console.error('[e621] Handler error:', e);
        await m.reply(`Error: ${e.message}`);
    }
};

handler.help = handler.command = ['e621'];
handler.tags = ["downloader", "adult"]
handler.limit = 1;
handler.ai = { risk: "low", description: "search e621 posts using keywords, download post using post id" }

export default handler;