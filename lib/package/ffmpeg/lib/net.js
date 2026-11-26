import fs from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { badArg, badData, noSupport } from './errors.js';

const defaultAgent = 'Lavf/60.16.100';

function parseHeaders(text) {
  const out = {};
  if (!text) return out;
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function requestHeaders(net, extra) {
  const h = { 'user-agent': net.userAgent || defaultAgent };
  for (const src of [net.headers || {}, extra || {}]) for (const [k, v] of Object.entries(src)) h[k.toLowerCase()] = v;
  if (net.referer && !h.referer) h.referer = net.referer;
  return h;
}

async function open(url, net, extra) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: requestHeaders(net, extra), redirect: 'follow', signal: AbortSignal.timeout(net.timeoutMs || 600000) });
      if (res.status === 429 || res.status >= 500) throw badData('http ' + res.status + ' for ' + url);
      if (!res.ok) {
        const err = badData('http ' + res.status + ' for ' + url);
        err.status = res.status;
        throw err;
      }
      return res;
    } catch (e) {
      last = e;
      if (e.status && e.status < 500 && e.status !== 429) break;
      await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
    }
  }
  throw last;
}

class Temps {
  constructor() {
    this.files = [];
  }

  create(ext) {
    const file = pathMod.join(os.tmpdir(), 'ffn_' + crypto.randomBytes(6).toString('hex') + ext);
    this.files.push(file);
    return file;
  }

  async cleanup() {
    for (const f of this.files) {
      try {
        await fs.promises.unlink(f);
      } catch (ignored) {
        f.length;
      }
    }
    this.files = [];
  }
}

function attrs(text) {
  const out = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(text))) out[m[1]] = m[2].replace(/^"|"$/g, '');
  return out;
}

function parseMedia(text) {
  const lines = text.split(/\r?\n/);
  const seg = [];
  let key = null;
  let map = null;
  let seq = 0;
  let extinf = false;
  let range = null;
  let lastEnd = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) seq = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-KEY:')) {
      const a = attrs(line.slice(11));
      if (a.METHOD === 'NONE') key = null;
      else if (a.METHOD === 'AES-128') key = { uri: a.URI, iv: a.IV || null };
      else throw noSupport('hls: unsupported encryption ' + a.METHOD);
    } else if (line.startsWith('#EXT-X-MAP:')) {
      const a = attrs(line.slice(11));
      map = { uri: a.URI, range: a.BYTERANGE || null, key };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      const [n, o] = line.slice(17).split('@');
      const len = Number(n);
      const off = o === undefined ? lastEnd : Number(o);
      range = { off, len };
      lastEnd = off + len;
    } else if (line.startsWith('#EXTINF:')) extinf = true;
    else if (!line.startsWith('#') && extinf) {
      seg.push({ uri: line, key, range, seq: seq + seg.length });
      extinf = false;
      range = null;
    }
  }
  return { segments: seg, map };
}

function parseMaster(text, base) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const media = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(lines[i].slice(18));
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j < lines.length) variants.push({ bandwidth: Number(a.BANDWIDTH) || 0, avg: Number(a['AVERAGE-BANDWIDTH']) || 0, resolution: a.RESOLUTION || '', audio: a.AUDIO || null, codecs: a.CODECS || '', uri: new URL(lines[j], base).href });
    } else if (lines[i].startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(lines[i].slice(13));
      if (a.TYPE === 'AUDIO') media.push({ group: a['GROUP-ID'], uri: a.URI ? new URL(a.URI, base).href : null, def: a.DEFAULT === 'YES', auto: a.AUTOSELECT === 'YES' });
    }
  }
  return { variants, media };
}

function pixels(res) {
  const m = /^(\d+)x(\d+)$/.exec(res);
  return m ? Number(m[1]) * Number(m[2]) : 0;
}

async function readText(url, net) {
  if (/^https?:\/\//i.test(url)) return (await open(url, net)).text();
  return fs.promises.readFile(url, 'utf8');
}

function resolveRef(base, ref) {
  if (/^https?:\/\//i.test(base)) return new URL(ref, base).href;
  if (/^https?:\/\//i.test(ref)) return ref;
  return pathMod.resolve(pathMod.dirname(base), ref);
}

async function fetchBytes(ref, range, net) {
  if (/^https?:\/\//i.test(ref)) {
    const extra = range ? { Range: 'bytes=' + range.off + '-' + (range.off + range.len - 1) } : undefined;
    const res = await open(ref, net, extra);
    const buf = Buffer.from(await res.arrayBuffer());
    if (range && res.status === 200 && buf.length > range.len) return buf.subarray(range.off, range.off + range.len);
    return buf;
  }
  const buf = await fs.promises.readFile(ref);
  return range ? buf.subarray(range.off, range.off + range.len) : buf;
}

async function keyBytes(uri, base, net, cache) {
  const ref = resolveRef(base, uri);
  if (!cache.has(ref)) cache.set(ref, await fetchBytes(ref, null, net));
  const k = cache.get(ref);
  if (k.length !== 16) throw badData('hls: invalid key length');
  return k;
}

function decrypt(buf, key, iv) {
  const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
  return Buffer.concat([d.update(buf), d.final()]);
}

function ivFor(seg) {
  if (seg.key.iv) {
    const hex = seg.key.iv.replace(/^0x/i, '').padStart(32, '0');
    return Buffer.from(hex, 'hex');
  }
  const iv = Buffer.alloc(16);
  iv.writeUInt32BE(Math.floor(seg.seq / 4294967296) >>> 0, 8);
  iv.writeUInt32BE(seg.seq >>> 0, 12);
  return iv;
}

async function downloadPlaylist(playlistRef, text, net, temps) {
  const { segments, map } = parseMedia(text);
  if (!segments.length) throw badData('hls: playlist has no segments');
  const ext = map || /\.(m4s|mp4|cmfv|cmfa)(\?|$)/i.test(segments[0].uri) ? '.mp4' : '.ts';
  const out = temps.create(ext);
  const handle = await fs.promises.open(out, 'w');
  const cache = new Map();
  const fetchSeg = async (s) => {
    let buf = await fetchBytes(resolveRef(playlistRef, s.uri), s.range, net);
    if (s.key) buf = decrypt(buf, await keyBytes(s.key.uri, playlistRef, net, cache), ivFor(s));
    return buf;
  };
  try {
    if (map) {
      let range = null;
      if (map.range) {
        const [n, o] = map.range.split('@');
        range = { off: Number(o || 0), len: Number(n) };
      }
      let buf = await fetchBytes(resolveRef(playlistRef, map.uri), range, net);
      if (map.key) buf = decrypt(buf, await keyBytes(map.key.uri, playlistRef, net, cache), ivFor({ key: map.key, seq: 0 }));
      await handle.write(buf);
    }
    const window = 4;
    const tasks = [];
    let next = 0;
    for (let i = 0; i < segments.length; i++) {
      while (next < segments.length && next - i < window) tasks[next] = fetchSeg(segments[next++]);
      const buf = await tasks[i];
      tasks[i] = null;
      await handle.write(buf);
    }
  } finally {
    await handle.close();
  }
  return out;
}

async function resolveHls(ref, text, net, temps) {
  if (text.includes('#EXT-X-STREAM-INF')) {
    const { variants, media } = parseMaster(text, /^https?:\/\//i.test(ref) ? ref : pathMod.resolve(ref));
    if (!variants.length) throw badData('hls: master playlist has no variants');
    const best = variants.slice().sort((a, b) => b.bandwidth - a.bandwidth || pixels(b.resolution) - pixels(a.resolution))[0];
    const files = [await resolveHls(best.uri, await readText(best.uri, net), net, temps)].flat();
    if (best.audio) {
      const group = media.filter((m) => m.group === best.audio && m.uri);
      const pick = group.find((m) => m.def) || group.find((m) => m.auto) || group[0];
      if (pick && pick.uri !== best.uri) files.push(...[await resolveHls(pick.uri, await readText(pick.uri, net), net, temps)].flat());
    }
    return files;
  }
  return [await downloadPlaylist(ref, text, net, temps)];
}

async function resolveInput(src, net, temps) {
  if (Buffer.isBuffer(src) || src instanceof Uint8Array) return [src];
  if (typeof src !== 'string') throw badArg('invalid input');
  let ref = src;
  if (/^file:\/\//i.test(ref)) ref = fileURLToPath(ref);
  if (/^https?:\/\//i.test(ref)) {
    const res = await open(ref, net);
    const type = (res.headers.get('content-type') || '').toLowerCase();
    const pathname = new URL(ref).pathname.toLowerCase();
    if (pathname.endsWith('.m3u8') || type.includes('mpegurl')) return resolveHls(ref, await res.text(), net, temps);
    const ext = pathMod.extname(pathname).slice(0, 8) || '.bin';
    const file = temps.create(ext);
    if (!res.body) throw badData('http: empty body');
    await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(file));
    const head = Buffer.alloc(8);
    const fh = await fs.promises.open(file, 'r');
    await fh.read(head, 0, 8, 0);
    await fh.close();
    if (head.toString('latin1', 0, 7) === '#EXTM3U') {
      const text = await fs.promises.readFile(file, 'utf8');
      return resolveHls(ref, text, net, temps);
    }
    return [file];
  }
  if (/\.m3u8$/i.test(ref) && fs.existsSync(ref)) return resolveHls(ref, await fs.promises.readFile(ref, 'utf8'), net, temps);
  return [ref];
}

export { parseHeaders, resolveInput, Temps, defaultAgent };
