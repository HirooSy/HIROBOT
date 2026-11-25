const vorbisMap = {
  title: 'TITLE',
  artist: 'ARTIST',
  album: 'ALBUM',
  album_artist: 'ALBUMARTIST',
  date: 'DATE',
  genre: 'GENRE',
  comment: 'COMMENT',
  composer: 'COMPOSER',
  track: 'TRACKNUMBER',
  disc: 'DISCNUMBER',
  copyright: 'COPYRIGHT',
  encoder: 'ENCODER',
};


const riffMap = {
  title: 'INAM',
  artist: 'IART',
  album: 'IPRD',
  date: 'ICRD',
  genre: 'IGNR',
  comment: 'ICMT',
  copyright: 'ICOP',
  encoder: 'ISFT',
  track: 'ITRK',
};

const id3Map = {
  title: 'TIT2',
  artist: 'TPE1',
  album: 'TALB',
  album_artist: 'TPE2',
  date: 'TDRC',
  genre: 'TCON',
  composer: 'TCOM',
  track: 'TRCK',
  disc: 'TPOS',
  copyright: 'TCOP',
  encoder: 'TSSE',
};

const mp4Map = {
  title: '\xa9nam',
  artist: '\xa9ART',
  album: '\xa9alb',
  album_artist: 'aART',
  date: '\xa9day',
  genre: '\xa9gen',
  comment: '\xa9cmt',
  composer: '\xa9wrt',
  encoder: '\xa9too',
  copyright: 'cprt',
};

function invert(map) {
  const out = {};
  for (const k of Object.keys(map)) out[map[k]] = k;
  return out;
}

function clean(tags) {
  const out = {};
  if (!tags) return out;
  for (const key of Object.keys(tags)) {
    const value = tags[key];
    if (value === undefined || value === null || value === '') continue;
    out[key.toLowerCase()] = String(value);
  }
  return out;
}

function parseVorbisComment(buf, start = 0) {
  const tags = {};
  let p = start;
  const vendorLen = buf.readUInt32LE(p);
  p += 4 + vendorLen;
  const count = buf.readUInt32LE(p);
  p += 4;
  for (let i = 0; i < count && p + 4 <= buf.length; i++) {
    const len = buf.readUInt32LE(p);
    p += 4;
    if (p + len > buf.length) break;
    const text = buf.toString('utf8', p, p + len);
    p += len;
    const eq = text.indexOf('=');
    if (eq < 1) continue;
    const name = text.slice(0, eq).toUpperCase();
    const key = invert(vorbisMap)[name] || { DESCRIPTION: 'comment', YEAR: 'date', ALBUM_ARTIST: 'album_artist', TRACK: 'track' }[name];
    if (key && !(key in tags)) tags[key] = text.slice(eq + 1);
  }
  return tags;
}

function buildVorbisComment(tags, vendor = 'ffnode') {
  const items = [];
  for (const key of Object.keys(tags)) {
    const name = vorbisMap[key] || key.toUpperCase();
    items.push(Buffer.from(name + '=' + tags[key], 'utf8'));
  }
  const vendorBuf = Buffer.from(vendor, 'utf8');
  let size = 8 + vendorBuf.length;
  for (const it of items) size += 4 + it.length;
  const out = Buffer.alloc(size);
  let p = 0;
  out.writeUInt32LE(vendorBuf.length, p);
  p += 4;
  vendorBuf.copy(out, p);
  p += vendorBuf.length;
  out.writeUInt32LE(items.length, p);
  p += 4;
  for (const it of items) {
    out.writeUInt32LE(it.length, p);
    p += 4;
    it.copy(out, p);
    p += it.length;
  }
  return out;
}

function parseRiffInfo(buf) {
  const tags = {};
  const reverse = invert(riffMap);
  let p = 0;
  while (p + 8 <= buf.length) {
    const id = buf.toString('latin1', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    p += 8;
    if (p + size > buf.length) break;
    const key = reverse[id];
    if (key) tags[key] = buf.toString('utf8', p, p + size).replace(/\0+$/, '');
    p += size + (size & 1);
  }
  return tags;
}

function buildRiffInfo(tags) {
  const parts = [Buffer.from('INFO', 'latin1')];
  for (const key of Object.keys(tags)) {
    const id = riffMap[key];
    if (!id) continue;
    const text = Buffer.concat([Buffer.from(tags[key], 'utf8'), Buffer.from([0])]);
    const head = Buffer.alloc(8);
    head.write(id, 0, 'latin1');
    head.writeUInt32LE(text.length, 4);
    parts.push(head, text);
    if (text.length & 1) parts.push(Buffer.from([0]));
  }
  if (parts.length === 1) return null;
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('LIST', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

function syncsafe(buf, off) {
  return ((buf[off] & 0x7f) << 21) | ((buf[off + 1] & 0x7f) << 14) | ((buf[off + 2] & 0x7f) << 7) | (buf[off + 3] & 0x7f);
}

function decodeId3Text(enc, buf) {
  let text;
  if (enc === 0) text = buf.toString('latin1');
  else if (enc === 3) text = buf.toString('utf8');
  else if (enc === 2) {
    const swapped = Buffer.from(buf);
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    if (swapped.length & 1) return '';
    swapped.swap16();
    text = swapped.toString('utf16le');
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) text = buf.toString('utf16le', 2);
  else text = buf.toString('utf16le');
  return text.replace(/\0+$/, '').replace(/\0/g, '/');
}

function id3Size(head) {
  if (head.length < 10 || head.toString('latin1', 0, 3) !== 'ID3') return 0;
  return 10 + syncsafe(head, 6) + (head[5] & 0x10 ? 10 : 0);
}

function parseId3(buf) {
  const tags = {};
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return tags;
  const version = buf[3];
  const flags = buf[5];
  const total = Math.min(buf.length, 10 + syncsafe(buf, 6));
  let p = 10;
  if (flags & 0x40) {
    const ext = version === 4 ? syncsafe(buf, p) : buf.readUInt32BE(p) + 4;
    p += ext;
  }
  if (version < 3) return tags;
  const reverse = invert(id3Map);
  reverse.TYER = 'date';
  while (p + 10 <= total) {
    const id = buf.toString('latin1', p, p + 4);
    if (id.charCodeAt(0) === 0) break;
    const size = version === 4 ? syncsafe(buf, p + 4) : buf.readUInt32BE(p + 4);
    p += 10;
    if (size <= 0 || p + size > total) break;
    const body = buf.subarray(p, p + size);
    p += size;
    if (id === 'COMM' && body.length > 4) {
      const enc = body[0];
      const wide = enc === 1 || enc === 2;
      let q = 4;
      while (q < body.length && !(body[q] === 0 && (!wide || body[q + 1] === 0))) q += wide ? 2 : 1;
      q += wide ? 2 : 1;
      if (!tags.comment) tags.comment = decodeId3Text(enc, body.subarray(q));
      continue;
    }
    const key = reverse[id];
    if (key && body.length > 1 && !(key in tags)) tags[key] = decodeId3Text(body[0], body.subarray(1));
  }
  return tags;
}

function buildId3(tags) {
  const frames = [];
  const add = (id, payload) => {
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    const size = payload.length;
    head[4] = (size >>> 21) & 0x7f;
    head[5] = (size >>> 14) & 0x7f;
    head[6] = (size >>> 7) & 0x7f;
    head[7] = size & 0x7f;
    frames.push(head, payload);
  };
  for (const key of Object.keys(tags)) {
    if (key === 'comment') {
      add('COMM', Buffer.concat([Buffer.from([3, 0x65, 0x6e, 0x67, 0]), Buffer.from(tags[key], 'utf8')]));
    } else if (id3Map[key]) {
      add(id3Map[key], Buffer.concat([Buffer.from([3]), Buffer.from(tags[key], 'utf8')]));
    }
  }
  if (!frames.length) return null;
  const body = Buffer.concat(frames);
  const head = Buffer.alloc(10);
  head.write('ID3', 0, 'latin1');
  head[3] = 4;
  head[6] = (body.length >>> 21) & 0x7f;
  head[7] = (body.length >>> 14) & 0x7f;
  head[8] = (body.length >>> 7) & 0x7f;
  head[9] = body.length & 0x7f;
  return Buffer.concat([head, body]);
}

function box(type, payload) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(8 + payload.length, 0);
  head.write(type, 4, 'latin1');
  return Buffer.concat([head, payload]);
}

function buildMp4Meta(tags) {
  const items = [];
  for (const key of Object.keys(tags)) {
    const id = mp4Map[key];
    if (!id) continue;
    const text = Buffer.from(tags[key], 'utf8');
    const data = Buffer.alloc(8);
    data.writeUInt32BE(1, 0);
    items.push(box(id, box('data', Buffer.concat([data, text]))));
  }
  if (!items.length) return null;
  const hdlr = Buffer.alloc(25);
  hdlr.write('mdir', 8, 'latin1');
  hdlr.write('appl', 12, 'latin1');
  const meta = Buffer.concat([Buffer.alloc(4), box('hdlr', hdlr), box('ilst', Buffer.concat(items))]);
  return box('udta', box('meta', meta));
}

function parseMp4Ilst(buf) {
  const tags = {};
  const reverse = {};
  for (const key of Object.keys(mp4Map)) reverse[Buffer.from(mp4Map[key], 'latin1').toString('latin1')] = key;
  let p = 0;
  while (p + 8 <= buf.length) {
    const size = buf.readUInt32BE(p);
    if (size < 8 || p + size > buf.length) break;
    const id = buf.toString('latin1', p + 4, p + 8);
    const key = reverse[id];
    if (key && size >= 24 && buf.toString('latin1', p + 12, p + 16) === 'data') {
      tags[key] = buf.toString('utf8', p + 24, p + size);
    }
    p += size;
  }
  return tags;
}

export {
  clean,
  parseVorbisComment,
  buildVorbisComment,
  parseRiffInfo,
  buildRiffInfo,
  parseId3,
  buildId3,
  id3Size,
  buildMp4Meta,
  parseMp4Ilst,
  mp4Map,
};
