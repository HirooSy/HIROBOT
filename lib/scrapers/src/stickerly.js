import { fileURLToPath } from 'node:url';
import path from 'node:path';

const API_BASE = 'https://api.sticker.ly/v3.1';
const USER_AGENT = 'androidapp.stickerly/1.13.3 (G011A; U; Android 22; pt-BR; br;)';

const DEFAULT_HEADERS = {
  'User-Agent': USER_AGENT,
  'Content-Type': 'application/json',
  'Host': 'api.sticker.ly',
  'Accept': '*/*'
};

export async function searchStickerly(query, options = {}) {
  const keyword = typeof query === 'string' ? query.trim() : '';

  if (!keyword) {
    throw new Error('Search query must not be empty.');
  }

  const cursor = typeof options.cursor === 'number' ? options.cursor : 0;
  const limit = typeof options.limit === 'number' && options.limit > 0 ? options.limit : null;

  const response = await fetch(`${API_BASE}/stickerPack/search`, {
    method: 'POST',
    headers: DEFAULT_HEADERS,
    body: JSON.stringify({
      keyword,
      cursor
    })
  });

  if (!response.ok) {
    throw new Error(`Sticker.ly API HTTP error! Status: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data?.error && data.error.errorCode !== '0') {
    throw new Error(`API Error: ${data.error.errorMessage || data.error.errorCode}`);
  }

  let packs = data?.result?.stickerPacks || [];

  if (limit) {
    packs = packs.slice(0, limit);
  }

  const formattedPacks = packs.map((pack) => {
    const prefix = pack.resourceUrlPrefix || '';
    const files = Array.isArray(pack.resourceFiles) ? pack.resourceFiles : [];
    const trayIdx = typeof pack.trayIndex === 'number' && pack.trayIndex >= 0 && pack.trayIndex < files.length
      ? pack.trayIndex
      : 0;

    const trayImage = files.length > 0 ? `${prefix}${files[trayIdx]}` : null;
    const stickers = files.map((fileName) => `${prefix}${fileName}`);

    return {
      id: pack.packId,
      name: pack.name,
      author: {
        name: pack.authorName || pack.user?.userName || null,
        username: pack.user?.userName || null,
        profileUrl: pack.user?.profileUrl || null,
        isOfficial: Boolean(pack.isOfficial || pack.user?.isOfficial)
      },
      shareUrl: pack.shareUrl || `https://sticker.ly/s/${pack.packId}`,
      isAnimated: Boolean(pack.isAnimated || pack.animated),
      viewCount: pack.viewCount || 0,
      exportCount: pack.exportCount || 0,
      trayImage,
      zipUrl: pack.resourceZip ? `${prefix}${pack.resourceZip}` : null,
      stickersCount: files.length,
      stickers
    };
  });

  return {
    status: true,
    query: keyword,
    total: formattedPacks.length,
    result: formattedPacks
  };
}

export async function getStickerPack(packId) {
  const cleanId = String(packId).trim().toUpperCase();
  if (!cleanId) {
    throw new Error('Pack ID must not be empty.');
  }

  const response = await fetch(`${API_BASE}/stickerPack/${cleanId}`, {
    method: 'GET',
    headers: DEFAULT_HEADERS
  });

  if (!response.ok) {
    throw new Error(`Sticker.ly API HTTP error! Status: ${response.status}`);
  }

  const data = await response.json();

  if (data?.error && data.error.errorCode !== '0') {
    throw new Error(`API Error: ${data.error.errorMessage || data.error.errorCode}`);
  }

  const res = data.result;
  const prefix = res.resourceUrlPrefix || '';
  const stickers = (res.stickers || []).map((s) => ({
    sid: s.sid,
    url: `${prefix}${s.fileName}`,
    isAnimated: Boolean(s.isAnimated || s.animated)
  }));

  return {
    status: true,
    pack: {
      id: res.packId,
      name: res.name,
      author: res.authorName,
      shareUrl: res.shareUrl || `https://sticker.ly/s/${res.packId}`,
      isAnimated: Boolean(res.isAnimated || res.animated),
      viewCount: res.viewCount || 0,
      exportCount: res.exportCount || 0,
      trayImage: res.thumb ? `${prefix}${res.thumb}` : null,
      zipUrl: res.resourceZip ? `${prefix}${res.resourceZip}` : null,
      stickersCount: stickers.length,
      stickers
    }
  };
}

const isDirectCall = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectCall) {
  const args = process.argv.slice(2);

  let limit = null;
  const filteredArgs = [];
  for (let i = 0; i < args.length; i++) {
    if ((args[i] === '--limit' || args[i] === '-l') && args[i + 1]) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i].startsWith('--limit=')) {
      limit = parseInt(args[i].split('=')[1], 10);
    } else {
      filteredArgs.push(args[i]);
    }
  }

  const query = filteredArgs.join(' ').trim();

  if (!query) {
    console.error(JSON.stringify({
      status: false,
      message: 'Please enter a search query. Example: node stickerly.js patrick'
    }, null, 2));
    process.exit(1);
  }

  try {
    const data = await searchStickerly(query, { limit });
    console.log(JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(JSON.stringify({
      status: false,
      error: err.message
    }, null, 2));
    process.exit(1);
  }
}