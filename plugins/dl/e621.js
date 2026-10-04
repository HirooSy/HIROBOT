import { default as axios } from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import { img2pdf, ZipFile } from '../../lib/utils/converter.js';

const e621 = global.scraper.e621;
const upload = global.scraper.upload.default;

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

async function searchTagsAccurate(keywords, page) {
    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: keywords, limit: 51, page },
            headers: e621.getHeaders(),
            timeout: 15000
        });
        const raw = res.data?.posts || [];
        if (!raw.length) return { posts: [], hasNext: false };
        const hasNext = raw.length > 30;
        return { posts: raw.slice(0, 30).map(mapE621Post), hasNext };
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

async function extractFramePreview(fileUrl, ext) {
    const tmpDir = getTmpDir();
    const ts = Date.now();
    const tmpInput = path.join(tmpDir, `frame_in_${ts}.${ext}`);
    const tmpOutput = path.join(tmpDir, `frame_out_${ts}.jpg`);
    try {
        const res = await axios.get(fileUrl, {
            responseType: 'stream',
            headers: e621.getHeaders(),
            timeout: 30000
        });

        await new Promise((resolve, reject) => {
            const writer = fs.createWriteStream(tmpInput);
            res.data.pipe(writer);
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        if (!fs.existsSync(tmpInput) || fs.statSync(tmpInput).size === 0) return null;

        await execFileAsync(FFMPEG_PATH, [
            '-y',
            '-i', tmpInput,
            '-vf', 'thumbnail,scale=320:-1',
            '-frames:v', '1',
            tmpOutput
        ]);

        if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) return null;

        const buffer = fs.readFileSync(tmpOutput);
        return await upload(buffer, `e621_frame_${ts}.jpg`);
    } catch (error) {
        console.error('[e621] extractFramePreview error:', error.message);
        return null;
    } finally {
        if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
        if (fs.existsSync(tmpOutput)) fs.unlinkSync(tmpOutput);
    }
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
const MAX_WIDGET_COMPONENTS = 100;

function calcMaxPreviewItems(perRow) {
    const reserved = 2;
    const perRowCost = 1 + perRow * 3;
    const maxRows = Math.floor((MAX_WIDGET_COMPONENTS - reserved) / perRowCost);
    return Math.max(perRow, maxRows * perRow);
}

async function resolveThumb(post) {
    const ext = (post.ext || '').toLowerCase();
    if (post.previewUrl) return post.previewUrl;
    if (IMAGE_EXTS.includes(ext) && post.url) return post.url;
    if (VIDEO_EXTS.includes(ext) && post.url) {
        const frameUrl = await extractFramePreview(post.url, ext);
        if (frameUrl) return frameUrl;
    }
    return '';
}

async function buildPreviewGrid(posts, perRow = 5) {
    const maxItems = calcMaxPreviewItems(perRow);
    const limited = posts.slice(0, maxItems);
    const thumbs = await Promise.all(limited.map(resolveThumb));

    const rows = [];
    for (let r = 0; r < limited.length; r += perRow) {
        const rowItems = limited.slice(r, r + perRow).map((post, j) => {
            const idx = r + j;
            const ext = (post.ext || '').toLowerCase();
            const thumb = thumbs[idx];
            const label = LABELED_EXTS.includes(ext) ? `${idx + 1} (${ext.toUpperCase()})` : String(idx + 1);
            return {
                column: [
                    thumb ? { image: thumb, fit: 'cover', variant: 'header' } : { text: `[${(post.ext || '?').toUpperCase()}]`, variant: 'caption' },
                    { text: label, variant: 'caption' }
                ],
                align: 'center'
            };
        });
        rows.push({ row: rowItems, justify: 'spaceBetween', align: 'start' });
    }
    return rows;
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

    const previewPerRow = 5;
    const caption = `- ${label}\n- *Page:* ${page}\n- *Showing:* ${posts.length}\n`;

    const widgetItems = [
        ...(await buildPreviewGrid(posts, previewPerRow)),
    ];

    const nativeFlow = [{ text: '\u0000', sections: [{ rows }] }, ...navFlow];

    await conn.sendButton(m.chat, {
        text: caption,
        footer: 'e621',
        widget: { align: 'center', items: widgetItems, fallback: "Can't load preview, try to use this command in private chat" },
        nativeFlow
    }, m);
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