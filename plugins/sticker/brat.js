import { sticker } from '../../lib/tools/sticker.js';
import { createCanvas, GlobalFonts, loadImage } from '@napi-rs/canvas';
import { Jimp } from 'jimp';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { writeFile, readFile } from 'fs/promises';
import { exec } from 'child_process';
import { promisify } from 'util';
import { tmpdir } from 'os';
import { join } from 'path';
import { parse as parseEmoji } from 'emoji-parser';

const execAsync = promisify(exec);
const { default: { Image } } = await import('node-webpmux');

const PNG_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/twemoji/14.0.2/72x72/';

// ── emoji helpers ─────────────────────────────────────────────────────────────

function parseSegments(str) {
  if (!str) return [];
  const matches = parseEmoji(str, {
    assetType: 'png',
    buildUrl: (cp) => `${PNG_CDN}${cp}.png`
  });
  if (!matches.length) return [{ type: 'text', value: str }];
  const segs = [];
  let last = 0;
  for (const match of matches) {
    const [s, e] = match.indices;
    if (s > last) segs.push({ type: 'text', value: str.slice(last, s) });
    segs.push({ type: 'emoji', value: match.text, url: match.url });
    last = e;
  }
  if (last < str.length) segs.push({ type: 'text', value: str.slice(last) });
  return segs.filter(seg => seg.value !== '');
}

function measureSegs(ctx, segs, emojiSize) {
  return segs.reduce((total, seg) =>
    total + (seg.type === 'text' ? ctx.measureText(seg.value).width : emojiSize), 0);
}

async function loadEmojiImages(wordSegs) {
  const emojiUrls = new Set(
    wordSegs.flat().filter(s => s.type === 'emoji').map(s => s.url)
  );
  const emojiImages = new Map();
  await Promise.all([...emojiUrls].map(async url => {
    try {
      emojiImages.set(url, await loadImage(url));
    } catch {
      const fallback = url.replace(/-fe0f/g, '');
      if (fallback !== url) {
        try { emojiImages.set(url, await loadImage(fallback)); } catch (e) {
          console.error('[brat] emoji load failed:', url, e.message);
        }
      } else {
        console.error('[brat] emoji load failed:', url);
      }
    }
  }));
  return emojiImages;
}

// ── draw helpers ──────────────────────────────────────────────────────────────

function buildLines(ctx, wordSegs, width, margin, wordSpacing, fontSize) {
  let lines = [];
  let lineWords = [];
  let lineWidth = 0;

  for (let i = 0; i < wordSegs.length; i++) {
    const ww = measureSegs(ctx, wordSegs[i], fontSize);

    if (ww > width - 2 * margin) return null; // signal: need smaller font

    const testWidth = lineWidth + (lineWords.length > 0 ? wordSpacing : 0) + ww;
    if (testWidth < width - 2 * margin || lineWords.length === 0) {
      lineWords.push(i);
      lineWidth = testWidth;
    } else {
      lines.push([...lineWords]);
      lineWords = [i];
      lineWidth = ww;
    }
  }
  if (lineWords.length) lines.push([...lineWords]);
  return lines;
}

function calcLayout(ctx, wordSegs, width, height, margin, wordSpacing, startFontSize = 100) {
  let fontSize = startFontSize;
  const lineHeightMultiplier = 1.3;

  while (fontSize > 10) {
    ctx.font = `bold ${fontSize}px ArialNarrow`;
    const lines = buildLines(ctx, wordSegs, width, margin, wordSpacing, fontSize);
    if (lines && lines.length * fontSize * lineHeightMultiplier <= height - 2 * margin) {
      return { lines, fontSize, lineHeight: fontSize * lineHeightMultiplier };
    }
    fontSize -= 2;
  }
  ctx.font = `bold ${fontSize}px ArialNarrow`;
  return {
    lines: buildLines(ctx, wordSegs, width, margin, wordSpacing, fontSize) || [],
    fontSize,
    lineHeight: fontSize * lineHeightMultiplier
  };
}

async function drawBratFrame(ctx, wordSegs, emojiImages, width, height, margin, wordSpacing) {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const { lines, fontSize, lineHeight } = calcLayout(ctx, wordSegs, width, height, margin, wordSpacing);
  const emojiSize = fontSize;
  let y = (height - lines.length * lineHeight) / 2;

  for (const lineWordIdxs of lines) {
    const totalW = lineWordIdxs.reduce((sum, wi) =>
      sum + measureSegs(ctx, wordSegs[wi], emojiSize), 0);
    const space = lineWordIdxs.length > 1
      ? (width - 2 * margin - totalW) / (lineWordIdxs.length - 1)
      : 0;

    let x = margin;
    for (const wi of lineWordIdxs) {
      for (const s of wordSegs[wi]) {
        if (s.type === 'text') {
          ctx.fillStyle = '#000000';
          ctx.fillText(s.value, x, y);
          x += ctx.measureText(s.value).width;
        } else {
          const img = emojiImages.get(s.url);
          if (img) ctx.drawImage(img, x, y, emojiSize, emojiSize);
          x += emojiSize;
        }
      }
      x += space;
    }
    y += lineHeight;
  }
}

async function applyBlur(canvas) {
  const buffer = canvas.toBuffer('image/png');
  const image = await Jimp.read(buffer);
  image.blur(3);
  return await image.getBuffer('image/png');
}

async function addExif(buffer, categories = [''], extra = {}) {
  const img = new Image();
  const json = {
    'sticker-pack-id': 'bot',
    'sticker-pack-name': '',
    'sticker-pack-publisher': '',
    'emojis': categories,
    ...extra
  };
  let exifAttr = Buffer.from([
    0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00,
    0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x16, 0x00, 0x00, 0x00
  ]);
  let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  let exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  await img.load(buffer);
  img.exif = exif;
  return await img.save(null);
}

// ── handler ───────────────────────────────────────────────────────────────────

const handler = async (m, { conn, text, command, usedPrefix }) => {
  if (!text) throw `*• Example :* ${usedPrefix + command} [text]`;

  const isVideo = /^bratvid$/i.test(command);

  try {
    GlobalFonts.registerFromPath('./lib/src/font/arial.ttf', 'ArialNarrow');

    const width = 512, height = 512;
    const margin = 40;
    const wordSpacing = 25;
    const words = text.split(' ');
    const wordSegs = words.map(w => parseSegments(w));

    if (!isVideo) {
      // ── static sticker ──
      const emojiImages = await loadEmojiImages(wordSegs);
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      await drawBratFrame(ctx, wordSegs, emojiImages, width, height, margin, wordSpacing);
      const blurredBuffer = await applyBlur(canvas);
      const stickerBuf = await sticker(blurredBuffer, false, false, false);
      const result = await addExif(stickerBuf);
      conn.sendMessage(m.chat, { sticker: result }, { quoted: m });

    } else {
      // ── animated sticker (word by word) ──
      const tmpDir = join(tmpdir(), `bratv_${Date.now()}`);
      mkdirSync(tmpDir, { recursive: true });

      try {
        const fps = 10;
        const frameDuration = 0.5;
        const repeatCount = Math.round(fps * frameDuration);

        // preload semua emoji sekaligus sebelum render frame
        const emojiImages = await loadEmojiImages(wordSegs);

        for (let i = 0; i < words.length; i++) {
          const slicedSegs = wordSegs.slice(0, i + 1);
          const canvas = createCanvas(width, height);
          const ctx = canvas.getContext('2d');
          await drawBratFrame(ctx, slicedSegs, emojiImages, width, height, margin, wordSpacing);
          const blurredBuffer = await applyBlur(canvas);

          for (let r = 0; r < repeatCount; r++) {
            const frameIndex = i * repeatCount + r;
            const framePath = join(tmpDir, `frame_${String(frameIndex).padStart(5, '0')}.png`);
            await writeFile(framePath, blurredBuffer);
          }
        }

        const outputPath = join(tmpDir, 'brat.webp');
        await execAsync(
          `ffmpeg -framerate ${fps} -i "${join(tmpDir, 'frame_%05d.png')}" -vf "scale=512:512" -loop 0 "${outputPath}" -y`
        );

        const webpBuffer = await readFile(outputPath);
        const result = await addExif(webpBuffer);
        conn.sendMessage(m.chat, { sticker: result }, { quoted: m });

      } finally {
        if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
      }
    }

  } catch (e) {
    m.reply(`❌ Failed: ${e.message}`);
    m.error = e;
  }
};

handler.help = ['brat <text>', 'bratvid <text>'];
handler.tags = ['sticker'];
handler.command = /^brat(vid)?$/i;
handler.limit = 1;
handler.ai = { risk: "low", description: "create a sticker. \"/brat <text>\" for image, \"/bratvid <text>\" for video" }

export default handler;