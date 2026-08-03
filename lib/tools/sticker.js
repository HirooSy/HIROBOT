import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import fluent_ffmpeg from 'fluent-ffmpeg'
import { fileTypeFromBuffer } from 'file-type'
import webp from 'node-webpmux'

async function sticker(img, url, packname, author, categories = [''], extra = {}) {
  if (url) {
    let res = await fetch(url)
    if (res.status !== 200) throw await res.text()
    img = await res.buffer()
  }

  const type = await fileTypeFromBuffer(img) || {
    mime: 'application/octet-stream',
    ext: 'bin'
  }
  if (type.ext == 'bin') throw new Error('Unsupported file type')

  const tmpDir = path.join(process.cwd(), 'data/tmp')
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true })
  const tmp = path.join(tmpDir, `${+new Date()}.${type.ext}`)
  const out = `${tmp}.webp`
  await fs.promises.writeFile(tmp, img)

  const webpBuffer = await new Promise((resolve, reject) => {
    // https://github.com/MhankBarBar/termux-wabot/blob/main/index.js#L313#L368
    const proc = /video/i.test(type.mime) ? fluent_ffmpeg(tmp).inputFormat(type.ext) : fluent_ffmpeg(tmp).input(tmp)
    proc
      .on('error', (err) => {
        fs.promises.unlink(tmp).catch(() => {})
        reject(err)
      })
      .on('end', async () => {
        fs.promises.unlink(tmp).catch(() => {})
        try {
          resolve(await fs.promises.readFile(out))
        } catch (e) {
          reject(e)
        }
      })
      .addOutputOptions([
        '-vcodec', 'libwebp', '-vf',
        `scale='min(320,iw)':min'(320,ih)':force_original_aspect_ratio=decrease,fps=15, pad=320:320:-1:-1:color=white@0.0, split [a][b]; [a] palettegen=reserve_transparent=on:transparency_color=ffffff [p]; [b][p] paletteuse`
      ])
      .toFormat('webp')
      .save(out)
  })

  fs.promises.unlink(out).catch(() => {})

  try {
    return await addExif(webpBuffer, packname, author, categories, extra)
  } catch (e) {
    console.error(e)
    return webpBuffer
  }
}

async function addExif(webpSticker, packname, author, categories = [''], extra = {}) {
  const img = new webp.Image();
  const stickerPackId = crypto.randomBytes(32).toString('hex');
  const json = { 'sticker-pack-id': stickerPackId, 'sticker-pack-name': packname, 'sticker-pack-publisher': author, 'emojis': categories, ...extra };
  let exifAttr = Buffer.from([0x49, 0x49, 0x2A, 0x00, 0x08, 0x00, 0x00, 0x00, 0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00, 0x00, 0x00, 0x16, 0x00, 0x00, 0x00]);
  let jsonBuffer = Buffer.from(JSON.stringify(json), 'utf8');
  let exif = Buffer.concat([exifAttr, jsonBuffer]);
  exif.writeUIntLE(jsonBuffer.length, 14, 4);
  await img.load(webpSticker)
  img.exif = exif
  return await img.save(null)
}

export {
  sticker,
  addExif
}
