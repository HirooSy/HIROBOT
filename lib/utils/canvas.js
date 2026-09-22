// ============================================================================
//  lib/utils/canvas.js
//  Engine gambar native (tanpa sharp / tanpa dependency npm).
//
//  export { canvas, jimp }
//    - jimp   : pengolah gambar (resize/crop/blur/composite/encode/decode), API mirip jimp
//    - canvas : Canvas 2D (createCanvas/loadImage/registerFont), API mirip node-canvas
//
//  Satu-satunya tool eksternal: ffmpeg, HANYA untuk encode/decode WebP (lewat pipe).
// ============================================================================
import { spawn } from 'node:child_process'
import { promises as fsp, readFileSync } from 'node:fs'

const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg'

// ---------- WebP <-> PNG lewat pipe ffmpeg (tanpa file temp) ----------
function ffmpegPipe(args, input) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', ...args], { stdio: ['pipe', 'pipe', 'pipe'] })
    const out = [], err = []
    p.stdout.on('data', d => out.push(d))
    p.stderr.on('data', d => err.push(d))
    p.on('error', e => reject(new Error(`ffmpeg tidak bisa dijalankan (${FFMPEG}): ${e.message}`)))
    p.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg gagal (kode ${code}): ${Buffer.concat(err).toString().trim().slice(0, 300)}`))
      resolve(Buffer.concat(out))
    })
    p.stdin.on('error', () => {})           // EPIPE kalau ffmpeg berhenti lebih awal
    p.stdin.end(input)
  })
}

// frame pertama saja (sticker animasi -> ambil frame 1), alpha dipertahankan
const webpToPng = buf => ffmpegPipe(['-f', 'webp_pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], buf)

const pngToWebp = (png, { quality = 80, lossless = false } = {}) =>
  ffmpegPipe(['-f', 'png_pipe', '-i', 'pipe:0', '-vcodec', 'libwebp', ...(lossless ? ['-lossless', '1'] : ['-quality', String(quality)]), '-f', 'webp', 'pipe:1'], png)

// ---------- parse warna CSS ----------
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

// ============================================================================
import zlib from "node:zlib"
// ============================================================================
//  PNG codec (pure JS, pakai node:zlib bawaan) - pengganti pngjs
// ============================================================================
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c
  }
  return t
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length)
  out.writeUInt32BE(data.length, 0)
  out.write(type, 4, 'latin1')
  data.copy(out, 8)
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length)
  return out
}

function paeth(a, b, c) {
  const p = a + b - c
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

// Pilih filter per-baris dengan heuristik "minimum sum of absolute differences".
// Tiap filter punya loop sendiri (tanpa percabangan per-byte) supaya JIT bisa mengoptimasinya.
function filterRows(rgba, width, height, bpp) {
  const stride = width * bpp
  const out = Buffer.alloc((stride + 1) * height)
  const c0 = new Uint8Array(stride), c1 = new Uint8Array(stride), c2 = new Uint8Array(stride), c3 = new Uint8Array(stride), c4 = new Uint8Array(stride)
  const cand = [c0, c1, c2, c3, c4]
  const zero = new Uint8Array(stride)
  for (let y = 0; y < height; y++) {
    const ro = y * stride
    const po = y > 0 ? ro - stride : -1
    let s0 = 0, s1 = 0, s2 = 0, s3 = 0, s4 = 0
    for (let i = 0; i < stride; i++) {
      const x = rgba[ro + i]
      const a = i >= bpp ? rgba[ro + i - bpp] : 0
      const b = po >= 0 ? rgba[po + i] : 0
      const c = po >= 0 && i >= bpp ? rgba[po + i - bpp] : 0
      // paeth
      const p = a + b - c
      let pa = p - a; if (pa < 0) pa = -pa
      let pb = p - b; if (pb < 0) pb = -pb
      let pc = p - c; if (pc < 0) pc = -pc
      const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c
      const v0 = x
      const v1 = (x - a) & 255
      const v2 = (x - b) & 255
      const v3 = (x - ((a + b) >> 1)) & 255
      const v4 = (x - pr) & 255
      c0[i] = v0; c1[i] = v1; c2[i] = v2; c3[i] = v3; c4[i] = v4
      s0 += v0 < 128 ? v0 : 256 - v0
      s1 += v1 < 128 ? v1 : 256 - v1
      s2 += v2 < 128 ? v2 : 256 - v2
      s3 += v3 < 128 ? v3 : 256 - v3
      s4 += v4 < 128 ? v4 : 256 - v4
    }
    let best = 0, bs = s0
    if (s1 < bs) { bs = s1; best = 1 }
    if (s2 < bs) { bs = s2; best = 2 }
    if (s3 < bs) { bs = s3; best = 3 }
    if (s4 < bs) { bs = s4; best = 4 }
    const o = y * (stride + 1)
    out[o] = best
    out.set(cand[best], o + 1)
  }
  return out
}

function pngEncode({ data, width, height }, { level = 6, hasAlpha = true } = {}) {
  let raw = data
  let colorType = 6, bpp = 4
  if (!hasAlpha) {
    raw = Buffer.alloc(width * height * 3)
    for (let i = 0, o = 0; i < data.length; i += 4, o += 3) {
      raw[o] = data[i]; raw[o + 1] = data[i + 1]; raw[o + 2] = data[i + 2]
    }
    colorType = 2; bpp = 3
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const idat = zlib.deflateSync(filterRows(raw, width, height, bpp), { level })
  return Buffer.concat([PNG_SIG, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

// Adam7 pass table
const ADAM7 = [
  { x0: 0, y0: 0, dx: 8, dy: 8 }, { x0: 4, y0: 0, dx: 8, dy: 8 },
  { x0: 0, y0: 4, dx: 4, dy: 8 }, { x0: 2, y0: 0, dx: 4, dy: 4 },
  { x0: 0, y0: 2, dx: 2, dy: 4 }, { x0: 1, y0: 0, dx: 2, dy: 2 },
  { x0: 0, y0: 1, dx: 1, dy: 2 }
]

function unfilter(inflated, offset, width, height, bpp, bitsPerPixel) {
  const stride = Math.ceil((width * bitsPerPixel) / 8)
  const out = Buffer.alloc(stride * height)
  let p = offset
  for (let y = 0; y < height; y++) {
    const ft = inflated[p++]
    const rowOff = y * stride
    const prevOff = (y - 1) * stride
    for (let i = 0; i < stride; i++) {
      const x = inflated[p++]
      const a = i >= bpp ? out[rowOff + i - bpp] : 0
      const b = y > 0 ? out[prevOff + i] : 0
      const c = y > 0 && i >= bpp ? out[prevOff + i - bpp] : 0
      let v
      switch (ft) {
        case 0: v = x; break
        case 1: v = x + a; break
        case 2: v = x + b; break
        case 3: v = x + ((a + b) >> 1); break
        case 4: v = x + paeth(a, b, c); break
        default: throw new Error('PNG: filter tidak valid ' + ft)
      }
      out[rowOff + i] = v & 255
    }
  }
  return { data: out, stride, consumed: p - offset }
}

function pngDecode(buf) {
  if (!buf.subarray(0, 8).equals(PNG_SIG)) throw new Error('Bukan file PNG valid')
  let pos = 8
  let width, height, bitDepth, colorType, interlace
  let palette = null, trns = null
  const idats = []
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('latin1', pos + 4, pos + 8)
    const data = buf.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4)
      bitDepth = data[8]; colorType = data[9]; interlace = data[12]
    } else if (type === 'PLTE') palette = data
    else if (type === 'tRNS') trns = data
    else if (type === 'IDAT') idats.push(data)
    else if (type === 'IEND') break
  }
  if (!width) throw new Error('PNG: IHDR hilang')
  const inflated = zlib.inflateSync(Buffer.concat(idats))

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (!channels) throw new Error('PNG: colorType tidak didukung ' + colorType)
  const bitsPerPixel = channels * bitDepth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  const out = Buffer.alloc(width * height * 4)

  const readSample = (row, stride, x, c) => {
    if (bitDepth === 8) return row[x * channels + c]
    if (bitDepth === 16) return row[(x * channels + c) * 2] // ambil high byte
    const bitPos = (x * channels + c) * bitDepth
    const byte = row[bitPos >> 3]
    const shift = 8 - bitDepth - (bitPos & 7)
    return (byte >> shift) & ((1 << bitDepth) - 1)
  }
  const scale = bitDepth < 8 ? 255 / ((1 << bitDepth) - 1) : 1

  const writePixel = (raw, stride, rowStart, x, dstIdx) => {
    const row = raw.subarray(rowStart, rowStart + stride)
    if (colorType === 6) {
      out[dstIdx] = readSample(row, stride, x, 0); out[dstIdx + 1] = readSample(row, stride, x, 1)
      out[dstIdx + 2] = readSample(row, stride, x, 2); out[dstIdx + 3] = readSample(row, stride, x, 3)
    } else if (colorType === 2) {
      const r = readSample(row, stride, x, 0), g = readSample(row, stride, x, 1), b = readSample(row, stride, x, 2)
      out[dstIdx] = r; out[dstIdx + 1] = g; out[dstIdx + 2] = b; out[dstIdx + 3] = 255
      if (trns && bitDepth === 8 && trns.readUInt16BE(0) === r && trns.readUInt16BE(2) === g && trns.readUInt16BE(4) === b) out[dstIdx + 3] = 0
    } else if (colorType === 0) {
      const raw0 = readSample(row, stride, x, 0)
      const v = Math.round(raw0 * scale)
      out[dstIdx] = out[dstIdx + 1] = out[dstIdx + 2] = v
      out[dstIdx + 3] = trns && trns.readUInt16BE(0) === raw0 ? 0 : 255
    } else if (colorType === 4) {
      const v = Math.round(readSample(row, stride, x, 0) * scale)
      out[dstIdx] = out[dstIdx + 1] = out[dstIdx + 2] = v
      out[dstIdx + 3] = readSample(row, stride, x, 1)
    } else if (colorType === 3) {
      const idx = readSample(row, stride, x, 0)
      out[dstIdx] = palette[idx * 3]; out[dstIdx + 1] = palette[idx * 3 + 1]; out[dstIdx + 2] = palette[idx * 3 + 2]
      out[dstIdx + 3] = trns && idx < trns.length ? trns[idx] : 255
    }
  }

  if (!interlace) {
    const { data: raw, stride } = unfilter(inflated, 0, width, height, bpp, bitsPerPixel)
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) writePixel(raw, stride, y * stride, x, (y * width + x) * 4)
  } else {
    let off = 0
    for (const pass of ADAM7) {
      const pw = Math.ceil((width - pass.x0) / pass.dx)
      const ph = Math.ceil((height - pass.y0) / pass.dy)
      if (pw <= 0 || ph <= 0) continue
      const { data: raw, stride, consumed } = unfilter(inflated, off, pw, ph, bpp, bitsPerPixel)
      off += consumed
      for (let y = 0; y < ph; y++)
        for (let x = 0; x < pw; x++)
          writePixel(raw, stride, y * stride, x, ((pass.y0 + y * pass.dy) * width + (pass.x0 + x * pass.dx)) * 4)
    }
  }
  return { data: out, width, height }
}
// ============================================================================
//  JPEG codec - di-inline dari jpeg-js (Adobe/notmasteryet/Eugene Ware)
//  Lisensi asli (BSD-3 Adobe, Apache-2.0 notmasteryet, BSD Eugene Ware) tetap berlaku.
// ============================================================================
const jpegEncode = (function () {
  const btoa = (buf) => Buffer.from(buf).toString('base64');
/*
  Copyright (c) 2008, Adobe Systems Incorporated
  All rights reserved.

  Redistribution and use in source and binary forms, with or without 
  modification, are permitted provided that the following conditions are
  met:

  * Redistributions of source code must retain the above copyright notice, 
    this list of conditions and the following disclaimer.
  
  * Redistributions in binary form must reproduce the above copyright
    notice, this list of conditions and the following disclaimer in the 
    documentation and/or other materials provided with the distribution.
  
  * Neither the name of Adobe Systems Incorporated nor the names of its 
    contributors may be used to endorse or promote products derived from 
    this software without specific prior written permission.

  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS
  IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO,
  THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR
  PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR 
  CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL,
  EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO,
  PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
  PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
  LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
  NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
  SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/
/*
JPEG encoder ported to JavaScript and optimized by Andreas Ritter, www.bytestrom.eu, 11/2009

Basic GUI blocking jpeg encoder
*/


function JPEGEncoder(quality) {
  var self = this;
	var fround = Math.round;
	var ffloor = Math.floor;
	var YTable = new Array(64);
	var UVTable = new Array(64);
	var fdtbl_Y = new Array(64);
	var fdtbl_UV = new Array(64);
	var YDC_HT;
	var UVDC_HT;
	var YAC_HT;
	var UVAC_HT;
	
	var bitcode = new Array(65535);
	var category = new Array(65535);
	var outputfDCTQuant = new Array(64);
	var DU = new Array(64);
	var byteout = [];
	var bytenew = 0;
	var bytepos = 7;
	
	var YDU = new Array(64);
	var UDU = new Array(64);
	var VDU = new Array(64);
	var clt = new Array(256);
	var RGB_YUV_TABLE = new Array(2048);
	var currentQuality;
	
	var ZigZag = [
			 0, 1, 5, 6,14,15,27,28,
			 2, 4, 7,13,16,26,29,42,
			 3, 8,12,17,25,30,41,43,
			 9,11,18,24,31,40,44,53,
			10,19,23,32,39,45,52,54,
			20,22,33,38,46,51,55,60,
			21,34,37,47,50,56,59,61,
			35,36,48,49,57,58,62,63
		];
	
	var std_dc_luminance_nrcodes = [0,0,1,5,1,1,1,1,1,1,0,0,0,0,0,0,0];
	var std_dc_luminance_values = [0,1,2,3,4,5,6,7,8,9,10,11];
	var std_ac_luminance_nrcodes = [0,0,2,1,3,3,2,4,3,5,5,4,4,0,0,1,0x7d];
	var std_ac_luminance_values = [
			0x01,0x02,0x03,0x00,0x04,0x11,0x05,0x12,
			0x21,0x31,0x41,0x06,0x13,0x51,0x61,0x07,
			0x22,0x71,0x14,0x32,0x81,0x91,0xa1,0x08,
			0x23,0x42,0xb1,0xc1,0x15,0x52,0xd1,0xf0,
			0x24,0x33,0x62,0x72,0x82,0x09,0x0a,0x16,
			0x17,0x18,0x19,0x1a,0x25,0x26,0x27,0x28,
			0x29,0x2a,0x34,0x35,0x36,0x37,0x38,0x39,
			0x3a,0x43,0x44,0x45,0x46,0x47,0x48,0x49,
			0x4a,0x53,0x54,0x55,0x56,0x57,0x58,0x59,
			0x5a,0x63,0x64,0x65,0x66,0x67,0x68,0x69,
			0x6a,0x73,0x74,0x75,0x76,0x77,0x78,0x79,
			0x7a,0x83,0x84,0x85,0x86,0x87,0x88,0x89,
			0x8a,0x92,0x93,0x94,0x95,0x96,0x97,0x98,
			0x99,0x9a,0xa2,0xa3,0xa4,0xa5,0xa6,0xa7,
			0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,0xb5,0xb6,
			0xb7,0xb8,0xb9,0xba,0xc2,0xc3,0xc4,0xc5,
			0xc6,0xc7,0xc8,0xc9,0xca,0xd2,0xd3,0xd4,
			0xd5,0xd6,0xd7,0xd8,0xd9,0xda,0xe1,0xe2,
			0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,0xea,
			0xf1,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
			0xf9,0xfa
		];
	
	var std_dc_chrominance_nrcodes = [0,0,3,1,1,1,1,1,1,1,1,1,0,0,0,0,0];
	var std_dc_chrominance_values = [0,1,2,3,4,5,6,7,8,9,10,11];
	var std_ac_chrominance_nrcodes = [0,0,2,1,2,4,4,3,4,7,5,4,4,0,1,2,0x77];
	var std_ac_chrominance_values = [
			0x00,0x01,0x02,0x03,0x11,0x04,0x05,0x21,
			0x31,0x06,0x12,0x41,0x51,0x07,0x61,0x71,
			0x13,0x22,0x32,0x81,0x08,0x14,0x42,0x91,
			0xa1,0xb1,0xc1,0x09,0x23,0x33,0x52,0xf0,
			0x15,0x62,0x72,0xd1,0x0a,0x16,0x24,0x34,
			0xe1,0x25,0xf1,0x17,0x18,0x19,0x1a,0x26,
			0x27,0x28,0x29,0x2a,0x35,0x36,0x37,0x38,
			0x39,0x3a,0x43,0x44,0x45,0x46,0x47,0x48,
			0x49,0x4a,0x53,0x54,0x55,0x56,0x57,0x58,
			0x59,0x5a,0x63,0x64,0x65,0x66,0x67,0x68,
			0x69,0x6a,0x73,0x74,0x75,0x76,0x77,0x78,
			0x79,0x7a,0x82,0x83,0x84,0x85,0x86,0x87,
			0x88,0x89,0x8a,0x92,0x93,0x94,0x95,0x96,
			0x97,0x98,0x99,0x9a,0xa2,0xa3,0xa4,0xa5,
			0xa6,0xa7,0xa8,0xa9,0xaa,0xb2,0xb3,0xb4,
			0xb5,0xb6,0xb7,0xb8,0xb9,0xba,0xc2,0xc3,
			0xc4,0xc5,0xc6,0xc7,0xc8,0xc9,0xca,0xd2,
			0xd3,0xd4,0xd5,0xd6,0xd7,0xd8,0xd9,0xda,
			0xe2,0xe3,0xe4,0xe5,0xe6,0xe7,0xe8,0xe9,
			0xea,0xf2,0xf3,0xf4,0xf5,0xf6,0xf7,0xf8,
			0xf9,0xfa
		];
	
	function initQuantTables(sf){
			var YQT = [
				16, 11, 10, 16, 24, 40, 51, 61,
				12, 12, 14, 19, 26, 58, 60, 55,
				14, 13, 16, 24, 40, 57, 69, 56,
				14, 17, 22, 29, 51, 87, 80, 62,
				18, 22, 37, 56, 68,109,103, 77,
				24, 35, 55, 64, 81,104,113, 92,
				49, 64, 78, 87,103,121,120,101,
				72, 92, 95, 98,112,100,103, 99
			];
			
			for (var i = 0; i < 64; i++) {
				var t = ffloor((YQT[i]*sf+50)/100);
				if (t < 1) {
					t = 1;
				} else if (t > 255) {
					t = 255;
				}
				YTable[ZigZag[i]] = t;
			}
			var UVQT = [
				17, 18, 24, 47, 99, 99, 99, 99,
				18, 21, 26, 66, 99, 99, 99, 99,
				24, 26, 56, 99, 99, 99, 99, 99,
				47, 66, 99, 99, 99, 99, 99, 99,
				99, 99, 99, 99, 99, 99, 99, 99,
				99, 99, 99, 99, 99, 99, 99, 99,
				99, 99, 99, 99, 99, 99, 99, 99,
				99, 99, 99, 99, 99, 99, 99, 99
			];
			for (var j = 0; j < 64; j++) {
				var u = ffloor((UVQT[j]*sf+50)/100);
				if (u < 1) {
					u = 1;
				} else if (u > 255) {
					u = 255;
				}
				UVTable[ZigZag[j]] = u;
			}
			var aasf = [
				1.0, 1.387039845, 1.306562965, 1.175875602,
				1.0, 0.785694958, 0.541196100, 0.275899379
			];
			var k = 0;
			for (var row = 0; row < 8; row++)
			{
				for (var col = 0; col < 8; col++)
				{
					fdtbl_Y[k]  = (1.0 / (YTable [ZigZag[k]] * aasf[row] * aasf[col] * 8.0));
					fdtbl_UV[k] = (1.0 / (UVTable[ZigZag[k]] * aasf[row] * aasf[col] * 8.0));
					k++;
				}
			}
		}
		
		function computeHuffmanTbl(nrcodes, std_table){
			var codevalue = 0;
			var pos_in_table = 0;
			var HT = new Array();
			for (var k = 1; k <= 16; k++) {
				for (var j = 1; j <= nrcodes[k]; j++) {
					HT[std_table[pos_in_table]] = [];
					HT[std_table[pos_in_table]][0] = codevalue;
					HT[std_table[pos_in_table]][1] = k;
					pos_in_table++;
					codevalue++;
				}
				codevalue*=2;
			}
			return HT;
		}
		
		function initHuffmanTbl()
		{
			YDC_HT = computeHuffmanTbl(std_dc_luminance_nrcodes,std_dc_luminance_values);
			UVDC_HT = computeHuffmanTbl(std_dc_chrominance_nrcodes,std_dc_chrominance_values);
			YAC_HT = computeHuffmanTbl(std_ac_luminance_nrcodes,std_ac_luminance_values);
			UVAC_HT = computeHuffmanTbl(std_ac_chrominance_nrcodes,std_ac_chrominance_values);
		}
	
		function initCategoryNumber()
		{
			var nrlower = 1;
			var nrupper = 2;
			for (var cat = 1; cat <= 15; cat++) {
				//Positive numbers
				for (var nr = nrlower; nr<nrupper; nr++) {
					category[32767+nr] = cat;
					bitcode[32767+nr] = [];
					bitcode[32767+nr][1] = cat;
					bitcode[32767+nr][0] = nr;
				}
				//Negative numbers
				for (var nrneg =-(nrupper-1); nrneg<=-nrlower; nrneg++) {
					category[32767+nrneg] = cat;
					bitcode[32767+nrneg] = [];
					bitcode[32767+nrneg][1] = cat;
					bitcode[32767+nrneg][0] = nrupper-1+nrneg;
				}
				nrlower <<= 1;
				nrupper <<= 1;
			}
		}
		
		function initRGBYUVTable() {
			for(var i = 0; i < 256;i++) {
				RGB_YUV_TABLE[i]      		=  19595 * i;
				RGB_YUV_TABLE[(i+ 256)>>0] 	=  38470 * i;
				RGB_YUV_TABLE[(i+ 512)>>0] 	=   7471 * i + 0x8000;
				RGB_YUV_TABLE[(i+ 768)>>0] 	= -11059 * i;
				RGB_YUV_TABLE[(i+1024)>>0] 	= -21709 * i;
				RGB_YUV_TABLE[(i+1280)>>0] 	=  32768 * i + 0x807FFF;
				RGB_YUV_TABLE[(i+1536)>>0] 	= -27439 * i;
				RGB_YUV_TABLE[(i+1792)>>0] 	= - 5329 * i;
			}
		}
		
		// IO functions
		function writeBits(bs)
		{
			var value = bs[0];
			var posval = bs[1]-1;
			while ( posval >= 0 ) {
				if (value & (1 << posval) ) {
					bytenew |= (1 << bytepos);
				}
				posval--;
				bytepos--;
				if (bytepos < 0) {
					if (bytenew == 0xFF) {
						writeByte(0xFF);
						writeByte(0);
					}
					else {
						writeByte(bytenew);
					}
					bytepos=7;
					bytenew=0;
				}
			}
		}
	
		function writeByte(value)
		{
			//byteout.push(clt[value]); // write char directly instead of converting later
      byteout.push(value);
		}
	
		function writeWord(value)
		{
			writeByte((value>>8)&0xFF);
			writeByte((value   )&0xFF);
		}
		
		// DCT & quantization core
		function fDCTQuant(data, fdtbl)
		{
			var d0, d1, d2, d3, d4, d5, d6, d7;
			/* Pass 1: process rows. */
			var dataOff=0;
			var i;
			var I8 = 8;
			var I64 = 64;
			for (i=0; i<I8; ++i)
			{
				d0 = data[dataOff];
				d1 = data[dataOff+1];
				d2 = data[dataOff+2];
				d3 = data[dataOff+3];
				d4 = data[dataOff+4];
				d5 = data[dataOff+5];
				d6 = data[dataOff+6];
				d7 = data[dataOff+7];
				
				var tmp0 = d0 + d7;
				var tmp7 = d0 - d7;
				var tmp1 = d1 + d6;
				var tmp6 = d1 - d6;
				var tmp2 = d2 + d5;
				var tmp5 = d2 - d5;
				var tmp3 = d3 + d4;
				var tmp4 = d3 - d4;
	
				/* Even part */
				var tmp10 = tmp0 + tmp3;	/* phase 2 */
				var tmp13 = tmp0 - tmp3;
				var tmp11 = tmp1 + tmp2;
				var tmp12 = tmp1 - tmp2;
	
				data[dataOff] = tmp10 + tmp11; /* phase 3 */
				data[dataOff+4] = tmp10 - tmp11;
	
				var z1 = (tmp12 + tmp13) * 0.707106781; /* c4 */
				data[dataOff+2] = tmp13 + z1; /* phase 5 */
				data[dataOff+6] = tmp13 - z1;
	
				/* Odd part */
				tmp10 = tmp4 + tmp5; /* phase 2 */
				tmp11 = tmp5 + tmp6;
				tmp12 = tmp6 + tmp7;
	
				/* The rotator is modified from fig 4-8 to avoid extra negations. */
				var z5 = (tmp10 - tmp12) * 0.382683433; /* c6 */
				var z2 = 0.541196100 * tmp10 + z5; /* c2-c6 */
				var z4 = 1.306562965 * tmp12 + z5; /* c2+c6 */
				var z3 = tmp11 * 0.707106781; /* c4 */
	
				var z11 = tmp7 + z3;	/* phase 5 */
				var z13 = tmp7 - z3;
	
				data[dataOff+5] = z13 + z2;	/* phase 6 */
				data[dataOff+3] = z13 - z2;
				data[dataOff+1] = z11 + z4;
				data[dataOff+7] = z11 - z4;
	
				dataOff += 8; /* advance pointer to next row */
			}
	
			/* Pass 2: process columns. */
			dataOff = 0;
			for (i=0; i<I8; ++i)
			{
				d0 = data[dataOff];
				d1 = data[dataOff + 8];
				d2 = data[dataOff + 16];
				d3 = data[dataOff + 24];
				d4 = data[dataOff + 32];
				d5 = data[dataOff + 40];
				d6 = data[dataOff + 48];
				d7 = data[dataOff + 56];
				
				var tmp0p2 = d0 + d7;
				var tmp7p2 = d0 - d7;
				var tmp1p2 = d1 + d6;
				var tmp6p2 = d1 - d6;
				var tmp2p2 = d2 + d5;
				var tmp5p2 = d2 - d5;
				var tmp3p2 = d3 + d4;
				var tmp4p2 = d3 - d4;
	
				/* Even part */
				var tmp10p2 = tmp0p2 + tmp3p2;	/* phase 2 */
				var tmp13p2 = tmp0p2 - tmp3p2;
				var tmp11p2 = tmp1p2 + tmp2p2;
				var tmp12p2 = tmp1p2 - tmp2p2;
	
				data[dataOff] = tmp10p2 + tmp11p2; /* phase 3 */
				data[dataOff+32] = tmp10p2 - tmp11p2;
	
				var z1p2 = (tmp12p2 + tmp13p2) * 0.707106781; /* c4 */
				data[dataOff+16] = tmp13p2 + z1p2; /* phase 5 */
				data[dataOff+48] = tmp13p2 - z1p2;
	
				/* Odd part */
				tmp10p2 = tmp4p2 + tmp5p2; /* phase 2 */
				tmp11p2 = tmp5p2 + tmp6p2;
				tmp12p2 = tmp6p2 + tmp7p2;
	
				/* The rotator is modified from fig 4-8 to avoid extra negations. */
				var z5p2 = (tmp10p2 - tmp12p2) * 0.382683433; /* c6 */
				var z2p2 = 0.541196100 * tmp10p2 + z5p2; /* c2-c6 */
				var z4p2 = 1.306562965 * tmp12p2 + z5p2; /* c2+c6 */
				var z3p2 = tmp11p2 * 0.707106781; /* c4 */
	
				var z11p2 = tmp7p2 + z3p2;	/* phase 5 */
				var z13p2 = tmp7p2 - z3p2;
	
				data[dataOff+40] = z13p2 + z2p2; /* phase 6 */
				data[dataOff+24] = z13p2 - z2p2;
				data[dataOff+ 8] = z11p2 + z4p2;
				data[dataOff+56] = z11p2 - z4p2;
	
				dataOff++; /* advance pointer to next column */
			}
	
			// Quantize/descale the coefficients
			var fDCTQuant;
			for (i=0; i<I64; ++i)
			{
				// Apply the quantization and scaling factor & Round to nearest integer
				fDCTQuant = data[i]*fdtbl[i];
				outputfDCTQuant[i] = (fDCTQuant > 0.0) ? ((fDCTQuant + 0.5)|0) : ((fDCTQuant - 0.5)|0);
				//outputfDCTQuant[i] = fround(fDCTQuant);

			}
			return outputfDCTQuant;
		}
		
		function writeAPP0()
		{
			writeWord(0xFFE0); // marker
			writeWord(16); // length
			writeByte(0x4A); // J
			writeByte(0x46); // F
			writeByte(0x49); // I
			writeByte(0x46); // F
			writeByte(0); // = "JFIF",'\0'
			writeByte(1); // versionhi
			writeByte(1); // versionlo
			writeByte(0); // xyunits
			writeWord(1); // xdensity
			writeWord(1); // ydensity
			writeByte(0); // thumbnwidth
			writeByte(0); // thumbnheight
		}

		function writeAPP1(exifBuffer) {
			if (!exifBuffer) return;

			writeWord(0xFFE1); // APP1 marker

			if (exifBuffer[0] === 0x45 &&
					exifBuffer[1] === 0x78 &&
					exifBuffer[2] === 0x69 &&
					exifBuffer[3] === 0x66) {
				// Buffer already starts with EXIF, just use it directly
				writeWord(exifBuffer.length + 2); // length is buffer + length itself!
			} else {
				// Buffer doesn't start with EXIF, write it for them
				writeWord(exifBuffer.length + 5 + 2); // length is buffer + EXIF\0 + length itself!
				writeByte(0x45); // E
				writeByte(0x78); // X
				writeByte(0x69); // I
				writeByte(0x66); // F
				writeByte(0); // = "EXIF",'\0'
			}

			for (var i = 0; i < exifBuffer.length; i++) {
				writeByte(exifBuffer[i]);
			}
		}

		function writeSOF0(width, height)
		{
			writeWord(0xFFC0); // marker
			writeWord(17);   // length, truecolor YUV JPG
			writeByte(8);    // precision
			writeWord(height);
			writeWord(width);
			writeByte(3);    // nrofcomponents
			writeByte(1);    // IdY
			writeByte(0x11); // HVY
			writeByte(0);    // QTY
			writeByte(2);    // IdU
			writeByte(0x11); // HVU
			writeByte(1);    // QTU
			writeByte(3);    // IdV
			writeByte(0x11); // HVV
			writeByte(1);    // QTV
		}
	
		function writeDQT()
		{
			writeWord(0xFFDB); // marker
			writeWord(132);	   // length
			writeByte(0);
			for (var i=0; i<64; i++) {
				writeByte(YTable[i]);
			}
			writeByte(1);
			for (var j=0; j<64; j++) {
				writeByte(UVTable[j]);
			}
		}
	
		function writeDHT()
		{
			writeWord(0xFFC4); // marker
			writeWord(0x01A2); // length
	
			writeByte(0); // HTYDCinfo
			for (var i=0; i<16; i++) {
				writeByte(std_dc_luminance_nrcodes[i+1]);
			}
			for (var j=0; j<=11; j++) {
				writeByte(std_dc_luminance_values[j]);
			}
	
			writeByte(0x10); // HTYACinfo
			for (var k=0; k<16; k++) {
				writeByte(std_ac_luminance_nrcodes[k+1]);
			}
			for (var l=0; l<=161; l++) {
				writeByte(std_ac_luminance_values[l]);
			}
	
			writeByte(1); // HTUDCinfo
			for (var m=0; m<16; m++) {
				writeByte(std_dc_chrominance_nrcodes[m+1]);
			}
			for (var n=0; n<=11; n++) {
				writeByte(std_dc_chrominance_values[n]);
			}
	
			writeByte(0x11); // HTUACinfo
			for (var o=0; o<16; o++) {
				writeByte(std_ac_chrominance_nrcodes[o+1]);
			}
			for (var p=0; p<=161; p++) {
				writeByte(std_ac_chrominance_values[p]);
			}
		}
		
		function writeCOM(comments)
		{
			if (typeof comments === "undefined" || comments.constructor !== Array) return;
			comments.forEach(e => {
				if (typeof e !== "string") return;
				writeWord(0xFFFE); // marker
				var l = e.length;
				writeWord(l + 2); // length itself as well
				var i;
				for (i = 0; i < l; i++)
					writeByte(e.charCodeAt(i));
			});
		}
	
		function writeSOS()
		{
			writeWord(0xFFDA); // marker
			writeWord(12); // length
			writeByte(3); // nrofcomponents
			writeByte(1); // IdY
			writeByte(0); // HTY
			writeByte(2); // IdU
			writeByte(0x11); // HTU
			writeByte(3); // IdV
			writeByte(0x11); // HTV
			writeByte(0); // Ss
			writeByte(0x3f); // Se
			writeByte(0); // Bf
		}
		
		function processDU(CDU, fdtbl, DC, HTDC, HTAC){
			var EOB = HTAC[0x00];
			var M16zeroes = HTAC[0xF0];
			var pos;
			var I16 = 16;
			var I63 = 63;
			var I64 = 64;
			var DU_DCT = fDCTQuant(CDU, fdtbl);
			//ZigZag reorder
			for (var j=0;j<I64;++j) {
				DU[ZigZag[j]]=DU_DCT[j];
			}
			var Diff = DU[0] - DC; DC = DU[0];
			//Encode DC
			if (Diff==0) {
				writeBits(HTDC[0]); // Diff might be 0
			} else {
				pos = 32767+Diff;
				writeBits(HTDC[category[pos]]);
				writeBits(bitcode[pos]);
			}
			//Encode ACs
			var end0pos = 63; // was const... which is crazy
			for (; (end0pos>0)&&(DU[end0pos]==0); end0pos--) {};
			//end0pos = first element in reverse order !=0
			if ( end0pos == 0) {
				writeBits(EOB);
				return DC;
			}
			var i = 1;
			var lng;
			while ( i <= end0pos ) {
				var startpos = i;
				for (; (DU[i]==0) && (i<=end0pos); ++i) {}
				var nrzeroes = i-startpos;
				if ( nrzeroes >= I16 ) {
					lng = nrzeroes>>4;
					for (var nrmarker=1; nrmarker <= lng; ++nrmarker)
						writeBits(M16zeroes);
					nrzeroes = nrzeroes&0xF;
				}
				pos = 32767+DU[i];
				writeBits(HTAC[(nrzeroes<<4)+category[pos]]);
				writeBits(bitcode[pos]);
				i++;
			}
			if ( end0pos != I63 ) {
				writeBits(EOB);
			}
			return DC;
		}

		function initCharLookupTable(){
			var sfcc = String.fromCharCode;
			for(var i=0; i < 256; i++){ ///// ACHTUNG // 255
				clt[i] = sfcc(i);
			}
		}
		
		this.encode = function(image,quality) // image data object
		{
			var time_start = new Date().getTime();
			
			if(quality) setQuality(quality);
			
			// Initialize bit writer
			byteout = new Array();
			bytenew=0;
			bytepos=7;
	
			// Add JPEG headers
			writeWord(0xFFD8); // SOI
			writeAPP0();
			writeCOM(image.comments);
			writeAPP1(image.exifBuffer);
			writeDQT();
			writeSOF0(image.width,image.height);
			writeDHT();
			writeSOS();

	
			// Encode 8x8 macroblocks
			var DCY=0;
			var DCU=0;
			var DCV=0;
			
			bytenew=0;
			bytepos=7;
			
			
			this.encode.displayName = "_encode_";

			var imageData = image.data;
			var width = image.width;
			var height = image.height;

			var quadWidth = width*4;
			var tripleWidth = width*3;
			
			var x, y = 0;
			var r, g, b;
			var start,p, col,row,pos;
			while(y < height){
				x = 0;
				while(x < quadWidth){
				start = quadWidth * y + x;
				p = start;
				col = -1;
				row = 0;
				
				for(pos=0; pos < 64; pos++){
					row = pos >> 3;// /8
					col = ( pos & 7 ) * 4; // %8
					p = start + ( row * quadWidth ) + col;		
					
					if(y+row >= height){ // padding bottom
						p-= (quadWidth*(y+1+row-height));
					}

					if(x+col >= quadWidth){ // padding right	
						p-= ((x+col) - quadWidth +4)
					}
					
					r = imageData[ p++ ];
					g = imageData[ p++ ];
					b = imageData[ p++ ];
					
					
					/* // calculate YUV values dynamically
					YDU[pos]=((( 0.29900)*r+( 0.58700)*g+( 0.11400)*b))-128; //-0x80
					UDU[pos]=(((-0.16874)*r+(-0.33126)*g+( 0.50000)*b));
					VDU[pos]=((( 0.50000)*r+(-0.41869)*g+(-0.08131)*b));
					*/
					
					// use lookup table (slightly faster)
					YDU[pos] = ((RGB_YUV_TABLE[r]             + RGB_YUV_TABLE[(g +  256)>>0] + RGB_YUV_TABLE[(b +  512)>>0]) >> 16)-128;
					UDU[pos] = ((RGB_YUV_TABLE[(r +  768)>>0] + RGB_YUV_TABLE[(g + 1024)>>0] + RGB_YUV_TABLE[(b + 1280)>>0]) >> 16)-128;
					VDU[pos] = ((RGB_YUV_TABLE[(r + 1280)>>0] + RGB_YUV_TABLE[(g + 1536)>>0] + RGB_YUV_TABLE[(b + 1792)>>0]) >> 16)-128;

				}
				
				DCY = processDU(YDU, fdtbl_Y, DCY, YDC_HT, YAC_HT);
				DCU = processDU(UDU, fdtbl_UV, DCU, UVDC_HT, UVAC_HT);
				DCV = processDU(VDU, fdtbl_UV, DCV, UVDC_HT, UVAC_HT);
				x+=32;
				}
				y+=8;
			}
			
			
			////////////////////////////////////////////////////////////////
	
			// Do the bit alignment of the EOI marker
			if ( bytepos >= 0 ) {
				var fillbits = [];
				fillbits[1] = bytepos+1;
				fillbits[0] = (1<<(bytepos+1))-1;
				writeBits(fillbits);
			}
	
			writeWord(0xFFD9); //EOI

			if (typeof module === 'undefined') return new Uint8Array(byteout);
      return Buffer.from(byteout);

			var jpegDataUri = 'data:image/jpeg;base64,' + btoa(byteout.join(''));
			
			byteout = [];
			
			// benchmarking
			var duration = new Date().getTime() - time_start;
    		//console.log('Encoding time: '+ duration + 'ms');
    		//
			
			return jpegDataUri			
	}
	
	function setQuality(quality){
		if (quality <= 0) {
			quality = 1;
		}
		if (quality > 100) {
			quality = 100;
		}
		
		if(currentQuality == quality) return // don't recalc if unchanged
		
		var sf = 0;
		if (quality < 50) {
			sf = Math.floor(5000 / quality);
		} else {
			sf = Math.floor(200 - quality*2);
		}
		
		initQuantTables(sf);
		currentQuality = quality;
		//console.log('Quality set to: '+quality +'%');
	}
	
	function init(){
		var time_start = new Date().getTime();
		if(!quality) quality = 50;
		// Create tables
		initCharLookupTable()
		initHuffmanTbl();
		initCategoryNumber();
		initRGBYUVTable();
		
		setQuality(quality);
		var duration = new Date().getTime() - time_start;
    	//console.log('Initialization '+ duration + 'ms');
	}
	
	init();
	
};


function encode(imgData, qu) {
  if (typeof qu === 'undefined') qu = 50;
  var encoder = new JPEGEncoder(qu);
	var data = encoder.encode(imgData, qu);
  return {
    data: data,
    width: imgData.width,
    height: imgData.height,
  };
}


  return encode;
})();

const jpegDecode = (function () {
/* -*- tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- /
/* vim: set shiftwidth=2 tabstop=2 autoindent cindent expandtab: */
/*
   Copyright 2011 notmasteryet

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.
*/

// - The JPEG specification can be found in the ITU CCITT Recommendation T.81
//   (www.w3.org/Graphics/JPEG/itu-t81.pdf)
// - The JFIF specification can be found in the JPEG File Interchange Format
//   (www.w3.org/Graphics/JPEG/jfif3.pdf)
// - The Adobe Application-Specific JPEG markers in the Supporting the DCT Filters
//   in PostScript Level 2, Technical Note #5116
//   (partners.adobe.com/public/developer/en/ps/sdk/5116.DCT_Filter.pdf)

var JpegImage = (function jpegImage() {
  "use strict";
  var dctZigZag = new Int32Array([
     0,
     1,  8,
    16,  9,  2,
     3, 10, 17, 24,
    32, 25, 18, 11, 4,
     5, 12, 19, 26, 33, 40,
    48, 41, 34, 27, 20, 13,  6,
     7, 14, 21, 28, 35, 42, 49, 56,
    57, 50, 43, 36, 29, 22, 15,
    23, 30, 37, 44, 51, 58,
    59, 52, 45, 38, 31,
    39, 46, 53, 60,
    61, 54, 47,
    55, 62,
    63
  ]);

  var dctCos1  =  4017   // cos(pi/16)
  var dctSin1  =   799   // sin(pi/16)
  var dctCos3  =  3406   // cos(3*pi/16)
  var dctSin3  =  2276   // sin(3*pi/16)
  var dctCos6  =  1567   // cos(6*pi/16)
  var dctSin6  =  3784   // sin(6*pi/16)
  var dctSqrt2 =  5793   // sqrt(2)
  var dctSqrt1d2 = 2896  // sqrt(2) / 2

  function constructor() {
  }

  function buildHuffmanTable(codeLengths, values) {
    var k = 0, code = [], i, j, length = 16;
    while (length > 0 && !codeLengths[length - 1])
      length--;
    code.push({children: [], index: 0});
    var p = code[0], q;
    for (i = 0; i < length; i++) {
      for (j = 0; j < codeLengths[i]; j++) {
        p = code.pop();
        p.children[p.index] = values[k];
        while (p.index > 0) {
          if (code.length === 0)
            throw new Error('Could not recreate Huffman Table');
          p = code.pop();
        }
        p.index++;
        code.push(p);
        while (code.length <= i) {
          code.push(q = {children: [], index: 0});
          p.children[p.index] = q.children;
          p = q;
        }
        k++;
      }
      if (i + 1 < length) {
        // p here points to last code
        code.push(q = {children: [], index: 0});
        p.children[p.index] = q.children;
        p = q;
      }
    }
    return code[0].children;
  }

  function decodeScan(data, offset,
                      frame, components, resetInterval,
                      spectralStart, spectralEnd,
                      successivePrev, successive, opts) {
    var precision = frame.precision;
    var samplesPerLine = frame.samplesPerLine;
    var scanLines = frame.scanLines;
    var mcusPerLine = frame.mcusPerLine;
    var progressive = frame.progressive;
    var maxH = frame.maxH, maxV = frame.maxV;

    var startOffset = offset, bitsData = 0, bitsCount = 0;
    function readBit() {
      if (bitsCount > 0) {
        bitsCount--;
        return (bitsData >> bitsCount) & 1;
      }
      bitsData = data[offset++];
      if (bitsData == 0xFF) {
        var nextByte = data[offset++];
        if (nextByte) {
          throw new Error("unexpected marker: " + ((bitsData << 8) | nextByte).toString(16));
        }
        // unstuff 0
      }
      bitsCount = 7;
      return bitsData >>> 7;
    }
    function decodeHuffman(tree) {
      var node = tree, bit;
      while ((bit = readBit()) !== null) {
        node = node[bit];
        if (typeof node === 'number')
          return node;
        if (typeof node !== 'object')
          throw new Error("invalid huffman sequence");
      }
      return null;
    }
    function receive(length) {
      var n = 0;
      while (length > 0) {
        var bit = readBit();
        if (bit === null) return;
        n = (n << 1) | bit;
        length--;
      }
      return n;
    }
    function receiveAndExtend(length) {
      var n = receive(length);
      if (n >= 1 << (length - 1))
        return n;
      return n + (-1 << length) + 1;
    }
    function decodeBaseline(component, zz) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : receiveAndExtend(t);
      zz[0]= (component.pred += diff);
      var k = 1;
      while (k < 64) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15)
            break;
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        zz[z] = receiveAndExtend(s);
        k++;
      }
    }
    function decodeDCFirst(component, zz) {
      var t = decodeHuffman(component.huffmanTableDC);
      var diff = t === 0 ? 0 : (receiveAndExtend(t) << successive);
      zz[0] = (component.pred += diff);
    }
    function decodeDCSuccessive(component, zz) {
      zz[0] |= readBit() << successive;
    }
    var eobrun = 0;
    function decodeACFirst(component, zz) {
      if (eobrun > 0) {
        eobrun--;
        return;
      }
      var k = spectralStart, e = spectralEnd;
      while (k <= e) {
        var rs = decodeHuffman(component.huffmanTableAC);
        var s = rs & 15, r = rs >> 4;
        if (s === 0) {
          if (r < 15) {
            eobrun = receive(r) + (1 << r) - 1;
            break;
          }
          k += 16;
          continue;
        }
        k += r;
        var z = dctZigZag[k];
        zz[z] = receiveAndExtend(s) * (1 << successive);
        k++;
      }
    }
    var successiveACState = 0, successiveACNextValue;
    function decodeACSuccessive(component, zz) {
      var k = spectralStart, e = spectralEnd, r = 0;
      while (k <= e) {
        var z = dctZigZag[k];
        var direction = zz[z] < 0 ? -1 : 1;
        switch (successiveACState) {
        case 0: // initial state
          var rs = decodeHuffman(component.huffmanTableAC);
          var s = rs & 15, r = rs >> 4;
          if (s === 0) {
            if (r < 15) {
              eobrun = receive(r) + (1 << r);
              successiveACState = 4;
            } else {
              r = 16;
              successiveACState = 1;
            }
          } else {
            if (s !== 1)
              throw new Error("invalid ACn encoding");
            successiveACNextValue = receiveAndExtend(s);
            successiveACState = r ? 2 : 3;
          }
          continue;
        case 1: // skipping r zero items
        case 2:
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          else {
            r--;
            if (r === 0)
              successiveACState = successiveACState == 2 ? 3 : 0;
          }
          break;
        case 3: // set value for a zero item
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          else {
            zz[z] = successiveACNextValue << successive;
            successiveACState = 0;
          }
          break;
        case 4: // eob
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          break;
        }
        k++;
      }
      if (successiveACState === 4) {
        eobrun--;
        if (eobrun === 0)
          successiveACState = 0;
      }
    }
    function decodeMcu(component, decode, mcu, row, col) {
      var mcuRow = (mcu / mcusPerLine) | 0;
      var mcuCol = mcu % mcusPerLine;
      var blockRow = mcuRow * component.v + row;
      var blockCol = mcuCol * component.h + col;
      // If the block is missing and we're in tolerant mode, just skip it.
      if (component.blocks[blockRow] === undefined && opts.tolerantDecoding)
        return;
      decode(component, component.blocks[blockRow][blockCol]);
    }
    function decodeBlock(component, decode, mcu) {
      var blockRow = (mcu / component.blocksPerLine) | 0;
      var blockCol = mcu % component.blocksPerLine;
      // If the block is missing and we're in tolerant mode, just skip it.
      if (component.blocks[blockRow] === undefined && opts.tolerantDecoding)
        return;
      decode(component, component.blocks[blockRow][blockCol]);
    }

    var componentsLength = components.length;
    var component, i, j, k, n;
    var decodeFn;
    if (progressive) {
      if (spectralStart === 0)
        decodeFn = successivePrev === 0 ? decodeDCFirst : decodeDCSuccessive;
      else
        decodeFn = successivePrev === 0 ? decodeACFirst : decodeACSuccessive;
    } else {
      decodeFn = decodeBaseline;
    }

    var mcu = 0, marker;
    var mcuExpected;
    if (componentsLength == 1) {
      mcuExpected = components[0].blocksPerLine * components[0].blocksPerColumn;
    } else {
      mcuExpected = mcusPerLine * frame.mcusPerColumn;
    }
    if (!resetInterval) resetInterval = mcuExpected;

    var h, v;
    while (mcu < mcuExpected) {
      // reset interval stuff
      for (i = 0; i < componentsLength; i++)
        components[i].pred = 0;
      eobrun = 0;

      if (componentsLength == 1) {
        component = components[0];
        for (n = 0; n < resetInterval; n++) {
          decodeBlock(component, decodeFn, mcu);
          mcu++;
        }
      } else {
        for (n = 0; n < resetInterval; n++) {
          for (i = 0; i < componentsLength; i++) {
            component = components[i];
            h = component.h;
            v = component.v;
            for (j = 0; j < v; j++) {
              for (k = 0; k < h; k++) {
                decodeMcu(component, decodeFn, mcu, j, k);
              }
            }
          }
          mcu++;

          // If we've reached our expected MCU's, stop decoding
          if (mcu === mcuExpected) break;
        }
      }

      if (mcu === mcuExpected) {
        // Skip trailing bytes at the end of the scan - until we reach the next marker
        do {
          if (data[offset] === 0xFF) {
            if (data[offset + 1] !== 0x00) {
              break;
            }
          }
          offset += 1;
        } while (offset < data.length - 2);
      }

      // find marker
      bitsCount = 0;
      marker = (data[offset] << 8) | data[offset + 1];
      if (marker < 0xFF00) {
        throw new Error("marker was not found");
      }

      if (marker >= 0xFFD0 && marker <= 0xFFD7) { // RSTx
        offset += 2;
      }
      else
        break;
    }

    return offset - startOffset;
  }

  function buildComponentData(frame, component) {
    var lines = [];
    var blocksPerLine = component.blocksPerLine;
    var blocksPerColumn = component.blocksPerColumn;
    var samplesPerLine = blocksPerLine << 3;
    // Only 1 used per invocation of this function and garbage collected after invocation, so no need to account for its memory footprint.
    var R = new Int32Array(64), r = new Uint8Array(64);

    // A port of poppler's IDCT method which in turn is taken from:
    //   Christoph Loeffler, Adriaan Ligtenberg, George S. Moschytz,
    //   "Practical Fast 1-D DCT Algorithms with 11 Multiplications",
    //   IEEE Intl. Conf. on Acoustics, Speech & Signal Processing, 1989,
    //   988-991.
    function quantizeAndInverse(zz, dataOut, dataIn) {
      var qt = component.quantizationTable;
      var v0, v1, v2, v3, v4, v5, v6, v7, t;
      var p = dataIn;
      var i;

      // dequant
      for (i = 0; i < 64; i++)
        p[i] = zz[i] * qt[i];

      // inverse DCT on rows
      for (i = 0; i < 8; ++i) {
        var row = 8 * i;

        // check for all-zero AC coefficients
        if (p[1 + row] == 0 && p[2 + row] == 0 && p[3 + row] == 0 &&
            p[4 + row] == 0 && p[5 + row] == 0 && p[6 + row] == 0 &&
            p[7 + row] == 0) {
          t = (dctSqrt2 * p[0 + row] + 512) >> 10;
          p[0 + row] = t;
          p[1 + row] = t;
          p[2 + row] = t;
          p[3 + row] = t;
          p[4 + row] = t;
          p[5 + row] = t;
          p[6 + row] = t;
          p[7 + row] = t;
          continue;
        }

        // stage 4
        v0 = (dctSqrt2 * p[0 + row] + 128) >> 8;
        v1 = (dctSqrt2 * p[4 + row] + 128) >> 8;
        v2 = p[2 + row];
        v3 = p[6 + row];
        v4 = (dctSqrt1d2 * (p[1 + row] - p[7 + row]) + 128) >> 8;
        v7 = (dctSqrt1d2 * (p[1 + row] + p[7 + row]) + 128) >> 8;
        v5 = p[3 + row] << 4;
        v6 = p[5 + row] << 4;

        // stage 3
        t = (v0 - v1+ 1) >> 1;
        v0 = (v0 + v1 + 1) >> 1;
        v1 = t;
        t = (v2 * dctSin6 + v3 * dctCos6 + 128) >> 8;
        v2 = (v2 * dctCos6 - v3 * dctSin6 + 128) >> 8;
        v3 = t;
        t = (v4 - v6 + 1) >> 1;
        v4 = (v4 + v6 + 1) >> 1;
        v6 = t;
        t = (v7 + v5 + 1) >> 1;
        v5 = (v7 - v5 + 1) >> 1;
        v7 = t;

        // stage 2
        t = (v0 - v3 + 1) >> 1;
        v0 = (v0 + v3 + 1) >> 1;
        v3 = t;
        t = (v1 - v2 + 1) >> 1;
        v1 = (v1 + v2 + 1) >> 1;
        v2 = t;
        t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
        v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
        v7 = t;
        t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
        v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
        v6 = t;

        // stage 1
        p[0 + row] = v0 + v7;
        p[7 + row] = v0 - v7;
        p[1 + row] = v1 + v6;
        p[6 + row] = v1 - v6;
        p[2 + row] = v2 + v5;
        p[5 + row] = v2 - v5;
        p[3 + row] = v3 + v4;
        p[4 + row] = v3 - v4;
      }

      // inverse DCT on columns
      for (i = 0; i < 8; ++i) {
        var col = i;

        // check for all-zero AC coefficients
        if (p[1*8 + col] == 0 && p[2*8 + col] == 0 && p[3*8 + col] == 0 &&
            p[4*8 + col] == 0 && p[5*8 + col] == 0 && p[6*8 + col] == 0 &&
            p[7*8 + col] == 0) {
          t = (dctSqrt2 * dataIn[i+0] + 8192) >> 14;
          p[0*8 + col] = t;
          p[1*8 + col] = t;
          p[2*8 + col] = t;
          p[3*8 + col] = t;
          p[4*8 + col] = t;
          p[5*8 + col] = t;
          p[6*8 + col] = t;
          p[7*8 + col] = t;
          continue;
        }

        // stage 4
        v0 = (dctSqrt2 * p[0*8 + col] + 2048) >> 12;
        v1 = (dctSqrt2 * p[4*8 + col] + 2048) >> 12;
        v2 = p[2*8 + col];
        v3 = p[6*8 + col];
        v4 = (dctSqrt1d2 * (p[1*8 + col] - p[7*8 + col]) + 2048) >> 12;
        v7 = (dctSqrt1d2 * (p[1*8 + col] + p[7*8 + col]) + 2048) >> 12;
        v5 = p[3*8 + col];
        v6 = p[5*8 + col];

        // stage 3
        t = (v0 - v1 + 1) >> 1;
        v0 = (v0 + v1 + 1) >> 1;
        v1 = t;
        t = (v2 * dctSin6 + v3 * dctCos6 + 2048) >> 12;
        v2 = (v2 * dctCos6 - v3 * dctSin6 + 2048) >> 12;
        v3 = t;
        t = (v4 - v6 + 1) >> 1;
        v4 = (v4 + v6 + 1) >> 1;
        v6 = t;
        t = (v7 + v5 + 1) >> 1;
        v5 = (v7 - v5 + 1) >> 1;
        v7 = t;

        // stage 2
        t = (v0 - v3 + 1) >> 1;
        v0 = (v0 + v3 + 1) >> 1;
        v3 = t;
        t = (v1 - v2 + 1) >> 1;
        v1 = (v1 + v2 + 1) >> 1;
        v2 = t;
        t = (v4 * dctSin3 + v7 * dctCos3 + 2048) >> 12;
        v4 = (v4 * dctCos3 - v7 * dctSin3 + 2048) >> 12;
        v7 = t;
        t = (v5 * dctSin1 + v6 * dctCos1 + 2048) >> 12;
        v5 = (v5 * dctCos1 - v6 * dctSin1 + 2048) >> 12;
        v6 = t;

        // stage 1
        p[0*8 + col] = v0 + v7;
        p[7*8 + col] = v0 - v7;
        p[1*8 + col] = v1 + v6;
        p[6*8 + col] = v1 - v6;
        p[2*8 + col] = v2 + v5;
        p[5*8 + col] = v2 - v5;
        p[3*8 + col] = v3 + v4;
        p[4*8 + col] = v3 - v4;
      }

      // convert to 8-bit integers
      for (i = 0; i < 64; ++i) {
        var sample = 128 + ((p[i] + 8) >> 4);
        dataOut[i] = sample < 0 ? 0 : sample > 0xFF ? 0xFF : sample;
      }
    }

    requestMemoryAllocation(samplesPerLine * blocksPerColumn * 8);

    var i, j;
    for (var blockRow = 0; blockRow < blocksPerColumn; blockRow++) {
      var scanLine = blockRow << 3;
      for (i = 0; i < 8; i++)
        lines.push(new Uint8Array(samplesPerLine));
      for (var blockCol = 0; blockCol < blocksPerLine; blockCol++) {
        quantizeAndInverse(component.blocks[blockRow][blockCol], r, R);

        var offset = 0, sample = blockCol << 3;
        for (j = 0; j < 8; j++) {
          var line = lines[scanLine + j];
          for (i = 0; i < 8; i++)
            line[sample + i] = r[offset++];
        }
      }
    }
    return lines;
  }

  function clampTo8bit(a) {
    return a < 0 ? 0 : a > 255 ? 255 : a;
  }

  constructor.prototype = {
    load: function load(path) {
      var xhr = new XMLHttpRequest();
      xhr.open("GET", path, true);
      xhr.responseType = "arraybuffer";
      xhr.onload = (function() {
        // TODO catch parse error
        var data = new Uint8Array(xhr.response || xhr.mozResponseArrayBuffer);
        this.parse(data);
        if (this.onload)
          this.onload();
      }).bind(this);
      xhr.send(null);
    },
    parse: function parse(data) {
      var maxResolutionInPixels = this.opts.maxResolutionInMP * 1000 * 1000;
      var offset = 0, length = data.length;
      function readUint16() {
        var value = (data[offset] << 8) | data[offset + 1];
        offset += 2;
        return value;
      }
      function readDataBlock() {
        var length = readUint16();
        var array = data.subarray(offset, offset + length - 2);
        offset += array.length;
        return array;
      }
      function prepareComponents(frame) {
        // According to the JPEG standard, the sampling factor must be between 1 and 4
        // See https://github.com/libjpeg-turbo/libjpeg-turbo/blob/9abeff46d87bd201a952e276f3e4339556a403a3/libjpeg.txt#L1138-L1146
        var maxH = 1, maxV = 1;
        var component, componentId;
        for (componentId in frame.components) {
          if (frame.components.hasOwnProperty(componentId)) {
            component = frame.components[componentId];
            if (maxH < component.h) maxH = component.h;
            if (maxV < component.v) maxV = component.v;
          }
        }
        var mcusPerLine = Math.ceil(frame.samplesPerLine / 8 / maxH);
        var mcusPerColumn = Math.ceil(frame.scanLines / 8 / maxV);
        for (componentId in frame.components) {
          if (frame.components.hasOwnProperty(componentId)) {
            component = frame.components[componentId];
            var blocksPerLine = Math.ceil(Math.ceil(frame.samplesPerLine / 8) * component.h / maxH);
            var blocksPerColumn = Math.ceil(Math.ceil(frame.scanLines  / 8) * component.v / maxV);
            var blocksPerLineForMcu = mcusPerLine * component.h;
            var blocksPerColumnForMcu = mcusPerColumn * component.v;
            var blocksToAllocate = blocksPerColumnForMcu * blocksPerLineForMcu;
            var blocks = [];

            // Each block is a Int32Array of length 64 (4 x 64 = 256 bytes)
            requestMemoryAllocation(blocksToAllocate * 256);

            for (var i = 0; i < blocksPerColumnForMcu; i++) {
              var row = [];
              for (var j = 0; j < blocksPerLineForMcu; j++)
                row.push(new Int32Array(64));
              blocks.push(row);
            }
            component.blocksPerLine = blocksPerLine;
            component.blocksPerColumn = blocksPerColumn;
            component.blocks = blocks;
          }
        }
        frame.maxH = maxH;
        frame.maxV = maxV;
        frame.mcusPerLine = mcusPerLine;
        frame.mcusPerColumn = mcusPerColumn;
      }
      var jfif = null;
      var adobe = null;
      var pixels = null;
      var frame, resetInterval;
      var quantizationTables = [], frames = [];
      var huffmanTablesAC = [], huffmanTablesDC = [];
      var fileMarker = readUint16();
      var malformedDataOffset = -1;
      this.comments = [];
      if (fileMarker != 0xFFD8) { // SOI (Start of Image)
        throw new Error("SOI not found");
      }

      fileMarker = readUint16();
      while (fileMarker != 0xFFD9) { // EOI (End of image)
        var i, j, l;
        switch(fileMarker) {
          case 0xFF00: break;
          case 0xFFE0: // APP0 (Application Specific)
          case 0xFFE1: // APP1
          case 0xFFE2: // APP2
          case 0xFFE3: // APP3
          case 0xFFE4: // APP4
          case 0xFFE5: // APP5
          case 0xFFE6: // APP6
          case 0xFFE7: // APP7
          case 0xFFE8: // APP8
          case 0xFFE9: // APP9
          case 0xFFEA: // APP10
          case 0xFFEB: // APP11
          case 0xFFEC: // APP12
          case 0xFFED: // APP13
          case 0xFFEE: // APP14
          case 0xFFEF: // APP15
          case 0xFFFE: // COM (Comment)
            var appData = readDataBlock();

            if (fileMarker === 0xFFFE) {
              var comment = String.fromCharCode.apply(null, appData);
              this.comments.push(comment);
            }

            if (fileMarker === 0xFFE0) {
              if (appData[0] === 0x4A && appData[1] === 0x46 && appData[2] === 0x49 &&
                appData[3] === 0x46 && appData[4] === 0) { // 'JFIF\x00'
                jfif = {
                  version: { major: appData[5], minor: appData[6] },
                  densityUnits: appData[7],
                  xDensity: (appData[8] << 8) | appData[9],
                  yDensity: (appData[10] << 8) | appData[11],
                  thumbWidth: appData[12],
                  thumbHeight: appData[13],
                  thumbData: appData.subarray(14, 14 + 3 * appData[12] * appData[13])
                };
              }
            }
            // TODO APP1 - Exif
            if (fileMarker === 0xFFE1) {
              if (appData[0] === 0x45 &&
                appData[1] === 0x78 &&
                appData[2] === 0x69 &&
                appData[3] === 0x66 &&
                appData[4] === 0) { // 'EXIF\x00'
                this.exifBuffer = appData.subarray(5, appData.length);
              }
            }

            if (fileMarker === 0xFFEE) {
              if (appData[0] === 0x41 && appData[1] === 0x64 && appData[2] === 0x6F &&
                appData[3] === 0x62 && appData[4] === 0x65 && appData[5] === 0) { // 'Adobe\x00'
                adobe = {
                  version: appData[6],
                  flags0: (appData[7] << 8) | appData[8],
                  flags1: (appData[9] << 8) | appData[10],
                  transformCode: appData[11]
                };
              }
            }
            break;

          case 0xFFDB: // DQT (Define Quantization Tables)
            var quantizationTablesLength = readUint16();
            var quantizationTablesEnd = quantizationTablesLength + offset - 2;
            while (offset < quantizationTablesEnd) {
              var quantizationTableSpec = data[offset++];
              requestMemoryAllocation(64 * 4);
              var tableData = new Int32Array(64);
              if ((quantizationTableSpec >> 4) === 0) { // 8 bit values
                for (j = 0; j < 64; j++) {
                  var z = dctZigZag[j];
                  tableData[z] = data[offset++];
                }
              } else if ((quantizationTableSpec >> 4) === 1) { //16 bit
                for (j = 0; j < 64; j++) {
                  var z = dctZigZag[j];
                  tableData[z] = readUint16();
                }
              } else
                throw new Error("DQT: invalid table spec");
              quantizationTables[quantizationTableSpec & 15] = tableData;
            }
            break;

          case 0xFFC0: // SOF0 (Start of Frame, Baseline DCT)
          case 0xFFC1: // SOF1 (Start of Frame, Extended DCT)
          case 0xFFC2: // SOF2 (Start of Frame, Progressive DCT)
            readUint16(); // skip data length
            frame = {};
            frame.extended = (fileMarker === 0xFFC1);
            frame.progressive = (fileMarker === 0xFFC2);
            frame.precision = data[offset++];
            frame.scanLines = readUint16();
            frame.samplesPerLine = readUint16();
            frame.components = {};
            frame.componentsOrder = [];

            var pixelsInFrame = frame.scanLines * frame.samplesPerLine;
            if (pixelsInFrame > maxResolutionInPixels) {
              var exceededAmount = Math.ceil((pixelsInFrame - maxResolutionInPixels) / 1e6);
              throw new Error(`maxResolutionInMP limit exceeded by ${exceededAmount}MP`);
            }

            var componentsCount = data[offset++], componentId;
            var maxH = 0, maxV = 0;
            for (i = 0; i < componentsCount; i++) {
              componentId = data[offset];
              var h = data[offset + 1] >> 4;
              var v = data[offset + 1] & 15;
              var qId = data[offset + 2];

              if ( h <= 0 || v <= 0 ) {
                throw new Error('Invalid sampling factor, expected values above 0');
              }

              frame.componentsOrder.push(componentId);
              frame.components[componentId] = {
                h: h,
                v: v,
                quantizationIdx: qId
              };
              offset += 3;
            }
            prepareComponents(frame);
            frames.push(frame);
            break;

          case 0xFFC4: // DHT (Define Huffman Tables)
            var huffmanLength = readUint16();
            for (i = 2; i < huffmanLength;) {
              var huffmanTableSpec = data[offset++];
              var codeLengths = new Uint8Array(16);
              var codeLengthSum = 0;
              for (j = 0; j < 16; j++, offset++) {
                codeLengthSum += (codeLengths[j] = data[offset]);
              }
              requestMemoryAllocation(16 + codeLengthSum);
              var huffmanValues = new Uint8Array(codeLengthSum);
              for (j = 0; j < codeLengthSum; j++, offset++)
                huffmanValues[j] = data[offset];
              i += 17 + codeLengthSum;

              ((huffmanTableSpec >> 4) === 0 ?
                huffmanTablesDC : huffmanTablesAC)[huffmanTableSpec & 15] =
                buildHuffmanTable(codeLengths, huffmanValues);
            }
            break;

          case 0xFFDD: // DRI (Define Restart Interval)
            readUint16(); // skip data length
            resetInterval = readUint16();
            break;

          case 0xFFDC: // Number of Lines marker
            readUint16() // skip data length
            readUint16() // Ignore this data since it represents the image height
            break;
            
          case 0xFFDA: // SOS (Start of Scan)
            var scanLength = readUint16();
            var selectorsCount = data[offset++];
            var components = [], component;
            for (i = 0; i < selectorsCount; i++) {
              component = frame.components[data[offset++]];
              var tableSpec = data[offset++];
              component.huffmanTableDC = huffmanTablesDC[tableSpec >> 4];
              component.huffmanTableAC = huffmanTablesAC[tableSpec & 15];
              components.push(component);
            }
            var spectralStart = data[offset++];
            var spectralEnd = data[offset++];
            var successiveApproximation = data[offset++];
            var processed = decodeScan(data, offset,
              frame, components, resetInterval,
              spectralStart, spectralEnd,
              successiveApproximation >> 4, successiveApproximation & 15, this.opts);
            offset += processed;
            break;

          case 0xFFFF: // Fill bytes
            if (data[offset] !== 0xFF) { // Avoid skipping a valid marker.
              offset--;
            }
            break;
          default:
            if (data[offset - 3] == 0xFF &&
                data[offset - 2] >= 0xC0 && data[offset - 2] <= 0xFE) {
              // could be incorrect encoding -- last 0xFF byte of the previous
              // block was eaten by the encoder
              offset -= 3;
              break;
            }
            else if (fileMarker === 0xE0 || fileMarker == 0xE1) {
              // Recover from malformed APP1 markers popular in some phone models.
              // See https://github.com/eugeneware/jpeg-js/issues/82
              if (malformedDataOffset !== -1) {
                throw new Error(`first unknown JPEG marker at offset ${malformedDataOffset.toString(16)}, second unknown JPEG marker ${fileMarker.toString(16)} at offset ${(offset - 1).toString(16)}`);
              }
              malformedDataOffset = offset - 1;
              const nextOffset = readUint16();
              if (data[offset + nextOffset - 2] === 0xFF) {
                offset += nextOffset - 2;
                break;
              }
            }
            throw new Error("unknown JPEG marker " + fileMarker.toString(16));
        }
        fileMarker = readUint16();
      }
      if (frames.length != 1)
        throw new Error("only single frame JPEGs supported");

      // set each frame's components quantization table
      for (var i = 0; i < frames.length; i++) {
        var cp = frames[i].components;
        for (var j in cp) {
          cp[j].quantizationTable = quantizationTables[cp[j].quantizationIdx];
          delete cp[j].quantizationIdx;
        }
      }

      this.width = frame.samplesPerLine;
      this.height = frame.scanLines;
      this.jfif = jfif;
      this.adobe = adobe;
      this.components = [];
      for (var i = 0; i < frame.componentsOrder.length; i++) {
        var component = frame.components[frame.componentsOrder[i]];
        this.components.push({
          lines: buildComponentData(frame, component),
          scaleX: component.h / frame.maxH,
          scaleY: component.v / frame.maxV
        });
      }
    },
    getData: function getData(width, height) {
      var scaleX = this.width / width, scaleY = this.height / height;

      var component1, component2, component3, component4;
      var component1Line, component2Line, component3Line, component4Line;
      var x, y;
      var offset = 0;
      var Y, Cb, Cr, K, C, M, Ye, R, G, B;
      var colorTransform;
      var dataLength = width * height * this.components.length;
      requestMemoryAllocation(dataLength);
      var data = new Uint8Array(dataLength);
      switch (this.components.length) {
        case 1:
          component1 = this.components[0];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];

              data[offset++] = Y;
            }
          }
          break;
        case 2:
          // PDF might compress two component data in custom colorspace
          component1 = this.components[0];
          component2 = this.components[1];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              Y = component1Line[0 | (x * component1.scaleX * scaleX)];
              data[offset++] = Y;
              Y = component2Line[0 | (x * component2.scaleX * scaleX)];
              data[offset++] = Y;
            }
          }
          break;
        case 3:
          // The default transform for three components is true
          colorTransform = true;
          // The adobe transform marker overrides any previous setting
          if (this.adobe && this.adobe.transformCode)
            colorTransform = true;
          else if (typeof this.opts.colorTransform !== 'undefined')
            colorTransform = !!this.opts.colorTransform;

          component1 = this.components[0];
          component2 = this.components[1];
          component3 = this.components[2];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              if (!colorTransform) {
                R = component1Line[0 | (x * component1.scaleX * scaleX)];
                G = component2Line[0 | (x * component2.scaleX * scaleX)];
                B = component3Line[0 | (x * component3.scaleX * scaleX)];
              } else {
                Y = component1Line[0 | (x * component1.scaleX * scaleX)];
                Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
                Cr = component3Line[0 | (x * component3.scaleX * scaleX)];

                R = clampTo8bit(Y + 1.402 * (Cr - 128));
                G = clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
                B = clampTo8bit(Y + 1.772 * (Cb - 128));
              }

              data[offset++] = R;
              data[offset++] = G;
              data[offset++] = B;
            }
          }
          break;
        case 4:
          if (!this.adobe)
            throw new Error('Unsupported color mode (4 components)');
          // The default transform for four components is false
          colorTransform = false;
          // The adobe transform marker overrides any previous setting
          if (this.adobe && this.adobe.transformCode)
            colorTransform = true;
          else if (typeof this.opts.colorTransform !== 'undefined')
            colorTransform = !!this.opts.colorTransform;

          component1 = this.components[0];
          component2 = this.components[1];
          component3 = this.components[2];
          component4 = this.components[3];
          for (y = 0; y < height; y++) {
            component1Line = component1.lines[0 | (y * component1.scaleY * scaleY)];
            component2Line = component2.lines[0 | (y * component2.scaleY * scaleY)];
            component3Line = component3.lines[0 | (y * component3.scaleY * scaleY)];
            component4Line = component4.lines[0 | (y * component4.scaleY * scaleY)];
            for (x = 0; x < width; x++) {
              if (!colorTransform) {
                C = component1Line[0 | (x * component1.scaleX * scaleX)];
                M = component2Line[0 | (x * component2.scaleX * scaleX)];
                Ye = component3Line[0 | (x * component3.scaleX * scaleX)];
                K = component4Line[0 | (x * component4.scaleX * scaleX)];
              } else {
                Y = component1Line[0 | (x * component1.scaleX * scaleX)];
                Cb = component2Line[0 | (x * component2.scaleX * scaleX)];
                Cr = component3Line[0 | (x * component3.scaleX * scaleX)];
                K = component4Line[0 | (x * component4.scaleX * scaleX)];

                C = 255 - clampTo8bit(Y + 1.402 * (Cr - 128));
                M = 255 - clampTo8bit(Y - 0.3441363 * (Cb - 128) - 0.71413636 * (Cr - 128));
                Ye = 255 - clampTo8bit(Y + 1.772 * (Cb - 128));
              }
              data[offset++] = 255-C;
              data[offset++] = 255-M;
              data[offset++] = 255-Ye;
              data[offset++] = 255-K;
            }
          }
          break;
        default:
          throw new Error('Unsupported color mode');
      }
      return data;
    },
    copyToImageData: function copyToImageData(imageData, formatAsRGBA) {
      var width = imageData.width, height = imageData.height;
      var imageDataArray = imageData.data;
      var data = this.getData(width, height);
      var i = 0, j = 0, x, y;
      var Y, K, C, M, R, G, B;
      switch (this.components.length) {
        case 1:
          for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
              Y = data[i++];

              imageDataArray[j++] = Y;
              imageDataArray[j++] = Y;
              imageDataArray[j++] = Y;
              if (formatAsRGBA) {
                imageDataArray[j++] = 255;
              }
            }
          }
          break;
        case 3:
          for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
              R = data[i++];
              G = data[i++];
              B = data[i++];

              imageDataArray[j++] = R;
              imageDataArray[j++] = G;
              imageDataArray[j++] = B;
              if (formatAsRGBA) {
                imageDataArray[j++] = 255;
              }
            }
          }
          break;
        case 4:
          for (y = 0; y < height; y++) {
            for (x = 0; x < width; x++) {
              C = data[i++];
              M = data[i++];
              Y = data[i++];
              K = data[i++];

              R = 255 - clampTo8bit(C * (1 - K / 255) + K);
              G = 255 - clampTo8bit(M * (1 - K / 255) + K);
              B = 255 - clampTo8bit(Y * (1 - K / 255) + K);

              imageDataArray[j++] = R;
              imageDataArray[j++] = G;
              imageDataArray[j++] = B;
              if (formatAsRGBA) {
                imageDataArray[j++] = 255;
              }
            }
          }
          break;
        default:
          throw new Error('Unsupported color mode');
      }
    }
  };


  // We cap the amount of memory used by jpeg-js to avoid unexpected OOMs from untrusted content.
  var totalBytesAllocated = 0;
  var maxMemoryUsageBytes = 0;
  function requestMemoryAllocation(increaseAmount = 0) {
    var totalMemoryImpactBytes = totalBytesAllocated + increaseAmount;
    if (totalMemoryImpactBytes > maxMemoryUsageBytes) {
      var exceededAmount = Math.ceil((totalMemoryImpactBytes - maxMemoryUsageBytes) / 1024 / 1024);
      throw new Error(`maxMemoryUsageInMB limit exceeded by at least ${exceededAmount}MB`);
    }

    totalBytesAllocated = totalMemoryImpactBytes;
  }

  constructor.resetMaxMemoryUsage = function (maxMemoryUsageBytes_) {
    totalBytesAllocated = 0;
    maxMemoryUsageBytes = maxMemoryUsageBytes_;
  };

  constructor.getBytesAllocated = function () {
    return totalBytesAllocated;
  };

  constructor.requestMemoryAllocation = requestMemoryAllocation;

  return constructor;
})();


function decode(jpegData, userOpts = {}) {
  var defaultOpts = {
    // "undefined" means "Choose whether to transform colors based on the image’s color model."
    colorTransform: undefined,
    useTArray: false,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 100, // Don't decode more than 100 megapixels
    maxMemoryUsageInMB: 512, // Don't decode if memory footprint is more than 512MB
  };

  var opts = {...defaultOpts, ...userOpts};
  var arr = new Uint8Array(jpegData);
  var decoder = new JpegImage();
  decoder.opts = opts;
  // If this constructor ever supports async decoding this will need to be done differently.
  // Until then, treating as singleton limit is fine.
  JpegImage.resetMaxMemoryUsage(opts.maxMemoryUsageInMB * 1024 * 1024);
  decoder.parse(arr);

  var channels = (opts.formatAsRGBA) ? 4 : 3;
  var bytesNeeded = decoder.width * decoder.height * channels;
  try {
    JpegImage.requestMemoryAllocation(bytesNeeded);
    var image = {
      width: decoder.width,
      height: decoder.height,
      exifBuffer: decoder.exifBuffer,
      data: opts.useTArray ?
        new Uint8Array(bytesNeeded) :
        Buffer.alloc(bytesNeeded)
    };
    if(decoder.comments.length > 0) {
      image["comments"] = decoder.comments;
    }
  } catch (err) {
    if (err instanceof RangeError) {
      throw new Error("Could not allocate enough memory for the image. " +
                      "Required: " + bytesNeeded);
    } 
    
    if (err instanceof ReferenceError) {
      if (err.message === "Buffer is not defined") {
        throw new Error("Buffer is not globally defined in this environment. " +
                        "Consider setting useTArray to true");
      }
    }
    throw err;
  }

  decoder.copyToImageData(image, opts.formatAsRGBA);

  return image;
}

  return decode;
})();// ============================================================================
//  GIF decoder (frame pertama, LZW) + BMP decoder - pure JS
// ============================================================================
function gifDecode(buf) {
  if (buf.toString('latin1', 0, 3) !== 'GIF') throw new Error('Bukan file GIF valid')
  const W = buf.readUInt16LE(6), H = buf.readUInt16LE(8)
  const flags = buf[10]
  let pos = 13
  let gct = null
  if (flags & 0x80) { const n = 3 * (1 << ((flags & 7) + 1)); gct = buf.subarray(pos, pos + n); pos += n }

  const out = Buffer.alloc(W * H * 4)
  let transparentIdx = -1

  while (pos < buf.length) {
    const b = buf[pos++]
    if (b === 0x21) {                       // extension
      const label = buf[pos++]
      if (label === 0xf9) {                 // graphic control ext
        const packed = buf[pos + 1]
        if (packed & 1) transparentIdx = buf[pos + 4]
      }
      while (buf[pos] !== 0) pos += buf[pos] + 1
      pos++
    } else if (b === 0x2c) {                // image descriptor -> frame pertama
      const ix = buf.readUInt16LE(pos), iy = buf.readUInt16LE(pos + 2)
      const iw = buf.readUInt16LE(pos + 4), ih = buf.readUInt16LE(pos + 6)
      const f = buf[pos + 8]; pos += 9
      let ct = gct
      if (f & 0x80) { const n = 3 * (1 << ((f & 7) + 1)); ct = buf.subarray(pos, pos + n); pos += n }
      const interlaced = !!(f & 0x40)
      const minCode = buf[pos++]

      const chunks = []
      while (buf[pos] !== 0) { chunks.push(buf.subarray(pos + 1, pos + 1 + buf[pos])); pos += buf[pos] + 1 }
      const data = Buffer.concat(chunks)

      // LZW
      const clear = 1 << minCode, eoi = clear + 1
      let codeSize = minCode + 1, next = eoi + 1
      const prefix = new Int32Array(4096), suffix = new Uint8Array(4096), stack = new Uint8Array(4097)
      const pixels = new Uint8Array(iw * ih)
      let bitBuf = 0, bits = 0, di = 0, pi = 0, prev = -1, first = 0

      for (let i = 0; i < clear; i++) { prefix[i] = -1; suffix[i] = i }
      while (pi < pixels.length) {
        while (bits < codeSize && di < data.length) { bitBuf |= data[di++] << bits; bits += 8 }
        if (bits < codeSize) break
        const code = bitBuf & ((1 << codeSize) - 1)
        bitBuf >>= codeSize; bits -= codeSize
        if (code === clear) { codeSize = minCode + 1; next = eoi + 1; prev = -1; continue }
        if (code === eoi) break
        let sp = 0, cur = code
        if (prev === -1) { pixels[pi++] = suffix[code]; prev = code; first = suffix[code]; continue }
        if (code >= next) { stack[sp++] = first; cur = prev }
        while (cur >= clear) { stack[sp++] = suffix[cur]; cur = prefix[cur] }
        first = suffix[cur]; stack[sp++] = first
        while (sp > 0 && pi < pixels.length) pixels[pi++] = stack[--sp]
        if (next < 4096) {
          prefix[next] = prev; suffix[next] = first; next++
          if (next === (1 << codeSize) && codeSize < 12) codeSize++
        }
        prev = code
      }

      if (pi < pixels.length * 0.5) throw new Error('GIF: data gambar terpotong (' + pi + ' dari ' + pixels.length + ' piksel)')

      // interlace mapping
      const rowMap = new Int32Array(ih)
      if (interlaced) {
        let r = 0
        for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]]) for (let y = start; y < ih; y += step) rowMap[r++] = y
      } else for (let y = 0; y < ih; y++) rowMap[y] = y

      for (let r = 0; r < ih; r++) {
        const y = rowMap[r] + iy
        if (y >= H) continue
        for (let x = 0; x < iw; x++) {
          const idx = pixels[r * iw + x]
          const X = x + ix
          if (X >= W) continue
          const o = (y * W + X) * 4
          if (idx === transparentIdx || !ct) { out[o + 3] = 0; continue }
          out[o] = ct[idx * 3]; out[o + 1] = ct[idx * 3 + 1]; out[o + 2] = ct[idx * 3 + 2]; out[o + 3] = 255
        }
      }
      return { data: out, width: W, height: H }
    } else if (b === 0x3b) break
  }
  throw new Error('GIF: tidak ada frame gambar (file rusak atau terpotong)')
}

function bmpDecode(buf) {
  if (buf.toString('latin1', 0, 2) !== 'BM') throw new Error('Bukan file BMP valid')
  const dataOff = buf.readUInt32LE(10)
  const hdrSize = buf.readUInt32LE(14)
  let W, H, bpp, comp = 0, colors = 0
  if (hdrSize === 12) { W = buf.readUInt16LE(18); H = buf.readUInt16LE(20); bpp = buf.readUInt16LE(24) }
  else { W = buf.readInt32LE(18); H = buf.readInt32LE(22); bpp = buf.readUInt16LE(28); comp = buf.readUInt32LE(30); colors = buf.readUInt32LE(46) }
  const topDown = H < 0; H = Math.abs(H)
  if (comp !== 0 && comp !== 3) throw new Error('BMP terkompresi (RLE) tidak didukung')

  let palette = null
  if (bpp <= 8) {
    const n = colors || (1 << bpp)
    const pOff = 14 + hdrSize, step = hdrSize === 12 ? 3 : 4
    palette = []
    for (let i = 0; i < n; i++) palette.push([buf[pOff + i * step + 2], buf[pOff + i * step + 1], buf[pOff + i * step]])
  }
  const stride = Math.floor((bpp * W + 31) / 32) * 4
  const out = Buffer.alloc(W * H * 4)
  let masks = null
  if (comp === 3 && (bpp === 16 || bpp === 32)) masks = [buf.readUInt32LE(54), buf.readUInt32LE(58), buf.readUInt32LE(62)]

  for (let y = 0; y < H; y++) {
    const srcY = topDown ? y : H - 1 - y
    const row = dataOff + srcY * stride
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4
      let r, g, b, a = 255
      if (bpp === 24) { b = buf[row + x * 3]; g = buf[row + x * 3 + 1]; r = buf[row + x * 3 + 2] }
      else if (bpp === 32) {
        if (masks) {
          const v = buf.readUInt32LE(row + x * 4)
          const ex = (m) => { if (!m) return 0; let s = 0; while (!((m >>> s) & 1)) s++; return Math.round(((v & m) >>> s) * 255 / (m >>> s)) }
          r = ex(masks[0]); g = ex(masks[1]); b = ex(masks[2])
        } else { b = buf[row + x * 4]; g = buf[row + x * 4 + 1]; r = buf[row + x * 4 + 2] }
      } else if (bpp === 16) {
        const v = buf.readUInt16LE(row + x * 2)
        if (masks) {
          const ex = (m) => { let s = 0; while (!((m >>> s) & 1)) s++; return Math.round(((v & m) >>> s) * 255 / (m >>> s)) }
          r = ex(masks[0]); g = ex(masks[1]); b = ex(masks[2])
        } else { r = ((v >> 10) & 31) * 255 / 31; g = ((v >> 5) & 31) * 255 / 31; b = (v & 31) * 255 / 31 }
      } else {
        const bitPos = x * bpp
        const idx = (buf[row + (bitPos >> 3)] >> (8 - bpp - (bitPos & 7))) & ((1 << bpp) - 1)
        ;[r, g, b] = palette[idx] || [0, 0, 0]
      }
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a
    }
  }
  return { data: out, width: W, height: H }
}

function bmpEncode({ data, width, height }) {
  const stride = Math.floor((24 * width + 31) / 32) * 4
  const size = 54 + stride * height
  const out = Buffer.alloc(size)
  out.write('BM', 0); out.writeUInt32LE(size, 2); out.writeUInt32LE(54, 10)
  out.writeUInt32LE(40, 14); out.writeInt32LE(width, 18); out.writeInt32LE(height, 22)
  out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(stride * height, 34)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = (y * width + x) * 4, d = 54 + (height - 1 - y) * stride + x * 3
    const a = data[s + 3] / 255
    out[d] = Math.round(data[s + 2] * a + 255 * (1 - a)); out[d + 1] = Math.round(data[s + 1] * a + 255 * (1 - a)); out[d + 2] = Math.round(data[s] * a + 255 * (1 - a))
  }
  return out
}
// ============================================================================
//  jimp - pengolah gambar native (API mengikuti jimp, tanpa dependency)
// ============================================================================

const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v)

// ---------- deteksi format (pengganti file-type + sharp.metadata) ----------
function detectFormat(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 4) return null
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg'
  if (buf.toString('latin1', 0, 3) === 'GIF') return 'gif'
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp'
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp'
  return null
}
const FORMAT_MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp' }

// dimensi tanpa decode penuh (cepat) - dipakai untuk metadata()
function readDimensions(buf) {
  const fmt = detectFormat(buf)
  if (fmt === 'png') return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (fmt === 'gif') return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (fmt === 'bmp') return buf.readUInt32LE(14) === 12
    ? { width: buf.readUInt16LE(18), height: buf.readUInt16LE(20) }
    : { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  if (fmt === 'jpeg') {
    let p = 2
    while (p < buf.length) {
      if (buf[p] !== 0xff) { p++; continue }
      const m = buf[p + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc)
        return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5) }
      p += 2 + buf.readUInt16BE(p + 2)
    }
  }
  if (fmt === 'webp') {
    const t = buf.toString('latin1', 12, 16)
    if (t === 'VP8X') return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) }
    if (t === 'VP8L') { const b = buf.readUInt32LE(21); return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 } }
    if (t === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
  }
  return null
}

// ---------- EXIF orientation (pengganti exif-parser) ----------
function getExifOrientation(buf) {
  if (detectFormat(buf) !== 'jpeg') return 1
  let p = 2
  while (p + 4 < buf.length) {
    if (buf[p] !== 0xff) return 1
    const marker = buf[p + 1], len = buf.readUInt16BE(p + 2)
    if (marker === 0xe1 && buf.toString('latin1', p + 4, p + 8) === 'Exif') {
      const t = p + 10
      const le = buf.toString('latin1', t, t + 2) === 'II'
      const r16 = o => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o))
      const r32 = o => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o))
      const ifd = t + r32(t + 4)
      const n = r16(ifd)
      for (let i = 0; i < n; i++) {
        const e = ifd + 2 + i * 12
        if (r16(e) === 0x0112) return r16(e + 8)
      }
      return 1
    }
    if (marker === 0xda) return 1
    p += 2 + len
  }
  return 1
}

// ---------- resize (area-average utk downscale, bilinear utk upscale) ----------
// Bekerja pada alpha-premultiplied supaya tepi transparan tidak "berdarah" warna hitam.
function resizeBitmap(src, dw, dh, kernel = 'lanczos3') {
  const sw = src.width, sh = src.height
  if (sw === dw && sh === dh) return { data: Buffer.from(src.data), width: dw, height: dh }

  // premultiply ke Float32
  const f = new Float32Array(sw * sh * 4)
  for (let i = 0; i < sw * sh; i++) {
    const a = src.data[i * 4 + 3] / 255
    f[i * 4] = src.data[i * 4] * a; f[i * 4 + 1] = src.data[i * 4 + 1] * a
    f[i * 4 + 2] = src.data[i * 4 + 2] * a; f[i * 4 + 3] = src.data[i * 4 + 3]
  }

  const lanczos = x => {
    if (x === 0) return 1
    if (Math.abs(x) >= 3) return 0
    const px = Math.PI * x
    return (3 * Math.sin(px) * Math.sin(px / 3)) / (px * px)
  }
  const tri = x => { x = Math.abs(x); return x < 1 ? 1 - x : 0 }
  const kern = kernel === 'bilinear' ? tri : lanczos
  const support = kernel === 'bilinear' ? 1 : 3

  // hitung bobot 1D untuk satu sumbu
  const weightsFor = (srcLen, dstLen) => {
    const scale = dstLen / srcLen
    const fscale = Math.max(1, 1 / scale)         // perlebar filter saat downscale
    const sup = support * fscale
    const out = new Array(dstLen)
    for (let d = 0; d < dstLen; d++) {
      const center = (d + 0.5) / scale
      const start = Math.max(0, Math.floor(center - sup))
      const end = Math.min(srcLen - 1, Math.ceil(center + sup))
      const w = []; let sum = 0
      for (let s = start; s <= end; s++) { const v = kern((s + 0.5 - center) / fscale); w.push(v); sum += v }
      if (sum === 0) { w[0] = 1; sum = 1 }
      for (let i = 0; i < w.length; i++) w[i] /= sum
      out[d] = { start, w }
    }
    return out
  }

  const wx = weightsFor(sw, dw), wy = weightsFor(sh, dh)

  // pass horizontal
  const tmp = new Float32Array(dw * sh * 4)
  for (let y = 0; y < sh; y++) for (let x = 0; x < dw; x++) {
    const { start, w } = wx[x]
    let r = 0, g = 0, b = 0, a = 0
    for (let k = 0; k < w.length; k++) {
      const si = (y * sw + start + k) * 4
      r += f[si] * w[k]; g += f[si + 1] * w[k]; b += f[si + 2] * w[k]; a += f[si + 3] * w[k]
    }
    const di = (y * dw + x) * 4
    tmp[di] = r; tmp[di + 1] = g; tmp[di + 2] = b; tmp[di + 3] = a
  }
  // pass vertikal + un-premultiply
  const out = Buffer.alloc(dw * dh * 4)
  for (let y = 0; y < dh; y++) {
    const { start, w } = wy[y]
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0
      for (let k = 0; k < w.length; k++) {
        const si = ((start + k) * dw + x) * 4
        r += tmp[si] * w[k]; g += tmp[si + 1] * w[k]; b += tmp[si + 2] * w[k]; a += tmp[si + 3] * w[k]
      }
      const di = (y * dw + x) * 4
      const aa = clamp255(a)
      const inv = aa > 0 ? 255 / aa : 0
      out[di] = clamp255(Math.round(r * inv)); out[di + 1] = clamp255(Math.round(g * inv))
      out[di + 2] = clamp255(Math.round(b * inv)); out[di + 3] = Math.round(aa)
    }
  }
  return { data: out, width: dw, height: dh }
}

// ---------- gaussian blur (sigma seperti sharp.blur) ----------
function gaussianBlurBitmap(bm, sigma) {
  if (sigma <= 0) return bm
  const radius = Math.max(1, Math.ceil(sigma * 3))
  const kernel = new Float32Array(radius * 2 + 1)
  let sum = 0
  for (let i = -radius; i <= radius; i++) { const v = Math.exp(-(i * i) / (2 * sigma * sigma)); kernel[i + radius] = v; sum += v }
  for (let i = 0; i < kernel.length; i++) kernel[i] /= sum

  const { width: W, height: H } = bm
  const f = new Float32Array(W * H * 4)
  for (let i = 0; i < W * H; i++) {
    const a = bm.data[i * 4 + 3] / 255
    f[i * 4] = bm.data[i * 4] * a; f[i * 4 + 1] = bm.data[i * 4 + 1] * a
    f[i * 4 + 2] = bm.data[i * 4 + 2] * a; f[i * 4 + 3] = bm.data[i * 4 + 3]
  }
  const tmp = new Float32Array(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let k = -radius; k <= radius; k++) {
      const xx = Math.min(W - 1, Math.max(0, x + k)), si = (y * W + xx) * 4, w = kernel[k + radius]
      r += f[si] * w; g += f[si + 1] * w; b += f[si + 2] * w; a += f[si + 3] * w
    }
    const di = (y * W + x) * 4; tmp[di] = r; tmp[di + 1] = g; tmp[di + 2] = b; tmp[di + 3] = a
  }
  const out = Buffer.alloc(W * H * 4)
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let k = -radius; k <= radius; k++) {
      const yy = Math.min(H - 1, Math.max(0, y + k)), si = (yy * W + x) * 4, w = kernel[k + radius]
      r += tmp[si] * w; g += tmp[si + 1] * w; b += tmp[si + 2] * w; a += tmp[si + 3] * w
    }
    const di = (y * W + x) * 4, aa = clamp255(a), inv = aa > 0 ? 255 / aa : 0
    out[di] = clamp255(Math.round(r * inv)); out[di + 1] = clamp255(Math.round(g * inv))
    out[di + 2] = clamp255(Math.round(b * inv)); out[di + 3] = Math.round(aa)
  }
  return { data: out, width: W, height: H }
}

// ---------- parse warna ----------
function parseColorInt(c) {
  if (typeof c === 'number') return c >>> 0
  if (c && typeof c === 'object') return (((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | Math.round((c.a ?? c.alpha ?? 1) <= 1 && c.alpha !== undefined ? c.alpha * 255 : (c.a ?? 255))) >>> 0
  const { r, g, b, a } = parseColor(c)
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | Math.round(a * 255)) >>> 0
}

// ---------- tabel sRGB <-> linear (grayscale gamma-aware, sama seperti libvips/sharp) ----------
const SRGB_TO_LIN = (() => {
  const t = new Float64Array(256)
  for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return t
})()
function linToSrgb8(l) {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  return clamp255(Math.round(v * 255))
}

// ---------- class Jimp ----------
class Jimp {
  constructor(opts = {}) {
    if (opts.data) {
      this.bitmap = { data: opts.data, width: opts.width, height: opts.height }
    } else {
      const { width, height, color = 0x00000000 } = opts
      if (!(width > 0) || !(height > 0)) throw new Error('Jimp: width dan height harus > 0')
      const data = Buffer.alloc(width * height * 4)
      const c = parseColorInt(color)
      if (c !== 0) for (let i = 0; i < data.length; i += 4) data.writeUInt32BE(c, i)
      this.bitmap = { data, width, height }
    }
    this.mime = null
    this.background = 0x00000000
  }

  static MAX_PIXELS = 100_000_000

  get width() { return this.bitmap.width }
  get height() { return this.bitmap.height }

  // ---- I/O ----
  static async fromBuffer(buf) {
    const fmt = detectFormat(buf)
    if (!fmt) throw new Error('Jimp: format gambar tidak dikenali')
    if (fmt === 'webp') throw new Error('Jimp: WebP diproses lewat ffmpeg (gunakan Jimp.read yang otomatis mengonversi)')
    // Tolak "gambar bom" SEBELUM decode: dimensi dibaca dari header, bukan dari alokasi yang gagal.
    const dim = readDimensions(buf)
    if (!dim || !(dim.width > 0) || !(dim.height > 0)) throw new Error('Jimp: dimensi gambar tidak valid')
    if (dim.width * dim.height > Jimp.MAX_PIXELS)
      throw new Error(`Jimp: gambar terlalu besar (${dim.width}x${dim.height} = ${(dim.width * dim.height / 1e6).toFixed(0)} MP, batas ${(Jimp.MAX_PIXELS / 1e6).toFixed(0)} MP)`)
    let bm
    if (fmt === 'png') bm = pngDecode(buf)
    else if (fmt === 'jpeg') bm = jpegDecode(buf, { useTArray: true, formatAsRGBA: true, tolerantDecoding: true })
    else if (fmt === 'gif') bm = gifDecode(buf)
    else if (fmt === 'bmp') bm = bmpDecode(buf)
    const img = new Jimp({ data: Buffer.from(bm.data.buffer ? Buffer.from(bm.data.buffer, bm.data.byteOffset, bm.data.length) : bm.data), width: bm.width, height: bm.height })
    img.mime = FORMAT_MIME[fmt]
    if (fmt === 'jpeg') img._applyExif(getExifOrientation(buf))
    return img
  }

  static async read(src) {
    let buf
    if (Buffer.isBuffer(src)) buf = src
    else if (src instanceof ArrayBuffer || ArrayBuffer.isView(src)) buf = Buffer.from(src.buffer ?? src)
    else if (typeof src === 'string') {
      if (/^https?:\/\//i.test(src)) {
        const res = await fetch(src)
        if (!res.ok) throw new Error(`Jimp.read: HTTP ${res.status} untuk ${src}`)
        buf = Buffer.from(await res.arrayBuffer())
      } else if (/^data:/i.test(src)) buf = Buffer.from(src.split(',')[1] || '', 'base64')
      else buf = await fsp.readFile(src)
    } else throw new Error('Jimp.read: sumber harus Buffer, path, URL, atau data URI')

    if (detectFormat(buf) === 'webp') buf = await webpToPng(buf)
    return Jimp.fromBuffer(buf)
  }

  static fromBitmap({ data, width, height }) {
    return new Jimp({ data: Buffer.from(data), width, height })
  }

  async getBuffer(mime = 'image/png', options = {}) {
    if (mime === 'image/png') return pngEncode(this.bitmap, { level: options.deflateLevel ?? 6, hasAlpha: options.alpha !== false })
    if (mime === 'image/jpeg' || mime === 'image/jpg') {
      const flat = this.clone().flatten(options.background ?? 0xffffffff)
      return Buffer.from(jpegEncode({ data: flat.bitmap.data, width: flat.width, height: flat.height }, options.quality ?? 80).data)
    }
    if (mime === 'image/bmp') return bmpEncode(this.bitmap)
    if (mime === 'image/webp') return pngToWebp(pngEncode(this.bitmap), options)
    throw new Error(`Jimp.getBuffer: MIME tidak didukung: ${mime}`)
  }
  async getBase64(mime, options) { return `data:${mime};base64,${(await this.getBuffer(mime, options)).toString('base64')}` }
  async write(path, options) {
    const ext = String(path).split('.').pop().toLowerCase()
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', webp: 'image/webp' }[ext]
    if (!mime) throw new Error('Jimp.write: ekstensi tidak didukung: ' + ext)
    await fsp.writeFile(path, await this.getBuffer(mime, options))
  }

  clone() { return new Jimp({ data: Buffer.from(this.bitmap.data), width: this.width, height: this.height }) }

  // ---- EXIF ----
  _applyExif(o) {
    if (o === 2) this.flip({ horizontal: true })
    else if (o === 3) this.rotate(180)
    else if (o === 4) this.flip({ vertical: true })
    else if (o === 5) { this.rotate(90); this.flip({ horizontal: true }) }
    else if (o === 6) this.rotate(90)
    else if (o === 7) { this.rotate(270); this.flip({ horizontal: true }) }
    else if (o === 8) this.rotate(270)
    return this
  }

  // ---- pixel ----
  getPixelColor(x, y) { return this.bitmap.data.readUInt32BE((Math.round(y) * this.width + Math.round(x)) * 4) }
  setPixelColor(color, x, y) { this.bitmap.data.writeUInt32BE(parseColorInt(color) >>> 0, (Math.round(y) * this.width + Math.round(x)) * 4); return this }
  scan(x, y, w, h, fn) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) fn.call(this, xx, yy, (this.width * yy + xx) << 2)
    return this
  }

  // ---- resize: 'fill' | 'cover' | 'contain' | 'inside' | 'outside' (semantik sharp) ----
  resize(a, b, c) {
    let w, h, opts = {}
    if (typeof a === 'object' && a !== null) { ({ w, h, ...opts } = a) } else { w = a; h = b; opts = c || {} }
    if (w == null && h == null) throw new Error('resize: w atau h wajib diisi')
    if (w == null) w = Math.round(this.width * (h / this.height))
    if (h == null) h = Math.round(this.height * (w / this.width))
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h))

    const fit = opts.fit || 'fill'
    const bg = opts.background ?? { r: 0, g: 0, b: 0, alpha: 0 }
    const kernel = opts.kernel || 'lanczos3'
    const position = opts.position || 'center'

    const posFrac = p => {
      const s = String(p).toLowerCase()
      const fx = /left|west/.test(s) ? 0 : /right|east/.test(s) ? 1 : 0.5
      const fy = /top|north/.test(s) ? 0 : /bottom|south/.test(s) ? 1 : 0.5
      return [fx, fy]
    }
    const [fx, fy] = posFrac(position)

    if (fit === 'fill') {
      this.bitmap = resizeBitmap(this.bitmap, w, h, kernel)
    } else if (fit === 'inside' || fit === 'outside') {
      const sc = fit === 'inside' ? Math.min(w / this.width, h / this.height) : Math.max(w / this.width, h / this.height)
      if (fit === 'inside' && opts.withoutEnlargement && sc > 1) return this
      this.bitmap = resizeBitmap(this.bitmap, Math.max(1, Math.round(this.width * sc)), Math.max(1, Math.round(this.height * sc)), kernel)
    } else if (fit === 'cover') {
      const sc = Math.max(w / this.width, h / this.height)
      const rw = Math.max(w, Math.round(this.width * sc)), rh = Math.max(h, Math.round(this.height * sc))
      this.bitmap = resizeBitmap(this.bitmap, rw, rh, kernel)
      this.crop(Math.ceil((rw - w) * fx), Math.ceil((rh - h) * fy), w, h)   // sharp membulatkan crop ke ATAS (beda dgn contain yg ke bawah)
    } else if (fit === 'contain') {
      const sc = Math.min(w / this.width, h / this.height)
      const rw = Math.max(1, Math.round(this.width * sc)), rh = Math.max(1, Math.round(this.height * sc))
      const scaled = resizeBitmap(this.bitmap, rw, rh, kernel)
      const canvas = new Jimp({ width: w, height: h, color: bg })
      canvas._blit(scaled, Math.floor((w - rw) * fx), Math.floor((h - rh) * fy))
      this.bitmap = canvas.bitmap
    } else throw new Error('resize: fit tidak dikenal: ' + fit)
    return this
  }

  scale(f) { return this.resize(Math.round(this.width * f), Math.round(this.height * f)) }

  // ---- crop / extract ----
  crop(x, y, w, h) {
    if (typeof x === 'object') ({ x, y, w, h } = x)
    x = Math.round(x); y = Math.round(y); w = Math.round(w); h = Math.round(h)
    if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > this.width || y + h > this.height)
      throw new Error(`crop: area di luar gambar (gambar ${this.width}x${this.height}, area ${x},${y} ${w}x${h})`)
    const out = Buffer.alloc(w * h * 4)
    for (let r = 0; r < h; r++) this.bitmap.data.copy(out, r * w * 4, ((y + r) * this.width + x) * 4, ((y + r) * this.width + x + w) * 4)
    this.bitmap = { data: out, width: w, height: h }
    return this
  }

  // ---- flatten (alpha -> background solid) ----
  flatten(bg = 0xffffffff) {
    const c = parseColorInt(bg)
    const br = (c >>> 24) & 255, bgc = (c >>> 16) & 255, bb = (c >>> 8) & 255
    const d = this.bitmap.data
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255
      d[i] = Math.round(d[i] * a + br * (1 - a)); d[i + 1] = Math.round(d[i + 1] * a + bgc * (1 - a))
      d[i + 2] = Math.round(d[i + 2] * a + bb * (1 - a)); d[i + 3] = 255
    }
    return this
  }

  // ---- warna ----
  greyscale() {
    const d = this.bitmap.data
    for (let i = 0; i < d.length; i += 4) {
      const y = 0.2126 * SRGB_TO_LIN[d[i]] + 0.7152 * SRGB_TO_LIN[d[i + 1]] + 0.0722 * SRGB_TO_LIN[d[i + 2]]
      const g = linToSrgb8(y)
      d[i] = d[i + 1] = d[i + 2] = g
    }
    return this
  }
  grayscale() { return this.greyscale() }
  invert() { const d = this.bitmap.data; for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2] } return this }
  opacity(f) { const d = this.bitmap.data; for (let i = 3; i < d.length; i += 4) d[i] = Math.round(d[i] * f); return this }
  brightness(v) { const d = this.bitmap.data; for (let i = 0; i < d.length; i += 4) { d[i] = clamp255(d[i] * v); d[i + 1] = clamp255(d[i + 1] * v); d[i + 2] = clamp255(d[i + 2] * v) } return this }

  // ---- blur ----
  blur(sigma) { this.bitmap = gaussianBlurBitmap(this.bitmap, sigma); return this }
  gaussian(sigma) { return this.blur(sigma) }

  // ---- flip / rotate ----
  flip({ horizontal = false, vertical = false } = {}) {
    const { width: W, height: H, data } = this.bitmap
    const out = Buffer.alloc(data.length)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const sx = horizontal ? W - 1 - x : x, sy = vertical ? H - 1 - y : y
      data.copy(out, (y * W + x) * 4, (sy * W + sx) * 4, (sy * W + sx) * 4 + 4)
    }
    this.bitmap.data = out
    return this
  }
  mirror(h, v) { return this.flip({ horizontal: h, vertical: v }) }

  rotate(deg) {
    const d = ((Math.round(deg) % 360) + 360) % 360
    if (d % 90 !== 0) throw new Error('rotate: hanya kelipatan 90 derajat')
    if (d === 0) return this
    const { width: W, height: H, data } = this.bitmap
    const nw = d === 180 ? W : H, nh = d === 180 ? H : W
    const out = Buffer.alloc(data.length)
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let nx, ny
      if (d === 90) { nx = H - 1 - y; ny = x } else if (d === 180) { nx = W - 1 - x; ny = H - 1 - y } else { nx = y; ny = W - 1 - x }
      data.copy(out, (ny * nw + nx) * 4, (y * W + x) * 4, (y * W + x) * 4 + 4)
    }
    this.bitmap = { data: out, width: nw, height: nh }
    return this
  }

  // ---- composite: source-over, alpha-correct ----
  _blit(src, x, y, opacity = 1) {
    const dst = this.bitmap
    x = Math.round(x); y = Math.round(y)
    for (let sy = 0; sy < src.height; sy++) {
      const dy = y + sy
      if (dy < 0 || dy >= dst.height) continue
      for (let sx = 0; sx < src.width; sx++) {
        const dx = x + sx
        if (dx < 0 || dx >= dst.width) continue
        const si = (sy * src.width + sx) * 4, di = (dy * dst.width + dx) * 4
        const sa = (src.data[si + 3] / 255) * opacity
        if (sa <= 0) continue
        if (sa >= 1) { dst.data[di] = src.data[si]; dst.data[di + 1] = src.data[si + 1]; dst.data[di + 2] = src.data[si + 2]; dst.data[di + 3] = 255; continue }
        const da = dst.data[di + 3] / 255, oa = sa + da * (1 - sa)
        if (oa <= 0) continue
        dst.data[di] = Math.round((src.data[si] * sa + dst.data[di] * da * (1 - sa)) / oa)
        dst.data[di + 1] = Math.round((src.data[si + 1] * sa + dst.data[di + 1] * da * (1 - sa)) / oa)
        dst.data[di + 2] = Math.round((src.data[si + 2] * sa + dst.data[di + 2] * da * (1 - sa)) / oa)
        dst.data[di + 3] = Math.round(oa * 255)
      }
    }
    return this
  }
  composite(src, x = 0, y = 0, opts = {}) {
    const s = src instanceof Jimp ? src.bitmap : src
    return this._blit(s, x, y, opts.opacitySource ?? opts.opacity ?? 1)
  }

  // ---- mask alpha: 'dest-in' (alpha hasil = alpha dest * alpha mask) ----
  maskAlpha(maskImg, x = 0, y = 0) {
    const m = maskImg.bitmap, d = this.bitmap
    for (let py = 0; py < d.height; py++) for (let px = 0; px < d.width; px++) {
      const mx = px - x, my = py - y
      const ma = mx >= 0 && my >= 0 && mx < m.width && my < m.height ? m.data[(my * m.width + mx) * 4 + 3] / 255 : 0
      const di = (py * d.width + px) * 4
      d.data[di + 3] = Math.round(d.data[di + 3] * ma)
    }
    return this
  }

  // luminance 1-channel (Buffer w*h), gamma-aware seperti sharp.grayscale().raw()
  greyscaleRaw() {
    const d = this.bitmap.data, n = this.width * this.height, out = Buffer.alloc(n)
    for (let i = 0; i < n; i++) {
      out[i] = linToSrgb8(0.2126 * SRGB_TO_LIN[d[i * 4]] + 0.7152 * SRGB_TO_LIN[d[i * 4 + 1]] + 0.0722 * SRGB_TO_LIN[d[i * 4 + 2]])
    }
    return out
  }

  // ---- kolom/baris raw ----
  toRaw() { return { data: Buffer.from(this.bitmap.data), width: this.width, height: this.height, channels: 4 } }
}
// ============================================================================
//  Rasterizer vektor (pure JS)
//   - fillPolygons : scanline coverage anti-aliasing (non-zero / even-odd)
//   - strokeToPolygons : ubah polyline jadi poligon garis tebal
//   - TTFont : parser TrueType (glyf/loca/cmap/hmtx/kern) + render teks
//  Dipakai oleh canvas (path/rect/arc/teks) dan brat.js (teks TTF).
// ============================================================================

// ---------- coverage buffer 8-bit: tiap piksel = persen tertutup ----------
// Supersampling vertikal 4x + akumulasi coverage horizontal exact => tepi halus tanpa berat.
const SS = 4

function fillPolygons(polys, width, height, rule = 'nonzero') {
  const cov = new Float32Array(width * height)

  // kumpulkan edge (skala vertikal SS)
  const edges = []
  for (const poly of polys) {
    const n = poly.length
    if (n < 3) continue
    for (let i = 0; i < n; i++) {
      const a = poly[i], b = poly[(i + 1) % n]
      if (a.y === b.y) continue
      const dir = a.y < b.y ? 1 : -1
      const p0 = a.y < b.y ? a : b, p1 = a.y < b.y ? b : a
      edges.push({ x0: p0.x, y0: p0.y * SS, x1: p1.x, y1: p1.y * SS, dir, slope: (p1.x - p0.x) / ((p1.y - p0.y) * SS) })
    }
  }
  if (!edges.length) return cov
  edges.sort((a, b) => a.y0 - b.y0)

  let minY = Infinity, maxY = -Infinity
  for (const e of edges) { if (e.y0 < minY) minY = e.y0; if (e.y1 > maxY) maxY = e.y1 }
  const startSub = Math.max(0, Math.floor(minY)), endSub = Math.min(height * SS - 1, Math.ceil(maxY))

  let active = [], ei = 0
  const weight = 1 / SS

  for (let sy = startSub; sy <= endSub; sy++) {
    const yc = sy + 0.5
    while (ei < edges.length && edges[ei].y0 <= yc) { active.push(edges[ei]); ei++ }
    active = active.filter(e => e.y1 > yc)
    if (!active.length) continue

    const xs = []
    for (const e of active) xs.push({ x: e.x0 + (yc - e.y0) * e.slope, dir: e.dir })
    xs.sort((a, b) => a.x - b.x)

    const row = Math.floor(sy / SS)
    if (row < 0 || row >= height) continue
    const base = row * width

    let winding = 0
    for (let i = 0; i < xs.length - 1; i++) {
      winding += xs[i].dir
      const inside = rule === 'evenodd' ? (i % 2 === 0) : winding !== 0
      if (!inside) continue
      const xa = xs[i].x, xb = xs[i + 1].x
      if (xb <= 0 || xa >= width) continue
      const a = Math.max(0, xa), b = Math.min(width, xb)
      const ia = Math.floor(a), ib = Math.floor(b)
      if (ia === ib) { cov[base + ia] += (b - a) * weight; continue }
      cov[base + ia] += (ia + 1 - a) * weight
      for (let x = ia + 1; x < ib; x++) cov[base + x] += weight
      if (ib < width) cov[base + ib] += (b - ib) * weight
    }
  }
  for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1
  return cov
}

// ---------- path -> polyline (flatten bezier/arc) ----------
function flattenQuad(out, x0, y0, cx, cy, x1, y1, tol = 0.15) {
  const dx = x0 - 2 * cx + x1, dy = y0 - 2 * cy + y1
  const steps = Math.min(32, Math.max(2, Math.ceil(Math.sqrt(Math.sqrt(dx * dx + dy * dy) / tol))))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, mt = 1 - t
    out.push({ x: mt * mt * x0 + 2 * mt * t * cx + t * t * x1, y: mt * mt * y0 + 2 * mt * t * cy + t * t * y1 })
  }
}
function flattenCubic(out, x0, y0, c1x, c1y, c2x, c2y, x1, y1, tol = 0.15) {
  const d = Math.hypot(c1x - x0, c1y - y0) + Math.hypot(c2x - c1x, c2y - c1y) + Math.hypot(x1 - c2x, y1 - c2y)
  const steps = Math.min(48, Math.max(3, Math.ceil(Math.sqrt(d / tol))))
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, mt = 1 - t
    out.push({
      x: mt ** 3 * x0 + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t ** 3 * x1,
      y: mt ** 3 * y0 + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t ** 3 * y1
    })
  }
}
function flattenArc(out, cx, cy, r, a0, a1, ccw) {
  let da = a1 - a0
  if (!ccw && da < 0) da += Math.PI * 2 * Math.ceil(-da / (Math.PI * 2))
  if (ccw && da > 0) da -= Math.PI * 2 * Math.ceil(da / (Math.PI * 2))
  if (Math.abs(da) > Math.PI * 2) da = Math.sign(da) * Math.PI * 2
  const steps = Math.max(8, Math.ceil((Math.abs(da) * Math.max(r, 1)) / 1.2))
  for (let i = 0; i <= steps; i++) {
    const a = a0 + da * (i / steps)
    out.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
}

// ---------- stroke: polyline -> poligon (butt/round/square cap, miter/round/bevel join) ----------
function strokeToPolygons(subpaths, width, cap = 'butt', join = 'miter') {
  const hw = width / 2, polys = []
  const circle = (c, r) => { const p = []; const n = Math.max(8, Math.ceil(r * 3)); for (let i = 0; i < n; i++) p.push({ x: c.x + r * Math.cos((i / n) * Math.PI * 2), y: c.y + r * Math.sin((i / n) * Math.PI * 2) }); return p }

  for (const { pts, closed } of subpaths) {
    const P = pts.filter((p, i) => i === 0 || Math.hypot(p.x - pts[i - 1].x, p.y - pts[i - 1].y) > 1e-6)
    if (P.length < 2) { if (P.length === 1 && cap === 'round') polys.push(circle(P[0], hw)); continue }
    const segCount = closed ? P.length : P.length - 1
    for (let i = 0; i < segCount; i++) {
      const a = P[i], b = P[(i + 1) % P.length]
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy)
      const nx = (-dy / len) * hw, ny = (dx / len) * hw
      let ax = a.x, ay = a.y, bx = b.x, by = b.y
      if (!closed && cap === 'square') {
        if (i === 0) { ax -= (dx / len) * hw; ay -= (dy / len) * hw }
        if (i === segCount - 1) { bx += (dx / len) * hw; by += (dy / len) * hw }
      }
      // urutan kuad diseragamkan (winding sama) supaya non-zero menyatukan overlap
      const quad = [{ x: ax + nx, y: ay + ny }, { x: bx + nx, y: by + ny }, { x: bx - nx, y: by - ny }, { x: ax - nx, y: ay - ny }]
      polys.push(quad)
    }
    // join
    const joinAt = (i) => {
      const p = P[i]
      const prev = P[(i - 1 + P.length) % P.length], next = P[(i + 1) % P.length]
      if (join === 'round') { polys.push(circle(p, hw)); return }
      const d1x = p.x - prev.x, d1y = p.y - prev.y, d2x = next.x - p.x, d2y = next.y - p.y
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y)
      const cross = d1x * d2y - d1y * d2x
      if (Math.abs(cross) < 1e-9) return
      const s = cross > 0 ? -1 : 1   // sisi luar tikungan
      const n1 = { x: (-d1y / l1) * hw * s, y: (d1x / l1) * hw * s }, n2 = { x: (-d2y / l2) * hw * s, y: (d2x / l2) * hw * s }
      const o1 = { x: p.x + n1.x, y: p.y + n1.y }, o2 = { x: p.x + n2.x, y: p.y + n2.y }
      const tri = [p, o1, o2]
      if (join === 'miter') {
        const mx = n1.x + n2.x, my = n1.y + n2.y, ml = Math.hypot(mx, my)
        if (ml > 1e-9) {
          const cosHalf = ml / (2 * hw)
          if (1 / cosHalf <= 10) { const k = hw / cosHalf / ml; tri.splice(2, 0, { x: p.x + mx * k, y: p.y + my * k }) }
        }
      }
      polys.push(tri)
    }
    const from = closed ? 0 : 1, to = closed ? P.length : P.length - 1
    for (let i = from; i < to; i++) joinAt(i)
    if (!closed && cap === 'round') { polys.push(circle(P[0], hw)); polys.push(circle(P[P.length - 1], hw)) }
  }
  // samakan orientasi semua poligon (CCW) supaya union non-zero benar
  for (const poly of polys) {
    let area = 0
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a.x * b.y - b.x * a.y }
    if (area < 0) poly.reverse()
  }
  return polys
}

// ---------- TrueType parser ----------
class TTFont {
  constructor(buf) {
    this.buf = buf
    const n = buf.readUInt16BE(4)
    this.tables = {}
    for (let i = 0; i < n; i++) {
      const r = 12 + i * 16
      this.tables[buf.toString('latin1', r, r + 4)] = { offset: buf.readUInt32BE(r + 8), length: buf.readUInt32BE(r + 12) }
    }
    for (const t of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'loca', 'glyf'])
      if (!this.tables[t]) throw new Error(`TTF: table wajib "${t}" tidak ada (font CFF/OTF belum didukung)`)

    this.unitsPerEm = buf.readUInt16BE(this.tables.head.offset + 18)
    this.locaFormat = buf.readInt16BE(this.tables.head.offset + 50)
    this.numGlyphs = buf.readUInt16BE(this.tables.maxp.offset + 4)
    this.ascent = buf.readInt16BE(this.tables.hhea.offset + 4)
    this.descent = buf.readInt16BE(this.tables.hhea.offset + 6)
    this.lineGap = buf.readInt16BE(this.tables.hhea.offset + 8)
    const nHM = buf.readUInt16BE(this.tables.hhea.offset + 34)
    this.advance = new Uint16Array(this.numGlyphs)
    let last = 0
    for (let g = 0; g < this.numGlyphs; g++) { if (g < nHM) last = buf.readUInt16BE(this.tables.hmtx.offset + g * 4); this.advance[g] = last }

    this.cmap = this._parseCmap()
    this.kernMap = this._parseKern()
    this._outlineCache = new Map()
  }

  _parseCmap() {
    const buf = this.buf, base = this.tables.cmap.offset
    const num = buf.readUInt16BE(base + 2)
    let best = -1, bestScore = -1
    for (let i = 0; i < num; i++) {
      const r = base + 4 + i * 8, pid = buf.readUInt16BE(r), eid = buf.readUInt16BE(r + 2), off = buf.readUInt32BE(r + 4)
      let sc = 0
      if (pid === 3 && eid === 10) sc = 5; else if (pid === 0 && eid >= 4) sc = 5
      else if (pid === 3 && eid === 1) sc = 4; else if (pid === 0) sc = 3
      if (sc > bestScore) { bestScore = sc; best = base + off }
    }
    if (best < 0) throw new Error('TTF: cmap unicode tidak ada')
    const fmt = buf.readUInt16BE(best), map = new Map()
    if (fmt === 4) {
      const sx2 = buf.readUInt16BE(best + 6), sc = sx2 / 2
      const endO = best + 14, startO = endO + sx2 + 2, deltaO = startO + sx2, rangeO = deltaO + sx2
      for (let s = 0; s < sc; s++) {
        const end = buf.readUInt16BE(endO + s * 2), start = buf.readUInt16BE(startO + s * 2)
        const delta = buf.readInt16BE(deltaO + s * 2), ro = buf.readUInt16BE(rangeO + s * 2)
        if (start === 0xffff) continue
        for (let c = start; c <= end; c++) {
          let g
          if (ro === 0) g = (c + delta) & 0xffff
          else { g = buf.readUInt16BE(rangeO + s * 2 + ro + (c - start) * 2); if (g) g = (g + delta) & 0xffff }
          if (g) map.set(c, g)
        }
      }
    } else if (fmt === 12) {
      const ng = buf.readUInt32BE(best + 12)
      for (let g = 0; g < ng; g++) {
        const r = best + 16 + g * 12, s = buf.readUInt32BE(r), e = buf.readUInt32BE(r + 4), gi = buf.readUInt32BE(r + 8)
        for (let c = s; c <= e; c++) map.set(c, gi + (c - s))
      }
    } else throw new Error(`TTF: cmap format ${fmt} tidak didukung`)
    return map
  }

  _parseKern() {
    const t = this.tables.kern
    if (!t) return null
    const buf = this.buf, m = new Map()
    try {
      const nTables = buf.readUInt16BE(t.offset + 2)
      let p = t.offset + 4
      for (let i = 0; i < nTables; i++) {
        const len = buf.readUInt16BE(p + 2), cov = buf.readUInt16BE(p + 4)
        if ((cov >> 8) === 0 && (cov & 1)) {
          const np = buf.readUInt16BE(p + 6)
          for (let k = 0; k < np; k++) { const o = p + 14 + k * 6; m.set((buf.readUInt16BE(o) << 16) | buf.readUInt16BE(o + 2), buf.readInt16BE(o + 4)) }
        }
        p += len
      }
    } catch { return null }
    return m
  }

  glyphIndex(cp) { return this.cmap.get(cp) || 0 }
  kerning(g1, g2) { return this.kernMap ? this.kernMap.get((g1 << 16) | g2) || 0 : 0 }

  measure(text, size, { kerning = true } = {}) {
    const sc = size / this.unitsPerEm
    let w = 0, prev = 0
    for (const ch of text) {
      const g = this.glyphIndex(ch.codePointAt(0))
      if (kerning && prev) w += this.kerning(prev, g)
      w += this.advance[g]; prev = g
    }
    return w * sc
  }

  // ---- outline glyph -> daftar kontur [{x,y,on}] dalam satuan font ----
  _glyphOffset(g) {
    const loca = this.tables.loca.offset
    return this.locaFormat === 0
      ? [this.buf.readUInt16BE(loca + g * 2) * 2, this.buf.readUInt16BE(loca + g * 2 + 2) * 2]
      : [this.buf.readUInt32BE(loca + g * 4), this.buf.readUInt32BE(loca + g * 4 + 4)]
  }

  outline(g, depth = 0) {
    if (this._outlineCache.has(g)) return this._outlineCache.get(g)
    if (g < 0 || g >= this.numGlyphs || depth > 6) return []
    const [s, e] = this._glyphOffset(g)
    if (s === e) { this._outlineCache.set(g, []); return [] }
    const buf = this.buf, base = this.tables.glyf.offset + s
    const nc = buf.readInt16BE(base)
    let contours = []

    if (nc >= 0) {
      const endPts = []
      for (let i = 0; i < nc; i++) endPts.push(buf.readUInt16BE(base + 10 + i * 2))
      const nPts = nc ? endPts[nc - 1] + 1 : 0
      let p = base + 10 + nc * 2
      const insLen = buf.readUInt16BE(p); p += 2 + insLen
      const flags = []
      while (flags.length < nPts) {
        const f = buf[p++]; flags.push(f)
        if (f & 8) { let r = buf[p++]; while (r--) flags.push(f) }
      }
      const xs = [], ys = []
      let v = 0
      for (let i = 0; i < nPts; i++) {
        const f = flags[i]
        if (f & 2) { const d = buf[p++]; v += f & 16 ? d : -d } else if (!(f & 16)) { v += buf.readInt16BE(p); p += 2 }
        xs.push(v)
      }
      v = 0
      for (let i = 0; i < nPts; i++) {
        const f = flags[i]
        if (f & 4) { const d = buf[p++]; v += f & 32 ? d : -d } else if (!(f & 32)) { v += buf.readInt16BE(p); p += 2 }
        ys.push(v)
      }
      let st = 0
      for (const en of endPts) {
        const c = []
        for (let i = st; i <= en; i++) c.push({ x: xs[i], y: ys[i], on: !!(flags[i] & 1) })
        contours.push(c); st = en + 1
      }
    } else {
      // composite glyph
      let p = base + 10, more = true
      while (more) {
        const fl = buf.readUInt16BE(p), gi = buf.readUInt16BE(p + 2); p += 4
        let dx, dy
        if (fl & 1) { dx = buf.readInt16BE(p); dy = buf.readInt16BE(p + 2); p += 4 } else { dx = buf.readInt8(p); dy = buf.readInt8(p + 1); p += 2 }
        if (!(fl & 2)) { dx = 0; dy = 0 }        // point-matching tidak didukung
        let a = 1, b = 0, c = 0, d = 1
        if (fl & 8) { a = d = buf.readInt16BE(p) / 16384; p += 2 }
        else if (fl & 0x40) { a = buf.readInt16BE(p) / 16384; d = buf.readInt16BE(p + 2) / 16384; p += 4 }
        else if (fl & 0x80) { a = buf.readInt16BE(p) / 16384; b = buf.readInt16BE(p + 2) / 16384; c = buf.readInt16BE(p + 4) / 16384; d = buf.readInt16BE(p + 6) / 16384; p += 8 }
        for (const con of this.outline(gi, depth + 1))
          contours.push(con.map(pt => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })))
        more = !!(fl & 0x20)
      }
    }
    this._outlineCache.set(g, contours)
    return contours
  }

  // kontur -> polyline (flatten quadratic), skala ke piksel, sumbu Y dibalik
  glyphPolys(g, scale, ox, oy) {
    const polys = []
    for (const c of this.outline(g)) {
      if (c.length < 2) continue
      // mulai dari titik on-curve
      let pts = c
      const firstOn = pts.findIndex(p => p.on)
      let start
      if (firstOn === -1) { const a = pts[0], b = pts[pts.length - 1]; start = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true } }
      else { pts = pts.slice(firstOn).concat(pts.slice(0, firstOn)); start = pts[0]; pts = pts.slice(1) }
      const T = p => ({ x: ox + p.x * scale, y: oy - p.y * scale })
      const out = [T(start)]
      let cur = start, i = 0
      const seq = firstOn === -1 ? [...c] : pts
      while (i < seq.length) {
        const p = seq[i]
        if (p.on) { out.push(T(p)); cur = p; i++ }
        else {
          const nx = seq[i + 1]
          let endP, adv
          if (nx && !nx.on) { endP = { x: (p.x + nx.x) / 2, y: (p.y + nx.y) / 2 }; adv = 1 }
          else if (nx) { endP = nx; adv = 2 }
          else { endP = start; adv = 1 }
          const a = T(cur), cc = T(p), e = T(endP)
          flattenQuad(out, a.x, a.y, cc.x, cc.y, e.x, e.y, 0.1)
          cur = endP; i += adv
        }
      }
      polys.push(out)
    }
    return polys
  }

  // Bitmap teks dipotong rapat ke bounding box tinta (kontrak yang sama dgn sharp `text:` / Pango).
  // Kembalian: { data: RGBA(hitam, alpha=coverage), width, height }
  renderInk(text, size, { kerning = true } = {}) {
    const sc = size / this.unitsPerEm
    const polys = []
    let pen = 0, prev = 0
    for (const ch of String(text)) {
      const g = this.glyphIndex(ch.codePointAt(0))
      if (kerning && prev) pen += this.kerning(prev, g) * sc
      polys.push(...this.glyphPolys(g, sc, pen, 0))
      pen += this.advance[g] * sc; prev = g
    }
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity
    for (const poly of polys) for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y }
    if (!isFinite(x0)) return { data: Buffer.alloc(0), width: 0, height: 0 }
    const W = Math.max(1, Math.round(x1 - x0)), H = Math.max(1, Math.round(y1 - y0))
    const dx = -x0, dy = -y0
    const shifted = polys.map(poly => poly.map(p => ({ x: p.x + dx, y: p.y + dy })))
    const cov = fillPolygons(shifted, W, H, 'nonzero')
    const data = Buffer.alloc(W * H * 4)
    for (let i = 0; i < W * H; i++) data[i * 4 + 3] = Math.round(cov[i] * 255)
    return { data, width: W, height: H }
  }

  // render teks jadi coverage (0..1) di kanvas (w x h). Baseline di y=baseline.
  renderText(text, size, width, height, x, baseline, { kerning = true } = {}) {
    const sc = size / this.unitsPerEm
    const polys = []
    let pen = x, prev = 0
    for (const ch of text) {
      const g = this.glyphIndex(ch.codePointAt(0))
      if (kerning && prev) pen += this.kerning(prev, g) * sc
      polys.push(...this.glyphPolys(g, sc, pen, baseline))
      pen += this.advance[g] * sc; prev = g
    }
    return { cov: fillPolygons(polys, width, height, 'nonzero'), advance: pen - x }
  }
}
// ============================================================================
//  canvas - Canvas 2D native (mirip node-canvas). Semua pure JS, tanpa sharp.
//  Render langsung ke buffer RGBA lewat rasterizer sendiri (bukan SVG).
// ============================================================================
const IDENTITY = [1, 0, 0, 1, 0, 0]
const mulM = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
]
const applyM = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })

// ---------- font terdaftar ----------
const registeredFonts = new Map()
function registerFont(path, { family } = {}) {
  if (!family) throw new Error('registerFont: opsi "family" wajib diisi')
  const buf = readFileSync(path)
  registeredFonts.set(family.toLowerCase(), { path, family, font: new TTFont(buf) })
}
// versi buffer untuk pemakaian internal (brat.js)
function loadFontBuffer(buf) { return new TTFont(buf) }

function parseFontString(fontStr) {
  const fb = { style: 'normal', weight: 'normal', size: 16, family: 'sans-serif' }
  if (!fontStr) return fb
  const tokens = fontStr.trim().split(/\s+/)
  const si = tokens.findIndex(t => /^[\d.]+px$/.test(t))
  if (si === -1) return fb
  const size = parseFloat(tokens[si]), before = tokens.slice(0, si)
  const family = tokens.slice(si + 1).join(' ').split(',')[0].replace(/['"]/g, '').trim() || fb.family
  return {
    style: before.includes('italic') ? 'italic' : before.includes('oblique') ? 'oblique' : 'normal',
    weight: before.includes('bold') ? 'bold' : (before.find(t => /^\d+$/.test(t)) || 'normal'),
    size: Number.isFinite(size) ? size : fb.size, family
  }
}

// ---------- Path2D ----------
class Path2D {
  constructor() { this.subpaths = []; this._cur = null }
  _begin(x, y) { this._cur = { pts: [{ x, y }], closed: false }; this.subpaths.push(this._cur) }
  _ensure(x, y) { if (!this._cur) this._begin(x, y) }
  moveTo(x, y) { this._begin(x, y) }
  lineTo(x, y) { this._ensure(x, y); this._cur.pts.push({ x, y }) }
  closePath() {
    if (!this._cur) return
    this._cur.closed = true
    const s = this._cur.pts[0]
    this._cur = { pts: [{ x: s.x, y: s.y }], closed: false }   // titik awal berikutnya = awal subpath
    this.subpaths.push(this._cur)
  }
  _last() { const p = this._cur.pts; return p[p.length - 1] }
  quadraticCurveTo(cx, cy, x, y) { this._ensure(cx, cy); const l = this._last(); flattenQuad(this._cur.pts, l.x, l.y, cx, cy, x, y) }
  bezierCurveTo(c1x, c1y, c2x, c2y, x, y) { this._ensure(c1x, c1y); const l = this._last(); flattenCubic(this._cur.pts, l.x, l.y, c1x, c1y, c2x, c2y, x, y) }
  rect(x, y, w, h) {
    this._begin(x, y)
    this._cur.pts.push({ x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h })
    this._cur.closed = true; this._cur = null
  }
  arc(cx, cy, r, a0, a1, ccw = false) {
    const pts = []; flattenArc(pts, cx, cy, r, a0, a1, ccw)
    if (this._cur && this._cur.pts.length) this._cur.pts.push(...pts); else { this._begin(pts[0].x, pts[0].y); this._cur.pts.push(...pts.slice(1)) }
  }
  ellipse(cx, cy, rx, ry, rot = 0, a0 = 0, a1 = Math.PI * 2, ccw = false) {
    const pts = []; flattenArc(pts, 0, 0, 1, a0, a1, ccw)
    const c = Math.cos(rot), s = Math.sin(rot)
    const m = pts.map(p => ({ x: cx + rx * p.x * c - ry * p.y * s, y: cy + rx * p.x * s + ry * p.y * c }))
    if (this._cur && this._cur.pts.length) this._cur.pts.push(...m); else { this._begin(m[0].x, m[0].y); this._cur.pts.push(...m.slice(1)) }
  }
  roundRect(x, y, w, h, radius = 0) {
    let r = Array.isArray(radius) ? radius : [radius]
    r = r.length === 1 ? [r[0], r[0], r[0], r[0]] : r.length === 2 ? [r[0], r[1], r[0], r[1]] : r.length === 3 ? [r[0], r[1], r[2], r[1]] : r
    r = r.map(v => Math.max(0, Math.min(typeof v === 'object' ? v.x : v, w / 2, h / 2)))
    const [tl, tr, br, bl] = r
    this._begin(x + tl, y)
    this.lineTo(x + w - tr, y); if (tr) this.arc(x + w - tr, y + tr, tr, -Math.PI / 2, 0)
    this.lineTo(x + w, y + h - br); if (br) this.arc(x + w - br, y + h - br, br, 0, Math.PI / 2)
    this.lineTo(x + bl, y + h); if (bl) this.arc(x + bl, y + h - bl, bl, Math.PI / 2, Math.PI)
    this.lineTo(x, y + tl); if (tl) this.arc(x + tl, y + tl, tl, Math.PI, Math.PI * 1.5)
    this._cur.closed = true; this._cur = null
  }
}

// ---------- Image ----------
class Image {
  constructor(jimpImg, src) { this._img = jimpImg; this.width = jimpImg.width; this.height = jimpImg.height; this.src = src || null }
}
async function loadImage(source) {
  if (source instanceof Image) return source
  const img = await Jimp.read(source)
  return new Image(img, typeof source === 'string' ? source : null)
}

// ---------- Context 2D ----------
class CanvasRenderingContext2D {
  constructor(canvas) {
    this.canvas = canvas
    this.fillStyle = '#000000'; this.strokeStyle = '#000000'
    this.lineWidth = 1; this.lineCap = 'butt'; this.lineJoin = 'miter'
    this.globalAlpha = 1; this.font = '10px sans-serif'
    this.textAlign = 'left'; this.textBaseline = 'alphabetic'
    this.globalCompositeOperation = 'source-over'
    this._m = IDENTITY.slice(); this._stack = []; this._path = new Path2D(); this._clip = null
  }

  // ---- state ----
  save() { this._stack.push({ m: this._m.slice(), fs: this.fillStyle, ss: this.strokeStyle, lw: this.lineWidth, lc: this.lineCap, lj: this.lineJoin, ga: this.globalAlpha, f: this.font, ta: this.textAlign, tb: this.textBaseline, gco: this.globalCompositeOperation, clip: this._clip }) }
  restore() {
    const s = this._stack.pop(); if (!s) return
    this._m = s.m; this.fillStyle = s.fs; this.strokeStyle = s.ss; this.lineWidth = s.lw; this.lineCap = s.lc; this.lineJoin = s.lj
    this.globalAlpha = s.ga; this.font = s.f; this.textAlign = s.ta; this.textBaseline = s.tb; this.globalCompositeOperation = s.gco; this._clip = s.clip
  }
  translate(x, y) { this._m = mulM(this._m, [1, 0, 0, 1, x, y]) }
  scale(sx, sy) { this._m = mulM(this._m, [sx, 0, 0, sy ?? sx, 0, 0]) }
  rotate(a) { const c = Math.cos(a), s = Math.sin(a); this._m = mulM(this._m, [c, s, -s, c, 0, 0]) }
  transform(a, b, c, d, e, f) { this._m = mulM(this._m, [a, b, c, d, e, f]) }
  setTransform(a, b, c, d, e, f) { if (a && typeof a === 'object') ({ a, b, c, d, e, f } = a); this._m = [a, b, c, d, e, f] }
  resetTransform() { this._m = IDENTITY.slice() }
  getTransform() { const [a, b, c, d, e, f] = this._m; return { a, b, c, d, e, f } }

  // ---- path ----
  beginPath() { this._path = new Path2D() }
  moveTo(x, y) { this._path.moveTo(x, y) }
  lineTo(x, y) { this._path.lineTo(x, y) }
  closePath() { this._path.closePath() }
  quadraticCurveTo(...a) { this._path.quadraticCurveTo(...a) }
  bezierCurveTo(...a) { this._path.bezierCurveTo(...a) }
  arc(...a) { this._path.arc(...a) }
  ellipse(...a) { this._path.ellipse(...a) }
  rect(...a) { this._path.rect(...a) }
  roundRect(...a) { this._path.roundRect(...a) }
  arcTo(x1, y1, x2, y2, r) {
    const p = this._path
    if (!p._cur) { p.moveTo(x1, y1); return }
    const l = p._last(), v1 = { x: l.x - x1, y: l.y - y1 }, v2 = { x: x2 - x1, y: y2 - y1 }
    const l1 = Math.hypot(v1.x, v1.y), l2 = Math.hypot(v2.x, v2.y)
    if (!l1 || !l2 || !r) { p.lineTo(x1, y1); return }
    const a = Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (l1 * l2))))
    if (Math.abs(Math.sin(a)) < 1e-6) { p.lineTo(x1, y1); return }
    const d = r / Math.tan(a / 2)
    const t1 = { x: x1 + (v1.x / l1) * d, y: y1 + (v1.y / l1) * d }, t2 = { x: x1 + (v2.x / l2) * d, y: y1 + (v2.y / l2) * d }
    p.lineTo(t1.x, t1.y)
    const cross = v1.x * v2.y - v1.y * v2.x
    const n = (cross > 0 ? 1 : -1)
    const c = { x: t1.x + n * (v1.y / l1) * r * -1, y: t1.y + n * (v1.x / l1) * r }
    const a0 = Math.atan2(t1.y - c.y, t1.x - c.x), a1 = Math.atan2(t2.y - c.y, t2.x - c.x)
    p.arc(c.x, c.y, r, a0, a1, cross > 0)
  }

  // ---- inti: gambar coverage ke buffer ----
  _paintCoverage(cov, color, alphaMul = 1) {
    const { width: W, height: H, _raw: raw } = this.canvas
    const { r, g, b, a } = color
    const ga = this.globalAlpha * a * alphaMul
    const clip = this._clip, op = this.globalCompositeOperation
    for (let i = 0; i < cov.length; i++) {
      let c = cov[i]; if (c <= 0) continue
      if (clip) { c *= clip[i]; if (c <= 0) continue }
      const sa = c * ga, di = i * 4
      if (op === 'destination-out') { raw[di + 3] = Math.round(raw[di + 3] * (1 - sa)); continue }
      if (op === 'destination-in') continue
      if (sa >= 0.9999) { raw[di] = r; raw[di + 1] = g; raw[di + 2] = b; raw[di + 3] = 255; continue }
      const da = raw[di + 3] / 255, oa = sa + da * (1 - sa)
      if (oa <= 0) continue
      raw[di] = Math.round((r * sa + raw[di] * da * (1 - sa)) / oa)
      raw[di + 1] = Math.round((g * sa + raw[di + 1] * da * (1 - sa)) / oa)
      raw[di + 2] = Math.round((b * sa + raw[di + 2] * da * (1 - sa)) / oa)
      raw[di + 3] = Math.round(oa * 255)
    }
  }

  _fillStyleColor(s) { return typeof s === 'object' && s && s._color ? s._color : parseColor(s) }

  _devicePolys(path, close = true) {
    const polys = []
    for (const sp of path.subpaths) {
      if (sp.pts.length < 2 && !(sp.pts.length === 1 && !close)) continue
      const pts = sp.pts.map(p => applyM(this._m, p.x, p.y))
      if (pts.length >= 3) polys.push(pts)
    }
    return polys
  }

  _fillPath(path, rule = 'nonzero') {
    const { width: W, height: H } = this.canvas
    const cov = fillPolygons(this._devicePolys(path), W, H, rule)
    this._paintCoverage(cov, this._fillStyleColor(this.fillStyle))
  }
  _strokePath(path) {
    const { width: W, height: H } = this.canvas
    const sc = Math.sqrt(Math.abs(this._m[0] * this._m[3] - this._m[1] * this._m[2])) || 1
    const sub = path.subpaths.filter(s => s.pts.length >= 2).map(s => ({ pts: s.pts.map(p => applyM(this._m, p.x, p.y)), closed: s.closed }))
    const polys = strokeToPolygons(sub, this.lineWidth * sc, this.lineCap, this.lineJoin)
    this._paintCoverage(fillPolygons(polys, W, H, 'nonzero'), this._fillStyleColor(this.strokeStyle))
  }

  fill(a, b) { const path = a instanceof Path2D ? a : this._path; this._fillPath(path, (a instanceof Path2D ? b : a) || 'nonzero') }
  stroke(p) { this._strokePath(p instanceof Path2D ? p : this._path) }
  clip(a, b) {
    const path = a instanceof Path2D ? a : this._path
    const { width: W, height: H } = this.canvas
    const cov = fillPolygons(this._devicePolys(path), W, H, (a instanceof Path2D ? b : a) || 'nonzero')
    if (this._clip) for (let i = 0; i < cov.length; i++) cov[i] *= this._clip[i]
    this._clip = cov
  }
  isPointInPath() { return false }

  // ---- rect ----
  fillRect(x, y, w, h) { const p = new Path2D(); p.rect(x, y, w, h); this._fillPath(p) }
  strokeRect(x, y, w, h) { const p = new Path2D(); p.rect(x, y, w, h); this._strokePath(p) }
  clearRect(x, y, w, h) {
    const p = new Path2D(); p.rect(x, y, w, h)
    const { width: W, height: H, _raw: raw } = this.canvas
    const cov = fillPolygons(this._devicePolys(p), W, H)
    for (let i = 0; i < cov.length; i++) { if (cov[i] <= 0) continue; const di = i * 4; raw[di + 3] = Math.round(raw[di + 3] * (1 - cov[i])); if (raw[di + 3] === 0) raw[di] = raw[di + 1] = raw[di + 2] = 0 }
  }

  // ---- gradient sederhana ----
  createLinearGradient(x0, y0, x1, y1) { return new Gradient('linear', [x0, y0, x1, y1]) }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Gradient('radial', [x0, y0, r0, x1, y1, r1]) }

  // ---- image ----
  drawImage(image, ...rest) {
    const src = image instanceof Image ? image._img : image instanceof Canvas ? image._asJimp() : null
    if (!src) throw new Error('drawImage: argumen pertama harus hasil loadImage() atau Canvas')
    let sx = 0, sy = 0, sw = src.width, sh = src.height, dx, dy, dw, dh
    if (rest.length === 2) { [dx, dy] = rest; dw = sw; dh = sh }
    else if (rest.length === 4) { [dx, dy, dw, dh] = rest }
    else if (rest.length === 8) { [sx, sy, sw, sh, dx, dy, dw, dh] = rest }
    else throw new Error('drawImage: jumlah argumen tidak valid (2, 4, atau 8 setelah image)')

    const { width: W, height: H, _raw: raw } = this.canvas
    const S = src.bitmap
    const inv = invertM(this._m)
    if (!inv) return
    // bounding box tujuan di device space
    const corners = [applyM(this._m, dx, dy), applyM(this._m, dx + dw, dy), applyM(this._m, dx, dy + dh), applyM(this._m, dx + dw, dy + dh)]
    const x0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c.x)))), x1 = Math.min(W - 1, Math.ceil(Math.max(...corners.map(c => c.x))))
    const y0 = Math.max(0, Math.floor(Math.min(...corners.map(c => c.y)))), y1 = Math.min(H - 1, Math.ceil(Math.max(...corners.map(c => c.y))))
    const ga = this.globalAlpha, clip = this._clip
    const kx = sw / dw, ky = sh / dh
    const smooth = Math.abs(kx * this._m[0]) < 1 || true
    for (let py = y0; py <= y1; py++) for (let px = x0; px <= x1; px++) {
      const u = applyM(inv, px + 0.5, py + 0.5)
      if (u.x < dx || u.y < dy || u.x >= dx + dw || u.y >= dy + dh) continue
      const fx = sx + (u.x - dx) * kx - 0.5, fy = sy + (u.y - dy) * ky - 0.5
      // bilinear premultiplied
      const ix = Math.floor(fx), iy = Math.floor(fy), tx = fx - ix, ty = fy - iy
      let r = 0, g = 0, b = 0, a = 0
      for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
        const cx = Math.min(sx + sw - 1, Math.max(sx, ix + i)), cy = Math.min(sy + sh - 1, Math.max(sy, iy + j))
        const w = (i ? tx : 1 - tx) * (j ? ty : 1 - ty), si = (cy * S.width + cx) * 4, al = S.data[si + 3] / 255
        r += S.data[si] * al * w; g += S.data[si + 1] * al * w; b += S.data[si + 2] * al * w; a += al * w
      }
      if (a <= 0) continue
      const sa = a * ga * (clip ? clip[py * W + px] : 1), di = (py * W + px) * 4
      if (sa <= 0) continue
      const cr = r / a, cg = g / a, cb = b / a, da = raw[di + 3] / 255, oa = sa + da * (1 - sa)
      raw[di] = Math.round((cr * sa + raw[di] * da * (1 - sa)) / oa); raw[di + 1] = Math.round((cg * sa + raw[di + 1] * da * (1 - sa)) / oa)
      raw[di + 2] = Math.round((cb * sa + raw[di + 2] * da * (1 - sa)) / oa); raw[di + 3] = Math.round(oa * 255)
    }
  }

  getImageData(x, y, w, h) {
    const { width: W, _raw: raw } = this.canvas, out = new Uint8ClampedArray(w * h * 4)
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j
      if (sx < 0 || sy < 0 || sx >= W || sy >= this.canvas.height) continue
      raw.copy(out, (j * w + i) * 4, (sy * W + sx) * 4, (sy * W + sx) * 4 + 4)
    }
    return { data: out, width: w, height: h }
  }
  putImageData(img, x, y) {
    const { width: W, height: H, _raw: raw } = this.canvas
    for (let j = 0; j < img.height; j++) for (let i = 0; i < img.width; i++) {
      const dx = x + i, dy = y + j; if (dx < 0 || dy < 0 || dx >= W || dy >= H) continue
      for (let k = 0; k < 4; k++) raw[(dy * W + dx) * 4 + k] = img.data[(j * img.width + i) * 4 + k]
    }
  }

  // ---- teks (TTF native) ----
  _resolveFont() {
    const p = parseFontString(this.font), reg = registeredFonts.get(p.family.toLowerCase())
    return { ...p, ttf: reg?.font || null }
  }
  measureText(text) {
    const f = this._resolveFont()
    const width = f.ttf ? f.ttf.measure(String(text), f.size) : String(text).length * f.size * 0.55
    const asc = f.ttf ? (f.ttf.ascent / f.ttf.unitsPerEm) * f.size : f.size * 0.8
    const desc = f.ttf ? (-f.ttf.descent / f.ttf.unitsPerEm) * f.size : f.size * 0.2
    return { width, actualBoundingBoxAscent: asc, actualBoundingBoxDescent: desc, actualBoundingBoxLeft: 0, actualBoundingBoxRight: width, fontBoundingBoxAscent: asc, fontBoundingBoxDescent: desc }
  }
  _drawText(text, x, y, maxWidth, style, stroke) {
    const f = this._resolveFont()
    if (!f.ttf) throw new Error(`Font "${f.family}" belum didaftarkan (registerFont). Rasterizer teks butuh file TTF.`)
    text = String(text)
    let size = f.size, width = f.ttf.measure(text, size)
    if (maxWidth && width > maxWidth) { size = size * (maxWidth / width); width = maxWidth }
    let ox = x
    if (this.textAlign === 'center') ox = x - width / 2
    else if (this.textAlign === 'right' || this.textAlign === 'end') ox = x - width
    const asc = (f.ttf.ascent / f.ttf.unitsPerEm) * size, desc = (-f.ttf.descent / f.ttf.unitsPerEm) * size
    let by = y
    if (this.textBaseline === 'top' || this.textBaseline === 'hanging') by = y + asc
    else if (this.textBaseline === 'middle') by = y + (asc - desc) / 2
    else if (this.textBaseline === 'bottom' || this.textBaseline === 'ideographic') by = y - desc

    const sc = size / f.ttf.unitsPerEm, polys = []
    let pen = 0, prev = 0
    for (const ch of text) {
      const g = f.ttf.glyphIndex(ch.codePointAt(0))
      if (prev) pen += f.ttf.kerning(prev, g) * sc
      for (const poly of f.ttf.glyphPolys(g, sc, ox + pen, by)) polys.push(poly.map(p => applyM(this._m, p.x, p.y)))
      pen += f.ttf.advance[g] * sc; prev = g
    }
    const { width: W, height: H } = this.canvas
    if (stroke) {
      const scl = Math.sqrt(Math.abs(this._m[0] * this._m[3] - this._m[1] * this._m[2])) || 1
      const sp = polys.map(p => ({ pts: p, closed: true }))
      this._paintCoverage(fillPolygons(strokeToPolygons(sp, this.lineWidth * scl, this.lineCap, this.lineJoin), W, H), this._fillStyleColor(style))
    } else this._paintCoverage(fillPolygons(polys, W, H, 'nonzero'), this._fillStyleColor(style))
  }
  fillText(t, x, y, mw) { this._drawText(t, x, y, mw, this.fillStyle, false) }
  strokeText(t, x, y, mw) { this._drawText(t, x, y, mw, this.strokeStyle, true) }
}

function invertM(m) {
  const det = m[0] * m[3] - m[1] * m[2]
  if (Math.abs(det) < 1e-12) return null
  const id = 1 / det
  return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id]
}

class Gradient {
  constructor(type, coords) { this.type = type; this.coords = coords; this.stops = [] }
  addColorStop(o, c) { this.stops.push({ o, c: parseColor(c) }); this.stops.sort((a, b) => a.o - b.o) }
  // pendekatan: pakai warna di titik tengah (gradient penuh belum diimplementasikan)
  get _color() {
    if (!this.stops.length) return { r: 0, g: 0, b: 0, a: 1 }
    return this.stops[Math.floor(this.stops.length / 2)].c
  }
}

class Canvas {
  constructor(width, height) {
    this.width = width; this.height = height
    this._raw = Buffer.alloc(width * height * 4); this._ctx = null
  }
  getContext(type = '2d') {
    if (type !== '2d') throw new Error(`Canvas.getContext: tipe "${type}" tidak didukung, cuma "2d"`)
    if (!this._ctx) this._ctx = new CanvasRenderingContext2D(this)
    return this._ctx
  }
  _asJimp() { return new Jimp({ data: Buffer.from(this._raw), width: this.width, height: this.height }) }
  // API lama bersifat async; tetap async supaya kode pemanggil tidak perlu berubah
  async toBuffer(mime = 'image/png', options) { return this._asJimp().getBuffer(mime === 'image/jpg' ? 'image/jpeg' : mime, options) }
  async toDataURL(mime = 'image/png', options) {
    const m = mime === 'image/jpg' ? 'image/jpeg' : mime
    return `data:${m};base64,${(await this.toBuffer(m, options)).toString('base64')}`
  }
}

function createCanvas(width, height) {
  if (!width || !height) throw new Error('createCanvas: width dan height wajib diisi')
  return new Canvas(width, height)
}

// ============================================================================
//  EXPORT
// ============================================================================
const jimp = {
  Jimp,
  read: src => Jimp.read(src),
  fromBuffer: buf => Jimp.fromBuffer(buf),
  create: (width, height, color = 0x00000000) => new Jimp({ width, height, color }),
  fromRaw: ({ data, width, height, channels = 4 }) => {
    if (channels === 4) return new Jimp({ data: Buffer.from(data), width, height })
    const out = Buffer.alloc(width * height * 4)
    for (let i = 0; i < width * height; i++) {
      if (channels === 3) { out[i * 4] = data[i * 3]; out[i * 4 + 1] = data[i * 3 + 1]; out[i * 4 + 2] = data[i * 3 + 2]; out[i * 4 + 3] = 255 }
      else if (channels === 1) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i]; out[i * 4 + 3] = 255 }
      else if (channels === 2) { out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = data[i * 2]; out[i * 4 + 3] = data[i * 2 + 1] }
      else throw new Error('fromRaw: channels harus 1-4')
    }
    return new Jimp({ data: out, width, height })
  },
  detectFormat, readDimensions, getExifOrientation,
  MIME: { PNG: 'image/png', JPEG: 'image/jpeg', BMP: 'image/bmp', WEBP: 'image/webp' },
  webpToPng, pngToWebp,
  TTFont, loadFontBuffer, fillPolygons,

  // ---- pengganti sharp(...).metadata() : tanpa decode penuh, aman utk WebP ----
  metadata(buf) {
    const format = detectFormat(buf)
    if (!format) throw new Error('metadata: format gambar tidak dikenali')
    const d = readDimensions(buf)
    if (!d) throw new Error('metadata: dimensi tidak terbaca')
    return { format, width: d.width, height: d.height }
  },

  // ---- pengganti sharp(x).resize(w,h,opts).png()/.jpeg()/.webp().toBuffer() ----
  // out: 'png' | 'jpeg' | 'webp'
  async resize(input, w, h, { fit = 'fill', position = 'center', background, out = 'png', quality, kernel } = {}) {
    const img = await Jimp.read(input)
    img.resize(w, h, { fit, position, background, kernel })
    return img.getBuffer(FORMAT_MIME[out], { quality })
  },

  // ---- pengganti sharp(x).extract({left,top,width,height}).jpeg().toBuffer() ----
  async extract(input, { left, top, width, height }, out = 'jpeg', quality) {
    const img = await Jimp.read(input)
    img.crop(left, top, width, height)
    return img.getBuffer(FORMAT_MIME[out], { quality })
  },

  // ---- gambar mentah -> Buffer piksel + info (pengganti .raw().toBuffer({resolveWithObject})) ----
  async toRaw(input, { channels = 4 } = {}) {
    const img = await Jimp.read(input)
    const src = img.bitmap.data, n = img.width * img.height
    if (channels === 4) return { data: Buffer.from(src), info: { width: img.width, height: img.height, channels: 4 } }
    const data = Buffer.alloc(n * channels)
    for (let i = 0; i < n; i++) {
      if (channels === 3) { data[i * 3] = src[i * 4]; data[i * 3 + 1] = src[i * 4 + 1]; data[i * 3 + 2] = src[i * 4 + 2] }
      else if (channels === 1) data[i] = Math.round(src[i * 4] * 0.2126 + src[i * 4 + 1] * 0.7152 + src[i * 4 + 2] * 0.0722)
      else throw new Error('toRaw: channels harus 1, 3, atau 4')
    }
    return { data, info: { width: img.width, height: img.height, channels } }
  },
}

const canvas = {
  createCanvas, loadImage, registerFont,
  Canvas, CanvasRenderingContext2D, Image, Path2D
}

export { canvas, jimp }
