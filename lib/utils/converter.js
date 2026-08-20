import { createReadStream, promises, ReadStream } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { Readable, PassThrough } from 'stream'
import { deflateRawSync, inflateSync } from 'zlib'
import Helper from './helper.js'

const TMP_DIR = join(process.cwd(), process.env.TMP || "data/tmp")
await promises.mkdir(TMP_DIR, { recursive: true })

/**
 * @param {Buffer | Readable} buffer 
 * @param {string[]} args 
 * @param {string} ext 
 * @param {string} ext2 
 * @returns {Promise<{
 *  data: ReadStream; 
 *  filename: string; 
 *  toBuffer: () => Promise<Buffer>;
 *  clear: () => Promise<void>;
 * }>}
 */
const MAX_INPUT_SIZE = 50 * 1024 * 1024 // 50MB

function ffmpeg(buffer, args = [], ext = '', ext2 = '', isAudio = false) {
  return new Promise(async (resolve, reject) => {
    try {
      const tmp = join(`${TMP_DIR}/${Date.now()}.${ext}`)
      const out = `${tmp}.${ext2}`

      const isStream = Helper.isReadableStream(buffer)
      if (isStream) await Helper.saveStreamToFile(buffer, tmp)
      else await promises.writeFile(tmp, buffer)

      const stat = await promises.stat(tmp)
      if (isAudio && stat.size > MAX_INPUT_SIZE) {
        const preOut = `${tmp}.pre.mp3`

        await new Promise((res, rej) => {
          spawn('ffmpeg', [
            '-y',
            '-i', tmp,
            '-vn',
            '-c:a', 'libmp3lame',
            '-b:a', '96k',
            preOut
          ])
            .once('error', rej)
            .once('close', code => code === 0 ? res() : rej(new Error(`pre-compress ffmpeg exited with code ${code}`)))
        })

        await promises.unlink(tmp)
        await promises.rename(preOut, tmp)
      }

      spawn('ffmpeg', [
        '-y',
        '-i', tmp,
        ...args,
        out
      ])
        .once('error', reject)
        .once('close', async (code) => {
          try {
            await promises.unlink(tmp)
            if (code !== 0) return reject(code)
            const data = createReadStream(out)
            resolve({
              data,
              filename: out,
              async toBuffer() {
                const buffers = []
                for await (const chunk of data) buffers.push(chunk)
                return Buffer.concat(buffers)
              },
              async clear() {
                data.destroy()
                await promises.unlink(out)
              }
            })
          } catch (e) {
            reject(e)
          }
        })
    } catch (e) {
      reject(e)
    }
  })
}

/**
 * Convert Audio to Playable WhatsApp Audio
 * @param {Buffer} buffer Audio Buffer
 * @param {String} ext File Extension 
 * @returns {ReturnType<typeof ffmpeg>}
 */
function toPTT(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-vbr', 'on',
  ], ext, 'ogg', true)
}

/**
 * Convert Audio to Playable WhatsApp PTT
 * @param {Buffer} buffer Audio Buffer
 * @param {String} ext File Extension 
 * @returns {ReturnType<typeof ffmpeg>}
 */
function toAudio(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-vbr', 'on',
    '-compression_level', '10'
  ], ext, 'opus', true)
}

/**
 * Convert Audio to Playable WhatsApp Video
 * @param {Buffer} buffer Video Buffer
 * @param {String} ext File Extension 
 * @returns {ReturnType<typeof ffmpeg>}
 */
function toVideo(buffer, ext) {
  return ffmpeg(buffer, [
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-ab', '128k',
    '-ar', '44100',
    '-crf', '32',
    '-preset', 'slow'
  ], ext, 'mp4')
}

function findImageObjects(buf) {
  const str = buf.toString('latin1')
  const images = []
  const objRe = /(\d+)\s+\d+\s+obj/g
  let m

  while ((m = objRe.exec(str))) {
    const dictStart = str.indexOf('<<', objRe.lastIndex)
    if (dictStart === -1 || dictStart - objRe.lastIndex > 20) continue

    let depth = 0
    let i = dictStart
    let dictEnd = -1
    while (i < str.length - 1) {
      if (str[i] === '<' && str[i + 1] === '<') { depth++; i += 2; continue }
      if (str[i] === '>' && str[i + 1] === '>') { depth--; i += 2; if (depth === 0) { dictEnd = i; break }; continue }
      i++
    }
    if (dictEnd === -1) continue

    const dict = str.slice(dictStart, dictEnd)
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue

    const streamKwIdx = str.indexOf('stream', dictEnd)
    if (streamKwIdx === -1 || streamKwIdx - dictEnd > 20) continue

    let dataStart = streamKwIdx + 'stream'.length
    if (str[dataStart] === '\r') dataStart++
    if (str[dataStart] === '\n') dataStart++

    const lengthMatch = dict.match(/\/Length\s+(\d+)/)
    const dataEnd = lengthMatch ? dataStart + parseInt(lengthMatch[1], 10) : str.indexOf('endstream', dataStart)
    if (dataEnd === -1 || dataEnd <= dataStart) continue

    const widthMatch = dict.match(/\/Width\s+(\d+)/)
    const heightMatch = dict.match(/\/Height\s+(\d+)/)
    const bpcMatch = dict.match(/\/BitsPerComponent\s+(\d+)/)
    const filterMatch = dict.match(/\/Filter\s*(\/\w+|\[[^\]]*\])/)
    const csMatch = dict.match(/\/ColorSpace\s*\/(\w+)/)

    images.push({
      objStart: m.index,
      width: widthMatch ? parseInt(widthMatch[1], 10) : null,
      height: heightMatch ? parseInt(heightMatch[1], 10) : null,
      bpc: bpcMatch ? parseInt(bpcMatch[1], 10) : 8,
      filter: filterMatch ? filterMatch[1] : '',
      colorSpace: csMatch ? csMatch[1] : 'DeviceRGB',
      data: buf.subarray(dataStart, dataEnd)
    })
  }

  return images.sort((a, b) => a.objStart - b.objStart)
}

async function rawSamplesToPng(raw, { width, height, bpc, colorSpace }) {
  if (!width || !height) throw new Error('Dimensi gambar (Width/Height) tidak ditemukan di objek PDF')
  if (bpc !== 8) throw new Error(`BitsPerComponent ${bpc} belum didukung, cuma gambar 8-bit yang didukung`)

  let PImage
  try {
    PImage = await import('pureimage')
  } catch {
    throw new Error('Install pureimage dulu:\nnpm i pureimage')
  }

  const channels = colorSpace === 'DeviceGray' ? 1 : colorSpace === 'DeviceCMYK' ? 4 : 3

  const bitmap = PImage.make(width, height)
  const out = bitmap.data

  for (let px = 0, o = 0; px < width * height; px++, o += channels) {
    let r, g, b
    if (channels === 1) {
      r = g = b = raw[o]
    } else if (channels === 4) {
      const c = raw[o] / 255, mag = raw[o + 1] / 255, y = raw[o + 2] / 255, k = raw[o + 3] / 255
      r = 255 * (1 - c) * (1 - k)
      g = 255 * (1 - mag) * (1 - k)
      b = 255 * (1 - y) * (1 - k)
    } else {
      r = raw[o]; g = raw[o + 1]; b = raw[o + 2]
    }
    const idx = px * 4
    out[idx] = r
    out[idx + 1] = g
    out[idx + 2] = b
    out[idx + 3] = 255
  }

  const chunks = []
  const sink = new PassThrough()
  sink.on('data', c => chunks.push(c))
  await PImage.encodePNGToStream(bitmap, sink)
  return Buffer.concat(chunks)
}

async function decodeImageObject(img) {
  const filter = img.filter || ''

  if (/DCTDecode/.test(filter)) {
    return Buffer.from(img.data)
  }

  if (/FlateDecode/.test(filter) && !/DCTDecode|JPXDecode|CCITTFaxDecode/.test(filter)) {
    const raw = inflateSync(img.data)
    return rawSamplesToPng(raw, img)
  }

  throw new Error(`Filter gambar "${filter || '(tidak diketahui)'}" belum didukung. Cuma DCTDecode (JPEG) dan FlateDecode (raw) yang didukung.`)
}

/**
 * Extract embedded page images from a "scan-style" PDF (one image per page)
 * into image buffers. Pure JS, no extra npm module (uses the already-installed
 * "pureimage" plus Node's built-in zlib/stream) and no system binary like
 * Ghostscript/ImageMagick required.
 *
 * Only works for PDFs whose pages are essentially embedded photos (e.g. scanned
 * documents). PDFs containing real text/vector content won't produce anything
 * useful this way. Supported image encodings: DCTDecode (JPEG, returned as-is)
 * and FlateDecode (raw 8-bit DeviceGray/DeviceRGB/DeviceCMYK samples, re-encoded
 * to PNG). JPXDecode (JPEG2000), CCITTFaxDecode (fax/bilevel scans) and indexed
 * color spaces are not supported.
 * @param {Buffer} buffer PDF Buffer
 * @param {Object} [options]
 * @param {number|number[]|'all'} [options.page=1] Which embedded image(s) to return, in the order they appear in the file
 * @returns {Promise<Buffer|Buffer[]>} Single buffer, or array of buffers when extracting multiple pages
 */
async function pdf2img(buffer, options = {}) {
  const { page = 1 } = options

  const images = findImageObjects(buffer)
  if (!images.length) {
    throw new Error('Tidak ditemukan gambar tertanam di PDF ini (mungkin isinya teks/vector, bukan hasil scan)')
  }

  if (page === 'all') {
    const results = []
    for (const img of images) results.push(await decodeImageObject(img))
    return results
  }

  const pages = Array.isArray(page) ? page : [page]
  const results = []
  for (const p of pages) {
    const img = images[p - 1]
    if (!img) throw new Error(`Halaman ${p} tidak ditemukan (PDF ini punya ${images.length} gambar)`)
    results.push(await decodeImageObject(img))
  }

  return Array.isArray(page) ? results : results[0]
}


const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let crc = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8)
  }
  return (crc ^ 0xFFFFFFFF) >>> 0
}

function dosDateTime(date) {
  const time = (
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    (date.getSeconds() >> 1)
  ) & 0xFFFF
  const dos = (
    (((date.getFullYear() - 1980) & 0x7F) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate()
  ) & 0xFFFF
  return { time, date: dos }
}

/**
 * Encoder ZIP minimal (pengganti jszip) pakai zlib built-in.
 * Support STORE (tanpa kompresi) dan DEFLATE, output nodebuffer.
 */
class ZipFile {
  constructor() {
    this._files = []
  }

  file(name, data) {
    if (typeof data === 'string') data = Buffer.from(data, 'utf8')
    if (!Buffer.isBuffer(data)) data = Buffer.from(data)
    this._files.push({ name: name.replace(/\\/g, '/'), data })
    return this
  }

  async generateAsync({ type = 'nodebuffer', compression = 'STORE' } = {}) {
    if (type !== 'nodebuffer') {
      throw new Error(`ZipFile.generateAsync: type "${type}" tidak didukung, cuma "nodebuffer"`)
    }

    const useDeflate = compression === 'DEFLATE'
    const localChunks = []
    const centralChunks = []
    let offset = 0
    const { time, date } = dosDateTime(new Date())

    for (const entry of this._files) {
      const nameBuf = Buffer.from(entry.name, 'utf8')
      const crc = crc32(entry.data)

      let compressedData = entry.data
      let method = 0

      if (useDeflate) {
        const deflated = deflateRawSync(entry.data)
        if (deflated.length < entry.data.length) {
          compressedData = deflated
          method = 8
        }
      }

      const localHeader = Buffer.alloc(30)
      localHeader.writeUInt32LE(0x04034b50, 0)
      localHeader.writeUInt16LE(20, 4)
      localHeader.writeUInt16LE(0, 6)
      localHeader.writeUInt16LE(method, 8)
      localHeader.writeUInt16LE(time, 10)
      localHeader.writeUInt16LE(date, 12)
      localHeader.writeUInt32LE(crc, 14)
      localHeader.writeUInt32LE(compressedData.length, 18)
      localHeader.writeUInt32LE(entry.data.length, 22)
      localHeader.writeUInt16LE(nameBuf.length, 26)
      localHeader.writeUInt16LE(0, 28)

      localChunks.push(localHeader, nameBuf, compressedData)

      const centralHeader = Buffer.alloc(46)
      centralHeader.writeUInt32LE(0x02014b50, 0)
      centralHeader.writeUInt16LE(20, 4)
      centralHeader.writeUInt16LE(20, 6)
      centralHeader.writeUInt16LE(0, 8)
      centralHeader.writeUInt16LE(method, 10)
      centralHeader.writeUInt16LE(time, 12)
      centralHeader.writeUInt16LE(date, 14)
      centralHeader.writeUInt32LE(crc, 16)
      centralHeader.writeUInt32LE(compressedData.length, 20)
      centralHeader.writeUInt32LE(entry.data.length, 24)
      centralHeader.writeUInt16LE(nameBuf.length, 28)
      centralHeader.writeUInt16LE(0, 30)
      centralHeader.writeUInt16LE(0, 32)
      centralHeader.writeUInt16LE(0, 34)
      centralHeader.writeUInt16LE(0, 36)
      centralHeader.writeUInt32LE(0, 38)
      centralHeader.writeUInt32LE(offset, 42)

      centralChunks.push(centralHeader, nameBuf)

      offset += localHeader.length + nameBuf.length + compressedData.length
    }

    const centralDirStart = offset
    const centralDirBuffer = Buffer.concat(centralChunks)
    const centralDirSize = centralDirBuffer.length

    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this._files.length, 8)
    eocd.writeUInt16LE(this._files.length, 10)
    eocd.writeUInt32LE(centralDirSize, 12)
    eocd.writeUInt32LE(centralDirStart, 16)
    eocd.writeUInt16LE(0, 20)

    return Buffer.concat([...localChunks, centralDirBuffer, eocd])
  }
}

export {
  toAudio,
  toPTT,
  toVideo,
  pdf2img,
  ffmpeg,
  ZipFile,
}