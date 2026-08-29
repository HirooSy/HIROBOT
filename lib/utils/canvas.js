import sharp from 'sharp'
import { promises as fsp, readFileSync } from 'fs'

const NAMED_COLORS = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000',
  blue: '#0000ff', yellow: '#ffff00', gray: '#808080', grey: '#808080',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a',
  cyan: '#00ffff', magenta: '#ff00ff', lime: '#00ff00', navy: '#000080',
  transparent: 'rgba(0,0,0,0)'
}

function parseColor(input) {
  if (input == null) return { r: 0, g: 0, b: 0, a: 1 }
  let str = String(input).trim().toLowerCase()
  if (NAMED_COLORS[str]) str = NAMED_COLORS[str]

  let m
  if ((m = str.match(/^#([0-9a-f]{3})$/))) {
    const [r, g, b] = m[1].split('').map(c => parseInt(c + c, 16))
    return { r, g, b, a: 1 }
  }
  if ((m = str.match(/^#([0-9a-f]{6})$/))) {
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 }
  }
  if ((m = str.match(/^#([0-9a-f]{8})$/))) {
    const n = parseInt(m[1], 16)
    return { r: (n >>> 24) & 255, g: (n >> 16) & 255, b: (n >> 8) & 255, a: (n & 255) / 255 }
  }
  if ((m = str.match(/^rgba?\(([^)]+)\)$/))) {
    const [r, g, b, a] = m[1].split(',').map(s => s.trim())
    return { r: parseInt(r) || 0, g: parseInt(g) || 0, b: parseInt(b) || 0, a: a !== undefined ? parseFloat(a) : 1 }
  }
  return { r: 0, g: 0, b: 0, a: 1 }
}

function colorToSvgAttrs(input) {
  const { r, g, b, a } = parseColor(input)
  return { fill: `rgb(${r},${g},${b})`, opacity: a }
}

function xmlEscape(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function parseFont(buf) {
  const numTables = buf.readUInt16BE(4)
  const tables = {}
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16
    const tag = buf.toString('latin1', rec, rec + 4)
    tables[tag] = { offset: buf.readUInt32BE(rec + 8), length: buf.readUInt32BE(rec + 12) }
  }
  for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap']) {
    if (!tables[t]) throw new Error(`Font tidak punya table wajib "${t}"`)
  }

  const unitsPerEm = buf.readUInt16BE(tables.head.offset + 18)
  const numberOfHMetrics = buf.readUInt16BE(tables.hhea.offset + 34)
  const numGlyphs = buf.readUInt16BE(tables.maxp.offset + 4)

  const advanceWidths = new Array(numGlyphs)
  let lastAdvance = 0
  for (let g = 0; g < numGlyphs; g++) {
    if (g < numberOfHMetrics) lastAdvance = buf.readUInt16BE(tables.hmtx.offset + g * 4)
    advanceWidths[g] = lastAdvance
  }

  const cmap = parseCmap(buf, tables.cmap.offset)

  return {
    unitsPerEm,
    getGlyphIndex(codePoint) { return cmap.get(codePoint) || 0 },
    getAdvanceWidth(glyphIndex) { return advanceWidths[glyphIndex] ?? advanceWidths[0] ?? 0 }
  }
}

function parseCmap(buf, cmapOffset) {
  const numSubtables = buf.readUInt16BE(cmapOffset + 2)
  let bestOffset = -1, bestScore = -1

  for (let i = 0; i < numSubtables; i++) {
    const rec = cmapOffset + 4 + i * 8
    const platformID = buf.readUInt16BE(rec)
    const encodingID = buf.readUInt16BE(rec + 2)
    const offset = buf.readUInt32BE(rec + 4)

    let score = 0
    if (platformID === 3 && encodingID === 10) score = 5
    else if (platformID === 0 && encodingID >= 4) score = 5
    else if (platformID === 3 && encodingID === 1) score = 4
    else if (platformID === 0) score = 3
    else if (platformID === 1 && encodingID === 0) score = 1

    if (score > bestScore) { bestScore = score; bestOffset = cmapOffset + offset }
  }
  if (bestOffset === -1) throw new Error('cmap: tidak ada subtable unicode yang didukung')

  const format = buf.readUInt16BE(bestOffset)
  const map = new Map()

  if (format === 4) {
    const segCountX2 = buf.readUInt16BE(bestOffset + 6)
    const segCount = segCountX2 / 2
    const endCodeOff = bestOffset + 14
    const startCodeOff = endCodeOff + segCountX2 + 2
    const idDeltaOff = startCodeOff + segCountX2
    const idRangeOffOff = idDeltaOff + segCountX2

    for (let s = 0; s < segCount; s++) {
      const endCode = buf.readUInt16BE(endCodeOff + s * 2)
      const startCode = buf.readUInt16BE(startCodeOff + s * 2)
      const idDelta = buf.readInt16BE(idDeltaOff + s * 2)
      const idRangeOffset = buf.readUInt16BE(idRangeOffOff + s * 2)
      if (startCode === 0xFFFF && endCode === 0xFFFF) continue

      for (let c = startCode; c <= endCode && c !== 0xFFFF; c++) {
        let glyphIndex
        if (idRangeOffset === 0) {
          glyphIndex = (c + idDelta) & 0xFFFF
        } else {
          const addr = idRangeOffOff + s * 2 + idRangeOffset + (c - startCode) * 2
          glyphIndex = buf.readUInt16BE(addr)
          if (glyphIndex !== 0) glyphIndex = (glyphIndex + idDelta) & 0xFFFF
        }
        if (glyphIndex !== 0) map.set(c, glyphIndex)
      }
    }
  } else if (format === 12) {
    const numGroups = buf.readUInt32BE(bestOffset + 12)
    for (let g = 0; g < numGroups; g++) {
      const rec = bestOffset + 16 + g * 12
      const startCharCode = buf.readUInt32BE(rec)
      const endCharCode = buf.readUInt32BE(rec + 4)
      const startGlyphID = buf.readUInt32BE(rec + 8)
      for (let c = startCharCode; c <= endCharCode; c++) map.set(c, startGlyphID + (c - startCharCode))
    }
  } else {
    throw new Error(`cmap format ${format} tidak didukung (cuma format 4 & 12)`)
  }
  return map
}

function measureAdvance(fontMetrics, text, fontSize) {
  const scale = fontSize / fontMetrics.unitsPerEm
  let total = 0
  for (const ch of text) {
    const glyphIndex = fontMetrics.getGlyphIndex(ch.codePointAt(0))
    total += fontMetrics.getAdvanceWidth(glyphIndex)
  }
  return total * scale
}

const registeredFonts = new Map() 
function registerFont(path, { family } = {}) {
  if (!family) throw new Error('registerFont: opsi "family" wajib diisi')
  const buf = readFileSync(path)
  const metrics = parseFont(buf)
  registeredFonts.set(family.toLowerCase(), { path, family, metrics })
}

function parseFontString(fontStr) {
  const fallback = { style: 'normal', weight: 'normal', size: 16, family: 'sans-serif' }
  if (!fontStr) return fallback
  const tokens = fontStr.trim().split(/\s+/)
  const sizeIdx = tokens.findIndex(t => /^[\d.]+px$/.test(t))
  if (sizeIdx === -1) return fallback

  const size = parseFloat(tokens[sizeIdx])
  const before = tokens.slice(0, sizeIdx)
  const family = tokens.slice(sizeIdx + 1).join(' ').split(',')[0].replace(/['"]/g, '').trim() || fallback.family
  const style = before.includes('italic') ? 'italic' : before.includes('oblique') ? 'oblique' : 'normal'
  const weight = before.includes('bold') ? 'bold' : (before.find(t => /^\d+$/.test(t)) || 'normal')

  return { style, weight, size: Number.isFinite(size) ? size : fallback.size, family }
}

function toPangoFontString({ family, weight, style, size }) {
  let parts = [family]
  if (weight === 'bold' || Number(weight) >= 600) parts.push('Bold')
  if (style === 'italic') parts.push('Italic')
  else if (style === 'oblique') parts.push('Oblique')
  parts.push(String(size))
  return parts.join(' ')
}

const IDENTITY = [1, 0, 0, 1, 0, 0]

function multiplyMatrix(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ]
}

function applyMatrix([a, b, c, d, e, f], x, y) {
  return { x: a * x + c * y + e, y: b * x + d * y + f }
}

function blitOver(dst, dstW, dstH, src, srcW, srcH, globalAlpha = 1) {
  const w = Math.min(dstW, srcW), h = Math.min(dstH, srcH)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = (y * srcW + x) * 4
      const sa = (src[si + 3] / 255) * globalAlpha
      if (sa <= 0) continue
      const di = (y * dstW + x) * 4
      if (sa >= 1) {
        dst[di] = src[si]; dst[di + 1] = src[si + 1]; dst[di + 2] = src[si + 2]; dst[di + 3] = 255
        continue
      }
      const da = dst[di + 3] / 255
      const outA = sa + da * (1 - sa)
      if (outA <= 0) { dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0; continue }
      dst[di] = Math.round((src[si] * sa + dst[di] * da * (1 - sa)) / outA)
      dst[di + 1] = Math.round((src[si + 1] * sa + dst[di + 1] * da * (1 - sa)) / outA)
      dst[di + 2] = Math.round((src[si + 2] * sa + dst[di + 2] * da * (1 - sa)) / outA)
      dst[di + 3] = Math.round(outA * 255)
    }
  }
}

function blitClear(dst, dstW, dstH, mask, maskW, maskH) {
  const w = Math.min(dstW, maskW), h = Math.min(dstH, maskH)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const mi = (y * maskW + x) * 4
      const a = mask[mi + 3] / 255
      if (a <= 0) continue
      const di = (y * dstW + x) * 4
      dst[di + 3] = Math.round(dst[di + 3] * (1 - a))
      if (dst[di + 3] === 0) dst[di] = dst[di + 1] = dst[di + 2] = 0
    }
  }
}

async function rasterizeFullCanvasSvg(width, height, innerSvg, matrix) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<g transform="matrix(${matrix.join(',')})">${innerSvg}</g></svg>`
  const { data } = await sharp(Buffer.from(svg)).ensureAlpha().raw()
    .toBuffer({ resolveWithObject: true })
  return data
}

class Image {
  constructor({ buffer, width, height, src }) {
    this._buffer = buffer 
    this.width = width
    this.height = height
    this.src = src || null
  }
}

async function loadImage(source) {
  if (source instanceof Image) return source

  let input
  if (Buffer.isBuffer(source)) {
    input = source
  } else if (typeof source === 'string') {
    if (/^https?:\/\//i.test(source)) {
      const res = await fetch(source)
      if (!res.ok) throw new Error(`loadImage: gagal mengambil "${source}" (status ${res.status})`)
      input = Buffer.from(await res.arrayBuffer())
    } else if (/^data:/i.test(source)) {
      const base64 = source.split(',')[1] || ''
      input = Buffer.from(base64, 'base64')
    } else {
      input = await fsp.readFile(source)
    }
  } else {
    throw new Error('loadImage: sumber tidak didukung (harus Buffer, path, URL, atau data URI)')
  }

  const png = await sharp(input).ensureAlpha().png().toBuffer()
  const meta = await sharp(png).metadata()

  return new Image({
    buffer: png,
    width: meta.width,
    height: meta.height,
    src: typeof source === 'string' ? source : null
  })
}

class Path2DBuilder {
  constructor() {
    this.d = ''
    this.cur = { x: 0, y: 0 }
    this.start = { x: 0, y: 0 }
  }

  moveTo(x, y) { this.d += `M${x} ${y} `; this.cur = { x, y }; this.start = { x, y } }
  lineTo(x, y) { this.d += `L${x} ${y} `; this.cur = { x, y } }
  closePath() { this.d += 'Z '; this.cur = { ...this.start } }
  bezierCurveTo(x1, y1, x2, y2, x, y) { this.d += `C${x1} ${y1} ${x2} ${y2} ${x} ${y} `; this.cur = { x, y } }
  quadraticCurveTo(x1, y1, x, y) { this.d += `Q${x1} ${y1} ${x} ${y} `; this.cur = { x, y } }

  rect(x, y, w, h) { this.d += `M${x} ${y} L${x + w} ${y} L${x + w} ${y + h} L${x} ${y + h} Z ` }

  arc(x, y, radius, startAngle, endAngle, anticlockwise = false) {
    const TAU = Math.PI * 2
    let delta = endAngle - startAngle
    const fullCircle = Math.abs(delta) >= TAU

    if (fullCircle) {
     
      const midAngle = startAngle + Math.PI
      this._arcSegment(x, y, radius, startAngle, midAngle, anticlockwise)
      this._arcSegment(x, y, radius, midAngle, startAngle + TAU, anticlockwise)
      return
    }
    this._arcSegment(x, y, radius, startAngle, endAngle, anticlockwise)
  }

  _arcSegment(x, y, radius, startAngle, endAngle, anticlockwise) {
    const sx = x + radius * Math.cos(startAngle)
    const sy = y + radius * Math.sin(startAngle)
    const ex = x + radius * Math.cos(endAngle)
    const ey = y + radius * Math.sin(endAngle)

    let delta = endAngle - startAngle
    if (anticlockwise) { while (delta > 0) delta -= Math.PI * 2 } else { while (delta < 0) delta += Math.PI * 2 }

    const largeArcFlag = Math.abs(delta) > Math.PI ? 1 : 0
    const sweepFlag = anticlockwise ? 0 : 1

    if (this.d === '') this.d += `M${sx} ${sy} `
    else this.d += `L${sx} ${sy} `
    this.d += `A${radius} ${radius} 0 ${largeArcFlag} ${sweepFlag} ${ex} ${ey} `
    this.cur = { x: ex, y: ey }
  }
}

class CanvasRenderingContext2D {
  constructor(canvas) {
    this._canvas = canvas
    this.fillStyle = '#000000'
    this.strokeStyle = '#000000'
    this.lineWidth = 1
    this.lineCap = 'butt'
    this.lineJoin = 'miter'
    this.globalAlpha = 1
    this.font = '10px sans-serif'
    this.textAlign = 'left'
    this.textBaseline = 'alphabetic'

    this._matrix = IDENTITY.slice()
    this._stack = []
    this._path = new Path2DBuilder()
  }

  // ---- transform ----
  save() {
    this._stack.push({
      matrix: this._matrix.slice(),
      fillStyle: this.fillStyle, strokeStyle: this.strokeStyle,
      lineWidth: this.lineWidth, lineCap: this.lineCap, lineJoin: this.lineJoin,
      globalAlpha: this.globalAlpha, font: this.font,
      textAlign: this.textAlign, textBaseline: this.textBaseline
    })
  }

  restore() {
    const s = this._stack.pop()
    if (!s) return
    Object.assign(this, s)
  }

  translate(x, y) { this._matrix = multiplyMatrix(this._matrix, [1, 0, 0, 1, x, y]) }
  scale(sx, sy) { this._matrix = multiplyMatrix(this._matrix, [sx, 0, 0, sy ?? sx, 0, 0]) }
  rotate(angleRad) {
    const c = Math.cos(angleRad), s = Math.sin(angleRad)
    this._matrix = multiplyMatrix(this._matrix, [c, s, -s, c, 0, 0])
  }
  setTransform(a, b, c, d, e, f) { this._matrix = [a, b, c, d, e, f] }
  resetTransform() { this._matrix = IDENTITY.slice() }

  _enqueue(job) {
    this._canvas._queue = this._canvas._queue.then(job).catch(err => {
      this._canvas._error = err
      throw err
    })
  }

  async _drawSvgOver(innerSvg) {
    const { width, height, _raw: raw } = this._canvas
    const layer = await rasterizeFullCanvasSvg(width, height, innerSvg, this._matrix)
    blitOver(raw, width, height, layer, width, height, this.globalAlpha)
  }

  // ---- rect ----
  fillRect(x, y, w, h) {
    const { fill, opacity } = colorToSvgAttrs(this.fillStyle)
    const svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${fill}" fill-opacity="${opacity}"/>`
    this._enqueue(() => this._drawSvgOver(svg))
  }

  strokeRect(x, y, w, h) {
    const { fill, opacity } = colorToSvgAttrs(this.strokeStyle)
    const svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="${fill}" stroke-opacity="${opacity}" stroke-width="${this.lineWidth}"/>`
    this._enqueue(() => this._drawSvgOver(svg))
  }

  clearRect(x, y, w, h) {
    this._enqueue(async () => {
      const { width, height, _raw: raw } = this._canvas
      const svg = `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="white"/>`
      const mask = await rasterizeFullCanvasSvg(width, height, svg, this._matrix)
      blitClear(raw, width, height, mask, width, height)
    })
  }

  roundRect(x, y, w, h, radius) {
    const r = typeof radius === 'number' ? radius : (radius?.[0] ?? 0)
    this._path = this._path || new Path2DBuilder()
    this._path.d += `M${x + r} ${y} L${x + w - r} ${y} Q${x + w} ${y} ${x + w} ${y + r} ` +
      `L${x + w} ${y + h - r} Q${x + w} ${y + h} ${x + w - r} ${y + h} ` +
      `L${x + r} ${y + h} Q${x} ${y + h} ${x} ${y + h - r} ` +
      `L${x} ${y + r} Q${x} ${y} ${x + r} ${y} Z `
  }

  // ---- path ----
  beginPath() { this._path = new Path2DBuilder() }
  moveTo(x, y) { this._path.moveTo(x, y) }
  lineTo(x, y) { this._path.lineTo(x, y) }
  closePath() { this._path.closePath() }
  bezierCurveTo(...args) { this._path.bezierCurveTo(...args) }
  quadraticCurveTo(...args) { this._path.quadraticCurveTo(...args) }
  arc(...args) { this._path.arc(...args) }
  ellipse(x, y, rx, ry, rotation = 0, startAngle = 0, endAngle = Math.PI * 2, anticlockwise = false) {
   
    this._path.d += `M${x + rx * Math.cos(startAngle)} ${y + ry * Math.sin(startAngle)} `
    const steps = 64
    for (let i = 1; i <= steps; i++) {
      const t = startAngle + (endAngle - startAngle) * (i / steps)
      this._path.d += `L${x + rx * Math.cos(t)} ${y + ry * Math.sin(t)} `
    }
  }

  fill() {
    const { fill, opacity } = colorToSvgAttrs(this.fillStyle)
    const svg = `<path d="${this._path.d}" fill="${fill}" fill-opacity="${opacity}" fill-rule="nonzero"/>`
    this._enqueue(() => this._drawSvgOver(svg))
  }

  stroke() {
    const { fill, opacity } = colorToSvgAttrs(this.strokeStyle)
    const svg = `<path d="${this._path.d}" fill="none" stroke="${fill}" stroke-opacity="${opacity}" ` +
      `stroke-width="${this.lineWidth}" stroke-linecap="${this.lineCap}" stroke-linejoin="${this.lineJoin}"/>`
    this._enqueue(() => this._drawSvgOver(svg))
  }

  // ---- image ----
  drawImage(image, ...rest) {
    if (!(image instanceof Image)) throw new Error('drawImage: argumen pertama harus hasil dari loadImage()')

    let sx = 0, sy = 0, sw = image.width, sh = image.height, dx, dy, dw, dh
    if (rest.length === 2) { [dx, dy] = rest; dw = image.width; dh = image.height }
    else if (rest.length === 4) { [dx, dy, dw, dh] = rest }
    else if (rest.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = rest }
    else throw new Error('drawImage: jumlah argumen tidak valid (harus 2, 4, atau 8 argumen setelah image)')

    this._enqueue(async () => {
      let srcBuffer = image._buffer
      const needsCrop = sx !== 0 || sy !== 0 || sw !== image.width || sh !== image.height
      if (needsCrop) {
        srcBuffer = await sharp(image._buffer)
          .extract({ left: Math.round(sx), top: Math.round(sy), width: Math.round(sw), height: Math.round(sh) })
          .png().toBuffer()
      }
      const b64 = srcBuffer.toString('base64')
      const svg = `<image x="${dx}" y="${dy}" width="${dw}" height="${dh}" href="data:image/png;base64,${b64}"/>`
      await this._drawSvgOver(svg)
    })
  }

  // ---- text ----
  _resolveFont() {
    const parsed = parseFontString(this.font)
    const registered = registeredFonts.get(parsed.family.toLowerCase())
    return { ...parsed, fontfile: registered?.path, metrics: registered?.metrics }
  }

  measureText(text) {
    const f = this._resolveFont()
    let width
    if (f.metrics) {
      width = measureAdvance(f.metrics, text, f.size)
    } else {
      width = text.length * f.size * 0.55
    }
    return { width, actualBoundingBoxAscent: f.size * 0.8, actualBoundingBoxDescent: f.size * 0.2 }
  }

  fillText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, this.fillStyle) }
  strokeText(text, x, y, maxWidth) { this._drawText(text, x, y, maxWidth, this.strokeStyle) }

  _drawText(text, x, y, maxWidth, colorInput) {
    this._enqueue(async () => {
      const f = this._resolveFont()
      const pangoFont = toPangoFontString(f)
      const renderWidth = Math.max(64, Math.ceil((maxWidth || this.measureText(text).width) + f.size))

      const textOpts = { text: String(text), font: pangoFont, rgba: true, width: renderWidth, dpi: 72 }
      if (f.fontfile) textOpts.fontfile = f.fontfile

      const { data: alphaLayer, info } = await sharp({ text: textOpts }).png().toBuffer({ resolveWithObject: true })

      const { r, g, b, a } = parseColor(colorInput)
      const tinted = await sharp({
        create: { width: info.width, height: info.height, channels: 4, background: { r, g, b, alpha: a } }
      }).composite([{ input: alphaLayer, blend: 'dest-in' }]).png().toBuffer()

      const b64 = tinted.toString('base64')

      let anchorX = x
      if (this.textAlign === 'center') anchorX = x - info.width / 2
      else if (this.textAlign === 'right' || this.textAlign === 'end') anchorX = x - info.width

      let anchorY = y
      if (this.textBaseline === 'top') anchorY = y
      else if (this.textBaseline === 'middle') anchorY = y - info.height / 2
      else if (this.textBaseline === 'bottom') anchorY = y - info.height
      else anchorY = y - info.height * 0.8 // aproksimasi baseline 'alphabetic'

      const svg = `<image x="${anchorX}" y="${anchorY}" width="${info.width}" height="${info.height}" href="data:image/png;base64,${b64}"/>`
      await this._drawSvgOver(svg)
    })
  }
}

class Canvas {
  constructor(width, height) {
    this.width = width
    this.height = height
    this._raw = Buffer.alloc(width * height * 4) 
    this._queue = Promise.resolve()
    this._error = null
    this._ctx = null
  }

  getContext(type = '2d') {
    if (type !== '2d') throw new Error(`Canvas.getContext: tipe "${type}" tidak didukung, cuma "2d"`)
    if (!this._ctx) this._ctx = new CanvasRenderingContext2D(this)
    return this._ctx
  }

  async _finish() {
    await this._queue
    if (this._error) throw this._error
  }

  async toBuffer(mime = 'image/png') {
    await this._finish()
    const pipeline = sharp(this._raw, { raw: { width: this.width, height: this.height, channels: 4 } })
    if (mime === 'image/jpeg' || mime === 'image/jpg') return pipeline.flatten({ background: '#ffffff' }).jpeg().toBuffer()
    if (mime === 'image/webp') return pipeline.webp().toBuffer()
    return pipeline.png().toBuffer()
  }

  async toDataURL(mime = 'image/png') {
    const buf = await this.toBuffer(mime)
    const mt = mime === 'image/jpeg' || mime === 'image/jpg' ? 'image/jpeg' : mime === 'image/webp' ? 'image/webp' : 'image/png'
    return `data:${mt};base64,${buf.toString('base64')}`
  }
}

function createCanvas(width, height) {
  if (!width || !height) throw new Error('createCanvas: width dan height wajib diisi')
  return new Canvas(width, height)
}

export {
  createCanvas,
  loadImage,
  registerFont,
  Canvas,
  CanvasRenderingContext2D,
  Image
}
