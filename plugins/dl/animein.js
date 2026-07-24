import { GhostClient } from 'ghostfetch';
import { spawn } from 'child_process';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

const TMP_DIR = path.join(process.cwd(), process.env.TMP || 'data/tmp');
const ENGINE_BIN = process.cwd() + '/node_modules/ghostfetch/dist/bin/ghostengine';
const ENGINE_SOCK = '/tmp/ghostengine.sock';

let engineStarted = false;
async function ensureEngine() {
  if (engineStarted) return;
  if (!fs.existsSync(ENGINE_SOCK)) {
    spawn(ENGINE_BIN, ['-socket', ENGINE_SOCK], { detached: true, stdio: 'ignore' });
    await new Promise(r => setTimeout(r, 1000));
  }
  engineStarted = true;
}

const apiClient = axios.create({
  baseURL: 'https://animeinweb.com/api/proxy',
  timeout: 15000,
  headers: { 'x-proxy-secret': 'animein-secure-proxy-key-123', 'User-Agent': 'Mozilla/5.0' }
});

async function searchAnime(keyword, page = 0) {
  const { data } = await apiClient.get('/3/2/explore/movie', {
    params: { keyword, page: String(page), sort: 'views' }
  });
  return data?.data?.movie || data?.movie || [];
}

async function getDetail(animeId) {
  const { data } = await apiClient.get(`/3/2/movie/detail/${animeId}`);
  return data?.data;
}

async function getEpisodes(animeId) {
  const allEpisodes = [];
  let page = 0;
  while (true) {
    const { data } = await apiClient.get(`/3/2/movie/episode/${animeId}`, { params: { page } });
    const episodes = data?.data?.episode || [];
    allEpisodes.push(...episodes);
    if (episodes.length < 30) break;
    page++;
  }
  return allEpisodes;
}

async function getStream(episodeId) {
  const { data } = await apiClient.get(`/3/2/episode/streamnew/${episodeId}`);
  return data?.data || data;
}

async function getFileSize(url) {
  try {
    await ensureEngine();
    const client = new GhostClient({ profileId: 'Chrome_124' });
    const head = await client.fetch(url, {
      headers: { 'Referer': 'https://animeinweb.com/', 'Range': 'bytes=0-1' }
    });
    const contentRange = head.headers.get('content-range');
    return contentRange ? parseInt(contentRange.split('/')[1]) : null;
  } catch {
    return null;
  }
}

function formatSize(bytes) {
  if (!bytes) return '?';
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function downloadEpisode(url, outputPath) {
  await ensureEngine();
  const client = new GhostClient({ profileId: 'Chrome_124' });

  const head = await client.fetch(url, {
    headers: { 'Referer': 'https://animeinweb.com/', 'Range': 'bytes=0-1' }
  });
  const totalSize = parseInt(head.headers.get('content-range').split('/')[1]);

  const writeStream = fs.createWriteStream(outputPath);
  const CHUNK = 3 * 1024 * 1024;
  let downloaded = 0;

  while (downloaded < totalSize) {
    const end = Math.min(downloaded + CHUNK - 1, totalSize - 1);
    const res = await client.fetch(url, {
      headers: { 'Referer': 'https://animeinweb.com/', 'Range': `bytes=${downloaded}-${end}` }
    });

    const buffer = Buffer.from(await res.arrayBuffer());
    await new Promise((resolve, reject) => writeStream.write(buffer, e => e ? reject(e) : resolve()));
    buffer.fill(0);

    downloaded = end + 1;
    if (global.gc) global.gc();
  }

  await new Promise(resolve => writeStream.end(resolve));
  return totalSize;
}

function sendList(conn, m, caption, rows, buttonText = 'Select') {
  return conn.sendButton(m.chat, {
    document: { url: 'https://animeinweb.com/favicon.ico' },
    mimetype: 'image/png',
    fileName: 'ANIMEIN',
    caption,
    fileLength: '665666646645000',
    optionText: buttonText,
    optionTitle: buttonText,
    nativeFlow: [{ text: buttonText, sections: [{ rows }] }]
  }, m);
}

let handler = async (m, { conn, text, command }) => {
  if (!text) return m.reply(
    `*ANIMEIN*\n\nUsage: .${command} <title>\n\nExample:\n.${command} pokemon`
  );

  const [sub, ...args] = text.trim().split(' ');

  // ── INFO + EPISODE LIST WITH QUALITY ──
  if (sub === 'info') {
    const animeId = args[0];
    if (!animeId) return;
    await m.react('🔍');

    const [detail, episodes] = await Promise.all([
      getDetail(animeId),
      getEpisodes(animeId)
    ]);

    if (!detail?.movie) return m.reply('Anime not found.');

    const mv = detail.movie;
    const caption = `*${mv.title}*\n━━━━━━━━━━━━━━\n- Type: ${mv.type}\n- Year: ${mv.year}\n- Status: ${mv.status}\n- Studio: ${mv.studio || '-'}\n- Aired: ${mv.aired_start} ~ ${mv.aired_end || '?'}\n- Genre: ${mv.genre}\n- Views: ${mv.views} | Favorites: ${mv.favorites}\n━━━━━━━━━━━━━━\n${mv.synopsis?.slice(0, 400)}...\n\n${episodes.length} episode(s) available`;

    if (!episodes.length) return m.reply(caption);

    const qualityOrder = ['1080p', '720p', '480p', '360p'];
    const firstStream = await getStream(episodes[0].id);
    const directServers = firstStream?.server?.filter(s => s.type === 'direct') || [];
    const availableQualities = qualityOrder.filter(q => directServers.some(s => s.quality === q));

    const sizeByQuality = {};
    await Promise.all(
      directServers.map(async s => {
        if (!sizeByQuality[s.quality]) {
          sizeByQuality[s.quality] = await getFileSize(s.link);
        }
      })
    );

    if (!availableQualities.length) {
      const rows = episodes.map(ep => ({
        header: ep.title,
        title: ep.key_time,
        description: `Views: ${ep.views}`,
        id: `.${command} dl ${ep.id}`
      }));
      return sendList(conn, m, caption, rows, 'Select Episode');
    }

    const nativeFlow = availableQualities.map(q => ({
      text: q,
      sections: [{
        rows: episodes.map(ep => ({
          header: ep.title,
          title: ep.key_time,
          description: `Views: ${ep.views} • Size: ${formatSize(sizeByQuality[q])}`,
          id: `.${command} dl ${ep.id} ${q}`
        }))
      }]
    }));

    return conn.sendButton(m.chat, {
      document: { url: 'https://animeinweb.com/favicon.ico' },
      mimetype: 'image/png',
      fileName: 'ANIMEIN',
      caption,
      fileLength: '665666646645000',
      optionText: 'Select',
      optionTitle: 'Select',
      nativeFlow
    }, m);
  }

  // ── DOWNLOAD ──
  if (sub === 'dl') {
    const [episodeId, quality] = args;
    if (!episodeId) return;
    await m.react('⬇️');

    const stream = await getStream(episodeId);
    if (!stream?.server?.length) return m.reply('Server not found.');

    const direct = stream.server.filter(s => s.type === 'direct');
    if (!direct.length) return m.reply('No direct servers available.');

    const qualityOrder = ['1080p', '720p', '480p', '360p'];
    const target = quality
      ? direct.find(s => s.quality === quality) || direct.sort((a, b) => qualityOrder.indexOf(a.quality) - qualityOrder.indexOf(b.quality))[0]
      : direct.sort((a, b) => qualityOrder.indexOf(a.quality) - qualityOrder.indexOf(b.quality))[0];

    const ep = stream.episode;

    if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
    const tmpPath = path.join(TMP_DIR, `animein_${episodeId}_${Date.now()}.mp4`);

    try {
      const totalSize = await downloadEpisode(target.link, tmpPath);
      await m.react('✅');

      const fileBuffer = fs.readFileSync(tmpPath);
      await conn.sendMessage(m.chat, {
        document: fileBuffer,
        mimetype: 'video/mp4',
        fileName: `${ep.title} - ${target.quality}.mp4`,
        caption: `*${ep.title}* | ${target.quality} | ${target.name} | ${formatSize(totalSize)}`
      }, { quoted: m });

    } finally {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    }
    return;
  }

  // ── SEARCH (default) ──
  await m.react('🔍');
  const keyword = text.trim();

  const results = await searchAnime(keyword);
  if (!results.length) return m.reply('No results found.');

  const rows = results.map((a, i) => ({
    header: `${i + 1}. ${a.title}`,
    title: `${a.type} | ${a.status} | ${a.year}`,
    description: `Views: ${a.views} | Favorites: ${a.favorites} | ${a.genre}`,
    id: `.${command} info ${a.id}`
  }));

  return sendList(conn, m,
    `*${keyword}* - ${results.length} result(s)`,
    rows, 'Select Anime'
  );
};

handler.help = ['animein'];
handler.tags = ['internet'];
handler.command = ['animein'];
handler.limit = 1;
handler.ai = { risk: 'low', description: "search/download anime" }

export default handler;