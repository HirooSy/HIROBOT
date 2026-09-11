const e621 = global.scraper.e621.default
import { default as axios } from 'axios';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';

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

const ratingMap = { s: 'Safe', q: 'Questionable', e: 'Explicit' };

// For gif/webm/mp4 posts that have no previewUrl from e621's API, grab the
// first frame of the actual media as a fallback thumbnail. Only runs for
// the (usually few) items missing a preview - not for every post - so it
// doesn't slow the whole gallery down like resizing/downloading everything
// would.
async function extractFirstFramePreview(mediaUrl) {
    const outPath = path.join(getTmpDir(), `e621_frame_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    try {
        await execFileAsync(FFMPEG_PATH, ['-y', '-i', mediaUrl, '-vframes', '1', '-q:v', '4', outPath]);
        if (!fs.existsSync(outPath) || fs.statSync(outPath).size === 0) return null;
        const buf = fs.readFileSync(outPath);
        return `data:image/jpeg;base64,${buf.toString('base64')}`;
    } catch (err) {
        console.error('[e621] frame extract error:', err.message);
        return null;
    } finally {
        if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
    }
}

// Returns the raw previewUrl (or a base64 first-frame for gif/video posts
// missing one) - no downloading here, so the gallery renders immediately.
// The client tries these URLs through the proxy first; only items whose
// proxy fetch actually fails get downloaded as base64, one at a time, via
// fetchThumbBase64 below - not all 50 up front.
async function resolveThumbs(posts) {
    return Promise.all(posts.map(async (p) => {
        if (p.previewUrl) return p.previewUrl;
        // p.url is null when e621 doesn't expose a file URL for this post
        // (see mapPostData) - nothing to extract a frame from in that case.
        if (['gif', 'webm', 'mp4'].includes(p.ext) && p.url) {
            return await extractFirstFramePreview(p.url);
        }
        return '';
    }));
}

// Server-side fallback: download one thumbnail and hand it back as base64.
// Only called by the client for thumbnails whose proxied <img> failed after
// retrying - keeps the common case (proxy works) fast while still
// recovering from persistent per-item failures.
async function fetchThumbAsBase64(url) {
    // VPS-to-CDN connectivity has been intermittently slow (see the
    // /api/proxy-image retry logic for the same issue) - retry once more
    // here with a longer timeout, since this fallback only runs for the
    // handful of thumbnails that already failed the proxy twice.
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await axios.get(url, {
                responseType: 'arraybuffer',
                headers: e621.getHeaders ? e621.getHeaders() : undefined,
                timeout: 10000
            });
            const mime = url.toLowerCase().includes('.png') ? 'image/png' : 'image/jpeg';
            return `data:${mime};base64,${Buffer.from(res.data).toString('base64')}`;
        } catch (err) {
            lastErr = err;
        }
    }
    throw lastErr;
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
            text: `⚠️ Media file for this post isn't available (e621 didn't expose a direct file URL - it may be restricted or deleted).\n\n${caption}\n${post.pageUrl || ''}`
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

// ─── Gallery HTML builder ──────────────────────────────────────────────────
// 3-column grid, 50 posts/page. Every post here already has the exact same
// shape as a post fetched by URL (scraper's tagsSearch and getPost share one
// mapper), so the Download button can resend it directly - no re-fetch
// needed, same as the ".e621 <url>" flow.
function buildGalleryHtml(posts, keywords, page, hasNext, token, pageToken, thumbToken, apiBase, thumbs) {
    const httpsApiBase = apiBase ? apiBase.replace(/^http:\/\//, 'https://') : '';
    // Route thumbnails through the bot's own image proxy - the WebView can
    // fetch from the bot's trusted origin fine, it's the direct e621 CDN
    // request that gets blocked. Data-URIs (from the gif/video first-frame
    // fallback) are left as-is since those aren't external URLs at all.
    const proxify = (url) => {
        if (!url) return '';
        if (url.startsWith('data:')) return url;
        return httpsApiBase ? `${httpsApiBase}/api/proxy-image?url=${encodeURIComponent(url)}` : url;
    };
    const cards = posts.map((p, i) => ({
        thumb: proxify((thumbs && thumbs[i]) || ''),
        rawThumb: (thumbs && thumbs[i]) || '',
        id: p.id,
        fav: p.favCount,
        rating: ratingMap[p.rating] || p.rating || '?',
        type: (p.ext || '').toString(),
        idx: i
    }));

    return `<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
body{margin:0;background:transparent;font-family:Arial,sans-serif;color:#fff}
.wrap{width:100%;max-width:680px;margin:auto;padding:12px}
.card-outer{background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.14);border-radius:16px;overflow:hidden;box-shadow:0 10px 35px rgba(0,0,0,.35)}
.head{padding:12px 16px;border-bottom:1px solid rgba(255,255,255,.1);display:flex;align-items:center;justify-content:space-between}
.head small{display:block;font-size:10px;letter-spacing:2px;color:#888}
.head b{font-size:16px}
.pagebadge{font-size:11px;color:#999;background:rgba(255,255,255,.08);padding:4px 10px;border-radius:12px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;padding:10px}
.item{background:rgba(255,255,255,.05);border-radius:10px;overflow:hidden;display:flex;flex-direction:column}
.thumbWrap{position:relative;width:100%;aspect-ratio:3/4;background:#000}
.thumbWrap img{width:100%;height:100%;object-fit:cover;display:block;background:#000}
.thumbSpinner{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:20px;height:20px;border:2px solid rgba(255,255,255,.2);border-top-color:#fff;border-radius:50%;animation:spin .8s linear infinite}
@keyframes spin{to{transform:translate(-50%,-50%) rotate(360deg)}}
.typeTag{position:absolute;top:4px;right:4px;font-size:9px;background:rgba(0,0,0,.6);padding:2px 5px;border-radius:6px;letter-spacing:.5px}
.meta{padding:6px 6px 4px;font-size:10px;line-height:1.5;color:#ccc}
.meta .id{color:#fff;font-weight:700;font-size:10.5px}
.dlbtn{margin:0 6px 6px;border:none;border-radius:14px;background:#00a884;color:#fff;font-size:10.5px;font-weight:600;padding:6px 0;cursor:pointer}
.dlbtn:disabled{opacity:.55}
.nav{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;border-top:1px solid rgba(255,255,255,.1)}
.navbtn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.2);color:#fff;font-size:12px;padding:8px 14px;border-radius:18px;cursor:pointer}
.navbtn:disabled{opacity:.35;cursor:default}
.pageinfo{font-size:12px;color:#999}
</style>
<div class="wrap">
  <div class="card-outer">
    <div class="head">
      <div><small>e621 SEARCH</small><b>${keywords.replace(/[<>&]/g, '')}</b></div>
      <div class="pagebadge">Page ${page}</div>
    </div>
    <div class="grid" id="grid"></div>
    <div class="nav">
      <button class="navbtn" id="prevBtn" ${page > 1 ? '' : 'disabled'}>&lsaquo; Previous</button>
      <span class="pageinfo" id="pageinfo">Page ${page}</span>
      <button class="navbtn" id="nextBtn" ${hasNext ? '' : 'disabled'}>Next &rsaquo;</button>
    </div>
  </div>
</div>
<script>
let cards = ${JSON.stringify(cards)};
const token = ${JSON.stringify(token || '')};
const pageToken = ${JSON.stringify(pageToken || '')};
const thumbToken = ${JSON.stringify(thumbToken || '')};
const apiBase = ${JSON.stringify(httpsApiBase)};
const keywords = ${JSON.stringify(keywords)};
let page = ${page};
let hasNext = ${hasNext ? 'true' : 'false'};

function proxifyClient(url) {
  if (!url) return '';
  if (url.startsWith('data:')) return url;
  return apiBase ? apiBase + '/api/proxy-image?url=' + encodeURIComponent(url) : url;
}

const grid = document.getElementById('grid');
function render() {
  try {
    grid.innerHTML = '';
    cards.forEach(c => {
      const item = document.createElement('div');
      item.className = 'item';

      const thumbWrap = document.createElement('div');
      thumbWrap.className = 'thumbWrap';
      if (c.thumb) {
        const spinner = document.createElement('div');
        spinner.className = 'thumbSpinner';
        thumbWrap.appendChild(spinner);

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.style.visibility = 'hidden';
        let retried = false;
        img.addEventListener('load', () => {
          spinner.remove();
          img.style.visibility = 'visible';
        });
        img.addEventListener('error', async () => {
          if (!retried) {
            // One retry with a cache-busting param, in case the first
            // failure was a transient proxy/network blip.
            retried = true;
            setTimeout(() => {
              img.src = c.thumb + (c.thumb.includes('?') ? '&' : '?') + '_r=' + Date.now();
            }, 800);
            return;
          }
          // Proxy still failing after a retry - fall back to asking the
          // server to download this one thumbnail and hand it back as
          // base64. Only happens for the (hopefully rare) persistent
          // failures, not for every item up front.
          if (thumbToken && c.rawThumb && !c.rawThumb.startsWith('data:')) {
            const result = await sendAction({ type: 'aiRichAction', token: thumbToken, url: c.rawThumb });
            if (result.success && result.dataUri) {
              img.src = result.dataUri;
              return;
            }
          }
          spinner.remove();
          img.replaceWith(Object.assign(document.createElement('div'), {
            style: 'font-size:8px;color:#f88;padding:4px;word-break:break-all;line-height:1.3',
            textContent: 'IMG FAIL: ' + c.thumb.slice(0, 60)
          }));
        });
        img.src = c.thumb;
        thumbWrap.appendChild(img);
      } else {
        const noThumb = document.createElement('div');
        noThumb.style.cssText = 'font-size:8px;color:#888;padding:4px;text-align:center';
        noThumb.textContent = 'no preview url';
        thumbWrap.appendChild(noThumb);
      }
      const typeTag = document.createElement('div');
      typeTag.className = 'typeTag';
      typeTag.textContent = c.type ? c.type.toUpperCase() : '?';
      thumbWrap.appendChild(typeTag);

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<div class="id">#' + c.id + '</div>' + c.fav + ' fav \u2022 ' + c.rating;

      const btn = document.createElement('button');
      btn.className = 'dlbtn';
      btn.dataset.idx = c.idx;
      btn.textContent = 'Download';
      btn.addEventListener('click', () => onDownload(btn));

      item.appendChild(thumbWrap);
      item.appendChild(meta);
      item.appendChild(btn);
      grid.appendChild(item);
    });
  } catch (err) {
    grid.innerHTML = '<div style="grid-column:1/-1;color:#f66;font-size:11px;padding:10px">Render error: ' + (err && err.message ? err.message : String(err)) + '</div>';
  }
}

let ws = null, wsReady = false, pingTimer = null;
const pending = new Map();

function connectWs() {
  if (!apiBase) return;
  const wsUrl = apiBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  try { ws = new WebSocket(wsUrl); } catch (e) { wsReady = false; return; }

  ws.onopen = () => {
    wsReady = true;
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'ping' }));
    }, 10000);
  };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'aiRichActionResult' && pending.has(msg.requestId)) {
      pending.get(msg.requestId)(msg);
      pending.delete(msg.requestId);
    }
  };
  ws.onclose = () => {
    wsReady = false;
    if (pingTimer) clearInterval(pingTimer);
    setTimeout(connectWs, 1500);
  };
  ws.onerror = () => { wsReady = false; };
}
connectWs();

function sendAction(payload, timeoutMs = 15000) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState !== 1) return resolve({ success: false, message: 'Not connected' });
    const requestId = Math.random().toString(36).slice(2);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve({ success: false, message: 'Timed out' });
    }, timeoutMs);
    pending.set(requestId, (msg) => { clearTimeout(timer); resolve(msg); });
    ws.send(JSON.stringify({ ...payload, requestId }));
  });
}

render();

async function onDownload(btn) {
  if (!token) { btn.textContent = 'Unavailable'; return; }
  const idx = parseInt(btn.dataset.idx);
  btn.disabled = true;
  btn.textContent = 'Sending...';
  const result = await sendAction({ type: 'aiRichAction', token, index: idx });
  btn.textContent = result.success ? 'Sent!' : ('Failed: ' + (result.message || 'unknown'));
  setTimeout(() => { btn.disabled = false; btn.textContent = 'Download'; }, 3000);
}

const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const pageBadge = document.querySelector('.pagebadge');
const pageinfo = document.getElementById('pageinfo');

function setNavLoading(loading) {
  prevBtn.disabled = loading || page <= 1;
  nextBtn.disabled = loading || !hasNext;
  if (loading) pageinfo.textContent = 'Loading...';
}

async function goToPage(targetPage) {
  if (targetPage < 1) return;
  if (!pageToken) { pageinfo.textContent = 'Unavailable'; return; }
  setNavLoading(true);
  const result = await sendAction({ type: 'aiRichAction', token: pageToken, page: targetPage });
  if (!result.success || !Array.isArray(result.posts)) {
    pageinfo.textContent = result.message || 'Failed to load page';
    setTimeout(() => { pageinfo.textContent = 'Page ' + page; setNavLoading(false); }, 2000);
    return;
  }
  page = result.page || targetPage;
  hasNext = !!result.hasNext;
  cards = result.posts.map((p, i) => ({
    thumb: proxifyClient((result.thumbs && result.thumbs[i]) || ''),
    rawThumb: (result.thumbs && result.thumbs[i]) || '',
    id: p.id,
    fav: p.favCount,
    rating: (${JSON.stringify(ratingMap)})[p.rating] || p.rating || '?',
    type: (p.ext || '').toString(),
    idx: i
  }));
  pageBadge.textContent = 'Page ' + page;
  pageinfo.textContent = 'Page ' + page;
  render();
  setNavLoading(false);
}

prevBtn.addEventListener('click', () => goToPage(page - 1));
nextBtn.addEventListener('click', () => goToPage(page + 1));
</script>`;
}

let handler = async (m, { conn, text }) => {
    if (!text) return m.reply(`How to use:\n.e621 <keywords>\n.e621 <url>`);

    try {
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

        const results = await e621.tagsSearch(keywords, page, 50);
        if (!results || results.length === 0) return m.reply(`No results found${page > 1 ? ` on page ${page}` : ''}.`);

        const posts = results.slice(0, 50);
        const hasNext = results.length >= 50;
        const thumbs = await resolveThumbs(posts);

        const rich = conn.aiRich()
            .setTitle('e621 Search')
            .addSuggest([
                `Query: ${keywords}`,
                `Page: ${page}`,
                `Showing: ${posts.length}`
            ]);

        // Shared mutable state between the two closures below, so that a
        // Download click *after* paging sends from whatever page is
        // currently shown, not the page the gallery originally opened on.
        const state = { posts, page };

        const token = global.registerHtmlAction({
            chatId: m.chat,
            singleUse: false,
            run: async (conn, chatId, args) => {
                const idx = Number(args?.index) || 0;
                const post = state.posts[idx];
                if (!post) throw new Error('Post not found.');
                await sende621Post(conn, chatId, post, null);
                return { message: 'Sent to chat.' };
            }
        });
        const pageToken = global.registerHtmlAction({
            chatId: m.chat,
            singleUse: false,
            run: async (conn, chatId, args) => {
                const requestedPage = Math.max(1, Number(args?.page) || 1);
                const results = await e621.tagsSearch(keywords, requestedPage, 50);
                if (!results || !results.length) {
                    throw new Error(`No results on page ${requestedPage}.`);
                }
                const newPosts = results.slice(0, 50);
                const newHasNext = results.length >= 50;
                const newThumbs = await resolveThumbs(newPosts);
                state.posts = newPosts;
                state.page = requestedPage;
                return { posts: newPosts, page: requestedPage, hasNext: newHasNext, thumbs: newThumbs };
            }
        });
        const thumbToken = global.registerHtmlAction({
            chatId: m.chat,
            singleUse: false,
            run: async (conn, chatId, args) => {
                const url = args?.url;
                if (!url || typeof url !== 'string') throw new Error('Missing url.');
                const dataUri = await fetchThumbAsBase64(url);
                return { dataUri };
            }
        });
        const rawServer = typeof global.opts?.server === 'string' ? global.opts.server : '';
        const apiBase = rawServer.replace(/\/$/, '');
        const apiHost = apiBase.replace(/^https?:\/\//, '');
        // Thumbnails are loaded through the bot's own /api/proxy-image
        // endpoint (server fetches e621's CDN, WebView fetches the bot's
        // own origin) - so only the bot's own host needs to be trusted,
        // both for the proxied images and the WebSocket bridge.
        const trustedSources = apiHost ? [apiHost] : [];
        rich.addHtml(buildGalleryHtml(posts, keywords, page, hasNext, token, pageToken, thumbToken, apiBase, thumbs), { trustedSources });

        await rich.send(m.chat, { quoted: m });

    } catch (e) {
        m.error = e;
        console.error('[e621] Handler error:', e);
        await m.reply(`⚠️ Error: ${e.message}`);
    }
};

handler.help = handler.command = ['e621'];
handler.tags = ["downloader"]
handler.limit = 1;
handler.ai = { risk: "low", description: "search e621 posts using keywords, download post using post id" }

export default handler;
