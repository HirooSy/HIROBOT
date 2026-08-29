import { createReadStream, promises, ReadStream } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { Readable, PassThrough } from 'stream'
import { deflateRawSync, inflateSync, inflateRawSync } from 'zlib'
import Helper from './helper.js'

const TMP_DIR = join(process.cwd(), process.env.TMP || "data/tmp")
await promises.mkdir(TMP_DIR, { recursive: true })

const MAX_INPUT_SIZE = 50 * 1024 * 1024

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

function toPTT(buffer, ext) {
  return ffmpeg(buffer, [
    '-vn',
    '-c:a', 'libopus',
    '-b:a', '128k',
    '-vbr', 'on',
  ], ext, 'ogg', true)
}

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
 * Convert audio/video buffer menjadi file .opus murni (Ogg Opus).
 * Berbeda dari toAudio/toPTT, fungsi ini menerima opsi kustom
 * seperti bitrate, sample rate, jumlah channel, dan mode VBR.
 *
 * @param {Buffer|ReadStream} buffer - data input (audio/video)
 * @param {string} ext - ekstensi file input, contoh: 'mp4', 'mp3', 'wav'
 * @param {object} [options]
 * @param {string} [options.bitrate='64k'] - bitrate audio, contoh '32k', '64k', '128k'
 * @param {number} [options.sampleRate=48000] - sample rate output (Hz)
 * @param {number} [options.channels=2] - jumlah channel, 1 = mono, 2 = stereo
 * @param {'on'|'off'|'constrained'} [options.vbr='on'] - mode variable bitrate
 * @param {'voip'|'audio'|'lowdelay'} [options.application='audio'] - target optimasi encoder opus
 * @param {number} [options.compressionLevel=10] - level kompresi encoder (0-10)
 */
function toOpus(buffer, ext, options = {}) {
  const {
    bitrate = '64k',
    sampleRate = 48000,
    channels = 2,
    vbr = 'on',
    application = 'audio',
    compressionLevel = 10
  } = options

  return ffmpeg(buffer, [
    '-vn',
    '-c:a', 'libopus',
    '-b:a', bitrate,
    '-ar', String(sampleRate),
    '-ac', String(channels),
    '-vbr', vbr,
    '-application', application,
    '-compression_level', String(compressionLevel)
  ], ext, 'opus', true)
}

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

function extractImageInfo(dict, data, resolveDecodeParms) {
  const widthMatch = dict.match(/\/Width\s+(\d+)/)
  const heightMatch = dict.match(/\/Height\s+(\d+)/)
  const bpcMatch = dict.match(/\/BitsPerComponent\s+(\d+)/)
  const filterMatch = dict.match(/\/Filter\s*(\/\w+|\[[^\]]*\])/)
  const csMatch = dict.match(/\/ColorSpace\s*\/(\w+)/)
  const width = widthMatch ? parseInt(widthMatch[1], 10) : null

  const dpDict = resolveDecodeParms(dict)
  const predictorMatch = dpDict.match(/\/Predictor\s+(\d+)/)
  const colorsMatch = dpDict.match(/\/Colors\s+(\d+)/)
  const columnsMatch = dpDict.match(/\/Columns\s+(\d+)/)
  const dpBpcMatch = dpDict.match(/\/BitsPerComponent\s+(\d+)/)

  return {
    width,
    height: heightMatch ? parseInt(heightMatch[1], 10) : null,
    bpc: bpcMatch ? parseInt(bpcMatch[1], 10) : 8,
    filter: filterMatch ? filterMatch[1] : '',
    colorSpace: csMatch ? csMatch[1] : 'DeviceRGB',
    predictor: predictorMatch ? parseInt(predictorMatch[1], 10) : 1,
    predictorColors: colorsMatch ? parseInt(colorsMatch[1], 10) : null,
    predictorColumns: columnsMatch ? parseInt(columnsMatch[1], 10) : width,
    predictorBpc: dpBpcMatch ? parseInt(dpBpcMatch[1], 10) : (bpcMatch ? parseInt(bpcMatch[1], 10) : 8),
    data
  }
}

function findImageObjects(buf) {
  const str = buf.toString('latin1')
  const images = []
  const objRe = /(\d+)\s+\d+\s+obj/g
  let m

  const objDicts = new Map()
  const objStreams = new Map()
  const objEntries = []

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
    objDicts.set(m[1], dict)
    objEntries.push({ num: m[1], index: m.index, dictEnd, dict })

    const streamKwIdx = str.indexOf('stream', dictEnd)
    if (streamKwIdx !== -1 && streamKwIdx - dictEnd <= 20) {
      let dataStart = streamKwIdx + 'stream'.length
      if (str[dataStart] === '\r') dataStart++
      if (str[dataStart] === '\n') dataStart++
      const lengthMatch = dict.match(/\/Length\s+(\d+)/)
      const dataEnd = lengthMatch ? dataStart + parseInt(lengthMatch[1], 10) : str.indexOf('endstream', dataStart)
      if (dataEnd !== -1 && dataEnd > dataStart) {
        objStreams.set(m[1], buf.subarray(dataStart, dataEnd))
      }
    }
  }

  const maskRefs = new Set()
  const maskRefRe = /\/(?:SMask|Mask)\s+(\d+)\s+0\s+R/g
  let mm
  while ((mm = maskRefRe.exec(str))) maskRefs.add(mm[1])

  function resolveDecodeParms(dict) {
    let mDp = dict.match(/\/(?:DecodeParms|DP)\s*<<([\s\S]*?)>>/)
    if (mDp) return mDp[1]

    mDp = dict.match(/\/(?:DecodeParms|DP)\s*\[\s*<<([\s\S]*?)>>\s*\]/)
    if (mDp) return mDp[1]

    mDp = dict.match(/\/(?:DecodeParms|DP)\s*\[?\s*(\d+)\s+\d+\s+R\s*\]?/)
    if (mDp) {
      const refDict = objDicts.get(mDp[1])
      if (refDict) return refDict
    }

    return ''
  }

  for (const { num, dictEnd, dict } of objEntries) {
    if (!/\/Subtype\s*\/Image\b/.test(dict)) continue
    if (maskRefs.has(num)) continue

    const data = objStreams.get(num)
    if (!data) continue

    const info = extractImageInfo(dict, data, resolveDecodeParms)

    const smaskMatch = dict.match(/\/SMask\s+(\d+)\s+0\s+R/)
    if (smaskMatch) {
      const smaskDict = objDicts.get(smaskMatch[1])
      const smaskData = objStreams.get(smaskMatch[1])
      if (smaskDict && smaskData) {
        info.smask = extractImageInfo(smaskDict, smaskData, resolveDecodeParms)
      }
    }

    images.push({ objStart: dictEnd, ...info })
  }

  return images.sort((a, b) => a.objStart - b.objStart)
}

function undoPredictor(data, { predictor, colors, bpc, columns }) {
  if (!predictor || predictor === 1) return data
  colors = colors || 1
  bpc = bpc || 8
  columns = columns || 1

  const bytesPerPixel = Math.max(1, Math.ceil((colors * bpc) / 8))
  const rowBytes = Math.ceil((colors * bpc * columns) / 8)
  if (rowBytes <= 0) return data

  if (predictor === 2) {

    if (bpc !== 8) return data
    const out = Buffer.from(data)
    const rows = Math.floor(out.length / rowBytes)
    for (let r = 0; r < rows; r++) {
      const rowStart = r * rowBytes
      for (let i = bytesPerPixel; i < rowBytes; i++) {
        out[rowStart + i] = (out[rowStart + i] + out[rowStart + i - bytesPerPixel]) & 0xff
      }
    }
    return out
  }

  const rows = Math.floor(data.length / (rowBytes + 1))
  const out = Buffer.alloc(rows * rowBytes)
  let prevRow = Buffer.alloc(rowBytes)

  for (let r = 0; r < rows; r++) {
    const inStart = r * (rowBytes + 1)
    const filterType = data[inStart]
    const inRow = data.subarray(inStart + 1, inStart + 1 + rowBytes)
    const outRow = out.subarray(r * rowBytes, (r + 1) * rowBytes)

    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bytesPerPixel ? outRow[i - bytesPerPixel] : 0
      const b = prevRow[i]
      const c = i >= bytesPerPixel ? prevRow[i - bytesPerPixel] : 0
      let val = inRow[i]

      switch (filterType) {
        case 0: break
        case 1: val = (val + a) & 0xff; break
        case 2: val = (val + b) & 0xff; break
        case 3: val = (val + Math.floor((a + b) / 2)) & 0xff; break
        case 4: {
          const p = a + b - c
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
          const pred = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c)
          val = (val + pred) & 0xff
          break
        }
        default: break
      }
      outRow[i] = val
    }
    prevRow = outRow
  }

  return out
}

function parseFilterList(filterStr) {
  if (!filterStr) return []
  return (filterStr.match(/\/(\w+)/g) || []).map(s => s.slice(1))
}

function computeChannels(len, width, height, colorSpace) {
  const px = width * height
  if (px > 0 && len % px === 0) {
    const bpp = len / px

    if (bpp === 1 || bpp === 3 || bpp === 4) return bpp
  }
  return colorSpace === 'DeviceGray' ? 1 : colorSpace === 'DeviceCMYK' ? 4 : 3
}

async function decodeStream(img) {
  const filters = parseFilterList(img.filter)
  let buf = img.data

  for (const f of filters) {
    if (f === 'FlateDecode') {
      buf = inflateSync(buf)
    } else if (f === 'DCTDecode') {

      return { kind: 'jpeg', buffer: buf }
    } else {
      throw new Error(`Filter gambar "${f}" belum didukung`)
    }
  }

  buf = undoPredictor(buf, {
    predictor: img.predictor,
    colors: img.predictorColors ?? (img.colorSpace === 'DeviceGray' ? 1 : img.colorSpace === 'DeviceCMYK' ? 4 : 3),
    bpc: img.predictorBpc || img.bpc,
    columns: img.predictorColumns || img.width
  })
  const channels = computeChannels(buf.length, img.width, img.height, img.colorSpace)
  return { kind: 'raw', buffer: buf, channels }
}

async function decodeImageObject(img) {
  const { default: sharp } = await import('sharp')

  if (img.bpc && img.bpc !== 8) {
    throw new Error(`BitsPerComponent ${img.bpc} belum didukung, cuma gambar 8-bit yang didukung`)
  }
  if (!img.width || !img.height) {
    throw new Error('Dimensi gambar (Width/Height) tidak ditemukan di objek PDF')
  }

  const base = await decodeStream(img)

  let baseBuf, baseChannels
  if (base.kind === 'jpeg') {
    const { data, info } = await sharp(base.buffer).raw().toBuffer({ resolveWithObject: true })
    baseBuf = data
    baseChannels = info.channels
  } else {
    baseBuf = base.buffer
    baseChannels = base.channels
  }

  if (baseChannels === 4) {

    const px = img.width * img.height
    const rgb = Buffer.alloc(px * 3)
    for (let i = 0, o = 0, ro = 0; i < px; i++, o += 4, ro += 3) {
      const c = baseBuf[o] / 255, mag = baseBuf[o + 1] / 255, y = baseBuf[o + 2] / 255, k = baseBuf[o + 3] / 255
      rgb[ro] = 255 * (1 - c) * (1 - k)
      rgb[ro + 1] = 255 * (1 - mag) * (1 - k)
      rgb[ro + 2] = 255 * (1 - y) * (1 - k)
    }
    baseBuf = rgb
    baseChannels = 3
  }

  if (img.smask) {

    const mask = await decodeStream(img.smask)
    let alphaBuf
    if (mask.kind === 'jpeg') {
      alphaBuf = await sharp(mask.buffer).grayscale().raw().toBuffer()
    } else if (mask.channels === 1) {
      alphaBuf = mask.buffer
    } else {
      alphaBuf = await sharp(mask.buffer, { raw: { width: img.smask.width, height: img.smask.height, channels: mask.channels } })
        .grayscale().raw().toBuffer()
    }

    const px = img.width * img.height
    const out = Buffer.alloc(px * baseChannels)
    for (let i = 0; i < px; i++) {
      const a = alphaBuf[i] / 255
      for (let c = 0; c < baseChannels; c++) {
        const idx = i * baseChannels + c
        out[idx] = Math.round(baseBuf[idx] * a + 255 * (1 - a))
      }
    }
    baseBuf = out
  }

  return sharp(baseBuf, { raw: { width: img.width, height: img.height, channels: baseChannels } })
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function img2pdf(input) {
  const { default: sharp } = await import('sharp')

  const items = Array.isArray(input) ? input : [input]
  if (!items.length) throw new Error('img2pdf: tidak ada gambar yang diberikan')

  const pages = []
  for (const raw of items) {
    let buf = raw
    if (typeof raw === 'string') {
      if (/^https?:\/\//i.test(raw)) {
        const res = await fetch(raw)
        if (!res.ok) throw new Error(`img2pdf: gagal download ${raw} (status ${res.status})`)
        buf = Buffer.from(await res.arrayBuffer())
      } else {
        buf = await promises.readFile(raw)
      }
    }
    if (!Buffer.isBuffer(buf)) throw new Error('img2pdf: setiap item harus berupa Buffer, URL, atau path string')

    const jpeg = await sharp(buf).rotate().toColourspace('srgb').jpeg({ quality: 92 }).toBuffer()
    const meta = await sharp(jpeg).metadata()
    pages.push({ jpeg, width: meta.width, height: meta.height })
  }

  const catalogNum = 1
  const pagesNum = 2
  const pageObjNums = []
  const contentObjNums = []
  const imageObjNums = []
  let next = 3
  for (let i = 0; i < pages.length; i++) {
    pageObjNums.push(next++)
    contentObjNums.push(next++)
    imageObjNums.push(next++)
  }
  const totalObjects = next - 1

  const chunks = []
  let offset = 0
  const offsets = new Array(totalObjects + 1).fill(0)

  function text(s) { return Buffer.from(s, 'latin1') }
  function push(buf) { chunks.push(buf); offset += buf.length }
  function pushObj(num, buf) { offsets[num] = offset; push(buf) }

  push(text('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n'))

  pushObj(catalogNum, text(`${catalogNum} 0 obj\n<< /Type /Catalog /Pages ${pagesNum} 0 R >>\nendobj\n`))

  const kids = pageObjNums.map(n => `${n} 0 R`).join(' ')
  pushObj(pagesNum, text(`${pagesNum} 0 obj\n<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`))

  for (let i = 0; i < pages.length; i++) {
    const { jpeg, width, height } = pages[i]
    const pageNum = pageObjNums[i]
    const contentNum = contentObjNums[i]
    const imageNum = imageObjNums[i]
    const contentBuf = text(`q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`)

    pushObj(pageNum, text(
      `${pageNum} 0 obj\n<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 ${imageNum} 0 R >> >> /Contents ${contentNum} 0 R >>\nendobj\n`
    ))

    pushObj(contentNum, Buffer.concat([
      text(`${contentNum} 0 obj\n<< /Length ${contentBuf.length} >>\nstream\n`),
      contentBuf,
      text('\nendstream\nendobj\n')
    ]))

    pushObj(imageNum, Buffer.concat([
      text(`${imageNum} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`),
      jpeg,
      text('\nendstream\nendobj\n')
    ]))
  }

  const xrefOffset = offset
  let xref = `xref\n0 ${totalObjects + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= totalObjects; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  push(text(xref))
  push(text(`trailer\n<< /Size ${totalObjects + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`))

  return Buffer.concat(chunks)
}

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

async function unzip(buffer, options = {}) {
  const { outputDir = null } = options

  const eocdSig = 0x06054b50
  let eocdOffset = -1
  const maxCommentLen = 65535
  const searchStart = Math.max(0, buffer.length - 22 - maxCommentLen)
  for (let i = buffer.length - 22; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === eocdSig) { eocdOffset = i; break }
  }
  if (eocdOffset === -1) throw new Error('unzip: bukan file ZIP yang valid (End Of Central Directory tidak ditemukan)')

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10)
  const centralDirSize = buffer.readUInt32LE(eocdOffset + 12)
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16)
  if (centralDirOffset + centralDirSize > buffer.length) {
    throw new Error('unzip: central directory rusak atau file ZIP terpotong')
  }

  const entries = []
  let ptr = centralDirOffset

  for (let i = 0; i < totalEntries; i++) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) {
      throw new Error(`unzip: central directory entry ke-${i} tidak valid`)
    }
    const method = buffer.readUInt16LE(ptr + 10)
    const crc = buffer.readUInt32LE(ptr + 16)
    const compressedSize = buffer.readUInt32LE(ptr + 20)
    const uncompressedSize = buffer.readUInt32LE(ptr + 24)
    const nameLen = buffer.readUInt16LE(ptr + 28)
    const extraLen = buffer.readUInt16LE(ptr + 30)
    const commentLen = buffer.readUInt16LE(ptr + 32)
    const localHeaderOffset = buffer.readUInt32LE(ptr + 42)
    const name = buffer.toString('utf8', ptr + 46, ptr + 46 + nameLen)

    entries.push({ name, method, crc, compressedSize, uncompressedSize, localHeaderOffset })
    ptr += 46 + nameLen + extraLen + commentLen
  }

  const isSafeRelativePath = p => {
    const norm = p.replace(/\\/g, '/')
    if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) return false
    const parts = norm.split('/')
    let depth = 0
    for (const part of parts) {
      if (part === '..') { depth--; if (depth < 0) return false }
      else if (part !== '.' && part !== '') depth++
    }
    return true
  }

  if (outputDir) {
    const results = []
    for (const entry of entries) {
      const isDirectory = entry.name.endsWith('/')

      if (!isSafeRelativePath(entry.name)) {
        throw new Error(`unzip: entry "${entry.name}" mencurigakan (path traversal), file ditolak`)
      }

      if (isDirectory) {
        await promises.mkdir(join(outputDir, entry.name), { recursive: true })
        results.push({ name: entry.name, isDirectory: true })
        continue
      }

      const data = readZipEntryData(buffer, entry)
      const dest = join(outputDir, entry.name)
      await promises.mkdir(join(dest, '..'), { recursive: true })
      await promises.writeFile(dest, data)
      results.push({ name: entry.name, isDirectory: false, path: dest, size: data.length })
    }
    return results
  }

  // In-memory mode: build a tree mirroring the ZIP's folder structure.
  // Each level is a plain object: subfolder names map to nested objects,
  // file names map directly to their Buffer.
  const root = { dirs: new Map(), files: new Map() }

  function getNode(pathParts) {
    let node = root
    for (const part of pathParts) {
      if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: new Map() })
      node = node.dirs.get(part)
    }
    return node
  }

  for (const entry of entries) {
    const isDirectory = entry.name.endsWith('/')

    if (!isSafeRelativePath(entry.name)) {
      throw new Error(`unzip: entry "${entry.name}" mencurigakan (path traversal), file ditolak`)
    }

    const parts = entry.name.replace(/\/+$/, '').split('/').filter(Boolean)

    if (isDirectory) {
      getNode(parts)
      continue
    }

    const fileName = parts.pop()
    const data = readZipEntryData(buffer, entry)
    getNode(parts).files.set(fileName, data)
  }

  function collapse(node) {
    const obj = {}
    for (const [name, buf] of node.files) obj[name] = buf
    for (const [name, child] of node.dirs) obj[name] = collapse(child)
    return obj
  }

  return { result: collapse(root) }
}

function readZipEntryData(buffer, entry) {
  const lp = entry.localHeaderOffset
  if (buffer.readUInt32LE(lp) !== 0x04034b50) {
    throw new Error(`unzip: local file header untuk "${entry.name}" tidak valid`)
  }
  const localNameLen = buffer.readUInt16LE(lp + 26)
  const localExtraLen = buffer.readUInt16LE(lp + 28)
  const dataStart = lp + 30 + localNameLen + localExtraLen
  const compressedData = buffer.subarray(dataStart, dataStart + entry.compressedSize)

  let data
  if (entry.method === 0) {
    data = Buffer.from(compressedData)
  } else if (entry.method === 8) {
    data = inflateRawSync(compressedData)
  } else {
    throw new Error(`unzip: compression method ${entry.method} untuk "${entry.name}" tidak didukung (cuma STORE dan DEFLATE)`)
  }

  if (crc32(data) !== entry.crc) {
    throw new Error(`unzip: CRC32 mismatch untuk "${entry.name}", file kemungkinan korup`)
  }

  return data
}

export {
  toAudio,
  toPTT,
  toOpus,
  toVideo,
  pdf2img,
  img2pdf,
  ffmpeg,
  ZipFile,
  unzip,
}