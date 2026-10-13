import { spawn } from 'node:child_process'
import { promises as fsp, readFileSync, readdirSync, openSync, readSync, closeSync, statSync, realpathSync } from 'node:fs'
import nodePath from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'

const FFMPEG = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg'

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
    p.stdin.on('error', () => {})
    p.stdin.end(input)
  })
}

const webpToPng = buf => ffmpegPipe(['-f', 'webp_pipe', '-i', 'pipe:0', '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', 'pipe:1'], buf)

const pngToWebp = (png, { quality = 80, lossless = false } = {}) =>
  ffmpegPipe(['-f', 'png_pipe', '-i', 'pipe:0', '-vcodec', 'libwebp', ...(lossless ? ['-lossless', '1'] : ['-quality', String(quality)]), '-f', 'webp', 'pipe:1'], png)

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

import zlib from "node:zlib"
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
    if (bitDepth === 16) return row[(x * channels + c) * 2]
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
const jpegEncode = (function () {
  const btoa = (buf) => Buffer.from(buf).toString('base64');

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
				for (var nr = nrlower; nr<nrupper; nr++) {
					category[32767+nr] = cat;
					bitcode[32767+nr] = [];
					bitcode[32767+nr][1] = cat;
					bitcode[32767+nr][0] = nr;
				}
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
      byteout.push(value);
		}

		function writeWord(value)
		{
			writeByte((value>>8)&0xFF);
			writeByte((value   )&0xFF);
		}

		function fDCTQuant(data, fdtbl)
		{
			var d0, d1, d2, d3, d4, d5, d6, d7;
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

				var tmp10 = tmp0 + tmp3;
				var tmp13 = tmp0 - tmp3;
				var tmp11 = tmp1 + tmp2;
				var tmp12 = tmp1 - tmp2;

				data[dataOff] = tmp10 + tmp11;
				data[dataOff+4] = tmp10 - tmp11;

				var z1 = (tmp12 + tmp13) * 0.707106781;
				data[dataOff+2] = tmp13 + z1;
				data[dataOff+6] = tmp13 - z1;

				tmp10 = tmp4 + tmp5;
				tmp11 = tmp5 + tmp6;
				tmp12 = tmp6 + tmp7;

				var z5 = (tmp10 - tmp12) * 0.382683433;
				var z2 = 0.541196100 * tmp10 + z5;
				var z4 = 1.306562965 * tmp12 + z5;
				var z3 = tmp11 * 0.707106781;

				var z11 = tmp7 + z3;
				var z13 = tmp7 - z3;

				data[dataOff+5] = z13 + z2;
				data[dataOff+3] = z13 - z2;
				data[dataOff+1] = z11 + z4;
				data[dataOff+7] = z11 - z4;

				dataOff += 8;
			}

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

				var tmp10p2 = tmp0p2 + tmp3p2;
				var tmp13p2 = tmp0p2 - tmp3p2;
				var tmp11p2 = tmp1p2 + tmp2p2;
				var tmp12p2 = tmp1p2 - tmp2p2;

				data[dataOff] = tmp10p2 + tmp11p2;
				data[dataOff+32] = tmp10p2 - tmp11p2;

				var z1p2 = (tmp12p2 + tmp13p2) * 0.707106781;
				data[dataOff+16] = tmp13p2 + z1p2;
				data[dataOff+48] = tmp13p2 - z1p2;

				tmp10p2 = tmp4p2 + tmp5p2;
				tmp11p2 = tmp5p2 + tmp6p2;
				tmp12p2 = tmp6p2 + tmp7p2;

				var z5p2 = (tmp10p2 - tmp12p2) * 0.382683433;
				var z2p2 = 0.541196100 * tmp10p2 + z5p2;
				var z4p2 = 1.306562965 * tmp12p2 + z5p2;
				var z3p2 = tmp11p2 * 0.707106781;

				var z11p2 = tmp7p2 + z3p2;
				var z13p2 = tmp7p2 - z3p2;

				data[dataOff+40] = z13p2 + z2p2;
				data[dataOff+24] = z13p2 - z2p2;
				data[dataOff+ 8] = z11p2 + z4p2;
				data[dataOff+56] = z11p2 - z4p2;

				dataOff++;
			}

			var fDCTQuant;
			for (i=0; i<I64; ++i)
			{
				fDCTQuant = data[i]*fdtbl[i];
				outputfDCTQuant[i] = (fDCTQuant > 0.0) ? ((fDCTQuant + 0.5)|0) : ((fDCTQuant - 0.5)|0);

			}
			return outputfDCTQuant;
		}

		function writeAPP0()
		{
			writeWord(0xFFE0);
			writeWord(16);
			writeByte(0x4A);
			writeByte(0x46);
			writeByte(0x49);
			writeByte(0x46);
			writeByte(0);
			writeByte(1);
			writeByte(1);
			writeByte(0);
			writeWord(1);
			writeWord(1);
			writeByte(0);
			writeByte(0);
		}

		function writeAPP1(exifBuffer) {
			if (!exifBuffer) return;

			writeWord(0xFFE1);

			if (exifBuffer[0] === 0x45 &&
					exifBuffer[1] === 0x78 &&
					exifBuffer[2] === 0x69 &&
					exifBuffer[3] === 0x66) {
				writeWord(exifBuffer.length + 2);
			} else {
				writeWord(exifBuffer.length + 5 + 2);
				writeByte(0x45);
				writeByte(0x78);
				writeByte(0x69);
				writeByte(0x66);
				writeByte(0);
			}

			for (var i = 0; i < exifBuffer.length; i++) {
				writeByte(exifBuffer[i]);
			}
		}

		function writeSOF0(width, height)
		{
			writeWord(0xFFC0);
			writeWord(17);
			writeByte(8);
			writeWord(height);
			writeWord(width);
			writeByte(3);
			writeByte(1);
			writeByte(0x11);
			writeByte(0);
			writeByte(2);
			writeByte(0x11);
			writeByte(1);
			writeByte(3);
			writeByte(0x11);
			writeByte(1);
		}

		function writeDQT()
		{
			writeWord(0xFFDB);
			writeWord(132);
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
			writeWord(0xFFC4);
			writeWord(0x01A2);

			writeByte(0);
			for (var i=0; i<16; i++) {
				writeByte(std_dc_luminance_nrcodes[i+1]);
			}
			for (var j=0; j<=11; j++) {
				writeByte(std_dc_luminance_values[j]);
			}

			writeByte(0x10);
			for (var k=0; k<16; k++) {
				writeByte(std_ac_luminance_nrcodes[k+1]);
			}
			for (var l=0; l<=161; l++) {
				writeByte(std_ac_luminance_values[l]);
			}

			writeByte(1);
			for (var m=0; m<16; m++) {
				writeByte(std_dc_chrominance_nrcodes[m+1]);
			}
			for (var n=0; n<=11; n++) {
				writeByte(std_dc_chrominance_values[n]);
			}

			writeByte(0x11);
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
				writeWord(0xFFFE);
				var l = e.length;
				writeWord(l + 2);
				var i;
				for (i = 0; i < l; i++)
					writeByte(e.charCodeAt(i));
			});
		}

		function writeSOS()
		{
			writeWord(0xFFDA);
			writeWord(12);
			writeByte(3);
			writeByte(1);
			writeByte(0);
			writeByte(2);
			writeByte(0x11);
			writeByte(3);
			writeByte(0x11);
			writeByte(0);
			writeByte(0x3f);
			writeByte(0);
		}

		function processDU(CDU, fdtbl, DC, HTDC, HTAC){
			var EOB = HTAC[0x00];
			var M16zeroes = HTAC[0xF0];
			var pos;
			var I16 = 16;
			var I63 = 63;
			var I64 = 64;
			var DU_DCT = fDCTQuant(CDU, fdtbl);
			for (var j=0;j<I64;++j) {
				DU[ZigZag[j]]=DU_DCT[j];
			}
			var Diff = DU[0] - DC; DC = DU[0];
			if (Diff==0) {
				writeBits(HTDC[0]);
			} else {
				pos = 32767+Diff;
				writeBits(HTDC[category[pos]]);
				writeBits(bitcode[pos]);
			}
			var end0pos = 63;
			for (; (end0pos>0)&&(DU[end0pos]==0); end0pos--) {};
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
			for(var i=0; i < 256; i++){
				clt[i] = sfcc(i);
			}
		}

		this.encode = function(image,quality)
		{
			var time_start = new Date().getTime();

			if(quality) setQuality(quality);

			byteout = new Array();
			bytenew=0;
			bytepos=7;

			writeWord(0xFFD8);
			writeAPP0();
			writeCOM(image.comments);
			writeAPP1(image.exifBuffer);
			writeDQT();
			writeSOF0(image.width,image.height);
			writeDHT();
			writeSOS();

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
					row = pos >> 3;
					col = ( pos & 7 ) * 4;
					p = start + ( row * quadWidth ) + col;

					if(y+row >= height){
						p-= (quadWidth*(y+1+row-height));
					}

					if(x+col >= quadWidth){
						p-= ((x+col) - quadWidth +4)
					}

					r = imageData[ p++ ];
					g = imageData[ p++ ];
					b = imageData[ p++ ];

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

			if ( bytepos >= 0 ) {
				var fillbits = [];
				fillbits[1] = bytepos+1;
				fillbits[0] = (1<<(bytepos+1))-1;
				writeBits(fillbits);
			}

			writeWord(0xFFD9);

			if (typeof module === 'undefined') return new Uint8Array(byteout);
      return Buffer.from(byteout);

			var jpegDataUri = 'data:image/jpeg;base64,' + btoa(byteout.join(''));

			byteout = [];

			var duration = new Date().getTime() - time_start;

			return jpegDataUri
	}

	function setQuality(quality){
		if (quality <= 0) {
			quality = 1;
		}
		if (quality > 100) {
			quality = 100;
		}

		if(currentQuality == quality) return

		var sf = 0;
		if (quality < 50) {
			sf = Math.floor(5000 / quality);
		} else {
			sf = Math.floor(200 - quality*2);
		}

		initQuantTables(sf);
		currentQuality = quality;
	}

	function init(){
		var time_start = new Date().getTime();
		if(!quality) quality = 50;
		initCharLookupTable()
		initHuffmanTbl();
		initCategoryNumber();
		initRGBYUVTable();

		setQuality(quality);
		var duration = new Date().getTime() - time_start;
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

  var dctCos1  =  4017
  var dctSin1  =   799
  var dctCos3  =  3406
  var dctSin3  =  2276
  var dctCos6  =  1567
  var dctSin6  =  3784
  var dctSqrt2 =  5793
  var dctSqrt1d2 = 2896

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
        case 0:
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
        case 1:
        case 2:
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          else {
            r--;
            if (r === 0)
              successiveACState = successiveACState == 2 ? 3 : 0;
          }
          break;
        case 3:
          if (zz[z])
            zz[z] += (readBit() << successive) * direction;
          else {
            zz[z] = successiveACNextValue << successive;
            successiveACState = 0;
          }
          break;
        case 4:
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
      if (component.blocks[blockRow] === undefined && opts.tolerantDecoding)
        return;
      decode(component, component.blocks[blockRow][blockCol]);
    }
    function decodeBlock(component, decode, mcu) {
      var blockRow = (mcu / component.blocksPerLine) | 0;
      var blockCol = mcu % component.blocksPerLine;
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

          if (mcu === mcuExpected) break;
        }
      }

      if (mcu === mcuExpected) {
        do {
          if (data[offset] === 0xFF) {
            if (data[offset + 1] !== 0x00) {
              break;
            }
          }
          offset += 1;
        } while (offset < data.length - 2);
      }

      bitsCount = 0;
      marker = (data[offset] << 8) | data[offset + 1];
      if (marker < 0xFF00) {
        throw new Error("marker was not found");
      }

      if (marker >= 0xFFD0 && marker <= 0xFFD7) {
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
    var R = new Int32Array(64), r = new Uint8Array(64);

    function quantizeAndInverse(zz, dataOut, dataIn) {
      var qt = component.quantizationTable;
      var v0, v1, v2, v3, v4, v5, v6, v7, t;
      var p = dataIn;
      var i;

      for (i = 0; i < 64; i++)
        p[i] = zz[i] * qt[i];

      for (i = 0; i < 8; ++i) {
        var row = 8 * i;

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

        v0 = (dctSqrt2 * p[0 + row] + 128) >> 8;
        v1 = (dctSqrt2 * p[4 + row] + 128) >> 8;
        v2 = p[2 + row];
        v3 = p[6 + row];
        v4 = (dctSqrt1d2 * (p[1 + row] - p[7 + row]) + 128) >> 8;
        v7 = (dctSqrt1d2 * (p[1 + row] + p[7 + row]) + 128) >> 8;
        v5 = p[3 + row] << 4;
        v6 = p[5 + row] << 4;

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

        p[0 + row] = v0 + v7;
        p[7 + row] = v0 - v7;
        p[1 + row] = v1 + v6;
        p[6 + row] = v1 - v6;
        p[2 + row] = v2 + v5;
        p[5 + row] = v2 - v5;
        p[3 + row] = v3 + v4;
        p[4 + row] = v3 - v4;
      }

      for (i = 0; i < 8; ++i) {
        var col = i;

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

        v0 = (dctSqrt2 * p[0*8 + col] + 2048) >> 12;
        v1 = (dctSqrt2 * p[4*8 + col] + 2048) >> 12;
        v2 = p[2*8 + col];
        v3 = p[6*8 + col];
        v4 = (dctSqrt1d2 * (p[1*8 + col] - p[7*8 + col]) + 2048) >> 12;
        v7 = (dctSqrt1d2 * (p[1*8 + col] + p[7*8 + col]) + 2048) >> 12;
        v5 = p[3*8 + col];
        v6 = p[5*8 + col];

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

        p[0*8 + col] = v0 + v7;
        p[7*8 + col] = v0 - v7;
        p[1*8 + col] = v1 + v6;
        p[6*8 + col] = v1 - v6;
        p[2*8 + col] = v2 + v5;
        p[5*8 + col] = v2 - v5;
        p[3*8 + col] = v3 + v4;
        p[4*8 + col] = v3 - v4;
      }

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
      if (fileMarker != 0xFFD8) {
        throw new Error("SOI not found");
      }

      fileMarker = readUint16();
      while (fileMarker != 0xFFD9) {
        var i, j, l;
        switch(fileMarker) {
          case 0xFF00: break;
          case 0xFFE0:
          case 0xFFE1:
          case 0xFFE2:
          case 0xFFE3:
          case 0xFFE4:
          case 0xFFE5:
          case 0xFFE6:
          case 0xFFE7:
          case 0xFFE8:
          case 0xFFE9:
          case 0xFFEA:
          case 0xFFEB:
          case 0xFFEC:
          case 0xFFED:
          case 0xFFEE:
          case 0xFFEF:
          case 0xFFFE:
            var appData = readDataBlock();

            if (fileMarker === 0xFFFE) {
              var comment = String.fromCharCode.apply(null, appData);
              this.comments.push(comment);
            }

            if (fileMarker === 0xFFE0) {
              if (appData[0] === 0x4A && appData[1] === 0x46 && appData[2] === 0x49 &&
                appData[3] === 0x46 && appData[4] === 0) {
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
            if (fileMarker === 0xFFE1) {
              if (appData[0] === 0x45 &&
                appData[1] === 0x78 &&
                appData[2] === 0x69 &&
                appData[3] === 0x66 &&
                appData[4] === 0) {
                this.exifBuffer = appData.subarray(5, appData.length);
              }
            }

            if (fileMarker === 0xFFEE) {
              if (appData[0] === 0x41 && appData[1] === 0x64 && appData[2] === 0x6F &&
                appData[3] === 0x62 && appData[4] === 0x65 && appData[5] === 0) {
                adobe = {
                  version: appData[6],
                  flags0: (appData[7] << 8) | appData[8],
                  flags1: (appData[9] << 8) | appData[10],
                  transformCode: appData[11]
                };
              }
            }
            break;

          case 0xFFDB:
            var quantizationTablesLength = readUint16();
            var quantizationTablesEnd = quantizationTablesLength + offset - 2;
            while (offset < quantizationTablesEnd) {
              var quantizationTableSpec = data[offset++];
              requestMemoryAllocation(64 * 4);
              var tableData = new Int32Array(64);
              if ((quantizationTableSpec >> 4) === 0) {
                for (j = 0; j < 64; j++) {
                  var z = dctZigZag[j];
                  tableData[z] = data[offset++];
                }
              } else if ((quantizationTableSpec >> 4) === 1) {
                for (j = 0; j < 64; j++) {
                  var z = dctZigZag[j];
                  tableData[z] = readUint16();
                }
              } else
                throw new Error("DQT: invalid table spec");
              quantizationTables[quantizationTableSpec & 15] = tableData;
            }
            break;

          case 0xFFC0:
          case 0xFFC1:
          case 0xFFC2:
            readUint16();
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

          case 0xFFC4:
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

          case 0xFFDD:
            readUint16();
            resetInterval = readUint16();
            break;

          case 0xFFDC:
            readUint16()
            readUint16()
            break;

          case 0xFFDA:
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

          case 0xFFFF:
            if (data[offset] !== 0xFF) {
              offset--;
            }
            break;
          default:
            if (data[offset - 3] == 0xFF &&
                data[offset - 2] >= 0xC0 && data[offset - 2] <= 0xFE) {
              offset -= 3;
              break;
            }
            else if (fileMarker === 0xE0 || fileMarker == 0xE1) {
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
          colorTransform = true;
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
          colorTransform = false;
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
    colorTransform: undefined,
    useTArray: false,
    formatAsRGBA: true,
    tolerantDecoding: true,
    maxResolutionInMP: 100,
    maxMemoryUsageInMB: 512,
  };

  var opts = {...defaultOpts, ...userOpts};
  var arr = new Uint8Array(jpegData);
  var decoder = new JpegImage();
  decoder.opts = opts;
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
})();
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
    if (b === 0x21) {
      const label = buf[pos++]
      if (label === 0xf9) {
        const packed = buf[pos + 1]
        if (packed & 1) transparentIdx = buf[pos + 4]
      }
      while (buf[pos] !== 0) pos += buf[pos] + 1
      pos++
    } else if (b === 0x2c) {
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

const clamp255 = v => (v < 0 ? 0 : v > 255 ? 255 : v)

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

function resizeBitmap(src, dw, dh, kernel = 'lanczos3') {
  const sw = src.width, sh = src.height
  if (sw === dw && sh === dh) return { data: Buffer.from(src.data), width: dw, height: dh }

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

  const weightsFor = (srcLen, dstLen) => {
    const scale = dstLen / srcLen
    const fscale = Math.max(1, 1 / scale)
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

function parseColorInt(c) {
  if (typeof c === 'number') return c >>> 0
  if (c && typeof c === 'object') return (((c.r & 255) << 24) | ((c.g & 255) << 16) | ((c.b & 255) << 8) | Math.round((c.a ?? c.alpha ?? 1) <= 1 && c.alpha !== undefined ? c.alpha * 255 : (c.a ?? 255))) >>> 0
  const { r, g, b, a } = parseColor(c)
  return (((r & 255) << 24) | ((g & 255) << 16) | ((b & 255) << 8) | Math.round(a * 255)) >>> 0
}

const SRGB_TO_LIN = (() => {
  const t = new Float64Array(256)
  for (let i = 0; i < 256; i++) { const c = i / 255; t[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4) }
  return t
})()
function linToSrgb8(l) {
  const v = l <= 0.0031308 ? l * 12.92 : 1.055 * Math.pow(l, 1 / 2.4) - 0.055
  return clamp255(Math.round(v * 255))
}

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

  static async fromBuffer(buf) {
    const fmt = detectFormat(buf)
    if (!fmt) throw new Error('Jimp: format gambar tidak dikenali')
    if (fmt === 'webp') throw new Error('Jimp: WebP diproses lewat ffmpeg (gunakan Jimp.read yang otomatis mengonversi)')
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
    if (htmlEngine.isHtmlInput(src)) return htmlEngine.htmlToJimp(src)
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

  getPixelColor(x, y) { return this.bitmap.data.readUInt32BE((Math.round(y) * this.width + Math.round(x)) * 4) }
  setPixelColor(color, x, y) { this.bitmap.data.writeUInt32BE(parseColorInt(color) >>> 0, (Math.round(y) * this.width + Math.round(x)) * 4); return this }
  scan(x, y, w, h, fn) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) fn.call(this, xx, yy, (this.width * yy + xx) << 2)
    return this
  }

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
      this.crop(Math.ceil((rw - w) * fx), Math.ceil((rh - h) * fy), w, h)
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

  blur(sigma) { this.bitmap = gaussianBlurBitmap(this.bitmap, sigma); return this }
  gaussian(sigma) { return this.blur(sigma) }

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

  greyscaleRaw() {
    const d = this.bitmap.data, n = this.width * this.height, out = Buffer.alloc(n)
    for (let i = 0; i < n; i++) {
      out[i] = linToSrgb8(0.2126 * SRGB_TO_LIN[d[i * 4]] + 0.7152 * SRGB_TO_LIN[d[i * 4 + 1]] + 0.0722 * SRGB_TO_LIN[d[i * 4 + 2]])
    }
    return out
  }

  toRaw() { return { data: Buffer.from(this.bitmap.data), width: this.width, height: this.height, channels: 4 } }
}

const SS = 4

function fillPolygons(polys, width, height, rule = 'nonzero') {
  const cov = new Float32Array(width * height)

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
      const quad = [{ x: ax + nx, y: ay + ny }, { x: bx + nx, y: by + ny }, { x: bx - nx, y: by - ny }, { x: ax - nx, y: ay - ny }]
      polys.push(quad)
    }
    const joinAt = (i) => {
      const p = P[i]
      const prev = P[(i - 1 + P.length) % P.length], next = P[(i + 1) % P.length]
      if (join === 'round') { polys.push(circle(p, hw)); return }
      const d1x = p.x - prev.x, d1y = p.y - prev.y, d2x = next.x - p.x, d2y = next.y - p.y
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y)
      const cross = d1x * d2y - d1y * d2x
      if (Math.abs(cross) < 1e-9) return
      const s = cross > 0 ? -1 : 1
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
  for (const poly of polys) {
    let area = 0
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a.x * b.y - b.x * a.y }
    if (area < 0) poly.reverse()
  }
  return polys
}

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
      let p = base + 10, more = true
      while (more) {
        const fl = buf.readUInt16BE(p), gi = buf.readUInt16BE(p + 2); p += 4
        let dx, dy
        if (fl & 1) { dx = buf.readInt16BE(p); dy = buf.readInt16BE(p + 2); p += 4 } else { dx = buf.readInt8(p); dy = buf.readInt8(p + 1); p += 2 }
        if (!(fl & 2)) { dx = 0; dy = 0 }
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

  glyphPolys(g, scale, ox, oy) {
    const polys = []
    for (const c of this.outline(g)) {
      if (c.length < 2) continue
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
/* =====================================================================
 * BUILT-IN FONT (tanpa file TTF)
 * Font vektor bawaan berbasis garis (stroke). Dipakai otomatis saat tidak
 * ada font yang didaftarkan (registerFont) dan tidak ada font sistem.
 * Cakupan: ASCII, spasi, tanda baca dasar, dan huruf Latin berdiakritik
 * (dibentuk dari huruf dasar + tanda lewat normalisasi NFD).
 * Koordinat: em = 1000, baseline = 0, y ke atas.
 * ===================================================================== */
const BF_MARGIN = 90   // margin kiri/kanan titik tengah garis tiap glyph
const BF_SW = 110      // tebal garis regular (per 1000 em)

const bfArc = (cx, cy, rx, ry, a0, a1) => {
  const n = Math.max(3, Math.ceil(Math.abs(a1 - a0) / 9)), out = []
  for (let i = 0; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)])
  }
  return out
}
const bfEll = (cx, cy, rx, ry) => ({ closed: true, pts: bfArc(cx, cy, rx, ry, 0, 360).slice(0, -1) })
const bfMap = (items, f) => items.map(it => (Array.isArray(it) ? it.map(f) : { closed: true, pts: it.pts.map(f) }))

// Sumber glyph: cp -> { adv, f(l, r, c) => items }. Item = array titik (terbuka) atau objek {closed, pts}.
function bfSource() {
  const Z = 55, X = 464, C = 661, A = 695, D = -155, XM = 259.5, CM = 358, M = 340
  const G = new Map(), MK = new Map()
  const d = (ch, adv, f) => G.set(ch.codePointAt(0), { adv, f })

  // ---------- huruf besar ----------
  d('A', 667, (l, r, c) => [[[l, Z], [c, C], [r, Z]], [[l + (r - l) * 0.2, 230], [r - (r - l) * 0.2, 230]]])
  d('B', 667, (l, r) => {
    const cu = l + (r - l) * 0.45, ru = r - cu, rl = ru + 12, cl = r - rl
    return [
      [[l, Z], [l, C], [cu, C], ...bfArc(cu, 500.5, ru, 160.5, 90, -90), [l, M]],
      [[l, M], [cl, M], ...bfArc(cl, 197.5, rl, 142.5, 90, -90), [l, Z]]
    ]
  })
  d('C', 722, (l, r, c) => [bfArc(c, CM, (r - l) / 2, 303, 40, 320)])
  d('D', 722, (l, r) => { const rx = 303, cx = r - rx; return [[[l, Z], [l, C], [cx, C], ...bfArc(cx, CM, rx, 303, 90, -90), [l, Z]]] })
  d('E', 667, (l, r) => [[[r, C], [l, C], [l, Z], [r, Z]], [[l, M], [r - 50, M]]])
  d('F', 611, (l, r) => [[[r, C], [l, C], [l, Z]], [[l, M], [r - 40, M]]])
  d('G', 778, (l, r, c) => [[...bfArc(c, CM, (r - l) / 2, 303, 40, 360), [c + 10, CM]]])
  d('H', 722, (l, r) => [[[l, Z], [l, C]], [[r, Z], [r, C]], [[l, M], [r, M]]])
  d('I', 278, (l, r, c) => [[[c, Z], [c, C]]])
  d('J', 500, (l, r, c) => [[[c + 60, C], [c + 60, 205], ...bfArc(c - 10, 205, 70, 150, 0, -180)]])
  d('K', 667, (l, r) => [[[l, Z], [l, C]], [[r, C], [l, M], [r, Z]]])
  d('L', 556, (l, r) => [[[l, C], [l, Z], [r, Z]]])
  d('M', 833, (l, r, c) => [[[l, Z], [l, C], [c, 250], [r, C], [r, Z]]])
  d('N', 722, (l, r) => [[[l, Z], [l, C], [r, Z], [r, C]]])
  d('O', 778, (l, r, c) => [bfEll(c, CM, (r - l) / 2 - 20, 303)])
  d('P', 667, (l, r) => { const rx = (r - l) / 2 - 10, cx = r - rx; return [[[l, Z], [l, C], [cx, C], ...bfArc(cx, 500.5, rx, 160.5, 90, -90), [l, M]]] })
  d('Q', 778, (l, r, c) => [bfEll(c, CM, (r - l) / 2 - 20, 303), [[c + 60, 170], [r + 20, -70]]])
  d('R', 722, (l, r) => {
    const rx = (r - l) / 2 - 10, cx = r - rx
    return [[[l, Z], [l, C], [cx, C], ...bfArc(cx, 500.5, rx, 160.5, 90, -90), [l, M]], [[cx, M], [r, Z]]]
  })
  d('S', 667, (l, r, c) => { const rx = (r - l) / 2 - 20; return [bfArc(c, 500.5, rx, 160.5, 30, 270), bfArc(c, 197.5, rx, 142.5, 90, -150)] })
  d('T', 611, (l, r, c) => [[[l, C], [r, C]], [[c, C], [c, Z]]])
  d('U', 722, (l, r, c) => [[[l, C], [l, 240], ...bfArc(c, 240, (r - l) / 2, 185, 180, 360), [r, C]]])
  d('V', 667, (l, r, c) => [[[l, C], [c, Z], [r, C]]])
  d('W', 944, (l, r, c) => [[[l, C], [l + (r - l) * 0.22, Z], [c, 430], [r - (r - l) * 0.22, Z], [r, C]]])
  d('X', 667, (l, r) => [[[l, C], [r, Z]], [[r, C], [l, Z]]])
  d('Y', 667, (l, r, c) => [[[l, C], [c, M], [r, C]], [[c, M], [c, Z]]])
  d('Z', 611, (l, r) => [[[l, C], [r, C], [l, Z], [r, Z]]])

  // ---------- huruf kecil ----------
  d('a', 556, (l, r, c) => { const rb = (r - l) / 2 - 15, cb = r - rb; return [bfEll(cb, 170, rb, 115), [...bfArc(c, 380, (r - l) / 2, 84, 160, 0), [r, Z]]] })
  d('b', 556, (l, r, c) => [[[l, A], [l, Z]], bfEll(c, XM, (r - l) / 2, 204.5)])
  d('c', 500, (l, r, c) => [bfArc(c, XM, (r - l) / 2, 204.5, 40, 320)])
  d('d', 556, (l, r, c) => [[[r, A], [r, Z]], bfEll(c, XM, (r - l) / 2, 204.5)])
  d('e', 556, (l, r, c) => [bfArc(c, XM, (r - l) / 2, 204.5, 0, 315), [[l, XM], [r, XM]]])
  d('f', 278, (l, r, c) => [[[c + 15, Z], [c + 15, 600], ...bfArc(c + 60, 600, 45, 95, 180, 80)], [[l, X], [r, X]]])
  d('g', 556, (l, r, c) => [bfEll(c - 10, XM, (r - l) / 2 - 15, 204.5), [[r, X], [r, -40]], bfArc(c, -40, (r - l) / 2, 115, 0, -180)])
  d('h', 556, (l, r, c) => [[[l, A], [l, Z]], [...bfArc(c, 300, (r - l) / 2, 164, 180, 0), [r, Z]]])
  d('i', 222, (l, r, c) => [[[c, Z], [c, X]], [[c, 600], [c + 0.5, 600]]])
  d('j', 222, (l, r, c) => [[[c + 25, X], [c + 25, -40], ...bfArc(c - 25, -40, 50, 115, 0, -180)], [[c + 25, 600], [c + 25.5, 600]]])
  d('k', 500, (l, r) => [[[l, A], [l, Z]], [[r, X], [l, 190]], [[l + (r - l) * 0.42, 305], [r, Z]]])
  d('l', 222, (l, r, c) => [[[c, A], [c, Z]]])
  d('m', 833, (l, r) => {
    const c2 = (l + r) / 2, xa = (l + c2) / 2, xb = (c2 + r) / 2
    return [[[l, X], [l, Z]], [...bfArc(xa, 300, xa - l, 164, 180, 0), [c2, Z]], [...bfArc(xb, 300, r - xb, 164, 180, 0), [r, Z]]]
  })
  d('n', 556, (l, r, c) => [[[l, X], [l, Z]], [...bfArc(c, 300, (r - l) / 2, 164, 180, 0), [r, Z]]])
  d('o', 556, (l, r, c) => [bfEll(c, XM, (r - l) / 2, 204.5)])
  d('p', 556, (l, r, c) => [[[l, X], [l, D]], bfEll(c, XM, (r - l) / 2, 204.5)])
  d('q', 556, (l, r, c) => [[[r, X], [r, D]], bfEll(c, XM, (r - l) / 2, 204.5)])
  d('r', 333, (l, r) => { const rr = (r - l) * 0.62, cr = l + rr; return [[[l, X], [l, Z]], bfArc(cr, 300, rr, 164, 180, 40)] })
  d('s', 500, (l, r, c) => { const rx = (r - l) / 2 - 10; return [bfArc(c, 362, rx, 102, 30, 270), bfArc(c, 157, rx, 102, 90, -150)] })
  d('t', 278, (l, r, c) => [[[c, 640], [c, 110], ...bfArc(c + 60, 110, 60, 55, 180, 270)], [[l, X], [r, X]]])
  d('u', 556, (l, r, c) => [[[l, X], [l, 150], ...bfArc(c, 150, (r - l) / 2, 95, 180, 360), [r, X]]])
  d('v', 500, (l, r, c) => [[[l, X], [c, Z], [r, X]]])
  d('w', 722, (l, r, c) => [[[l, X], [l + (r - l) * 0.25, Z], [c, 380], [r - (r - l) * 0.25, Z], [r, X]]])
  d('x', 500, (l, r) => [[[l, X], [r, Z]], [[r, X], [l, Z]]])
  d('y', 500, (l, r, c) => [[[l, X], [c, Z]], [[r, X], [l + 30, D]]])
  d('z', 500, (l, r) => [[[l, X], [r, X], [l, Z], [r, Z]]])

  // ---------- angka ----------
  d('0', 556, (l, r, c) => [bfEll(c, CM, (r - l) / 2 - 30, 303)])
  d('1', 556, (l, r, c) => [[[c - 110, 500], [c + 5, C], [c + 5, Z]], [[c - 110, Z], [c + 120, Z]]])
  d('2', 556, (l, r, c) => [[...bfArc(c, 500, (r - l) / 2 - 40, 161, 160, -30), [l, Z], [r, Z]]])
  d('3', 556, (l, r, c) => { const rx = (r - l) / 2 - 30; return [bfArc(c, 500.5, rx, 160.5, 150, -90), bfArc(c, 197.5, rx, 142.5, 90, -150)] })
  d('4', 556, (l, r) => [[[r - 110, Z], [r - 110, C], [l, 230], [r, 230]]])
  d('5', 556, (l, r, c) => [[[r, C], [l + 10, C], [l + 10, 335], [c - 10, 340]], bfArc(c + 10, 200, (r - l) / 2 - 20, 145, 97, -145)])
  d('6', 556, (l, r, c) => [bfEll(c, 215, (r - l) / 2, 160), [[l, 215], [l, 520], ...bfArc(c + 15, 520, c + 15 - l, 141, 180, 30)]])
  d('7', 556, (l, r, c) => [[[l, C], [r, C], [c - 60, Z]]])
  d('8', 556, (l, r, c) => [bfEll(c, 500, (r - l) / 2 - 30, 161), bfEll(c, 197, (r - l) / 2 - 20, 142)])
  d('9', 556, (l, r, c) => bfMap(bfItemsOf(G.get(54)), ([x, y]) => [556 - x, 716 - y]))

  // ---------- tanda baca & simbol ----------
  d(' ', 278, () => [])
  d('\u00a0', 278, () => [])
  d('!', 278, (l, r, c) => [[[c, C], [c, 220]], [[c, Z], [c + 0.5, Z]]])
  d('"', 355, (l, r, c) => [[[c - 65, C], [c - 65, 470]], [[c + 65, C], [c + 65, 470]]])
  d('#', 556, (l, r, c) => [[[c - 80, Z], [c - 100, C]], [[c + 80, Z], [c + 60, C]], [[l, 230], [r, 230]], [[l, 420], [r, 420]]])
  d('$', 556, (l, r, c) => { const rx = (r - l) / 2 - 30; return [bfArc(c, 500.5, rx, 160.5, 30, 270), bfArc(c, 197.5, rx, 142.5, 90, -150), [[c, 640], [c, -20]]] })
  d('%', 889, (l, r) => [bfEll(l + 100, 540, 90, 95), bfEll(r - 100, 170, 90, 95), [[r - 20, C], [l + 20, Z]]])
  d('&', 667, (l, r, c) => [bfEll(c - 10, 485, 92, 100), [[c - 5, 385], [c - 60, 300]], bfArc(c - 5, 205, 150, 150, 60, 330), [[c + 130, 300], [r - 10, Z + 10]]])
  d("'", 191, (l, r, c) => [[[c, C], [c, 470]]])
  d('(', 333, (l, r, c) => [bfArc(c + 120, 270, 170, 425, 120, 240)])
  d(')', 333, (l, r, c) => [bfArc(c - 120, 270, 170, 425, -60, 60)])
  d('*', 389, (l, r, c) => [[[c - 95, 540], [c + 95, 380]], [[c + 95, 540], [c - 95, 380]], [[c, 600], [c, 320]]])
  d('+', 584, (l, r, c) => [[[c, 110], [c, 490]], [[l + 20, 300], [r - 20, 300]]])
  d(',', 278, (l, r, c) => [[[c + 15, 110], [c - 30, -30]]])
  d('-', 333, (l, r) => [[[l + 10, 300], [r - 10, 300]]])
  d('.', 278, (l, r, c) => [[[c, Z], [c + 0.5, Z]]])
  d('/', 278, (l, r) => [[[l - 30, -110], [r + 30, A]]])
  d(':', 278, (l, r, c) => [[[c, Z], [c + 0.5, Z]], [[c, XM], [c + 0.5, XM]]])
  d(';', 278, (l, r, c) => [[[c, XM], [c + 0.5, XM]], [[c + 15, 110], [c - 30, -30]]])
  d('<', 584, (l, r) => [[[r, 400], [l, 265], [r, 130]]])
  d('>', 584, (l, r) => [[[l, 400], [r, 265], [l, 130]]])
  d('=', 584, (l, r) => [[[l + 10, 220], [r - 10, 220]], [[l + 10, 380], [r - 10, 380]]])
  d('?', 556, (l, r, c) => [[...bfArc(c, 510, 130, 151, 160, -90), [c, 260]], [[c, Z], [c + 0.5, Z]]])
  d('@', 1015, (l, r, c) => [bfEll(c, 355, (r - l) / 2 - 30, 300), bfEll(c + 20, 300, 170, 125), [[c + 190, 300], [c + 190, 430]]])
  d('[', 278, (l, r) => [[[r, A], [l, A], [l, D], [r, D]]])
  d(']', 278, (l, r) => [[[l, A], [r, A], [r, D], [l, D]]])
  d('\\', 278, (l, r) => [[[l - 30, A], [r + 30, -110]]])
  d('^', 469, (l, r, c) => [[[l, 440], [c, C], [r, 440]]])
  d('_', 556, (l, r) => [[[l, -30], [r, -30]]])
  d('`', 333, (l, r, c) => [[[c - 50, 690], [c + 20, 640]]])
  d('{', 334, (l, r, c) => [[[c + 50, A], [c + 10, A - 30], [c + 10, 330], [c - 50, 270], [c + 10, 210], [c + 10, 20], [c - 20, -40], [c + 50, D]]])
  d('}', 334, (l, r, c) => [[[c - 50, A], [c - 10, A - 30], [c - 10, 330], [c + 50, 270], [c - 10, 210], [c - 10, 20], [c + 20, -40], [c - 50, D]]])
  d('|', 260, (l, r, c) => [[[c, A], [c, D]]])
  d('~', 584, (l, r, c) => [[[l, 250], [(l + c) / 2, 330], [c, 250], [(c + r) / 2, 170], [r, 250]]])
  d('¡', 278, () => bfMap(bfItemsOf(G.get(33)), ([x, y]) => [278 - x, 716 - y]))
  d('¿', 556, () => bfMap(bfItemsOf(G.get(63)), ([x, y]) => [556 - x, 716 - y]))
  d('°', 400, (l, r, c) => [[[c, 580], [c + 0.5, 580]]])
  d('•', 350, (l, r, c) => [[[c, 330], [c + 0.5, 330]]])
  d('\u2018', 191, (l, r, c) => [[[c + 30, C], [c - 20, 500]]])
  d('\u2019', 191, (l, r, c) => [[[c - 30, C], [c + 20, 500]]])
  d('\u201c', 355, (l, r, c) => [[[c - 35, C], [c - 85, 500]], [[c + 85, C], [c + 35, 500]]])
  d('\u201d', 355, (l, r, c) => [[[c - 35, C], [c - 85, 500]], [[c + 85, C], [c + 35, 500]]])
  d('\u2013', 556, (l, r) => [[[l, 300], [r, 300]]])
  d('\u2014', 1000, (l, r) => [[[l, 300], [r, 300]]])
  d('\u2026', 1000, () => [[[200, Z], [200.5, Z]], [[500, Z], [500.5, Z]], [[800, Z], [800.5, Z]]])
  d('€', 556, (l, r, c) => [bfArc(c + 40, CM, (r - l) / 2 - 40, 303, 40, 320), [[l + 10, 300], [r - 40, 300]], [[l + 10, 220], [r - 40, 220]]])

  // ---------- tanda diakritik (dipakai lewat NFD) ----------
  MK.set(0x300, [[[-45, 700], [15, 650]]])
  MK.set(0x301, [[[-15, 650], [45, 700]]])
  MK.set(0x302, [[[-60, 620], [0, 700], [60, 620]]])
  MK.set(0x303, [[[-65, 650], [-35, 690], [0, 650], [35, 610], [65, 650]]])
  MK.set(0x304, [[[-55, 680], [55, 680]]])
  MK.set(0x306, [[[-55, 650], [0, 600], [55, 650]]])
  MK.set(0x307, [[[0, 680], [0.5, 680]]])
  MK.set(0x308, [[[-55, 660], [-54.5, 660]], [[55, 660], [55.5, 660]]])
  MK.set(0x30a, [[[0, 690], [0.5, 690]]])
  MK.set(0x30b, [[[-75, 650], [-20, 700]], [[15, 650], [70, 700]]])
  MK.set(0x30c, [[[-60, 700], [0, 620], [60, 700]]])
  MK.set(0x327, [[[25, 20], [0, -45], [-40, -40]]])
  return { G, MK }
}

let BF_SRC = null
const BF_COMPOSED = new Map()
const bfItemsOf = e => e.items || (e.items = e.f(BF_MARGIN, e.adv - BF_MARGIN, e.adv / 2))

function bfResolve(cp) {
  if (!BF_SRC) BF_SRC = bfSource()
  const e = BF_SRC.G.get(cp)
  if (e) return { adv: e.adv, items: bfItemsOf(e) }
  if (BF_COMPOSED.has(cp)) return BF_COMPOSED.get(cp)
  let res = null
  const parts = [...String.fromCodePoint(cp).normalize('NFD')]
  if (parts.length > 1) {
    const base = BF_SRC.G.get(parts[0].codePointAt(0))
    if (base) {
      const dy = /[A-Z]/.test(parts[0]) ? 80 : 0
      let items = bfItemsOf(base)
      for (const mch of parts.slice(1)) {
        const mcp = mch.codePointAt(0), marks = BF_SRC.MK.get(mcp)
        if (!marks) continue
        const sy = mcp === 0x327 ? 0 : dy
        items = items.concat(bfMap(marks, ([x, y]) => [x + base.adv / 2, y + sy]))
      }
      res = { adv: base.adv, items }
    }
  }
  BF_COMPOSED.set(cp, res)
  return res
}

function bfStroke(items, hw) {
  // Stroker khusus font bawaan: sambungan halus (lengkung) pakai bevel murah,
  // sudut tajam & ujung garis pakai lingkaran agar tetap bulat.
  const polys = [], n24 = 24
  const circ = (c, r) => {
    const p = []
    for (let i = 0; i < n24; i++) { const a = (i / n24) * Math.PI * 2; p.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) }) }
    return p
  }
  for (const it of items) {
    const closed = !Array.isArray(it)
    const raw = (closed ? it.pts : it).map(([x, y]) => ({ x, y }))
    const P = raw.filter((p, i) => i === 0 || Math.hypot(p.x - raw[i - 1].x, p.y - raw[i - 1].y) > 1e-6)
    if (closed && P.length > 2 && Math.hypot(P[0].x - P[P.length - 1].x, P[0].y - P[P.length - 1].y) < 1e-6) P.pop()
    const n = P.length
    if (n === 0) continue
    if (n === 1) { polys.push(circ(P[0], hw)); continue }
    const segs = closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = P[i], b = P[(i + 1) % n]
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy)
      const nx = (-dy / len) * hw, ny = (dx / len) * hw
      polys.push([{ x: a.x + nx, y: a.y + ny }, { x: b.x + nx, y: b.y + ny }, { x: b.x - nx, y: b.y - ny }, { x: a.x - nx, y: a.y - ny }])
    }
    const joinAt = i => {
      const p = P[i], prev = P[(i - 1 + n) % n], next = P[(i + 1) % n]
      const d1x = p.x - prev.x, d1y = p.y - prev.y, d2x = next.x - p.x, d2y = next.y - p.y
      const l1 = Math.hypot(d1x, d1y), l2 = Math.hypot(d2x, d2y)
      if (!l1 || !l2) return
      const cross = (d1x / l1) * (d2y / l2) - (d1y / l1) * (d2x / l2)
      const dot = (d1x / l1) * (d2x / l2) + (d1y / l1) * (d2y / l2)
      if (dot > 0.94) {                  // lengkung halus (≈ < 20°): bevel saja
        if (Math.abs(cross) < 1e-9) return
        const s = cross > 0 ? -1 : 1
        const n1 = { x: (-d1y / l1) * hw * s, y: (d1x / l1) * hw * s }
        const n2 = { x: (-d2y / l2) * hw * s, y: (d2x / l2) * hw * s }
        polys.push([p, { x: p.x + n1.x, y: p.y + n1.y }, { x: p.x + n2.x, y: p.y + n2.y }])
      } else polys.push(circ(p, hw))   // sudut tajam: lingkaran
    }
    if (closed) for (let i = 0; i < n; i++) joinAt(i)
    else {
      for (let i = 1; i < n - 1; i++) joinAt(i)
      polys.push(circ(P[0], hw)); polys.push(circ(P[n - 1], hw))
    }
  }
  // samakan orientasi agar fill nonzero menggabungkan (bukan saling meniadakan)
  for (const poly of polys) {
    let area = 0
    for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; area += a.x * b.y - b.x * a.y }
    if (area < 0) poly.reverse()
  }
  return polys
}

class BuiltinFont {
  constructor({ stroke = 0.11 } = {}) {
    this.unitsPerEm = 1000
    this.ascent = 905
    this.descent = -212
    this.lineGap = 0
    this.kernMap = null
    this.variable = false
    this.builtin = true
    this.stroke = stroke
    this._hw = (stroke * 1000) / 2
    this._dy = this._hw - BF_SW / 2   // tebal bertambah → geser agar garis dasar tetap
    this._id = ++BF_SEQ
    this._cmap = new Map()
    this._items = [null]
    this._polys = [null]
    this.advance = [0]                // glyph 0 = .notdef (kosong)
  }
  _addGlyph(cp, adv, items) {
    const g = this.advance.length
    this.advance.push(adv); this._items.push(items); this._polys.push(null); this._cmap.set(cp, g)
    return g
  }
  glyphIndex(cp) {
    let g = this._cmap.get(cp)
    if (g !== undefined) return g
    const e = bfResolve(cp)
    g = e ? this._addGlyph(cp, e.adv, e.items) : 0
    this._cmap.set(cp, g)
    return g
  }
  kerning() { return 0 }
  _polyFor(g) {
    let p = this._polys[g]
    if (p) return p
    const dy = this._dy
    p = bfStroke(bfMap(this._items[g] || [], ([x, y]) => [x, y + dy]), this._hw)
    this._polys[g] = p
    return p
  }
  glyphPolys(g, scale, ox, oy) {
    return this._polyFor(g).map(poly => poly.map(p => ({ x: ox + p.x * scale, y: oy - p.y * scale })))
  }
  outline(g) {
    return this._polyFor(g).map(poly => poly.map(p => ({ x: p.x, y: p.y, on: true })))
  }
  // Glyph yang diperlebar sebesar `grow` (satuan em-px) — dipakai untuk outline teks
  dilatedPolys(g, scale, ox, oy, grow) {
    const dy = this._dy, hw = this._hw + grow / scale
    const polys = bfStroke(bfMap(this._items[g] || [], ([x, y]) => [x, y + dy]), hw)
    return polys.map(poly => poly.map(p => ({ x: ox + p.x * scale, y: oy - p.y * scale })))
  }
}
BuiltinFont.prototype.measure = TTFont.prototype.measure
BuiltinFont.prototype.renderInk = TTFont.prototype.renderInk
BuiltinFont.prototype.renderText = TTFont.prototype.renderText

let BF_SEQ = 1e9   // id unik terpisah dari id font TTF (cache glyph)
const BF_INSTANCES = new Map()
// Font bawaan (tanpa file). bold: garis lebih tebal (mirip Arial Bold untuk brat).
function getBuiltinFont({ bold = false } = {}) {
  const k = bold ? 'bold' : 'regular'
  let f = BF_INSTANCES.get(k)
  if (!f) { f = new BuiltinFont({ stroke: bold ? 0.165 : 0.11 }); BF_INSTANCES.set(k, f) }
  return f
}

const BF_METAS = new Map()
// Meta untuk rantai font HTML (bentuk sama dengan face dari file sistem).
function builtinMeta(bold) {
  const k = bold ? 'bold' : 'regular'
  let m = BF_METAS.get(k)
  if (!m) {
    m = { family: 'builtin', weight: bold ? 700 : 400, italic: false, path: null, variable: false, builtin: true, ttf: getBuiltinFont({ bold }) }
    BF_METAS.set(k, m)
  }
  return m
}

const IDENTITY = [1, 0, 0, 1, 0, 0]
const mulM = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
]
const applyM = (m, x, y) => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] })

const registeredFonts = new Map()
function registerFont(path, { family } = {}) {
  if (!family) throw new Error('registerFont: opsi "family" wajib diisi')
  const buf = readFileSync(path)
  registeredFonts.set(family.toLowerCase(), { path, family, font: new TTFont(buf) })
}
function loadFontBuffer(buf) { return new TTFont(buf) }

// ---- Font kustom: path lokal atau URL (TTF / WOFF) ----
const FONT_MAX_BYTES = 20 * 1024 * 1024
let USER_FONT_SEQ = 5e8   // id unik untuk cache glyph, terpisah dari font lain

async function readFontSource(source, { timeout = 15000 } = {}) {
  if (Buffer.isBuffer(source)) return source
  const s = String(source || '').trim()
  if (!s) throw new Error('font: sumber font kosong')
  if (/^https?:\/\//i.test(s)) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(s, { signal: ac.signal, redirect: 'follow' })
      if (!res.ok) throw new Error(`font: unduh gagal (HTTP ${res.status})`)
      if (Number(res.headers.get('content-length') || 0) > FONT_MAX_BYTES) throw new Error('font: file terlalu besar')
      const buf = Buffer.from(await res.arrayBuffer())
      if (buf.length > FONT_MAX_BYTES) throw new Error('font: file terlalu besar')
      return buf
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`font: unduh timeout (${timeout}ms)`)
      if (e.message === 'fetch failed') throw new Error(`font: unduh gagal (${e.cause?.code || 'jaringan'})`)
      throw e
    } finally { clearTimeout(timer) }
  }
  const fp = nodePath.resolve(s)
  if (statSync(fp).size > FONT_MAX_BYTES) throw new Error('font: file terlalu besar')
  return readFileSync(fp)
}

function parseFontBuffer(buf) {
  const tag = buf.toString('latin1', 0, 4)
  let data = buf
  if (tag === 'wOFF') {
    data = woffToTtf(buf)
    if (!data) throw new Error('font: WOFF rusak')
  } else if (tag === 'wOF2') throw new Error('font: WOFF2 belum didukung (pakai TTF atau WOFF)')
  else if (tag === 'OTTO') throw new Error('font: OTF berbasis CFF belum didukung (pakai TTF)')
  else if (tag === 'ttcf') throw new Error('font: koleksi TTC belum didukung (pakai TTF)')
  else if (!(buf.readUInt32BE(0) === 0x00010000 || tag === 'true')) throw new Error('font: format tidak dikenali (pakai TTF/WOFF)')
  return new TTFont(data)
}

// Muat font dari path / URL / Buffer tanpa mendaftarkannya.
async function loadFontFace(source) {
  return parseFontBuffer(await readFontSource(source))
}

// Muat lalu daftarkan dengan nama family. Setelah itu bisa dipakai di
// ctx.font = '40px NamaFamily' dan di font-family pada canvas.html.
async function loadFont(source, { family } = {}) {
  if (!family) throw new Error('loadFont: opsi "family" wajib diisi')
  const font = await loadFontFace(source)
  font._id = font._id || ++USER_FONT_SEQ
  registeredFonts.set(String(family).toLowerCase(), { path: typeof source === 'string' ? source : null, family: String(family), font })
  return String(family)
}

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
    this._cur = { pts: [{ x: s.x, y: s.y }], closed: false }
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

class Image {
  constructor(jimpImg, src) { this._img = jimpImg; this.width = jimpImg.width; this.height = jimpImg.height; this.src = src || null }
}
async function loadImage(source) {
  if (source instanceof Image) return source
  const img = await Jimp.read(source)
  return new Image(img, typeof source === 'string' && !htmlEngine.isHtmlInput(source) ? source : null)
}

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

  fillRect(x, y, w, h) { const p = new Path2D(); p.rect(x, y, w, h); this._fillPath(p) }
  strokeRect(x, y, w, h) { const p = new Path2D(); p.rect(x, y, w, h); this._strokePath(p) }
  clearRect(x, y, w, h) {
    const p = new Path2D(); p.rect(x, y, w, h)
    const { width: W, height: H, _raw: raw } = this.canvas
    const cov = fillPolygons(this._devicePolys(p), W, H)
    for (let i = 0; i < cov.length; i++) { if (cov[i] <= 0) continue; const di = i * 4; raw[di + 3] = Math.round(raw[di + 3] * (1 - cov[i])); if (raw[di + 3] === 0) raw[di] = raw[di + 1] = raw[di + 2] = 0 }
  }

  createLinearGradient(x0, y0, x1, y1) { return new Gradient('linear', [x0, y0, x1, y1]) }
  createRadialGradient(x0, y0, r0, x1, y1, r1) { return new Gradient('radial', [x0, y0, r0, x1, y1, r1]) }

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

  _resolveFont() {
    const p = parseFontString(this.font), reg = registeredFonts.get(p.family.toLowerCase())
    const bold = p.weight === 'bold' || parseInt(p.weight, 10) >= 600
    return { ...p, ttf: reg?.font || getBuiltinFont({ bold }) }
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

    const sc = size / f.ttf.unitsPerEm, polys = [], grown = []
    const builtin = !!f.ttf.builtin && stroke
    const halo = stroke ? this.lineWidth : 0
    let pen = 0, prev = 0
    for (const ch of text) {
      const g = f.ttf.glyphIndex(ch.codePointAt(0))
      if (prev) pen += f.ttf.kerning(prev, g) * sc
      for (const poly of f.ttf.glyphPolys(g, sc, ox + pen, by)) polys.push(poly.map(p => applyM(this._m, p.x, p.y)))
      if (builtin) for (const poly of f.ttf.dilatedPolys(g, sc, ox + pen, by, halo)) grown.push(poly.map(p => applyM(this._m, p.x, p.y)))
      pen += f.ttf.advance[g] * sc; prev = g
    }
    const { width: W, height: H } = this.canvas
    if (builtin) {
      // outline bersih untuk font bawaan: area diperlebar dikurangi isi glyph
      const cov = fillPolygons(grown, W, H, 'nonzero'), fill = fillPolygons(polys, W, H, 'nonzero')
      for (let i = 0; i < cov.length; i++) cov[i] = Math.max(0, cov[i] - fill[i])
      this._paintCoverage(cov, this._fillStyleColor(style))
    } else if (stroke) {
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

const htmlEngine = (() => {
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const HEAD_TAGS = new Set(['meta', 'title', 'link', 'style', 'script', 'base', 'noscript', 'template'])
const P_CLOSERS = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'])
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', reg: '®', trade: '™', hellip: '…', mdash: '—', ndash: '–',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', sbquo: '‚', bdquo: '„', bull: '•', middot: '·', times: '×', divide: '÷', deg: '°',
  plusmn: '±', laquo: '«', raquo: '»', euro: '€', pound: '£', yen: '¥', cent: '¢', sect: '§', para: '¶', larr: '←', rarr: '→', uarr: '↑',
  darr: '↓', harr: '↔', hearts: '♥', spades: '♠', clubs: '♣', diams: '♦', check: '✓', star: '☆', starf: '★', infin: '∞', ne: '≠', le: '≤',
  ge: '≥', asymp: '≈', micro: 'µ', frac12: '½', frac14: '¼', frac34: '¾', sup1: '¹', sup2: '²', sup3: '³', iexcl: '¡', iquest: '¿',
  agrave: 'à', aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì',
  iacute: 'í', icirc: 'î', iuml: 'ï', ograve: 'ò', oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', ugrave: 'ù', uacute: 'ú', ucirc: 'û',
  uuml: 'ü', ntilde: 'ñ', ccedil: 'ç', szlig: 'ß', ensp: ' ', emsp: ' ', thinsp: ' ', zwj: '‍', zwnj: '‌',
  shy: '­', dagger: '†', Dagger: '‡', permil: '‰', prime: '′', Prime: '″', lt_: '<', minus: '−', sum: '∑', radic: '√', hellip_: '…',
  rArr: '⇒', lArr: '⇐', crarr: '↵', oline: '‾', loz: '◊', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', pi: 'π', sigma: 'σ', omega: 'ω',
  lambda: 'λ', mu: 'μ', theta: 'θ', Omega: 'Ω', Delta: 'Δ', Sigma: 'Σ'
}
const ENT_LEGACY = new Set(['amp', 'lt', 'gt', 'quot', 'nbsp', 'copy', 'reg'])

function decodeEntities(s) {
  if (s.indexOf('&') < 0) return s
  return s.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[a-zA-Z][a-zA-Z0-9]*)(;?)/g, (m, e, semi) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
      if (!(cp > 0) || cp > 0x10ffff) return '�'
      try { return String.fromCodePoint(cp) } catch { return '�' }
    }
    if (Object.prototype.hasOwnProperty.call(ENT, e) && (semi || ENT_LEGACY.has(e))) return ENT[e]
    return m
  })
}

function parseHTML(src) {
  const root = { type: 1, tag: '#root', attrs: {}, children: [], parent: null }
  const stack = [root]
  const n = src.length
  let i = 0
  const top = () => stack[stack.length - 1]
  const addText = s => {
    if (!s) return
    const p = top(), last = p.children[p.children.length - 1]
    if (last && last.type === 3) last.text += s
    else p.children.push({ type: 3, text: s, parent: p })
  }
  const popTo = idx => { stack.length = idx }
  const findOpen = (tags, stops) => {
    for (let k = stack.length - 1; k > 0; k--) {
      const t = stack[k].tag
      if (tags.has(t)) return k
      if (stops.has(t)) return -1
    }
    return -1
  }
  const SCOPE_P = new Set(['button', 'table', 'td', 'th', 'caption', 'html', 'body', 'template', 'object', 'svg'])
  const closeFor = tag => {
    let k
    if (P_CLOSERS.has(tag) && (k = findOpen(new Set(['p']), SCOPE_P)) > 0) popTo(k)
    if (tag === 'li' && (k = findOpen(new Set(['li']), new Set(['ul', 'ol', 'menu', 'table']))) > 0) popTo(k)
    else if ((tag === 'dt' || tag === 'dd') && (k = findOpen(new Set(['dt', 'dd']), new Set(['dl']))) > 0) popTo(k)
    else if (tag === 'tr' && (k = findOpen(new Set(['tr']), new Set(['table', 'thead', 'tbody', 'tfoot']))) > 0) popTo(k)
    else if ((tag === 'td' || tag === 'th') && (k = findOpen(new Set(['td', 'th']), new Set(['tr', 'table']))) > 0) popTo(k)
    else if ((tag === 'tbody' || tag === 'thead' || tag === 'tfoot') && (k = findOpen(new Set(['tbody', 'thead', 'tfoot']), new Set(['table']))) > 0) popTo(k)
    else if ((tag === 'option' || tag === 'optgroup') && (k = findOpen(new Set(['option']), new Set(['select', 'datalist']))) > 0) popTo(k)
    else if (/^h[1-6]$/.test(tag) && /^h[1-6]$/.test(top().tag)) popTo(stack.length - 1)
  }
  const attrRe = /\s*([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/y
  const nameRe = /<([a-zA-Z][^\s\/>]*)/y
  const endRe = /<\/([a-zA-Z][^\s>\/]*)[^>]*>?/y
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) { addText(decodeEntities(src.slice(i))); break }
    if (lt > i) addText(decodeEntities(src.slice(i, lt)))
    i = lt
    if (src.startsWith('<!--', i)) { const e = src.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue }
    if (src.startsWith('<![CDATA[', i)) { const e = src.indexOf(']]>', i + 9); addText(src.slice(i + 9, e < 0 ? n : e)); i = e < 0 ? n : e + 3; continue }
    const c1 = src[i + 1]
    if (c1 === '!' || c1 === '?') { const e = src.indexOf('>', i); i = e < 0 ? n : e + 1; continue }
    if (c1 === '/') {
      endRe.lastIndex = i
      const m = endRe.exec(src)
      if (!m) { addText('<'); i++; continue }
      i = endRe.lastIndex
      const tag = m[1].toLowerCase()
      if (tag === 'body' || tag === 'html') continue
      const tableTag = /^(table|tr|td|th|tbody|thead|tfoot|caption|colgroup|col)$/.test(tag)
      for (let k = stack.length - 1; k > 0; k--) {
        if (stack[k].tag === tag) { popTo(k); break }
        if (!tableTag && /^(td|th|caption|table)$/.test(stack[k].tag)) break
      }
      continue
    }
    nameRe.lastIndex = i
    const m = nameRe.exec(src)
    if (!m) { addText('<'); i++; continue }
    const tag = m[1].toLowerCase()
    i = nameRe.lastIndex
    const attrs = {}
    let selfClose = false
    for (;;) {
      while (i < n && /\s/.test(src[i])) i++
      if (i >= n) break
      if (src[i] === '>') { i++; break }
      if (src[i] === '/') { if (src[i + 1] === '>') { selfClose = true; i += 2; break } i++; continue }
      attrRe.lastIndex = i
      const a = attrRe.exec(src)
      if (!a || attrRe.lastIndex === i) { i++; continue }
      i = attrRe.lastIndex
      const name = a[1].toLowerCase()
      if (!(name in attrs)) attrs[name] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '')
    }
    if (tag === 'html' || tag === 'head' || tag === 'body') {
      const html = root.children.find(e => e.type === 1 && e.tag === 'html')
      const ex = tag === 'html' ? html : html && html.children.find(e => e.type === 1 && e.tag === tag)
      if (ex) {
        Object.assign(ex.attrs, attrs)
        if (tag === 'body') { stack.length = 1; stack.push(html, ex) }
        else if (tag === 'html') { stack.length = 1; stack.push(html) }
        continue
      }
      if (tag === 'body' && html) { const h = stack.indexOf(html); if (h > 0) stack.length = h + 1 }
    }
    closeFor(tag)
    const inSvg = stack.some(e => e.tag === 'svg') || tag === 'svg'
    const el = { type: 1, tag, attrs, children: [], parent: top(), svg: inSvg }
    el.parent.children.push(el)
    if (VOID.has(tag) && !inSvg) continue
    if (selfClose && inSvg) continue
    if (tag === 'script' || tag === 'style' || (!inSvg && (tag === 'textarea' || tag === 'title'))) {
      const re = new RegExp('</' + tag + '\\s*>', 'ig')
      re.lastIndex = i
      const e = re.exec(src)
      const body = src.slice(i, e ? e.index : n)
      if (body) el.children.push({ type: 3, text: tag === 'textarea' || tag === 'title' ? decodeEntities(body) : body, parent: el })
      i = e ? e.index + e[0].length : n
      continue
    }
    stack.push(el)
  }
  return root
}

function normalizeDoc(root) {
  let html = root.children.find(e => e.type === 1 && e.tag === 'html')
  if (!html) {
    html = { type: 1, tag: 'html', attrs: {}, children: root.children, parent: root }
    for (const c of html.children) c.parent = html
    root.children = [html]
  }
  let head = html.children.find(e => e.type === 1 && e.tag === 'head')
  let body = html.children.find(e => e.type === 1 && e.tag === 'body')
  if (!head) { head = { type: 1, tag: 'head', attrs: {}, children: [], parent: html }; html.children.unshift(head) }
  if (!body) { body = { type: 1, tag: 'body', attrs: {}, children: [], parent: html }; html.children.push(body) }
  const rest = html.children.filter(c => c !== head && c !== body)
  if (rest.length) {
    const before = [], after = []
    let seenBody = false
    for (const c of html.children) { if (c === body) seenBody = true; else if (c !== head) (seenBody ? after : before).push(c) }
    const strip = c => c.type === 3 && !c.text.trim()
    body.children = [...before.filter(c => !strip(c)), ...body.children, ...after.filter(c => !strip(c))]
    for (const c of body.children) c.parent = body
    html.children = [head, body]
  }
  return { root, html, head, body }
}

function walk(node, fn) {
  if (fn(node) === false) return
  if (node.children) for (const c of node.children) walk(c, fn)
}

function textOf(node) {
  if (node.type === 3) return node.text
  let s = ''
  for (const c of node.children) s += textOf(c)
  return s
}

function indexTree(node) {
  const kids = []
  for (const c of node.children) if (c.type === 1) kids.push(c)
  node.kids = kids
  const counts = {}
  kids.forEach((k, i) => { k.pos = i; k.tpos = counts[k.tag] = (counts[k.tag] || 0) + 1; k.parent = node })
  kids.forEach(k => { k.tcount = counts[k.tag] })
  for (const k of kids) indexTree(k)
}

const NAMED = {}
'aliceblue:f0f8ff,antiquewhite:faebd7,aqua:00ffff,aquamarine:7fffd4,azure:f0ffff,beige:f5f5dc,bisque:ffe4c4,black:000000,blanchedalmond:ffebcd,blue:0000ff,blueviolet:8a2be2,brown:a52a2a,burlywood:deb887,cadetblue:5f9ea0,chartreuse:7fff00,chocolate:d2691e,coral:ff7f50,cornflowerblue:6495ed,cornsilk:fff8dc,crimson:dc143c,cyan:00ffff,darkblue:00008b,darkcyan:008b8b,darkgoldenrod:b8860b,darkgray:a9a9a9,darkgreen:006400,darkgrey:a9a9a9,darkkhaki:bdb76b,darkmagenta:8b008b,darkolivegreen:556b2f,darkorange:ff8c00,darkorchid:9932cc,darkred:8b0000,darksalmon:e9967a,darkseagreen:8fbc8f,darkslateblue:483d8b,darkslategray:2f4f4f,darkslategrey:2f4f4f,darkturquoise:00ced1,darkviolet:9400d3,deeppink:ff1493,deepskyblue:00bfff,dimgray:696969,dimgrey:696969,dodgerblue:1e90ff,firebrick:b22222,floralwhite:fffaf0,forestgreen:228b22,fuchsia:ff00ff,gainsboro:dcdcdc,ghostwhite:f8f8ff,gold:ffd700,goldenrod:daa520,gray:808080,green:008000,greenyellow:adff2f,grey:808080,honeydew:f0fff0,hotpink:ff69b4,indianred:cd5c5c,indigo:4b0082,ivory:fffff0,khaki:f0e68c,lavender:e6e6fa,lavenderblush:fff0f5,lawngreen:7cfc00,lemonchiffon:fffacd,lightblue:add8e6,lightcoral:f08080,lightcyan:e0ffff,lightgoldenrodyellow:fafad2,lightgray:d3d3d3,lightgreen:90ee90,lightgrey:d3d3d3,lightpink:ffb6c1,lightsalmon:ffa07a,lightseagreen:20b2aa,lightskyblue:87cefa,lightslategray:778899,lightslategrey:778899,lightsteelblue:b0c4de,lightyellow:ffffe0,lime:00ff00,limegreen:32cd32,linen:faf0e6,magenta:ff00ff,maroon:800000,mediumaquamarine:66cdaa,mediumblue:0000cd,mediumorchid:ba55d3,mediumpurple:9370db,mediumseagreen:3cb371,mediumslateblue:7b68ee,mediumspringgreen:00fa9a,mediumturquoise:48d1cc,mediumvioletred:c71585,midnightblue:191970,mintcream:f5fffa,mistyrose:ffe4e1,moccasin:ffe4b5,navajowhite:ffdead,navy:000080,oldlace:fdf5e6,olive:808000,olivedrab:6b8e23,orange:ffa500,orangered:ff4500,orchid:da70d6,palegoldenrod:eee8aa,palegreen:98fb98,paleturquoise:afeeee,palevioletred:db7093,papayawhip:ffefd5,peachpuff:ffdab9,peru:cd853f,pink:ffc0cb,plum:dda0dd,powderblue:b0e0e6,purple:800080,rebeccapurple:663399,red:ff0000,rosybrown:bc8f8f,royalblue:4169e1,saddlebrown:8b4513,salmon:fa8072,sandybrown:f4a460,seagreen:2e8b57,seashell:fff5ee,sienna:a0522d,silver:c0c0c0,skyblue:87ceeb,slateblue:6a5acd,slategray:708090,slategrey:708090,snow:fffafa,springgreen:00ff7f,steelblue:4682b4,tan:d2b48c,teal:008080,thistle:d8bfd8,tomato:ff6347,turquoise:40e0d0,violet:ee82ee,wheat:f5deb3,white:ffffff,whitesmoke:f5f5f5,yellow:ffff00,yellowgreen:9acd32'
  .split(',').forEach(p => { const [k, v] = p.split(':'); const n = parseInt(v, 16); NAMED[k] = { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 } })
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 }

function splitTop(str, sep) {
  const out = []
  let depth = 0, q = null, start = 0
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '(' || c === '[') depth++
    else if (c === ')' || c === ']') depth--
    else if (c === sep && depth <= 0) { out.push(str.slice(start, i)); start = i + 1 }
  }
  out.push(str.slice(start))
  return out
}

function tokens(str) {
  const out = []
  let depth = 0, q = null, start = -1
  for (let i = 0; i < str.length; i++) {
    const c = str[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === '"' || c === "'") { q = c; if (start < 0) start = i; continue }
    if (c === '(') depth++
    else if (c === ')') depth--
    if (/\s/.test(c) && depth <= 0) { if (start >= 0) { out.push(str.slice(start, i)); start = -1 } }
    else if (start < 0) start = i
  }
  if (start >= 0) out.push(str.slice(start))
  return out
}

function clampN(v, a, b) { return v < a ? a : v > b ? b : v }
function srgbEnc(v) { v = clampN(v, 0, 1); return (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255 }

function oklabToRgb(L, a, b, alpha) {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b, m_ = L - 0.1055613458 * a - 0.0638541728 * b, s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3, m = m_ ** 3, s = s_ ** 3
  return {
    r: srgbEnc(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: srgbEnc(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: srgbEnc(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s), a: alpha
  }
}

function hslToRgb(h, s, l, a) {
  h = ((h % 360) + 360) % 360 / 360
  s = clampN(s, 0, 1); l = clampN(l, 0, 1)
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q
  const f = t => { t = (t + 1) % 1; return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p }
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a }
}

function parseAngle(s) {
  const m = /^([+-]?[\d.]+(?:e[+-]?\d+)?)(deg|grad|rad|turn)?$/i.exec(String(s).trim())
  if (!m) return null
  const v = parseFloat(m[1]), u = (m[2] || 'deg').toLowerCase()
  return u === 'deg' ? v : u === 'rad' ? v * 180 / Math.PI : u === 'turn' ? v * 360 : v * 0.9
}

function numOrPct(s, pctBase = 1) {
  s = s.trim()
  if (s === 'none') return 0
  if (s.endsWith('%')) return parseFloat(s) / 100 * pctBase
  return parseFloat(s)
}

function cssColor(input, cur) {
  if (input == null) return null
  let s = String(input).trim().toLowerCase()
  if (!s) return null
  if (s === 'transparent') return TRANSPARENT
  if (s === 'currentcolor') return cur ? { ...cur } : { r: 0, g: 0, b: 0, a: 1 }
  const nm = NAMED[s]
  if (nm) return nm
  let m
  if (s[0] === '#') {
    const h = s.slice(1)
    if (!/^[0-9a-f]+$/.test(h)) return null
    if (h.length === 3 || h.length === 4) { const v = h.split('').map(c => parseInt(c + c, 16)); return { r: v[0], g: v[1], b: v[2], a: v.length === 4 ? v[3] / 255 : 1 } }
    if (h.length === 6 || h.length === 8) { const n = parseInt(h.slice(0, 6), 16); return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 } }
    return null
  }
  if ((m = /^([a-z-]+)\((.*)\)$/s.exec(s))) {
    const fn = m[1], body = m[2].trim()
    if (fn === 'light-dark') { const p = splitTop(body, ','); return cssColor(p[0], cur) }
    if (fn === 'color-mix') {
      const p = splitTop(body, ',').map(x => x.trim())
      if (p.length < 3) return null
      const parse = x => { const t = tokens(x); let pct = null, col = []; for (const k of t) { if (/^[\d.]+%$/.test(k)) pct = parseFloat(k) / 100; else col.push(k) } return { c: cssColor(col.join(' '), cur), pct } }
      const A = parse(p[1]), B = parse(p[2])
      if (!A.c || !B.c) return null
      let pa = A.pct, pb = B.pct
      if (pa == null && pb == null) { pa = 0.5; pb = 0.5 } else if (pa == null) pa = 1 - pb; else if (pb == null) pb = 1 - pa
      const tot = pa + pb || 1
      pa /= tot; pb /= tot
      const al = A.c.a * pa + B.c.a * pb
      if (al <= 0) return TRANSPARENT
      return { r: (A.c.r * A.c.a * pa + B.c.r * B.c.a * pb) / al, g: (A.c.g * A.c.a * pa + B.c.g * B.c.a * pb) / al, b: (A.c.b * A.c.a * pa + B.c.b * B.c.a * pb) / al, a: al }
    }
    const slash = splitTop(body, '/')
    let parts, alpha = 1
    if (body.includes(',')) { parts = splitTop(body, ',').map(x => x.trim()); if (parts.length > 3) alpha = numOrPct(parts[3]) }
    else { parts = tokens(slash[0]); if (slash[1] != null) alpha = numOrPct(slash[1]) }
    if (!(alpha === alpha)) alpha = 1
    alpha = clampN(alpha, 0, 1)
    const P = i => parts[i] == null ? NaN : parts[i]
    if (fn === 'rgb' || fn === 'rgba') {
      const c = i => { const v = P(i); return v === 'none' ? 0 : String(v).endsWith('%') ? parseFloat(v) * 2.55 : parseFloat(v) }
      const r = c(0), g = c(1), b = c(2)
      if (!(r === r && g === g && b === b)) return null
      return { r: clampN(r, 0, 255), g: clampN(g, 0, 255), b: clampN(b, 0, 255), a: alpha }
    }
    if (fn === 'hsl' || fn === 'hsla') {
      const h = parseAngle(P(0)), sv = parseFloat(P(1)) / 100, l = parseFloat(P(2)) / 100
      if (!(h === h && sv === sv && l === l)) return null
      return hslToRgb(h, sv, l, alpha)
    }
    if (fn === 'hwb') {
      const h = parseAngle(P(0)), w = parseFloat(P(1)) / 100, bl = parseFloat(P(2)) / 100
      if (!(h === h)) return null
      const base = hslToRgb(h, 1, 0.5, alpha), k = 1 - w - bl
      return { r: (base.r / 255 * k + w) * 255, g: (base.g / 255 * k + w) * 255, b: (base.b / 255 * k + w) * 255, a: alpha }
    }
    if (fn === 'oklch') {
      const L = numOrPct(P(0)), C = String(P(1)).endsWith('%') ? parseFloat(P(1)) / 100 * 0.4 : parseFloat(P(1)), h = (parseAngle(P(2)) || 0) * Math.PI / 180
      if (!(L === L && C === C)) return null
      return oklabToRgb(L, C * Math.cos(h), C * Math.sin(h), alpha)
    }
    if (fn === 'oklab') {
      const L = numOrPct(P(0)), a = numOrPct(P(1), 0.4), b = numOrPct(P(2), 0.4)
      if (!(L === L)) return null
      return oklabToRgb(L, a, b, alpha)
    }
    if (fn === 'color') {
      const sp = parts[0].split(/\s+/)
      const vals = [sp[1], parts[1], parts[2]].map(x => x == null ? NaN : numOrPct(x))
      if (/^(srgb|display-p3|rec2020|a98-rgb|prophoto-rgb)$/.test(sp[0]) && vals.every(v => v === v)) return { r: clampN(vals[0], 0, 1) * 255, g: clampN(vals[1], 0, 1) * 255, b: clampN(vals[2], 0, 1) * 255, a: alpha }
      return null
    }
  }
  return null
}

function lengthCalc(expr, E) {
  const src = expr.replace(/\s+/g, ' ').trim()
  let i = 0
  const unit = (n, u) => {
    switch (u) {
      case 'px': case '': return n
      case 'em': return n * E.fs
      case 'rem': return n * E.rfs
      case 'ex': case 'ch': return n * E.fs * 0.5
      case 'vw': case 'svw': case 'lvw': case 'dvw': return n * E.vw / 100
      case 'vh': case 'svh': case 'lvh': case 'dvh': return n * E.vh / 100
      case 'vmin': return n * Math.min(E.vw, E.vh) / 100
      case 'vmax': return n * Math.max(E.vw, E.vh) / 100
      case 'pt': return n * 4 / 3
      case 'pc': return n * 16
      case 'in': return n * 96
      case 'cm': return n * 96 / 2.54
      case 'mm': return n * 96 / 25.4
      case 'q': return n * 96 / 101.6
      case 'deg': return n
      default: return NaN
    }
  }
  const ws = () => { while (src[i] === ' ') i++ }
  const num = (f, pct = false, isNum = false) => ({ f, pct, num: isNum })
  const primary = () => {
    ws()
    if (src[i] === '(') { i++; const v = sum(); ws(); if (src[i] === ')') i++; return v }
    const fm = /^(calc|min|max|clamp|abs)\(/.exec(src.slice(i))
    if (fm) {
      i += fm[0].length
      const args = []
      if (fm[1] === 'calc') { const v = sum(); ws(); if (src[i] === ')') i++; return v }
      for (;;) { args.push(sum()); ws(); if (src[i] === ',') { i++; continue } if (src[i] === ')') i++; break }
      const pct = args.some(a => a.pct)
      if (fm[1] === 'min') return num(b => Math.min(...args.map(a => a.f(b))), pct)
      if (fm[1] === 'max') return num(b => Math.max(...args.map(a => a.f(b))), pct)
      if (fm[1] === 'abs') return num(b => Math.abs(args[0].f(b)), pct)
      return num(b => { const lo = args[0].f(b), v = args[1].f(b), hi = args[2].f(b); return Math.max(lo, Math.min(v, hi)) }, pct)
    }
    const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)/i.exec(src.slice(i))
    if (!m) { i = src.length; return num(() => NaN) }
    i += m[0].length
    const n = parseFloat(m[1]), u = m[2].toLowerCase()
    if (u === '%') return num(b => b * n / 100, true)
    if (u === '') return num(() => n, false, true)
    const v = unit(n, u)
    return num(() => v)
  }
  const prod = () => {
    let a = primary()
    for (;;) {
      ws()
      if (src[i] === '*') { i++; const b = primary(); const x = a; a = num(bs => x.f(bs) * b.f(bs), x.pct || b.pct, x.num && b.num) }
      else if (src[i] === '/') { i++; const b = primary(); const x = a; a = num(bs => x.f(bs) / b.f(bs), x.pct || b.pct, x.num && b.num) }
      else return a
    }
  }
  const sum = () => {
    let a = prod()
    for (;;) {
      ws()
      if (src[i] === '+' && src[i + 1] === ' ') { i++; const b = prod(); const x = a; a = num(bs => x.f(bs) + b.f(bs), x.pct || b.pct) }
      else if (src[i] === '-' && src[i + 1] === ' ') { i++; const b = prod(); const x = a; a = num(bs => x.f(bs) - b.f(bs), x.pct || b.pct) }
      else return a
    }
  }
  const r = sum()
  if (!r.pct) { const v = r.f(0); return v === v ? v : null }
  const f = b => r.f(b)
  f.pct = true
  return f
}

function parseLen(str, E) {
  if (str == null) return null
  const s = String(str).trim().toLowerCase()
  if (!s) return null
  if (s === 'auto') return 'auto'
  if (/^(calc|min|max|clamp)\(/.test(s)) return lengthCalc(s, E)
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([a-z%]*)$/.exec(s)
  if (!m) return null
  const n = parseFloat(m[1]), u = m[2]
  if (u === '%') { const f = b => b * n / 100; f.pct = true; return f }
  if (u === '') return n
  const v = lengthCalc(s, E)
  return v
}

function matchMedia(query, env) {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return splitTop(q, ',').some(part => {
    let p = part.trim(), neg = false
    if (p.startsWith('not ')) { neg = true; p = p.slice(4) }
    p = p.replace(/^only\s+/, '')
    const conds = p.split(/\s+and\s+/)
    let ok = true
    for (let c of conds) {
      c = c.trim()
      if (!c) continue
      if (c === 'all' || c === 'screen') continue
      if (c === 'print' || c === 'speech' || c === 'tv') { ok = false; continue }
      const m = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/.exec(c)
      const E = { fs: 16, rfs: 16, vw: env.width, vh: env.height }
      if (!m) {
        const r = /^\(\s*([a-z-]+)\s*(<=|>=|<|>|=)\s*([^)]+)\)$/.exec(c) || null
        if (r) {
          const val = { width: env.width, height: env.height }[r[1]]
          const t = parseLen(r[3], E)
          if (val == null || typeof t !== 'number') { ok = false; continue }
          const res = r[2] === '<=' ? val <= t : r[2] === '>=' ? val >= t : r[2] === '<' ? val < t : r[2] === '>' ? val > t : val === t
          if (!res) ok = false
          continue
        }
        const r2 = /^\(\s*([^<>=]+?)\s*(<=|>=|<|>)\s*(width|height)\s*(<=|>=|<|>)\s*([^)]+)\)$/.exec(c)
        if (r2) {
          const val = r2[3] === 'width' ? env.width : env.height
          const lo = parseLen(r2[1], E), hi = parseLen(r2[5], E)
          const a = r2[2] === '<=' ? lo <= val : lo < val, b = r2[4] === '<=' ? val <= hi : val < hi
          if (!(a && b)) ok = false
          continue
        }
        ok = false
        continue
      }
      const f = m[1], v = (m[2] || '').trim()
      const val = f.replace(/^(min|max)-/, '')
      const kind = f.startsWith('min-') ? 'min' : f.startsWith('max-') ? 'max' : 'eq'
      let res = true
      if (val === 'width' || val === 'height' || val === 'device-width' || val === 'device-height') {
        const cur = val.endsWith('width') ? env.width : env.height, t = parseLen(v, E)
        if (typeof t !== 'number') res = false
        else res = kind === 'min' ? cur >= t : kind === 'max' ? cur <= t : cur === t
      } else if (val === 'prefers-color-scheme') res = v === (env.dark ? 'dark' : 'light')
      else if (val === 'prefers-reduced-motion') res = v === 'no-preference'
      else if (val === 'prefers-contrast') res = v === 'no-preference'
      else if (val === 'orientation') res = v === (env.width >= env.height ? 'landscape' : 'portrait')
      else if (val === 'hover' || val === 'any-hover') res = v === 'hover' || v === ''
      else if (val === 'pointer' || val === 'any-pointer') res = v === 'fine' || v === ''
      else if (val === 'resolution' || val === 'min-resolution') { const d = parseFloat(v); res = kind === 'min' ? (env.dpr || 1) >= d : true }
      else if (val === 'color' || val === 'color-gamut') res = true
      else if (val === 'aspect-ratio') { const [a, b] = v.split('/').map(Number); const r = env.width / env.height, t = a / (b || 1); res = kind === 'min' ? r >= t : kind === 'max' ? r <= t : Math.abs(r - t) < 0.01 }
      else res = false
      if (!res) ok = false
    }
    return neg ? !ok : ok
  })
}

function stripComments(css) {
  let out = '', i = 0
  const n = css.length
  while (i < n) {
    const c = css[i]
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && css[j] !== c) { if (css[j] === '\\') j++; j++ }
      out += css.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue }
    out += c; i++
  }
  return out
}

function matchBrace(s, open) {
  let depth = 0, q = null
  for (let i = open; i < s.length; i++) {
    const c = s[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '{') depth++
    else if (c === '}') { depth--; if (depth === 0) return i }
  }
  return s.length
}

function parseDecls(body) {
  const out = []
  let depth = 0, q = null, start = 0
  const flush = end => {
    const d = body.slice(start, end).trim()
    start = end + 1
    if (!d) return
    const ci = d.indexOf(':')
    if (ci <= 0) return
    const prop = d.slice(0, ci).trim()
    let val = d.slice(ci + 1).trim()
    let imp = false
    const im = /!\s*important\s*$/i.exec(val)
    if (im) { imp = true; val = val.slice(0, im.index).trim() }
    const p = prop.startsWith('--') ? prop : prop.toLowerCase()
    out.push({ p, v: val, imp })
  }
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (q) { if (c === '\\') i++; else if (c === q) q = null; continue }
    if (c === '"' || c === "'") q = c
    else if (c === '(') depth++
    else if (c === ')') depth--
    else if (c === '{') { const e = matchBrace(body, i); i = e; start = e + 1 }
    else if (c === ';' && depth <= 0) flush(i)
  }
  flush(body.length)
  return out
}

const IDENT = /(?:[\w -￿-]|\\[\s\S])+/y
const unesc = s => s.replace(/\\([0-9a-fA-F]{1,6})\s?|\\([\s\S])/g, (m, h, c) => h ? String.fromCodePoint(parseInt(h, 16) || 0xfffd) : c)

function parseNth(a) {
  a = a.trim().toLowerCase().replace(/\s+of\s+.*$/, '')
  if (a === 'odd') return [2, 1]
  if (a === 'even') return [2, 0]
  const m = /^([+-]?\d*)n\s*([+-]\s*\d+)?$/.exec(a)
  if (m) { const A = m[1] === '' || m[1] === '+' ? 1 : m[1] === '-' ? -1 : parseInt(m[1], 10); return [A, m[2] ? parseInt(m[2].replace(/\s+/g, ''), 10) : 0] }
  const n = parseInt(a, 10)
  return Number.isNaN(n) ? null : [0, n]
}
const nthOk = ([A, B], idx) => A === 0 ? idx === B : ((idx - B) / A >= 0 && (idx - B) % A === 0)

function parseSelectorList(str) {
  const out = []
  for (const part of splitTop(str, ',')) {
    const sel = parseComplex(part.trim())
    if (sel) out.push(sel)
  }
  return out
}

function parseComplex(s) {
  if (!s) return null
  const seq = []
  let i = 0, comb = null
  const n = s.length
  while (i < n) {
    let ws = false
    while (i < n && /\s/.test(s[i])) { i++; ws = true }
    if (i >= n) break
    if (s[i] === '>' || s[i] === '+' || s[i] === '~') { comb = s[i]; i++; while (i < n && /\s/.test(s[i])) i++; continue }
    if (ws && seq.length && !comb) comb = ' '
    const r = parseCompound(s, i)
    if (!r) return null
    i = r.i
    seq.push({ comb: seq.length ? (comb || ' ') : null, comp: r.comp })
    comb = null
  }
  if (!seq.length) return null
  const spec = [0, 0, 0]
  let pseudo = null
  seq.forEach((e, k) => {
    const sp = e.comp.spec
    spec[0] += sp[0]; spec[1] += sp[1]; spec[2] += sp[2]
    if (e.comp.pseudoEl) { if (k !== seq.length - 1) pseudo = 'never'; else pseudo = e.comp.pseudoEl }
  })
  return { seq, spec: spec[0] * 1e6 + spec[1] * 1e3 + spec[2], pseudo }
}

function parseCompound(s, i0) {
  let i = i0
  const n = s.length
  const comp = { tag: null, id: null, classes: [], attrs: [], tests: [], spec: [0, 0, 0], pseudoEl: null }
  let any = false
  while (i < n) {
    const c = s[i]
    if (c === '*') { i++; any = true; continue }
    if (c === '#') { IDENT.lastIndex = i + 1; const m = IDENT.exec(s); if (!m) return null; comp.id = unesc(m[0]); comp.spec[0]++; i = IDENT.lastIndex; any = true; continue }
    if (c === '.') { IDENT.lastIndex = i + 1; const m = IDENT.exec(s); if (!m) return null; comp.classes.push(unesc(m[0])); comp.spec[1]++; i = IDENT.lastIndex; any = true; continue }
    if (c === '[') {
      let j = i + 1, q = null
      while (j < n && (q || s[j] !== ']')) { if (q) { if (s[j] === q) q = null } else if (s[j] === '"' || s[j] === "'") q = s[j]; j++ }
      const body = s.slice(i + 1, j)
      const m = /^\s*([^\s~|^$*=\]]+)\s*(?:([~|^$*]?=)\s*("[^"]*"|'[^']*'|[^\s\]]*)\s*([iIsS])?)?\s*$/.exec(body)
      if (!m) return null
      let v = m[3]
      if (v != null && (v[0] === '"' || v[0] === "'")) v = v.slice(1, -1)
      comp.attrs.push({ name: m[1].toLowerCase().replace(/^.*\|/, ''), op: m[2] || null, val: v == null ? null : unesc(v), ci: !!m[4] && m[4].toLowerCase() === 'i' })
      comp.spec[1]++
      i = j + 1; any = true; continue
    }
    if (c === ':') {
      const dbl = s[i + 1] === ':'
      IDENT.lastIndex = i + (dbl ? 2 : 1)
      const m = IDENT.exec(s)
      if (!m) return null
      const name = m[0].toLowerCase()
      i = IDENT.lastIndex
      let arg = null
      if (s[i] === '(') {
        let depth = 0, j = i, q = null
        for (; j < n; j++) {
          const ch = s[j]
          if (q) { if (ch === '\\') j++; else if (ch === q) q = null; continue }
          if (ch === '"' || ch === "'") q = ch
          else if (ch === '(') depth++
          else if (ch === ')') { depth--; if (depth === 0) break }
        }
        arg = s.slice(i + 1, j); i = j + 1
      }
      any = true
      if (dbl || name === 'before' || name === 'after' || name === 'first-line' || name === 'first-letter') {
        comp.pseudoEl = (name === 'before' || name === 'after' || name === 'marker') ? name : 'never'
        comp.spec[2]++
        continue
      }
      const t = pseudoClass(name, arg, comp)
      if (!t) return null
      comp.tests.push(t)
      continue
    }
    if (/[\w -￿\\-]/.test(c)) {
      IDENT.lastIndex = i
      const m = IDENT.exec(s)
      if (!m) return null
      if (m.index !== i) return null
      comp.tag = unesc(m[0]).toLowerCase(); comp.spec[2]++
      i = IDENT.lastIndex; any = true; continue
    }
    break
  }
  if (!any) return null
  return { comp, i }
}

function pseudoClass(name, arg, comp) {
  const never = () => false
  switch (name) {
    case 'root': comp.spec[1]++; return el => el.tag === 'html'
    case 'first-child': comp.spec[1]++; return el => el.pos === 0
    case 'last-child': comp.spec[1]++; return el => el.parent && el.parent.kids && el.pos === el.parent.kids.length - 1
    case 'only-child': comp.spec[1]++; return el => el.parent && el.parent.kids && el.parent.kids.length === 1
    case 'first-of-type': comp.spec[1]++; return el => el.tpos === 1
    case 'last-of-type': comp.spec[1]++; return el => el.tpos === el.tcount
    case 'only-of-type': comp.spec[1]++; return el => el.tcount === 1
    case 'empty': comp.spec[1]++; return el => !el.children.some(c => c.type === 1 || (c.type === 3 && c.text.length))
    case 'nth-child': { comp.spec[1]++; const nth = parseNth(arg || ''); if (!nth) return null; return el => nthOk(nth, el.pos + 1) }
    case 'nth-last-child': { comp.spec[1]++; const nth = parseNth(arg || ''); if (!nth) return null; return el => el.parent && el.parent.kids && nthOk(nth, el.parent.kids.length - el.pos) }
    case 'nth-of-type': { comp.spec[1]++; const nth = parseNth(arg || ''); if (!nth) return null; return el => nthOk(nth, el.tpos) }
    case 'nth-last-of-type': { comp.spec[1]++; const nth = parseNth(arg || ''); if (!nth) return null; return el => nthOk(nth, el.tcount - el.tpos + 1) }
    case 'not': {
      const list = parseSelectorList(arg || '')
      if (!list.length) return null
      comp.spec[1] += Math.max(...list.map(l => l.spec >= 1e6 ? 1 : l.spec >= 1e3 ? 1 : 0))
      return el => !list.some(l => matchComplex(el, l.seq, l.seq.length - 1))
    }
    case 'is': case 'matches': case 'any': case '-webkit-any': case '-moz-any': {
      const list = parseSelectorList(arg || '')
      if (!list.length) return never
      comp.spec[1]++
      return el => list.some(l => matchComplex(el, l.seq, l.seq.length - 1))
    }
    case 'where': {
      const list = parseSelectorList(arg || '')
      if (!list.length) return never
      return el => list.some(l => matchComplex(el, l.seq, l.seq.length - 1))
    }
    case 'has': {
      comp.spec[1]++
      const list = splitTop(arg || '', ',').map(x => {
        x = x.trim()
        const m = /^([>+~])\s*(.*)$/.exec(x)
        const sel = parseComplex(m ? m[2] : x)
        return sel ? { rel: m ? m[1] : ' ', sel } : null
      }).filter(Boolean)
      if (!list.length) return never
      return el => list.some(({ rel, sel }) => {
        const test = d => matchComplex(d, sel.seq, sel.seq.length - 1)
        if (rel === '>') return el.kids.some(test)
        if (rel === '+') return el.parent && el.parent.kids[el.pos + 1] && test(el.parent.kids[el.pos + 1])
        if (rel === '~') return el.parent && el.parent.kids.slice(el.pos + 1).some(test)
        let found = false
        walk(el, d => { if (found) return false; if (d !== el && d.type === 1 && test(d)) { found = true; return false } })
        return found
      })
    }
    case 'checked': comp.spec[1]++; return el => 'checked' in el.attrs || (el.tag === 'option' && 'selected' in el.attrs)
    case 'disabled': comp.spec[1]++; return el => 'disabled' in el.attrs
    case 'enabled': comp.spec[1]++; return el => /^(input|button|select|textarea)$/.test(el.tag) && !('disabled' in el.attrs)
    case 'required': comp.spec[1]++; return el => 'required' in el.attrs
    case 'optional': comp.spec[1]++; return el => /^(input|select|textarea)$/.test(el.tag) && !('required' in el.attrs)
    case 'read-only': comp.spec[1]++; return el => !/^(input|textarea)$/.test(el.tag) || 'readonly' in el.attrs
    case 'read-write': comp.spec[1]++; return el => /^(input|textarea)$/.test(el.tag) && !('readonly' in el.attrs)
    case 'placeholder-shown': comp.spec[1]++; return el => /^(input|textarea)$/.test(el.tag) && 'placeholder' in el.attrs && !el.attrs.value
    case 'link': case 'any-link': comp.spec[1]++; return el => (el.tag === 'a' || el.tag === 'area') && 'href' in el.attrs
    case 'defined': case 'scope': comp.spec[1]++; return el => true
    case 'lang': comp.spec[1]++; return el => { let e = el; while (e && e.type === 1) { if (e.attrs.lang) return e.attrs.lang.toLowerCase().startsWith((arg || '').trim().toLowerCase()); e = e.parent } return false }
    case 'dir': comp.spec[1]++; return el => (arg || '').trim() === 'ltr'
    case 'hover': case 'active': case 'focus': case 'focus-within': case 'focus-visible': case 'visited': case 'target': case 'indeterminate': case 'invalid': case 'valid': case 'out-of-range': case 'in-range': case 'fullscreen': case 'popover-open': case 'open':
      comp.spec[1]++; return never
    default: return null
  }
}

function matchCompound(el, c) {
  if (c.tag && c.tag !== '*' && c.tag !== el.tag) return false
  if (c.id != null && el.attrs.id !== c.id) return false
  if (c.classes.length) {
    const cl = el.cls || (el.cls = new Set((el.attrs.class || '').split(/\s+/).filter(Boolean)))
    for (const k of c.classes) if (!cl.has(k)) return false
  }
  for (const a of c.attrs) {
    const v = el.attrs[a.name]
    if (v === undefined) return false
    if (a.op == null) continue
    let x = v, y = a.val
    if (a.ci) { x = x.toLowerCase(); y = y.toLowerCase() }
    switch (a.op) {
      case '=': if (x !== y) return false; break
      case '~=': if (!x.split(/\s+/).includes(y)) return false; break
      case '|=': if (x !== y && !x.startsWith(y + '-')) return false; break
      case '^=': if (!y || !x.startsWith(y)) return false; break
      case '$=': if (!y || !x.endsWith(y)) return false; break
      case '*=': if (!y || !x.includes(y)) return false; break
    }
  }
  for (const t of c.tests) if (!t(el)) return false
  return true
}

function matchComplex(el, seq, i) {
  const e = seq[i]
  if (!matchCompound(el, e.comp)) return false
  if (i === 0) return true
  const p = el.parent
  switch (e.comb) {
    case '>': return !!p && p.type === 1 && p.tag !== '#root' && matchComplex(p, seq, i - 1)
    case ' ': { let a = p; while (a && a.type === 1 && a.tag !== '#root') { if (matchComplex(a, seq, i - 1)) return true; a = a.parent } return false }
    case '+': return !!p && el.pos > 0 && matchComplex(p.kids[el.pos - 1], seq, i - 1)
    case '~': { if (!p) return false; for (let k = el.pos - 1; k >= 0; k--) if (matchComplex(p.kids[k], seq, i - 1)) return true; return false }
  }
  return false
}

function parseStylesheet(css, env, out, origin) {
  css = stripComments(css)
  let i = 0
  const n = css.length
  while (i < n) {
    while (i < n && /\s/.test(css[i])) i++
    if (i >= n) break
    if (css[i] === '@') {
      let j = i, depth = 0, q = null
      while (j < n) {
        const c = css[j]
        if (q) { if (c === '\\') j++; else if (c === q) q = null }
        else if (c === '"' || c === "'") q = c
        else if (c === '(') depth++
        else if (c === ')') depth--
        else if ((c === '{' || c === ';') && depth <= 0) break
        j++
      }
      const head = css.slice(i, j).trim()
      const m = /^@([\w-]+)\s*([\s\S]*)$/.exec(head)
      const name = m ? m[1].toLowerCase() : '', prelude = m ? m[2].trim() : ''
      if (css[j] === '{') {
        const e = matchBrace(css, j)
        const body = css.slice(j + 1, e)
        if (name === 'media') { if (matchMedia(prelude, env)) parseStylesheet(body, env, out, origin) }
        else if (name === 'supports') { if (!/^not\b/i.test(prelude)) parseStylesheet(body, env, out, origin) }
        else if (name === 'layer' || name === 'scope' || name === 'document') parseStylesheet(body, env, out, origin)
        else if (name === 'font-face') out.fontFaces.push(parseDecls(body))
        i = e + 1
      } else i = j + 1
      continue
    }
    const b = css.indexOf('{', i)
    if (b < 0) break
    const e = matchBrace(css, b)
    const selText = css.slice(i, b).trim()
    const decls = parseDecls(css.slice(b + 1, e))
    i = e + 1
    if (!decls.length) continue
    for (const sel of parseSelectorList(selText)) {
      if (sel.pseudo === 'never') continue
      out.rules.push({ sel, decls, order: out.order++, origin, pseudo: sel.pseudo })
    }
  }
}

function buildIndex(rules) {
  const idx = { id: new Map(), cls: new Map(), tag: new Map(), any: [], pseudo: [] }
  const push = (m, k, r) => { const a = m.get(k); if (a) a.push(r); else m.set(k, [r]) }
  for (const r of rules) {
    if (r.pseudo) { idx.pseudo.push(r); continue }
    const c = r.sel.seq[r.sel.seq.length - 1].comp
    if (c.id != null) push(idx.id, c.id, r)
    else if (c.classes.length) push(idx.cls, c.classes[0], r)
    else if (c.tag && c.tag !== '*') push(idx.tag, c.tag, r)
    else idx.any.push(r)
  }
  return idx
}

function matchingRules(el, idx, pseudo) {
  const out = []
  const test = r => { if (matchComplex(el, r.sel.seq, r.sel.seq.length - 1)) out.push(r) }
  if (pseudo) {
    for (const r of idx.pseudo) if (r.pseudo === pseudo) test(r)
    return out
  }
  const a = idx.id.get(el.attrs.id)
  if (a) a.forEach(test)
  const cl = el.cls || (el.cls = new Set((el.attrs.class || '').split(/\s+/).filter(Boolean)))
  for (const k of cl) { const b = idx.cls.get(k); if (b) b.forEach(test) }
  const t = idx.tag.get(el.tag)
  if (t) t.forEach(test)
  idx.any.forEach(test)
  return out
}

const UA_CSS = `
html,address,blockquote,body,center,dialog,div,figure,figcaption,footer,form,header,hr,legend,listing,main,p,plaintext,pre,search,xmp,article,aside,h1,h2,h3,h4,h5,h6,hgroup,nav,section,dir,dd,dl,dt,menu,ol,ul,fieldset,details,summary,optgroup{display:block}
li{display:list-item}
head,link,meta,script,style,title,base,template,noscript,datalist,area,param,source,track,rp,dialog:not([open]){display:none}
[hidden]{display:none}
body{margin:8px}
p,dl,menu,ol,ul,fieldset,figure,pre,listing,plaintext,xmp{margin-top:1em;margin-bottom:1em}
blockquote{margin:1em 40px}
figure{margin:1em 40px}
address{font-style:italic}
h1{font-size:2em;margin:.67em 0;font-weight:bold}
h2{font-size:1.5em;margin:.83em 0;font-weight:bold}
h3{font-size:1.17em;margin:1em 0;font-weight:bold}
h4{margin:1.33em 0;font-weight:bold}
h5{font-size:.83em;margin:1.67em 0;font-weight:bold}
h6{font-size:.67em;margin:2.33em 0;font-weight:bold}
ul,ol,dir,menu{padding-left:40px}
ul{list-style-type:disc}
ol{list-style-type:decimal}
ul ul,ol ul,menu ul{list-style-type:circle}
ul ul ul,ol ol ul,ul ol ul,ol ul ul,menu ul ul{list-style-type:square}
dd{margin-left:40px}
nav ul,nav ol{list-style-type:none}
b,strong,th{font-weight:bold}
i,em,cite,var,dfn{font-style:italic}
u,ins{text-decoration:underline}
s,strike,del{text-decoration:line-through}
a:link{color:#0000ee;text-decoration:underline}
small{font-size:smaller}
big{font-size:larger}
sub{vertical-align:sub;font-size:smaller}
sup{vertical-align:super;font-size:smaller}
mark{background-color:#ffff00;color:#000}
code,kbd,samp,tt,pre,listing,plaintext,xmp{font-family:monospace}
pre,listing,plaintext,xmp{white-space:pre}
hr{border:1px inset;margin:.5em auto;color:gray;overflow:hidden}
center{text-align:center}
img{display:inline-block}
table{display:table;border-spacing:2px;border-collapse:separate;box-sizing:border-box;text-indent:0}
caption{display:table-caption;text-align:center}
colgroup{display:table-column-group}
col{display:table-column}
thead{display:table-header-group;vertical-align:middle}
tbody{display:table-row-group;vertical-align:middle}
tfoot{display:table-footer-group;vertical-align:middle}
tr{display:table-row;vertical-align:inherit}
td,th{display:table-cell;padding:1px;vertical-align:inherit}
th{text-align:center}
fieldset{padding:.35em .75em .625em;margin-left:2px;margin-right:2px;border:2px groove #c0c0c0}
legend{padding:0 2px}
details>:not(summary){display:none}
details[open]>:not(summary){display:block}
summary{display:block}
button,input,select,textarea{font:13.3333px Arial,sans-serif;color:fieldtext;letter-spacing:normal;word-spacing:normal;text-transform:none;text-indent:0;text-align:start;display:inline-block;margin:0}
input,textarea,select{background-color:#fff;border:2px inset #767676;border-radius:2px}
input{padding:1px 2px}
textarea{padding:2px;white-space:pre-wrap;font-family:monospace;display:inline-block}
select{padding:0 4px 0 4px;border:1px solid #767676;border-radius:4px}
button,input[type=button],input[type=submit],input[type=reset]{background-color:#efefef;border:2px outset #767676;border-radius:3px;padding:1px 6px;text-align:center}
input[type=checkbox],input[type=radio]{padding:0;margin:3px 3px 3px 4px;border:none;background:none}
input[type=range],input[type=color],input[type=file],input[type=image]{border:none;padding:0;background:none}
input[type=hidden]{display:none}
button{display:inline-flex;align-items:center;justify-content:center;text-align:center}
svg{display:inline;overflow:hidden}
svg:not(:root){overflow:hidden}
video,canvas,iframe,embed,object,audio{display:inline-block}
iframe{border:2px inset}
br{display:inline}
ruby{display:inline}
rt{font-size:50%}
progress{display:inline-block;width:160px;height:16px;vertical-align:-0.2em}
meter{display:inline-block;width:80px;height:16px;vertical-align:-0.2em}
`

const INHERITED = new Set(['color', 'font-family', 'font-size', 'font-style', 'font-weight', 'font-variant', 'font-variant-caps', 'line-height', 'letter-spacing', 'word-spacing', 'text-align', 'text-indent', 'text-transform', 'white-space', 'word-break', 'overflow-wrap', 'text-shadow', 'visibility', 'list-style-type', 'list-style-position', 'list-style-image', 'border-collapse', 'border-spacing', 'caption-side', 'cursor', 'direction', 'quotes', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'clip-rule', 'text-anchor', '-webkit-text-fill-color', '-webkit-text-stroke-width', '-webkit-text-stroke-color', 'color-scheme', 'tab-size', 'font-stretch', 'dominant-baseline', 'marker-start', 'marker-mid', 'marker-end', 'paint-order', 'text-rendering', 'stroke-miterlimit', '-webkit-box-orient', 'text-wrap'])

const SIDES = ['top', 'right', 'bottom', 'left']
const CORNERS = ['top-left', 'top-right', 'bottom-right', 'bottom-left']
const BORDER_STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset'])
const FONT_SIZE_KW = { 'xx-small': 9, 'x-small': 10, small: 13, medium: 16, large: 18, 'x-large': 24, 'xx-large': 32, 'xxx-large': 48 }
const LEN_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?(?:px|em|rem|ex|ch|vw|vh|vmin|vmax|svh|dvh|lvh|svw|dvw|lvw|pt|pc|in|cm|mm|q|%)?$|^(?:calc|min|max|clamp)\(/i
const isLenTok = t => LEN_RE.test(t) || /^(thin|medium|thick)$/i.test(t)

const SHORT_LONG = {
  margin: SIDES.map(s => 'margin-' + s), padding: SIDES.map(s => 'padding-' + s), inset: SIDES,
  'border-width': SIDES.map(s => `border-${s}-width`), 'border-style': SIDES.map(s => `border-${s}-style`), 'border-color': SIDES.map(s => `border-${s}-color`),
  'border-radius': CORNERS.map(c => `border-${c}-radius`),
  border: SIDES.flatMap(s => [`border-${s}-width`, `border-${s}-style`, `border-${s}-color`]),
  'border-top': ['border-top-width', 'border-top-style', 'border-top-color'], 'border-right': ['border-right-width', 'border-right-style', 'border-right-color'],
  'border-bottom': ['border-bottom-width', 'border-bottom-style', 'border-bottom-color'], 'border-left': ['border-left-width', 'border-left-style', 'border-left-color'],
  outline: ['outline-width', 'outline-style', 'outline-color'],
  background: ['background-image', 'background-position', 'background-size', 'background-repeat', 'background-origin', 'background-clip', 'background-color'],
  font: ['font-style', 'font-weight', 'font-size', 'line-height', 'font-family'], flex: ['flex-grow', 'flex-shrink', 'flex-basis'], 'flex-flow': ['flex-direction', 'flex-wrap'],
  gap: ['row-gap', 'column-gap'], overflow: ['overflow-x', 'overflow-y'], 'list-style': ['list-style-type', 'list-style-position', 'list-style-image'],
  'text-decoration': ['text-decoration-line', 'text-decoration-style', 'text-decoration-color'], 'place-items': ['align-items', 'justify-items'],
  'place-content': ['align-content', 'justify-content'], 'place-self': ['align-self', 'justify-self'], 'grid-column': ['grid-column-start', 'grid-column-end'],
  'grid-row': ['grid-row-start', 'grid-row-end'], 'grid-area': ['grid-row-start', 'grid-column-start', 'grid-row-end', 'grid-column-end'],
  'grid-template': ['grid-template-rows', 'grid-template-columns', 'grid-template-areas']
}
SHORT_LONG['grid-gap'] = SHORT_LONG.gap
SHORT_LONG['-webkit-box-flex'] = ['flex-grow']

function box4(v) {
  const t = tokens(v)
  if (t.length === 1) return [t[0], t[0], t[0], t[0]]
  if (t.length === 2) return [t[0], t[1], t[0], t[1]]
  if (t.length === 3) return [t[0], t[1], t[2], t[1]]
  return t.slice(0, 4)
}

function expandBackground(v, set) {
  const layers = splitTop(v, ',').map(x => x.trim()).filter(Boolean)
  const out = { image: [], pos: [], size: [], repeat: [], origin: [], clip: [] }
  let color = null
  layers.forEach((layer, li) => {
    let toks = []
    for (const t of tokens(layer)) {
      if (t.includes('/') && !/^(url|[a-z-]*gradient|image-set|calc|min|max|clamp)\(/i.test(t)) {
        const parts = t.split('/')
        parts.forEach((p, k) => { if (k) toks.push('/'); if (p) toks.push(p) })
      } else toks.push(t)
    }
    let image = 'none', repeat = [], boxes = [], pos = [], size = [], afterSlash = false
    for (const t of toks) {
      const lt = t.toLowerCase()
      if (t === '/') { afterSlash = true; continue }
      if (/^(url|image-set|(repeating-)?(linear|radial|conic)-gradient|-webkit-(linear|radial)-gradient|element|cross-fade)\(/i.test(t) || lt === 'none') { image = t; continue }
      if (/^(repeat|repeat-x|repeat-y|no-repeat|space|round)$/.test(lt)) { repeat.push(lt); continue }
      if (/^(border-box|padding-box|content-box|text)$/.test(lt)) { boxes.push(lt); continue }
      if (/^(scroll|fixed|local)$/.test(lt)) continue
      if (afterSlash) { if (/^(auto|cover|contain)$/.test(lt) || isLenTok(t)) { size.push(t); continue } afterSlash = false }
      if (/^(left|right|top|bottom|center)$/.test(lt) || isLenTok(t)) { pos.push(t); continue }
      const c = cssColor(t)
      if (c) { color = t; continue }
    }
    out.image.push(image)
    out.pos.push(pos.join(' ') || '0% 0%')
    out.size.push(size.join(' ') || 'auto')
    out.repeat.push(repeat.join(' ') || 'repeat')
    out.origin.push(boxes[0] && boxes[0] !== 'text' ? boxes[0] : 'padding-box')
    out.clip.push(boxes.length > 1 ? boxes[1] : boxes[0] || 'border-box')
  })
  set('background-image', out.image.join(','))
  set('background-position', out.pos.join(','))
  set('background-size', out.size.join(','))
  set('background-repeat', out.repeat.join(','))
  set('background-origin', out.origin.join(','))
  set('background-clip', out.clip.join(','))
  set('background-color', color || 'transparent')
}

function expandShorthand(p, v, set) {
  v = v.trim()
  switch (p) {
    case 'margin': case 'padding': case 'inset': { const b = box4(v); SIDES.forEach((s, i) => set(p === 'inset' ? s : `${p}-${s}`, b[i])); return true }
    case 'border-width': case 'border-style': case 'border-color': { const b = box4(v), k = p.slice(7); SIDES.forEach((s, i) => set(`border-${s}-${k}`, b[i])); return true }
    case 'border-radius': {
      const [h, vv] = v.split('/')
      const bh = box4(h), bv = vv ? box4(vv) : bh
      CORNERS.forEach((c, i) => set(`border-${c}-radius`, bh[i] + ' ' + bv[i]))
      return true
    }
    case 'border': case 'border-top': case 'border-right': case 'border-bottom': case 'border-left': {
      let w = 'medium', st = 'none', col = 'currentcolor'
      for (const t of tokens(v)) {
        const lt = t.toLowerCase()
        if (BORDER_STYLES.has(lt)) st = lt
        else if (isLenTok(t)) w = t
        else col = t
      }
      const sides = p === 'border' ? SIDES : [p.slice(7)]
      for (const s of sides) { set(`border-${s}-width`, w); set(`border-${s}-style`, st); set(`border-${s}-color`, col) }
      return true
    }
    case 'outline': {
      let w = 'medium', st = 'none', col = 'currentcolor'
      for (const t of tokens(v)) { const lt = t.toLowerCase(); if (BORDER_STYLES.has(lt) || lt === 'auto') st = lt === 'auto' ? 'solid' : lt; else if (isLenTok(t)) w = t; else col = t }
      set('outline-width', w); set('outline-style', st); set('outline-color', col)
      return true
    }
    case 'background': expandBackground(v, set); return true
    case 'font': {
      if (/^(caption|icon|menu|message-box|small-caption|status-bar)$/i.test(v)) return true
      const t = tokens(v)
      let i = 0, style = 'normal', weight = 'normal'
      for (; i < t.length; i++) {
        const lt = t[i].toLowerCase()
        if (lt === 'italic' || lt === 'oblique') style = 'italic'
        else if (lt === 'bold' || lt === 'bolder' || lt === 'lighter' || /^[1-9]00$/.test(lt)) weight = lt
        else if (lt === 'normal' || lt === 'small-caps' || /^(ultra-|extra-|semi-)?(condensed|expanded)$/.test(lt)) continue
        else break
      }
      if (i >= t.length) return true
      const [size, lh] = t[i].split('/')
      let lhv = lh
      let j = i + 1
      if (!lhv && t[j] && t[j].startsWith('/')) { lhv = t[j].slice(1) || t[++j]; j++ }
      set('font-style', style); set('font-weight', weight); set('font-size', size); set('line-height', lhv || 'normal')
      set('font-family', t.slice(j).join(' '))
      return true
    }
    case 'flex': {
      const lv = v.toLowerCase()
      if (lv === 'none') { set('flex-grow', '0'); set('flex-shrink', '0'); set('flex-basis', 'auto'); return true }
      if (lv === 'auto') { set('flex-grow', '1'); set('flex-shrink', '1'); set('flex-basis', 'auto'); return true }
      if (lv === 'initial') { set('flex-grow', '0'); set('flex-shrink', '1'); set('flex-basis', 'auto'); return true }
      const t = tokens(v)
      const nums = t.filter(x => /^[+-]?(\d+\.?\d*|\.\d+)$/.test(x)), other = t.filter(x => !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(x))
      set('flex-grow', nums[0] ?? '1'); set('flex-shrink', nums[1] ?? '1'); set('flex-basis', other[0] ?? '0%')
      if (nums.length === 3 && !other.length) set('flex-basis', nums[2] + 'px')
      return true
    }
    case 'flex-flow': for (const t of tokens(v)) { if (/^(row|column)(-reverse)?$/i.test(t)) set('flex-direction', t); else set('flex-wrap', t) } return true
    case 'gap': case 'grid-gap': { const t = tokens(v); set('row-gap', t[0]); set('column-gap', t[1] ?? t[0]); return true }
    case 'overflow': { const t = tokens(v); set('overflow-x', t[0]); set('overflow-y', t[1] ?? t[0]); return true }
    case 'list-style': {
      let type = 'disc', pos = 'outside', img = 'none'
      for (const t of tokens(v)) { const lt = t.toLowerCase(); if (lt === 'inside' || lt === 'outside') pos = lt; else if (/^url\(/i.test(t)) img = t; else if (lt !== 'none' || true) type = lt }
      set('list-style-type', type); set('list-style-position', pos); set('list-style-image', img)
      return true
    }
    case 'text-decoration': {
      const lines = [], rest = []
      let style = 'solid', col = 'currentcolor'
      for (const t of tokens(v)) { const lt = t.toLowerCase(); if (/^(underline|overline|line-through|none|blink)$/.test(lt)) lines.push(lt); else if (/^(solid|double|dotted|dashed|wavy)$/.test(lt)) style = lt; else if (isLenTok(t) || lt === 'auto' || lt === 'from-font') rest.push(t); else col = t }
      set('text-decoration-line', lines.join(' ') || 'none'); set('text-decoration-style', style); set('text-decoration-color', col)
      return true
    }
    case 'place-items': { const t = tokens(v); set('align-items', t[0]); set('justify-items', t[1] ?? t[0]); return true }
    case 'place-content': { const t = tokens(v); set('align-content', t[0]); set('justify-content', t[1] ?? t[0]); return true }
    case 'place-self': { const t = tokens(v); set('align-self', t[0]); set('justify-self', t[1] ?? t[0]); return true }
    case 'grid-column': case 'grid-row': { const [a, b] = v.split('/').map(x => x.trim()); set(p + '-start', a); set(p + '-end', b ?? (/^span\b/.test(a) ? 'auto' : 'auto')); return true }
    case 'grid-area': {
      const parts = v.split('/').map(x => x.trim())
      if (parts.length === 1) { set('grid-area', parts[0]); set('grid-row-start', parts[0]); set('grid-column-start', parts[0]); set('grid-row-end', parts[0]); set('grid-column-end', parts[0]) }
      else { set('grid-row-start', parts[0]); set('grid-column-start', parts[1] ?? 'auto'); set('grid-row-end', parts[2] ?? 'auto'); set('grid-column-end', parts[3] ?? 'auto') }
      return true
    }
    case 'grid-template': {
      if (/["']/.test(v)) {
        const [rowsPart, colsPart] = v.split('/')
        const areas = [], rows = []
        const re = /(["'])(.*?)\1\s*([^"'\s][^"']*)?/g
        let m
        while ((m = re.exec(rowsPart))) { areas.push(`"${m[2]}"`); rows.push((m[3] || 'auto').trim()) }
        set('grid-template-areas', areas.join(' ')); set('grid-template-rows', rows.join(' '))
        if (colsPart) set('grid-template-columns', colsPart.trim())
      } else {
        const [r, c] = v.split('/')
        set('grid-template-rows', (r || 'none').trim()); set('grid-template-columns', (c || 'none').trim())
      }
      return true
    }
    case 'grid': { if (v.includes('/') && !/\bauto-flow\b/.test(v)) return expandShorthand('grid-template', v, set); return true }
    case 'word-wrap': set('overflow-wrap', v); return true
    case '-webkit-background-clip': set('background-clip', v); return true
    case '-webkit-box-flex': set('flex-grow', v); return true
    case 'transition': case 'animation': case 'will-change': case 'cursor': case 'pointer-events': case 'user-select': case '-webkit-user-select': case 'scroll-behavior': case 'transition-property': return true
  }
  return false
}

function subVars(v, vars, depth = 0) {
  if (v.indexOf('var(') < 0 && v.indexOf('env(') < 0) return v
  if (depth > 12) return null
  let out = '', i = 0
  while (i < v.length) {
    const k = v.slice(i).search(/\b(var|env)\(/)
    if (k < 0) { out += v.slice(i); break }
    out += v.slice(i, i + k)
    let j = i + k + 4
    if (v[i + k] === 'e') j = i + k + 4
    const isEnv = v[i + k] === 'e'
    let d = 1, q = null
    const start = i + k + (isEnv ? 4 : 4)
    j = start
    for (; j < v.length; j++) {
      const c = v[j]
      if (q) { if (c === '\\') j++; else if (c === q) q = null; continue }
      if (c === '"' || c === "'") q = c
      else if (c === '(') d++
      else if (c === ')') { d--; if (d === 0) break }
    }
    const inner = v.slice(start, j)
    const ci = splitTop(inner, ',')
    const name = ci[0].trim()
    const fb = ci.length > 1 ? inner.slice(ci[0].length + 1).trim() : null
    let val
    if (isEnv) val = fb != null ? fb : '0px'
    else {
      val = vars[name]
      if (val === undefined) val = fb
      if (val != null) val = subVars(val, vars, depth + 1)
    }
    if (val == null) return null
    out += val
    i = j + 1
  }
  return out
}

function presentational(el) {
  const a = el.attrs, out = []
  const dim = v => /^\d+(\.\d+)?%?$/.test(v.trim()) ? (v.trim().endsWith('%') ? v.trim() : v.trim() + 'px') : null
  const add = (p, v) => { if (v != null) out.push({ p, v, imp: false }) }
  if (a.width && /^(img|table|td|th|svg|video|canvas|iframe|col|input|embed|object|colgroup|hr)$/.test(el.tag)) add('width', dim(a.width))
  if (a.height && /^(img|table|td|th|svg|video|canvas|iframe|tr|input|embed|object)$/.test(el.tag)) add('height', dim(a.height))
  if (a.bgcolor) add('background-color', a.bgcolor)
  if (el.tag === 'body' && a.text) add('color', a.text)
  if (el.tag === 'font') { if (a.color) add('color', a.color); if (a.face) add('font-family', a.face); if (a.size) { const n = parseInt(a.size, 10); add('font-size', ['x-small', 'x-small', 'small', 'medium', 'large', 'x-large', 'xx-large', 'xxx-large'][clampN(n || 3, 0, 7)]) } }
  if (a.align) {
    const al = a.align.toLowerCase()
    if (el.tag === 'img' || el.tag === 'table') { if (al === 'left' || al === 'right') add('float', al); else if (al === 'center' && el.tag === 'table') { add('margin-left', 'auto'); add('margin-right', 'auto') } }
    else if (/^(left|right|center|justify)$/.test(al)) add('text-align', al)
  }
  if (a.valign && /^(td|th|tr|tbody|thead|tfoot)$/.test(el.tag)) add('vertical-align', a.valign.toLowerCase())
  if (el.tag === 'table' && a.border && /^\d+$/.test(a.border) && +a.border > 0) { add('border-width', a.border + 'px'); add('border-style', 'outset'); add('border-color', 'gray') }
  if (el.tag === 'table' && a.cellspacing) add('border-spacing', parseFloat(a.cellspacing) + 'px')
  if ((el.tag === 'td' || el.tag === 'th') && el.parent) {
    let t = el.parent
    while (t && t.tag !== 'table') t = t.parent
    if (t && t.attrs.cellpadding && /^\d+$/.test(t.attrs.cellpadding)) add('padding', t.attrs.cellpadding + 'px')
    if (t && t.attrs.border && +t.attrs.border > 0) { add('border-width', '1px'); add('border-style', 'inset'); add('border-color', 'gray') }
  }
  if (el.tag === 'hr' && a.size) add('height', a.size + 'px')
  if (el.tag === 'br' && 'clear' in a) add('clear', a.clear || 'both')
  if (el.tag === 'ol' && a.type) add('list-style-type', { a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', 1: 'decimal' }[a.type] || 'decimal')
  if (el.tag === 'li' && a.type) add('list-style-type', { a: 'lower-alpha', A: 'upper-alpha', i: 'lower-roman', I: 'upper-roman', 1: 'decimal', disc: 'disc', circle: 'circle', square: 'square' }[a.type] || 'disc')
  return out
}

function cascadeElement(el, parentRaw, idx, pseudo) {
  const entries = []
  let ord = 0
  const addDecls = (decls, org, spec) => { for (const d of decls) entries.push({ p: d.p, v: d.v, imp: d.imp ? 1 : 0, org, spec, ord: ord++ }) }
  if (!pseudo) addDecls(presentational(el), 0.5, 0)
  for (const r of matchingRules(el, idx, pseudo)) addDecls(r.decls, r.origin, r.sel.spec)
  if (!pseudo && el.attrs.style) addDecls(parseDecls(el.attrs.style), 2, 0)
  if (el.svg && !pseudo) {
    const a = el.attrs, pa = []
    for (const k of ['fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-dasharray', 'stroke-dashoffset', 'stroke-opacity', 'fill-opacity', 'fill-rule', 'stop-color', 'stop-opacity', 'opacity', 'text-anchor', 'font-size', 'font-family', 'font-weight', 'font-style', 'display', 'visibility', 'color', 'clip-path', 'letter-spacing', 'dominant-baseline', 'stroke-miterlimit', 'paint-order'])
      if (a[k] != null) pa.push({ p: k, v: a[k], imp: false })
    entries.unshift(...pa.map(d => ({ p: d.p, v: d.v, imp: 0, org: 0.5, spec: 0, ord: -1 })))
  }
  entries.sort((x, y) => x.imp - y.imp || x.org - y.org || x.spec - y.spec || x.ord - y.ord)
  const vars = Object.create(parentRaw ? parentRaw.vars : null)
  const own = {}
  for (const e of entries) {
    if (e.p.startsWith('--')) { const sv = subVars(e.v, vars); vars[e.p] = sv == null ? '' : sv }
  }
  const apply = (p, v) => {
    const lv = v.toLowerCase()
    if (lv === 'inherit') { own[p] = { inherit: true }; return }
    if (lv === 'initial' || lv === 'revert' || lv === 'revert-layer') { delete own[p]; own[p] = { initial: true }; return }
    if (lv === 'unset') { own[p] = INHERITED.has(p) ? { inherit: true } : { initial: true }; return }
    own[p] = v
  }
  for (const e of entries) {
    if (e.p.startsWith('--')) continue
    let v = e.v
    if (v.indexOf('var(') >= 0 || v.indexOf('env(') >= 0) { v = subVars(v, vars); if (v == null) continue }
    const lv = v.trim().toLowerCase()
    if (SHORT_LONG[e.p] && (lv === 'inherit' || lv === 'initial' || lv === 'unset' || lv === 'revert')) { for (const l of SHORT_LONG[e.p]) apply(l, v); continue }
    const handled = expandShorthand(e.p, v, (lp, lv2) => apply(lp, lv2))
    if (!handled) apply(e.p, v)
  }
  return { own, vars }
}

function parseShadows(str, cs, E) {
  const out = []
  if (!str || str === 'none') return out
  for (const part of splitTop(str, ',')) {
    const t = tokens(part.trim())
    let inset = false, col = null
    const nums = []
    for (const k of t) {
      if (k.toLowerCase() === 'inset') { inset = true; continue }
      if (isLenTok(k) && !(cssColor(k))) { const v = parseLen(k, E); nums.push(typeof v === 'number' ? v : 0); continue }
      const c = cssColor(k, cs.color)
      if (c) col = c
    }
    if (nums.length < 2) continue
    out.push({ inset, x: nums[0], y: nums[1], blur: Math.max(0, nums[2] || 0), spread: nums[3] || 0, color: col || cs.color })
  }
  return out
}

function parseTransformList(str, E) {
  const ops = []
  if (!str || str === 'none') return ops
  const re = /([a-z0-9]+)\(([^)]*)\)/gi
  let m
  while ((m = re.exec(str))) {
    const fn = m[1].toLowerCase()
    const args = splitTop(m[2], ',').map(x => x.trim()).filter(x => x !== '')
    ops.push({ fn, args: args.length === 1 && /\s/.test(args[0]) && fn !== 'matrix' ? tokens(args[0]) : args, E })
  }
  return ops
}

function parseContent(str, el, cs) {
  if (!str) return null
  const v = str.trim()
  const lv = v.toLowerCase()
  if (lv === 'none' || lv === 'normal') return null
  const parts = []
  const re = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(attr|counter|counters)\(([^)]*)\)|(open-quote|close-quote|no-open-quote|no-close-quote)|(url\([^)]*\))/gi
  let m
  while ((m = re.exec(v))) {
    if (m[1] != null || m[2] != null) parts.push({ s: (m[1] ?? m[2]).replace(/\\([0-9a-fA-F]{1,6})\s?/g, (x, h) => String.fromCodePoint(parseInt(h, 16))).replace(/\\(.)/g, '$1') })
    else if (m[3]) {
      const fn = m[3].toLowerCase(), args = splitTop(m[4], ',').map(x => x.trim().replace(/^['"]|['"]$/g, ''))
      if (fn === 'attr') parts.push({ s: el.attrs[args[0].toLowerCase()] || '' })
      else parts.push({ counter: args[0], sep: fn === 'counters' ? args[1] || '' : null, style: fn === 'counters' ? args[2] : args[1] })
    } else if (m[5]) parts.push({ s: /^open/i.test(m[5]) ? '“' : /^close/i.test(m[5]) ? '”' : '' })
    else if (m[6]) parts.push({ s: '' })
  }
  return parts
}

Object.assign(NAMED, {
  canvastext: NAMED.black, fieldtext: NAMED.black, buttontext: NAMED.black, windowtext: NAMED.black, canvas: NAMED.white, window: NAMED.white, field: NAMED.white,
  buttonface: { r: 239, g: 239, b: 239, a: 1 }, buttonborder: { r: 118, g: 118, b: 118, a: 1 }, graytext: NAMED.gray, linktext: { r: 0, g: 0, b: 238, a: 1 },
  highlight: { r: 0, g: 120, b: 215, a: 1 }, highlighttext: NAMED.white
})

function normDisplay(v, el) {
  v = (v || 'inline').trim().toLowerCase()
  const t = v.split(/\s+/)
  if (t.length > 1) {
    const outer = t.includes('inline') ? 'inline' : 'block'
    const inner = t.find(x => x !== 'inline' && x !== 'block' && x !== 'run-in') || 'flow'
    if (inner === 'flow') return outer
    if (inner === 'flow-root') return outer === 'inline' ? 'inline-block' : 'flow-root'
    if (inner === 'list-item') return 'list-item'
    return outer === 'inline' ? 'inline-' + inner : inner
  }
  if (v === '-webkit-box' || v === '-webkit-inline-box') return v === '-webkit-box' ? 'block' : 'inline-block'
  if (v === '-webkit-flex') return 'flex'
  if (v === '-webkit-inline-flex') return 'inline-flex'
  if (v === 'ruby' || v === 'ruby-text' || v === 'ruby-base') return 'inline'
  if (v === 'contents' || v === 'none' || v === 'block' || v === 'inline' || v === 'inline-block' || v === 'flex' || v === 'inline-flex' || v === 'grid' || v === 'inline-grid' || v === 'list-item' || v === 'table' || v === 'inline-table' || v === 'flow-root' || v.startsWith('table-')) return v
  return 'inline'
}

const blockify = d => d === 'inline' || d === 'inline-block' ? 'block' : d === 'inline-flex' ? 'flex' : d === 'inline-grid' ? 'grid' : d === 'inline-table' ? 'table' : d

function makeCS(el, own, vars, parentCS, ctx) {
  const raw = {}
  const pRaw = parentCS ? parentCS.raw : null
  for (const p in own) {
    const v = own[p]
    if (v && typeof v === 'object') { if (v.inherit && pRaw && pRaw[p] !== undefined) raw[p] = pRaw[p] }
    else raw[p] = v
  }
  if (pRaw) for (const p of INHERITED) if (!(p in own) && pRaw[p] !== undefined) raw[p] = pRaw[p]
  const cs = { el, raw, vars, parent: parentCS }
  const pfs = parentCS ? parentCS.fontSize : 16
  let fs = pfs
  const rfs0 = ctx.rootFs
  const E0 = { fs: pfs, rfs: rfs0, vw: ctx.vw, vh: ctx.vh }
  if (raw['font-size'] !== undefined) {
    const v = raw['font-size'].trim().toLowerCase()
    if (FONT_SIZE_KW[v]) fs = FONT_SIZE_KW[v]
    else if (v === 'smaller') fs = pfs / 1.2
    else if (v === 'larger') fs = pfs * 1.2
    else { const r = parseLen(v, E0); fs = typeof r === 'number' ? r : typeof r === 'function' ? r(pfs) : pfs }
  }
  if (!(fs >= 0)) fs = pfs
  cs.fontSize = fs
  raw['font-size'] = fs + 'px'
  if (el.tag === 'html' && !el.pseudo) ctx.rootFs = fs
  const E = { fs, rfs: el.tag === 'html' ? fs : ctx.rootFs, vw: ctx.vw, vh: ctx.vh }
  cs.E = E
  const L = (p, def = 'auto') => { const v = raw[p]; if (v === undefined) return def; const r = parseLen(v, E); return r == null ? def : r }
  const color = raw.color !== undefined ? cssColor(raw.color, parentCS ? parentCS.color : null) : null
  cs.color = color || (parentCS ? parentCS.color : { r: 0, g: 0, b: 0, a: 1 })
  if (raw.color !== undefined && !color && parentCS) cs.color = parentCS.color
  const col = (p, def) => { const v = raw[p]; if (v === undefined) return def; const c = cssColor(v, cs.color); return c || def }

  let fw = parentCS ? parentCS.fontWeight : 400
  if (raw['font-weight'] !== undefined) {
    const v = raw['font-weight'].trim().toLowerCase()
    if (v === 'normal') fw = 400
    else if (v === 'bold') fw = 700
    else if (v === 'bolder') fw = fw < 400 ? 400 : fw < 600 ? 700 : 900
    else if (v === 'lighter') fw = fw < 600 ? 100 : fw < 800 ? 400 : 700
    else { const n = parseFloat(v); if (n === n) fw = clampN(n, 1, 1000) }
  }
  cs.fontWeight = fw
  raw['font-weight'] = String(fw)
  cs.fontStyle = /italic|oblique/i.test(raw['font-style'] || '') ? 'italic' : 'normal'
  cs.fontFamily = splitTop(raw['font-family'] || 'serif', ',').map(x => x.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean)
  cs.smallCaps = /small-caps/.test(raw['font-variant'] || '') || /small-caps/.test(raw['font-variant-caps'] || '')

  const lhv = (raw['line-height'] || 'normal').trim().toLowerCase()
  if (lhv === 'normal') cs.lineHeight = null
  else if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(lhv)) cs.lineHeight = { mul: parseFloat(lhv) }
  else { const r = parseLen(lhv, E); const px = typeof r === 'number' ? r : typeof r === 'function' ? r(fs) : null; if (px == null) cs.lineHeight = null; else { cs.lineHeight = { px }; raw['line-height'] = px + 'px' } }

  const ls = raw['letter-spacing']
  cs.letterSpacing = 0
  if (ls !== undefined && ls.trim().toLowerCase() !== 'normal') { const r = parseLen(ls, E); if (typeof r === 'number') { cs.letterSpacing = r; raw['letter-spacing'] = r + 'px' } }
  cs.wordSpacing = 0
  if (raw['word-spacing'] !== undefined && raw['word-spacing'].trim().toLowerCase() !== 'normal') { const r = parseLen(raw['word-spacing'], E); if (typeof r === 'number') { cs.wordSpacing = r; raw['word-spacing'] = r + 'px' } }
  cs.textIndent = 0
  if (raw['text-indent'] !== undefined) { const r = parseLen(raw['text-indent'].split(/\s+/)[0], E); if (r != null && r !== 'auto') { cs.textIndent = r; if (typeof r === 'number') raw['text-indent'] = r + 'px' } }

  let ta = (raw['text-align'] || 'start').trim().toLowerCase().replace('-webkit-', '').replace('-moz-', '')
  if (ta === 'start' || ta === 'match-parent') ta = 'left'
  else if (ta === 'end') ta = 'right'
  cs.textAlign = ta
  cs.textTransform = (raw['text-transform'] || 'none').trim().toLowerCase()
  const ws = (raw['white-space'] || 'normal').trim().toLowerCase()
  cs.whiteSpace = ws
  if (/\bnowrap\b/.test(raw['text-wrap'] || '')) cs.whiteSpace = ws === 'normal' ? 'nowrap' : ws
  cs.wordBreak = (raw['word-break'] || 'normal').trim().toLowerCase()
  cs.overflowWrap = (raw['overflow-wrap'] || 'normal').trim().toLowerCase()
  if (cs.wordBreak === 'break-word') cs.overflowWrap = 'anywhere'
  cs.textOverflow = /ellipsis/.test(raw['text-overflow'] || '') ? 'ellipsis' : 'clip'
  cs.verticalAlign = (raw['vertical-align'] || 'baseline').trim().toLowerCase()
  cs.visibility = (raw.visibility || 'visible').trim().toLowerCase()
  cs.listType = (raw['list-style-type'] || (el.tag === 'li' ? 'disc' : 'disc')).trim().toLowerCase().replace(/^["']|["']$/g, '')
  cs.listPos = (raw['list-style-position'] || 'outside').trim().toLowerCase()
  cs.listImage = raw['list-style-image'] && /^url\(/i.test(raw['list-style-image']) ? raw['list-style-image'] : null

  const fill = raw['-webkit-text-fill-color']
  cs.textFill = fill !== undefined ? cssColor(fill, cs.color) : null
  cs.textStrokeW = raw['-webkit-text-stroke-width'] !== undefined ? (parseLen(raw['-webkit-text-stroke-width'], E) || 0) : 0
  cs.textStrokeC = raw['-webkit-text-stroke-color'] !== undefined ? (cssColor(raw['-webkit-text-stroke-color'], cs.color) || cs.color) : cs.color
  if (typeof cs.textStrokeW !== 'number') cs.textStrokeW = 0
  cs.textShadow = raw['text-shadow'] !== undefined && raw['text-shadow'] !== 'none' ? parseShadows(raw['text-shadow'], cs, E).map(s => ({ x: s.x, y: s.y, blur: s.blur, color: s.color })) : []
  cs.lineClamp = parseInt(raw['-webkit-line-clamp'] || raw['line-clamp'] || '0', 10) || 0

  let disp = normDisplay(raw.display, el)
  cs.floatSide = (raw.float || 'none').trim().toLowerCase().replace('inline-', '')
  if (cs.floatSide !== 'left' && cs.floatSide !== 'right') cs.floatSide = 'none'
  cs.position = (raw.position || 'static').trim().toLowerCase()
  if (cs.position === 'sticky') cs.position = 'relative'
  cs.oof = cs.position === 'absolute' || cs.position === 'fixed'
  if (cs.oof) cs.floatSide = 'none'
  if (cs.floatSide !== 'none' || cs.oof) disp = blockify(disp)
  if (el.tag === 'html' && !el.pseudo) disp = blockify(disp)
  cs.display = disp
  cs.clear = (raw.clear || 'none').trim().toLowerCase()
  cs.boxSizing = (raw['box-sizing'] || 'content-box').trim().toLowerCase()
  cs.opacity = 1
  if (raw.opacity !== undefined) { const o = raw.opacity.trim(); const n = o.endsWith('%') ? parseFloat(o) / 100 : parseFloat(o); if (n === n) cs.opacity = clampN(n, 0, 1) }
  const zi = (raw['z-index'] || 'auto').trim()
  cs.zIndex = /^[+-]?\d+$/.test(zi) ? parseInt(zi, 10) : 'auto'
  cs.overflowX = (raw['overflow-x'] || 'visible').trim().toLowerCase()
  cs.overflowY = (raw['overflow-y'] || 'visible').trim().toLowerCase()
  if (cs.overflowX === 'visible' && cs.overflowY !== 'visible' && cs.overflowY !== 'clip') cs.overflowX = 'auto'
  if (cs.overflowY === 'visible' && cs.overflowX !== 'visible' && cs.overflowX !== 'clip') cs.overflowY = 'auto'
  cs.clips = cs.overflowX !== 'visible' || cs.overflowY !== 'visible'

  cs.width = L('width'); cs.height = L('height')
  const lim = (p, def) => { const v = raw[p]; if (v === undefined || /^(none|auto)$/i.test(v.trim())) return def; const r = parseLen(v, E); return r == null || r === 'auto' ? def : r }
  cs.minWAuto = raw['min-width'] === undefined || /^auto$/i.test(raw['min-width'].trim()); cs.minHAuto = raw['min-height'] === undefined || /^auto$/i.test(raw['min-height'].trim())
  cs.minW = lim('min-width', 0); cs.minH = lim('min-height', 0); cs.maxW = lim('max-width', null); cs.maxH = lim('max-height', null)
  cs.margin = SIDES.map(s => L('margin-' + s, 0))
  cs.padding = SIDES.map(s => { const v = L('padding-' + s, 0); return v === 'auto' ? 0 : v })
  cs.bs = SIDES.map(s => { const v = (raw[`border-${s}-style`] || 'none').trim().toLowerCase(); return BORDER_STYLES.has(v) ? v : 'none' })
  cs.bw = SIDES.map((s, i) => {
    if (cs.bs[i] === 'none' || cs.bs[i] === 'hidden') return 0
    const v = (raw[`border-${s}-width`] || 'medium').trim().toLowerCase()
    if (v === 'thin') return 1
    if (v === 'medium') return 3
    if (v === 'thick') return 5
    const r = parseLen(v, E)
    return typeof r === 'number' ? Math.max(0, r) : 3
  })
  cs.bc = SIDES.map(s => col(`border-${s}-color`, cs.color))
  cs.radius = CORNERS.map(c => {
    const v = raw[`border-${c}-radius`]
    if (v === undefined) return [0, 0]
    const t = tokens(v)
    const a = parseLen(t[0], E), b = t[1] !== undefined ? parseLen(t[1], E) : a
    const f = x => (typeof x === 'number' || typeof x === 'function') ? x : 0
    return [f(a), f(b)]
  })
  cs.top = L('top'); cs.right = L('right'); cs.bottom = L('bottom'); cs.left = L('left')
  cs.aspect = null
  if (raw['aspect-ratio'] !== undefined && !/auto/i.test(raw['aspect-ratio'])) {
    const m = /^\s*([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(raw['aspect-ratio'])
    if (m) { const r = parseFloat(m[1]) / (m[2] ? parseFloat(m[2]) : 1); if (r > 0 && isFinite(r)) cs.aspect = r }
  }

  cs.flexDir = (raw['flex-direction'] || 'row').trim().toLowerCase()
  cs.flexWrap = (raw['flex-wrap'] || 'nowrap').trim().toLowerCase()
  const fg = parseFloat(raw['flex-grow']), fsh = parseFloat(raw['flex-shrink'])
  cs.flexGrow = fg === fg ? Math.max(0, fg) : 0
  cs.flexShrink = fsh === fsh ? Math.max(0, fsh) : 1
  const fb = (raw['flex-basis'] || 'auto').trim().toLowerCase()
  cs.flexBasis = fb === 'auto' || fb === 'content' ? fb : (() => { const r = parseLen(fb, E); return r == null ? 'auto' : r })()
  cs.order = parseInt(raw.order || '0', 10) || 0
  const kw = (p, d) => (raw[p] || d).trim().toLowerCase()
  cs.justifyContent = kw('justify-content', 'normal')
  cs.alignItems = kw('align-items', 'normal')
  cs.alignSelf = kw('align-self', 'auto')
  cs.alignContent = kw('align-content', 'normal')
  cs.justifyItems = kw('justify-items', 'normal')
  cs.justifySelf = kw('justify-self', 'auto')
  const gp = p => { const v = raw[p]; if (v === undefined || /^normal$/i.test(v.trim())) return 0; const r = parseLen(v, E); return r == null || r === 'auto' ? 0 : r }
  cs.rowGap = gp('row-gap'); cs.colGap = gp('column-gap')
  cs.gridCols = raw['grid-template-columns'] || 'none'
  cs.gridRows = raw['grid-template-rows'] || 'none'
  cs.gridAreas = raw['grid-template-areas'] || 'none'
  cs.gridAutoCols = raw['grid-auto-columns'] || 'auto'
  cs.gridAutoRows = raw['grid-auto-rows'] || 'auto'
  cs.gridFlow = kw('grid-auto-flow', 'row')
  cs.gridArea = raw['grid-area'] && !raw['grid-area'].includes('/') ? raw['grid-area'].trim() : null
  cs.gridColStart = (raw['grid-column-start'] || 'auto').trim(); cs.gridColEnd = (raw['grid-column-end'] || 'auto').trim()
  cs.gridRowStart = (raw['grid-row-start'] || 'auto').trim(); cs.gridRowEnd = (raw['grid-row-end'] || 'auto').trim()

  cs.bgColor = col('background-color', TRANSPARENT)
  const imgs = splitTop(raw['background-image'] || 'none', ',').map(x => x.trim())
  const lists = ['background-position', 'background-size', 'background-repeat', 'background-origin', 'background-clip'].map(p => splitTop(raw[p] || '', ',').map(x => x.trim()))
  cs.bgLayers = []
  imgs.forEach((im, i) => {
    if (!im || im === 'none') return
    const at = (k, d) => { const l = lists[k]; return l.length && l[i % l.length] ? l[i % l.length] : d }
    cs.bgLayers.push({ image: im, pos: at(0, '0% 0%'), size: at(1, 'auto'), repeat: at(2, 'repeat'), origin: at(3, 'padding-box'), clip: at(4, 'border-box') })
  })
  cs.bgClipText = lists[4].some(x => x === 'text')
  cs.shadows = raw['box-shadow'] !== undefined && raw['box-shadow'] !== 'none' ? parseShadows(raw['box-shadow'], cs, E) : []
  cs.transform = parseTransformList(raw.transform, E)
  const tr = []
  if (raw.translate) tr.push({ fn: 'translate', args: tokens(raw.translate), E })
  if (raw.rotate) tr.push({ fn: 'rotate', args: [raw.rotate.trim()], E })
  if (raw.scale) { const a = tokens(raw.scale); tr.push({ fn: 'scale', args: a, E }) }
  cs.transform = tr.concat(cs.transform)
  cs.transformOrigin = (raw['transform-origin'] || '50% 50%').trim().toLowerCase()
  cs.filter = raw.filter && raw.filter !== 'none' ? raw.filter : null
  cs.backdrop = raw['backdrop-filter'] || raw['-webkit-backdrop-filter'] || null
  if (cs.backdrop === 'none') cs.backdrop = null
  cs.clipPath = raw['clip-path'] && raw['clip-path'] !== 'none' ? raw['clip-path'] : null
  cs.objectFit = kw('object-fit', 'fill')
  cs.objectPos = kw('object-position', '50% 50%')
  cs.mixBlend = kw('mix-blend-mode', 'normal')
  const ow = raw['outline-width'] !== undefined ? (() => { const v = raw['outline-width'].trim().toLowerCase(); if (v === 'thin') return 1; if (v === 'medium') return 3; if (v === 'thick') return 5; const r = parseLen(v, E); return typeof r === 'number' ? r : 3 })() : 3
  const os = kw('outline-style', 'none')
  cs.outline = os === 'none' || os === 'hidden' ? null : { w: ow, style: os, color: col('outline-color', cs.color), offset: raw['outline-offset'] !== undefined ? (parseLen(raw['outline-offset'], E) || 0) : 0 }
  if (typeof cs.outline?.offset !== 'number' && cs.outline) cs.outline.offset = 0
  cs.borderCollapse = kw('border-collapse', 'separate')
  const bsp = tokens(raw['border-spacing'] || '0')
  const bs0 = parseLen(bsp[0], E), bs1 = bsp[1] !== undefined ? parseLen(bsp[1], E) : bs0
  cs.spacingH = typeof bs0 === 'number' ? bs0 : 0
  cs.spacingV = typeof bs1 === 'number' ? bs1 : 0
  cs.tableLayout = kw('table-layout', 'auto')
  cs.captionSide = kw('caption-side', 'top')
  cs.contentRaw = raw.content
  cs.textAnchor = kw('text-anchor', 'start')

  const decoLine = (raw['text-decoration-line'] || '').trim().toLowerCase()
  const lines = decoLine && decoLine !== 'none' ? decoLine.split(/\s+/).filter(x => /^(underline|overline|line-through)$/.test(x)) : []
  const inherits = parentCS && parentCS.decos && !(cs.display === 'inline-block' || cs.display === 'inline-flex' || cs.display === 'inline-grid' || cs.display === 'inline-table' || cs.floatSide !== 'none' || cs.oof) ? parentCS.decos : []
  cs.decos = lines.length ? inherits.concat(lines.map(l => ({ line: l, color: col('text-decoration-color', cs.color), style: kw('text-decoration-style', 'solid'), fs }))) : inherits
  return cs
}

function computeTree(el, parentCS, ctx) {
  const { own, vars } = cascadeElement(el, parentCS && parentCS, ctx.idx, null)
  el.own = own
  el.cs = makeCS(el, own, vars, parentCS, ctx)
  for (const k of el.kids) computeTree(k, el.cs, ctx)
}

const fontState = { faces: null, byFamily: new Map(), loaded: new Map(), custom: [], fallback: null }

function readFontMeta(file) {
  let fd
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(12)
    if (readSync(fd, head, 0, 12, 0) < 12) return null
    const tag = head.readUInt32BE(0)
    if (tag !== 0x00010000 && tag !== 0x74727565) return null
    const n = head.readUInt16BE(4)
    if (n < 1 || n > 80) return null
    const dir = Buffer.alloc(n * 16)
    readSync(fd, dir, 0, dir.length, 12)
    const t = {}
    for (let i = 0; i < n; i++) t[dir.toString('latin1', i * 16, i * 16 + 4)] = { off: dir.readUInt32BE(i * 16 + 8), len: dir.readUInt32BE(i * 16 + 12) }
    if (!t.glyf || !t.name || !t.head || !t.cmap || !t.loca) return null
    const rd = (tb, max) => { const len = Math.min(tb.len, max); const b = Buffer.alloc(len); readSync(fd, b, 0, len, tb.off); return b }
    const name = rd(t.name, 65536)
    const cnt = name.readUInt16BE(2), so = name.readUInt16BE(4)
    const names = {}
    for (let i = 0; i < cnt; i++) {
      const r = 6 + i * 12
      if (r + 12 > name.length) break
      const pid = name.readUInt16BE(r), id = name.readUInt16BE(r + 6), len = name.readUInt16BE(r + 8), off = name.readUInt16BE(r + 10)
      if (![1, 2, 4, 16, 17].includes(id)) continue
      if (so + off + len > name.length) continue
      let s
      if (pid === 3 || pid === 0) { const b = Buffer.from(name.subarray(so + off, so + off + len)); for (let k = 0; k + 1 < b.length; k += 2) { const a = b[k]; b[k] = b[k + 1]; b[k + 1] = a } s = b.toString('utf16le') }
      else if (pid === 1) s = name.toString('latin1', so + off, so + off + len)
      else continue
      if (!names[id] || pid === 3) names[id] = s
    }
    const headT = rd(t.head, 54)
    const mac = headT.readUInt16BE(44)
    let weight = 400, italic = !!(mac & 2)
    if (t['OS/2']) {
      const os = rd(t['OS/2'], 64)
      weight = os.readUInt16BE(4)
      if (os.length >= 64) { const sel = os.readUInt16BE(62); if (sel & 1) italic = true }
    } else if (mac & 1) weight = 700
    if (!(weight >= 1 && weight <= 1000)) weight = 400
    const family = (names[16] || names[1] || '').trim()
    if (!family) return null
    const sub = (names[17] || names[2] || '').toLowerCase()
    if (/italic|oblique/.test(sub)) italic = true
    return { path: file, family, weight, italic, variable: !!t.fvar }
  } catch { return null } finally { if (fd !== undefined) try { closeSync(fd) } catch {} }
}

function fontDirs() {
  const dirs = []
  const env = process.env.HTML_FONT_DIRS || process.env.FONT_DIRS
  if (env) dirs.push(...env.split(nodePath.delimiter).filter(Boolean))
  const home = process.env.HOME || process.env.USERPROFILE || ''
  dirs.push('/usr/share/fonts', '/usr/local/share/fonts', '/usr/share/texmf/fonts/truetype', '/usr/X11R6/lib/X11/fonts', '/system/fonts', '/data/data/com.termux/files/usr/share/fonts', '/Library/Fonts', '/System/Library/Fonts/Supplemental')
  if (home) dirs.push(nodePath.join(home, '.fonts'), nodePath.join(home, '.local/share/fonts'), nodePath.join(home, 'Library/Fonts'))
  if (process.env.WINDIR) dirs.push(nodePath.join(process.env.WINDIR, 'Fonts'))
  const here = nodePath.dirname(fileURLToPath(import.meta.url))
  dirs.push(nodePath.join(here, '../../data'), nodePath.join(here, '../../fonts'), nodePath.join(process.cwd(), 'data'), nodePath.join(process.cwd(), 'fonts'), nodePath.join(here, 'fonts'))
  return dirs
}

function scanFonts() {
  if (fontState.faces) return fontState.faces
  const faces = [], seen = new Set()
  let budget = 6000
  const visit = (dir, depth) => {
    let ents
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      if (budget <= 0) return
      const full = nodePath.join(dir, e.name)
      if (e.isDirectory()) { if (depth < 5) visit(full, depth + 1); continue }
      if (!/\.(ttf|otf)$/i.test(e.name)) continue
      let real = full
      try { real = realpathSync(full) } catch {}
      if (seen.has(real)) continue
      seen.add(real)
      budget--
      const m = readFontMeta(real)
      if (m) faces.push(m)
    }
  }
  for (const d of fontDirs()) visit(d, 0)
  fontState.faces = faces
  fontState.byFamily = new Map()
  for (const f of faces) {
    const k = f.family.toLowerCase()
    const a = fontState.byFamily.get(k)
    if (a) a.push(f); else fontState.byFamily.set(k, [f])
  }
  return faces
}

let fontSeq = 0

function loadFace(meta) {
  if (meta.ttf !== undefined) return meta.ttf
  try { meta.ttf = new TTFont(meta.buf || readFileSync(meta.path)); meta.ttf._id = ++fontSeq } catch { meta.ttf = null }
  return meta.ttf
}

const GENERIC = {
  'sans-serif': ['liberation sans', 'arimo', 'arial', 'helvetica', 'noto sans', 'open sans', 'roboto', 'inter', 'dejavu sans', 'freesans', 'carlito'],
  serif: ['liberation serif', 'tinos', 'times new roman', 'noto serif', 'dejavu serif', 'freeserif', 'lora', 'georgia'],
  monospace: ['liberation mono', 'cousine', 'dejavu sans mono', 'noto sans mono', 'courier new', 'freemono', 'roboto mono'],
  cursive: ['comic neue', 'comic sans ms', 'dejavu sans'],
  fantasy: ['dejavu sans'],
  'system-ui': ['inter', 'noto sans', 'roboto', 'liberation sans', 'dejavu sans', 'arial'],
  'ui-sans-serif': ['inter', 'noto sans', 'roboto', 'liberation sans', 'dejavu sans', 'arial'],
  'ui-serif': ['liberation serif', 'dejavu serif'],
  'ui-monospace': ['liberation mono', 'dejavu sans mono'],
  '-apple-system': ['inter', 'noto sans', 'roboto', 'liberation sans', 'dejavu sans', 'arial'],
  blinkmacsystemfont: ['inter', 'noto sans', 'roboto', 'liberation sans', 'dejavu sans', 'arial'],
  'segoe ui': ['inter', 'noto sans', 'open sans', 'roboto', 'liberation sans', 'dejavu sans', 'arial'],
  'helvetica neue': ['liberation sans', 'arimo', 'arial', 'helvetica', 'inter', 'dejavu sans'],
  helvetica: ['liberation sans', 'arimo', 'arial', 'inter', 'dejavu sans'],
  arial: ['arial', 'liberation sans', 'arimo', 'helvetica', 'dejavu sans'],
  verdana: ['dejavu sans', 'verdana', 'liberation sans'],
  tahoma: ['dejavu sans', 'liberation sans'],
  georgia: ['georgia', 'liberation serif', 'dejavu serif'],
  'times new roman': ['liberation serif', 'tinos', 'times new roman', 'dejavu serif'],
  times: ['liberation serif', 'tinos', 'dejavu serif'],
  'courier new': ['liberation mono', 'cousine', 'dejavu sans mono'],
  courier: ['liberation mono', 'cousine', 'dejavu sans mono'],
  menlo: ['dejavu sans mono', 'liberation mono'], monaco: ['dejavu sans mono', 'liberation mono'], consolas: ['dejavu sans mono', 'liberation mono'],
  'sf mono': ['dejavu sans mono', 'liberation mono'], 'fira code': ['dejavu sans mono', 'liberation mono'], 'jetbrains mono': ['dejavu sans mono', 'liberation mono'],
  'sf pro display': ['inter', 'noto sans', 'liberation sans', 'dejavu sans'], 'sf pro text': ['inter', 'noto sans', 'liberation sans', 'dejavu sans'],
  emoji: [], math: ['dejavu sans']
}
const FALLBACK_FAMS = ['dejavu sans', 'noto sans symbols', 'noto sans symbols2', 'freesans', 'noto sans', 'liberation sans', 'arial', 'unifont']

function pickFace(famKey, weight, italic) {
  const arr = fontState.byFamily.get(famKey)
  if (!arr) return null
  let best = null, bs = Infinity
  for (const f of arr) {
    const s = Math.abs(f.weight - weight) + (f.italic !== italic ? 600 : 0)
    if (s < bs) { bs = s; best = f }
  }
  return best
}

function familyFaces(name, weight, italic, out) {
  scanFonts()
  const keys = [name]
  const g = GENERIC[name]
  if (g) keys.push(...g)
  for (const k of keys) {
    const f = pickFace(k, weight, italic)
    if (f && !out.includes(f)) out.push(f)
    if (f && k === name && !g) break
  }
}

function resolveChain(cs) {
  const key = cs.fontFamily.join('|') + '#' + cs.fontWeight + '#' + cs.fontStyle
  let c = fontState.loaded.get(key)
  if (c) return c
  scanFonts()
  const italic = cs.fontStyle === 'italic'
  const faces = []
  for (const c of fontState.custom) {
    if (cs.fontFamily.includes(c.family)) {
      let best = null, bs = Infinity
      for (const f of fontState.custom) if (f.family === c.family) { const s = Math.abs(f.weight - cs.fontWeight) + (f.italic !== italic ? 600 : 0); if (s < bs) { bs = s; best = f } }
      if (best && !faces.includes(best)) faces.push(best)
    }
  }
  for (const fam of cs.fontFamily) {
    if (fontState.custom.some(f => f.family === fam)) continue
    familyFaces(fam, cs.fontWeight, italic, faces)
  }
  if (!cs.fontFamily.some(f => GENERIC[f] && /serif|sans|mono|system|arial|helvet|times|courier/.test(f))) familyFaces('sans-serif', cs.fontWeight, italic, faces)
  if (!faces.length) { for (const f of fontState.faces) { faces.push(pickFace(f.family.toLowerCase(), cs.fontWeight, italic) || f); break } }
  if (!faces.length) faces.push(builtinMeta(cs.fontWeight >= 600))
  c = faces
  fontState.loaded.set(key, c)
  return c
}

function fallbackChain() {
  if (fontState.fallback) return fontState.fallback
  scanFonts()
  const out = []
  for (const k of FALLBACK_FAMS) { const f = pickFace(k, 400, false); if (f && !out.includes(f)) out.push(f) }
  fontState.fallback = out
  return out
}

const EMOJI_RE = /[\u{1F000}-\u{1FFFF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{200D}\u{E0000}-\u{E007F}]/u

function pickGlyph(chain, cp) {
  for (const m of chain) {
    const t = loadFace(m)
    if (!t) continue
    const g = t.glyphIndex(cp)
    if (g) return { m, t, g }
  }
  const fb = fallbackChain()
  for (const m of fb) {
    const t = loadFace(m)
    if (!t) continue
    const g = t.glyphIndex(cp)
    if (g) return { m, t, g }
  }
  const bm = builtinMeta(false), bg = bm.ttf.glyphIndex(cp)
  if (bg) return { m: bm, t: bm.ttf, g: bg }
  return null
}

const fontInfoCache = new Map()
function fontInfo(cs) {
  const key = cs.fontFamily.join('|') + '#' + cs.fontWeight + '#' + cs.fontStyle + '#' + cs.fontSize + '#' + cs.letterSpacing
  let fi = fontInfoCache.get(key)
  if (fi) return fi
  const chain = resolveChain(cs)
  const primary = chain.length ? loadFace(chain[0]) : null
  const size = cs.fontSize
  const upem = primary ? primary.unitsPerEm : 1000
  const asc = primary ? primary.ascent / upem * size : size * 0.9
  const desc = primary ? -primary.descent / upem * size : size * 0.2
  const gap = primary ? primary.lineGap / upem * size : 0
  const m0 = chain[0]
  const synthBold = cs.fontWeight >= 600 && (!m0 || m0.weight < cs.fontWeight - 150) && !(m0 && m0.variable && false)
  const synthItalic = cs.fontStyle === 'italic' && (!m0 || !m0.italic)
  let xh = size * 0.5
  if (primary) { const g = primary.glyphIndex(120); if (g) { const o = primary.outline(g); let mx = 0; for (const c of o) for (const p of c) if (p.y > mx) mx = p.y; if (mx) xh = mx / upem * size } }
  fi = { chain, size, asc, desc, gap, ls: cs.letterSpacing, synthBold, synthItalic, cache: new Map(), glyphCache: new Map(), xh, normalLH: asc + desc + gap, key }
  fontInfoCache.set(key, fi)
  return fi
}

function glyphRun(fi, text, ws) {
  const out = []
  let pen = 0, prevT = null, prevG = 0
  const size = fi.size
  for (const ch of text) {
    const cp = ch.codePointAt(0)
    if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200b || cp === 0x200c || cp === 0xad || (cp >= 0xe0000 && cp <= 0xe007f)) continue
    let gl = fi.glyphCache.get(cp)
    if (gl === undefined) { gl = pickGlyph(fi.chain, cp) || null; fi.glyphCache.set(cp, gl) }
    if (!gl) {
      const adv = EMOJI_RE.test(ch) ? size * 1.1 : size * 0.55
      out.push({ t: null, g: 0, x: pen, adv, cp })
      pen += adv + fi.ls
      prevT = null; prevG = 0
      continue
    }
    const sc = size / gl.t.unitsPerEm
    if (prevT === gl.t && prevG) pen += gl.t.kerning(prevG, gl.g) * sc
    const adv = gl.t.advance[gl.g] * sc
    out.push({ t: gl.t, g: gl.g, x: pen, adv, cp, sc })
    pen += adv + fi.ls
    prevT = gl.t; prevG = gl.g
  }
  return { glyphs: out, width: pen }
}

function measureText(fi, text) {
  let w = fi.cache.get(text)
  if (w !== undefined) return w
  w = glyphRun(fi, text).width
  if (fi.cache.size > 5000) fi.cache.clear()
  fi.cache.set(text, w)
  return w
}

function glyphBase(fi, gl) {
  const k = gl.t._id + ':' + gl.g + ':' + fi.size
  let c = gl.t._pc && gl.t._pc.get(k)
  if (c) return c
  if (!gl.t._pc) gl.t._pc = new Map()
  c = gl.t.glyphPolys(gl.g, gl.sc, 0, 0)
  gl.t._pc.set(k, c)
  return c
}

function transformText(s, cs, prevChar) {
  switch (cs.textTransform) {
    case 'uppercase': return s.toUpperCase()
    case 'lowercase': return s.toLowerCase()
    case 'capitalize': return s.replace(/(^|[\s\-("'“‘\[{])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())
  }
  return s
}

class Box {
  constructor(level, type, el, cs) {
    this.level = level; this.type = type; this.el = el; this.cs = cs
    this.children = []; this.parent = null
    this.rx = 0; this.ry = 0; this.w = 0; this.h = 0
    this.pad = [0, 0, 0, 0]; this.bor = [0, 0, 0, 0]; this.mar = [0, 0, 0, 0]
    this.ax = 0; this.ay = 0
    this.floatSide = 'none'; this.oof = false
  }
  get atomic() { return this.level === 'inline' && this.type !== 'inline' && this.type !== 'text' && this.type !== 'br' && this.type !== 'wbr' }
}

const REPLACED_TAGS = new Set(['img', 'video', 'canvas', 'iframe', 'embed', 'object', 'audio', 'select', 'textarea', 'progress', 'meter'])

function anonCS(ctx, parentCS, display = 'block') {
  const fake = { type: 1, tag: '#anon', attrs: {}, children: [], kids: [], parent: null, anon: true }
  const cs = makeCS(fake, { display }, parentCS.vars, parentCS, ctx)
  fake.cs = cs
  return cs
}

function isBlankText(b) {
  if (b.type !== 'text') return false
  const ws = b.cs.whiteSpace
  if (ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces') return b.text.length === 0
  return !/\S/.test(b.text.replace(/ /g, 'x'))
}

function fmtCounter(n, style) {
  style = (style || 'decimal').toLowerCase()
  const alpha = (v, base) => { let s = ''; if (v <= 0) return String(v); while (v > 0) { v--; s = String.fromCharCode(base + (v % 26)) + s; v = Math.floor(v / 26) } return s }
  const roman = v => { if (v <= 0 || v >= 4000) return String(v); const t = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']]; let s = ''; for (const [k, r] of t) while (v >= k) { s += r; v -= k } return s }
  switch (style) {
    case 'none': return ''
    case 'decimal-leading-zero': return (n < 10 && n >= 0 ? '0' : '') + n
    case 'lower-alpha': case 'lower-latin': return alpha(n, 97)
    case 'upper-alpha': case 'upper-latin': return alpha(n, 65)
    case 'lower-roman': return roman(n)
    case 'upper-roman': return roman(n).toUpperCase()
    case 'lower-greek': return n >= 1 && n <= 24 ? String.fromCharCode(0x3b1 + n - 1 + (n > 17 ? 1 : 0)) : String(n)
    case 'disc': return '•'
    case 'circle': return '◦'
    case 'square': return '▪'
    default: return String(n)
  }
}

function parseCounterList(v, def) {
  const out = []
  if (!v || /^none$/i.test(v.trim())) return out
  const t = tokens(v)
  for (let i = 0; i < t.length; i++) {
    const name = t[i]
    if (/^[+-]?\d+$/.test(name)) continue
    let val = def
    if (t[i + 1] !== undefined && /^[+-]?\d+$/.test(t[i + 1])) { val = parseInt(t[i + 1], 10); i++ }
    out.push([name, val])
  }
  return out
}

function applyCounters(ctx, el, cs) {
  const r = cs.raw
  if (!r['counter-reset'] && !r['counter-increment'] && !r['counter-set']) return
  const par = el.parent
  const scopeOf = () => par ? (par.__scope || (par.__scope = [])) : []
  for (const [n, v] of parseCounterList(r['counter-reset'], 0)) {
    let st = ctx.counters.get(n)
    if (!st) { st = []; ctx.counters.set(n, st) }
    st.push(v)
    scopeOf().push(n)
  }
  for (const [n, v] of parseCounterList(r['counter-set'], 0)) {
    let st = ctx.counters.get(n)
    if (!st) { st = [0]; ctx.counters.set(n, st); scopeOf().push(n) }
    st[st.length - 1] = v
  }
  for (const [n, v] of parseCounterList(r['counter-increment'], 1)) {
    let st = ctx.counters.get(n)
    if (!st) { st = [0]; ctx.counters.set(n, st); scopeOf().push(n) }
    st[st.length - 1] += v
  }
}

function pseudoNode(ctx, el, which) {
  const { own, vars } = cascadeElement(el, el.cs, ctx.idx, which)
  if (!own.content || typeof own.content !== 'string') return null
  const node = { type: 1, tag: '::' + which, attrs: {}, children: [], kids: [], parent: el, pseudo: true, svg: el.svg }
  node.cs = makeCS(node, own, vars, el.cs, ctx)
  const parts = parseContent(own.content, el, node.cs)
  if (!parts) return null
  let s = ''
  for (const p of parts) {
    if (p.s != null) s += p.s
    else if (p.counter) {
      const st = ctx.counters.get(p.counter) || [0]
      if (p.sep != null) s += st.map(v => fmtCounter(v, p.style)).join(p.sep)
      else s += fmtCounter(st[st.length - 1], p.style)
    }
  }
  if (s) node.children.push({ type: 3, text: s, parent: node })
  return node
}

function listMarker(ctx, el, cs) {
  const t = cs.listType
  if (t === 'none' && !cs.listImage) return null
  if (cs.listImage) { ctx.want(cs.listImage.replace(/^url\(\s*["']?|["']?\s*\)$/g, '')); return { kind: 'image', src: cs.listImage.replace(/^url\(\s*["']?|["']?\s*\)$/g, '') } }
  if (t === 'disc' || t === 'circle' || t === 'square') return { kind: t }
  if (/^["']/.test(t)) return { kind: 'text', text: t.replace(/^["']|["']$/g, '') }
  const par = el.parent
  if (par) {
    if (par.__li === undefined) {
      const a = par.attrs || {}
      const start = parseInt(a.start, 10)
      if ('reversed' in a) par.__li = (Number.isNaN(start) ? par.kids.filter(k => k.cs && k.cs.display === 'list-item').length : start) + 1
      else par.__li = (Number.isNaN(start) ? 1 : start) - 1
      par.__rev = 'reversed' in a
    }
    if (el.attrs.value && /^-?\d+$/.test(el.attrs.value)) par.__li = parseInt(el.attrs.value, 10) + (par.__rev ? 1 : -1)
    par.__li += par.__rev ? -1 : 1
    return { kind: 'text', text: fmtCounter(par.__li, t) + '. ' }
  }
  return { kind: 'text', text: '1. ' }
}

function makeBoxes(ctx, node, pb) {
  if (node.type === 3) {
    if (!node.text) return []
    const b = new Box('inline', 'text', null, pb.cs)
    b.text = node.text
    return [b]
  }
  const el = node, cs = el.cs
  if (!cs || cs.display === 'none') return []
  if (el.svg && el.tag !== 'svg') return []
  if (el.tag === 'br' && !el.pseudo) return [new Box('inline', 'br', el, cs)]
  if (el.tag === 'wbr') return [new Box('inline', 'wbr', el, cs)]
  let display = cs.display
  if (pb && (pb.type === 'flex' || pb.type === 'grid') && !cs.oof) display = blockify(display)
  applyCounters(ctx, el, cs)
  if (display === 'contents') {
    const out = buildChildren(ctx, el, pb)
    return out
  }
  let level = 'block', type = 'flow'
  switch (display) {
    case 'inline': level = 'inline'; type = 'inline'; break
    case 'inline-block': level = 'inline'; type = 'flow'; break
    case 'flex': type = 'flex'; break
    case 'inline-flex': level = 'inline'; type = 'flex'; break
    case 'grid': type = 'grid'; break
    case 'inline-grid': level = 'inline'; type = 'grid'; break
    case 'table': type = 'table'; break
    case 'inline-table': level = 'inline'; type = 'table'; break
  }
  const replaced = !el.pseudo && (REPLACED_TAGS.has(el.tag) || (el.tag === 'svg' && !(el.parent && el.parent.svg)) || (el.tag === 'input' && el.attrs.type !== 'hidden'))
  const box = new Box(level, replaced ? 'replaced' : type, el, cs)
  box.display = display
  box.oof = cs.oof
  box.floatSide = cs.floatSide
  const isCB = cs.position !== 'static' || cs.transform.length > 0 || !!cs.filter
  const anc = box.oof && cs.position === 'fixed' ? ctx.rootBox : pb.posAnc || ctx.rootBox
  if (box.oof) { box.cbBox = anc; anc.absList.push(box) }
  if (isCB) { box.absList = []; box.posAnc = box } else box.posAnc = pb.posAnc || ctx.rootBox
  if (cs.display === 'list-item' || display === 'list-item') box.marker = listMarker(ctx, el, cs)
  if (replaced) {
    box.rep = makeReplaced(ctx, el, cs, box)
    if (box.rep.kind === 'img' && box.rep.failed && el.attrs.alt && !(cs.width !== 'auto' || cs.height !== 'auto')) {
      box.type = 'inline'; box.level = 'inline'; box.rep = null
      const t = new Box('inline', 'text', null, cs); t.text = el.attrs.alt; box.children.push(t); t.parent = box
    }
    if (box.rep) { finishCounters(el); return [box] }
  } else {
    for (const c of buildChildren(ctx, el, box)) { box.children.push(c); c.parent = box }
    if (box.marker && cs.listPos === 'inside' && box.type === 'flow') {
      const m = new Box('inline', 'replaced', null, cs)
      m.rep = { kind: 'marker', marker: box.marker }
      m.posAnc = box.posAnc
      if (box.marker.kind === 'text') { const t = new Box('inline', 'text', null, cs); t.text = box.marker.text; box.children.unshift(t); t.parent = box }
      else { box.children.unshift(m); m.parent = box }
      box.marker = null
    }
    if (display.startsWith('table-') && display !== 'table-caption') box.tableRole = display
    if (display === 'table-caption') box.tableRole = display
    if (display === 'table-cell') box.tableRole = display
    finalizeBox(ctx, box)
  }
  finishCounters(el)
  return [box]
}

function finishCounters(el) {
  if (el.__scope) {
    for (const n of el.__scope) { const st = ctxCounters.get(n); if (st) st.pop() }
    el.__scope = null
  }
}
let ctxCounters = new Map()

function buildChildren(ctx, el, pb) {
  const out = []
  ctxCounters = ctx.counters
  const addAll = arr => { for (const b of arr) out.push(b) }
  if (!el.pseudo) {
    const bf = pseudoNode(ctx, el, 'before')
    if (bf) addAll(makeBoxes(ctx, bf, pb))
  }
  for (const c of el.children) {
    if (c.type === 1 && !c.cs) continue
    addAll(makeBoxes(ctx, c, pb))
  }
  if (!el.pseudo) {
    const af = pseudoNode(ctx, el, 'after')
    if (af) addAll(makeBoxes(ctx, af, pb))
  }
  finishCounters(el)
  return out
}

function finalizeBox(ctx, box) {
  if (box.type === 'inline') {
    if (box.children.some(c => c.level === 'block' && !c.oof && c.floatSide === 'none' || (c.level === 'block' && !c.oof && c.type === 'flow'))) { box.level = 'block'; box.type = 'flow' }
    else return
  }
  if (box.type === 'flow') {
    if (box.tableRole === 'table-cell' || box.tableRole === 'table-row' || box.tableRole === 'table-row-group' || box.tableRole === 'table-header-group' || box.tableRole === 'table-footer-group') {
      if (box.tableRole !== 'table-cell') return
    }
    const hasBlock = box.children.some(c => c.level === 'block' && !c.oof)
    if (!hasBlock) { box.ifc = true; return }
    const out = []
    let run = []
    const flush = () => {
      if (!run.length) return
      const meaningful = run.some(b => !isBlankText(b) && !(b.oof))
      if (meaningful) {
        const a = new Box('block', 'flow', null, anonCS(ctx, box.cs))
        a.ifc = true; a.anon = true; a.posAnc = box.posAnc
        a.children = run
        for (const r of run) r.parent = a
        a.parent = box
        out.push(a)
      } else for (const b of run) if (b.oof) { out.push(b) }
      run = []
    }
    for (const c of box.children) {
      if (c.level === 'block' && !c.oof) { flush(); out.push(c) } else run.push(c)
    }
    flush()
    box.children = out
    return
  }
  if (box.type === 'flex' || box.type === 'grid') {
    const out = []
    let run = []
    const flush = () => {
      if (!run.length) return
      if (run.some(b => !isBlankText(b))) {
        const a = new Box('block', 'flow', null, anonCS(ctx, box.cs))
        a.ifc = true; a.anon = true; a.posAnc = box.posAnc
        a.children = run
        for (const r of run) r.parent = a
        a.parent = box
        out.push(a)
      }
      run = []
    }
    for (const c of box.children) {
      if (c.type === 'text') run.push(c)
      else { flush(); out.push(c) }
    }
    flush()
    box.children = out
  }
}

function makeReplaced(ctx, el, cs, box) {
  const a = el.attrs
  switch (el.tag) {
    case 'img': {
      let src = (a.src || '').trim()
      if (!src && a.srcset) src = a.srcset.split(',')[0].trim().split(/\s+/)[0]
      if (!src && a['data-src']) src = a['data-src']
      const url = ctx.want(src)
      return { kind: 'img', src: url, failed: !url }
    }
    case 'svg': return { kind: 'svg' }
    case 'input': {
      const type = (a.type || 'text').toLowerCase()
      if (type === 'image' && a.src) { const url = ctx.want(a.src); return { kind: 'img', src: url, failed: !url } }
      return { kind: 'input', type, value: a.value || '', placeholder: a.placeholder || '', checked: 'checked' in a, size: parseInt(a.size, 10) || 20 }
    }
    case 'textarea': return { kind: 'textarea', value: textOf(el).replace(/^\n/, ''), placeholder: a.placeholder || '', rows: parseInt(a.rows, 10) || 2, cols: parseInt(a.cols, 10) || 20 }
    case 'select': {
      const opts = []
      walk(el, n => { if (n.type === 1 && n.tag === 'option') opts.push({ text: textOf(n).trim(), selected: 'selected' in n.attrs }) })
      const sel = opts.find(o => o.selected) || opts[0]
      return { kind: 'select', text: sel ? sel.text : '', multiple: 'multiple' in a }
    }
    case 'progress': return { kind: 'progress', value: parseFloat(a.value), max: parseFloat(a.max) || 1 }
    case 'meter': return { kind: 'meter', value: parseFloat(a.value) || 0, min: parseFloat(a.min) || 0, max: parseFloat(a.max) || 1 }
    default: return { kind: 'media', tag: el.tag }
  }
}

let C = null

function res(v, basis) {
  if (v == null || v === 'auto') return null
  const x = typeof v === 'function' ? v(basis) : v
  return x === x && isFinite(x) ? x : null
}

function resolveEdges(box, cbw) {
  const cs = box.cs
  const base = cbw === cbw && isFinite(cbw) ? cbw : 0
  const r = v => { if (v === 'auto') return 0; const x = typeof v === 'function' ? v(base) : v; return x === x ? x : 0 }
  box.pad = cs.padding.map(v => Math.max(0, r(v)))
  box.bor = cs.bw
  box.mar = cs.margin.map(r)
  box.mauto = cs.margin.map(v => v === 'auto')
}

function clampSize(x, min, max) {
  if (max != null && x > max) x = max
  if (min != null && x < min) x = min
  return x
}

function lhPx(cs, fi) {
  if (!cs.lineHeight) return fi.normalLH
  if (cs.lineHeight.mul !== undefined) return cs.lineHeight.mul * cs.fontSize
  return cs.lineHeight.px
}

function isBFC(box) {
  const cs = box.cs
  return box === C.rootBox || box.oof || box.floatSide !== 'none' || box.level === 'inline' || cs.clips || box.tableRole === 'table-cell' || box.type === 'flex' || box.type === 'grid' || box.type === 'table' || box.display === 'flow-root' || (box.parent && (box.parent.type === 'flex' || box.parent.type === 'grid')) || box.type === 'replaced'
}

const CJK_RE = /[⺀-鿿豈-﫿＀-￯가-힯぀-ヿ]/

function collectItems(root, mode, W) {
  const items = []
  let prevSpace = true
  const Wb = mode === 'layout' ? W : 0
  const edge = (b, side) => {
    const cs = b.cs, ix = side === 'l' ? 3 : 1
    const rr = v => { if (v === 'auto') return 0; const x = typeof v === 'function' ? v(Wb) : v; return x === x ? x : 0 }
    const m = rr(cs.margin[ix])
    return { m, t: m + Math.max(0, rr(cs.padding[ix])) + cs.bw[ix] }
  }
  const pushText = c => {
    const cs = c.cs, fi = fontInfo(cs), ws = cs.whiteSpace
    const preserve = ws === 'pre' || ws === 'pre-wrap' || ws === 'break-spaces'
    const keepNl = preserve || ws === 'pre-line'
    const nowrap = ws === 'nowrap' || ws === 'pre'
    let s = transformText(c.text, cs)
    const segs = keepNl ? s.split(/\r\n|\r|\n/) : [s.replace(/[\r\n]+/g, ' ')]
    const spaceW = measureText(fi, ' ') + cs.wordSpacing
    segs.forEach((seg, si) => {
      if (si > 0) { items.push({ t: 'br', box: c, cs }); prevSpace = true }
      const re = /([ \t\f]+)|([^ \t\f]+)/g
      let m
      while ((m = re.exec(seg))) {
        if (m[1] !== undefined) {
          if (preserve) {
            let n = 0
            for (const ch of m[1]) n += ch === '\t' ? 8 : 1
            items.push({ t: 'space', w: spaceW * n, fi, cs, box: c, str: ' '.repeat(n), hard: true, nb: nowrap })
            prevSpace = false
          } else if (!prevSpace) {
            items.push({ t: 'space', w: spaceW, fi, cs, box: c, str: ' ', nb: nowrap })
            prevSpace = true
          }
        } else {
          const word = m[2]
          const pieces = []
          if (cs.wordBreak === 'break-all' || CJK_RE.test(word)) {
            let cur = ''
            for (const ch of word) {
              if (cs.wordBreak === 'break-all' || CJK_RE.test(ch)) { if (cur) pieces.push(cur); cur = ch; pieces.push(cur); cur = '' }
              else cur += ch
            }
            if (cur) pieces.push(cur)
          } else if (word.indexOf('-') > 0 && word.indexOf('-') < word.length - 1 && /[A-Za-z0-9]-[A-Za-z0-9]/.test(word)) {
            let last = 0
            const hre = /([A-Za-z0-9])-(?=[A-Za-z0-9])/g
            let hm
            while ((hm = hre.exec(word))) { pieces.push(word.slice(last, hm.index + 2)); last = hm.index + 2 }
            if (last < word.length) pieces.push(word.slice(last))
          } else pieces.push(word)
          pieces.forEach((p, pi) => {
            items.push({ t: 'text', str: p, w: measureText(fi, p), fi, cs, box: c, soft: pi > 0 && !nowrap, nb: nowrap })
          })
          prevSpace = false
        }
      }
    })
  }
  const walkBox = b => {
    for (const c of b.children) {
      if (c.type === 'text') { pushText(c); continue }
      if (c.type === 'br') { items.push({ t: 'br', box: c, cs: c.cs }); prevSpace = true; continue }
      if (c.type === 'wbr') { items.push({ t: 'wbr' }); continue }
      if (c.oof) { items.push({ t: 'oof', box: c }); continue }
      if (c.floatSide !== 'none') { items.push({ t: 'float', box: c }); continue }
      if (c.type === 'inline') {
        const el = edge(c, 'l'), er = edge(c, 'r')
        items.push({ t: 'open', box: c, el: el.t, ml: el.m })
        walkBox(c)
        items.push({ t: 'close', box: c, er: er.t, mr: er.m })
        continue
      }
      let w
      if (mode === 'layout') {
        layoutAtom(c, W)
        w = c.w + c.mar[1] + c.mar[3]
      } else {
        resolveEdges(c, 0)
        w = intrinsicW(c, mode) + c.mar[1] + c.mar[3]
      }
      items.push({ t: 'atom', box: c, w, cs: c.cs })
      prevSpace = false
    }
  }
  walkBox(root)
  return items
}

function itemWidth(it) {
  switch (it.t) {
    case 'text': case 'space': case 'atom': return it.w
    case 'open': return it.el
    case 'close': return it.er
  }
  return 0
}

function makeBreaker(items) {
  let i = 0
  return {
    done: () => i >= items.length,
    peek: () => items[i],
    skip: () => { i++ },
    next(W, indent) {
      const line = { items: [], hasContent: false, br: false, floats: [], indent }
      let x = indent
      let wbr = false
      while (i < items.length) {
        const it = items[i]
        if (it.t === 'br') { line.items.push(it); i++; line.br = true; break }
        if (it.t === 'float') { line.floats.push(it); i++; continue }
        if (it.t === 'wbr') { wbr = true; i++; continue }
        if (it.t === 'open') { x += it.el; line.items.push(it); i++; continue }
        if (it.t === 'close') { x += it.er; line.items.push(it); i++; continue }
        if (it.t === 'oof') { line.items.push(it); i++; continue }
        if (it.t === 'space') {
          if (!line.hasContent && !it.hard) { i++; continue }
          x += it.w; line.items.push(it); i++; continue
        }
        let prev = null
        for (let k = line.items.length - 1; k >= 0; k--) { const t = line.items[k].t; if (t === 'text' || t === 'space' || t === 'atom') { prev = line.items[k]; break } }
        const nowrap = it.nb || (it.t === 'atom' && (it.cs.whiteSpace === 'nowrap' || it.cs.whiteSpace === 'pre'))
        let canBreak = false
        if (line.hasContent && !nowrap) canBreak = wbr || it.soft || it.t === 'atom' || (prev && (prev.t === 'atom' || (prev.t === 'space' && !prev.nb)))
        if (line.hasContent && prev && prev.t === 'space' && prev.nb) canBreak = false
        if (canBreak && x + it.w > W + 0.01) break
        if (!line.hasContent && it.t === 'text' && it.w > W + 0.01 && W > 0 && !nowrap && (it.cs.overflowWrap === 'anywhere' || it.cs.overflowWrap === 'break-word')) {
          const chars = Array.from(it.str)
          let acc = '', k = 0
          for (; k < chars.length; k++) { const t2 = acc + chars[k]; if (measureText(it.fi, t2) > W - x && acc) break; acc = t2 }
          if (k < chars.length) {
            const rest = chars.slice(k).join('')
            items.splice(i, 1, { ...it, str: acc, w: measureText(it.fi, acc) }, { ...it, str: rest, w: measureText(it.fi, rest), soft: true })
            continue
          }
        }
        wbr = false
        x += it.w
        line.items.push(it)
        line.hasContent = true
        i++
      }
      for (let k = line.items.length - 1; k >= 0; k--) {
        const t = line.items[k].t
        if (t === 'space' && !line.items[k].hard) { line.items.splice(k, 1); continue }
        if (t === 'text' || t === 'atom' || t === 'space') break
      }
      return line
    }
  }
}

function lineContentWidth(line) {
  let w = 0
  for (const it of line.items) w += itemWidth(it)
  return w
}

function inlineIntrinsic(box, mode) {
  const items = collectItems(box, mode, 0)
  const br = makeBreaker(items)
  let best = 0
  const cs = box.cs
  const W = mode === 'max' ? Infinity : 0
  let guard = 0
  while (!br.done() && guard++ < 100000) {
    const ln = br.next(W, 0)
    if (ln.floats.length) for (const f of ln.floats) { resolveEdges(f.box, 0); best = Math.max(best, intrinsicW(f.box, mode) + f.box.mar[1] + f.box.mar[3]) }
    const w = lineContentWidth(ln)
    if (w > best) best = w
    if (!ln.items.length && !ln.floats.length && br.done()) break
  }
  if (mode === 'max' && cs.textIndent && typeof cs.textIndent === 'number') best += cs.textIndent
  return best
}

function cpair(a, b) {
  const p = Math.max(a > 0 ? a : 0, b && b.p > 0 ? b.p : 0), n = Math.min(a < 0 ? a : 0, b && b.n < 0 ? b.n : 0)
  return p + n
}

function svgIntrinsic(el) {
  const a = el.attrs
  const num = v => { if (v == null) return null; const m = /^\s*([\d.]+)\s*(px)?\s*$/.exec(v); return m ? parseFloat(m[1]) : null }
  let w = num(a.width), h = num(a.height)
  let vb = null
  if (a.viewbox) { const p = a.viewbox.trim().split(/[\s,]+/).map(Number); if (p.length === 4 && p[2] > 0 && p[3] > 0) vb = p }
  let ratio = vb ? vb[2] / vb[3] : (w && h ? w / h : 0)
  if (w == null && h == null) { if (vb) { w = vb[2]; h = vb[3] } else { w = 300; h = 150 } }
  else if (w == null) w = ratio ? h * ratio : 300
  else if (h == null) h = ratio ? w / ratio : 150
  return { w, h, ratio: ratio || (w && h ? w / h : 0), vb }
}

function replacedSize(box) {
  const rep = box.rep, cs = box.cs
  switch (rep.kind) {
    case 'img': { const im = C.images.get(rep.src); if (im && im.w > 0 && im.h > 0) return { w: im.w, h: im.h, ratio: im.w / im.h }; return { w: 0, h: 0, ratio: 0 } }
    case 'svg': { const s = svgIntrinsic(box.el); return { w: s.w, h: s.h, ratio: s.ratio } }
    case 'marker': return { w: cs.fontSize * 1.1, h: cs.fontSize * 0.7, ratio: 0 }
    case 'input': {
      const fi = fontInfo(cs), t = rep.type
      if (t === 'checkbox' || t === 'radio') return { w: 13, h: 13, ratio: 1 }
      if (t === 'range') return { w: 129, h: 16, ratio: 0 }
      if (t === 'color') return { w: 50, h: 27, ratio: 0 }
      if (t === 'file') return { w: 235, h: Math.max(21, fi.normalLH), ratio: 0 }
      if (t === 'submit' || t === 'button' || t === 'reset') { const v = rep.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''); return { w: measureText(fi, v), h: fi.normalLH, ratio: 0 } }
      return { w: rep.size * cs.fontSize * 0.575, h: fi.normalLH, ratio: 0 }
    }
    case 'textarea': { const fi = fontInfo(cs); return { w: rep.cols * cs.fontSize * 0.6, h: rep.rows * fi.normalLH, ratio: 0 } }
    case 'select': { const fi = fontInfo(cs); return { w: measureText(fi, rep.text || 'W') + 22, h: fi.normalLH, ratio: 0 } }
    case 'progress': case 'meter': return { w: 160, h: 16, ratio: 0 }
    default: {
      const a = box.el.attrs
      if (rep.tag === 'audio') return { w: 300, h: 54, ratio: 0 }
      return { w: parseFloat(a.width) || 300, h: parseFloat(a.height) || 150, ratio: 0 }
    }
  }
}

function intrinsicW(box, mode) {
  const key = mode === 'max' ? '_imax' : '_imin'
  if (box[key] !== undefined) return box[key]
  const cs = box.cs
  resolveEdges(box, 0)
  const edgeX = box.pad[1] + box.pad[3] + box.bor[1] + box.bor[3]
  const bsB = cs.boxSizing === 'border-box'
  let w
  const sw = typeof cs.width === 'function' ? null : res(cs.width, NaN)
  if (sw != null) w = bsB ? sw : sw + edgeX
  else {
    let cw = 0
    switch (box.type) {
      case 'replaced': {
        const nat = replacedSize(box)
        const sh = typeof cs.height === 'function' ? null : res(cs.height, NaN)
        cw = sh != null && nat.ratio ? (bsB ? sh - box.pad[0] - box.pad[2] - box.bor[0] - box.bor[2] : sh) * nat.ratio : nat.w
        break
      }
      case 'flow':
        if (box.ifc) cw = inlineIntrinsic(box, mode)
        else for (const c of box.children) {
          if (c.oof) continue
          resolveEdges(c, 0)
          cw = Math.max(cw, intrinsicW(c, mode) + c.mar[1] + c.mar[3])
        }
        break
      case 'flex': {
        const row = !/^column/.test(cs.flexDir)
        const kids = box.children.filter(c => !c.oof)
        const gap = row ? (res(cs.colGap, 0) || 0) : 0
        let sum = 0, mx = 0
        for (const c of kids) { resolveEdges(c, 0); const v = intrinsicW(c, mode) + c.mar[1] + c.mar[3]; sum += v; mx = Math.max(mx, v) }
        if (row) cw = (mode === 'max' || cs.flexWrap === 'nowrap') ? sum + gap * Math.max(0, kids.length - 1) : mx
        else cw = mx
        break
      }
      case 'grid': cw = gridIntrinsic(box, mode); break
      case 'table': cw = tableIntrinsic(box, mode); break
    }
    w = cw + edgeX
  }
  if (cs.maxW != null && typeof cs.maxW !== 'function') w = Math.min(w, bsB ? cs.maxW : cs.maxW + edgeX)
  if (typeof cs.minW === 'number') w = Math.max(w, bsB ? cs.minW : cs.minW + edgeX)
  w = Math.max(w, edgeX)
  box[key] = w
  return w
}

function layoutAtom(c, W) {
  resolveEdges(c, W)
  layoutBox(c, { cbw: W, cbh: NaN, shrink: true, availW: W - c.mar[1] - c.mar[3] })
}

function maxFloatBottom(bfc) {
  let m = -Infinity
  for (const f of bfc.floats) m = Math.max(m, f.y + f.h)
  return m
}

function floatAvail(bfc, y, h, x0, x1) {
  let l = x0, r = x1
  for (const f of bfc.floats) {
    if (f.y + f.h <= y || f.y >= y + Math.max(h, 0.01)) continue
    if (f.side === 'left') l = Math.max(l, f.x + f.w); else r = Math.min(r, f.x)
  }
  return { left: Math.max(0, l - x0), right: Math.max(0, x1 - r) }
}

function placeFloat(bfc, side, ow, oh, x0, x1, y) {
  y = Math.max(y, bfc.lastTop || 0)
  for (let g = 0; g < 2000; g++) {
    let l = x0, r = x1, nextY = Infinity
    for (const f of bfc.floats) {
      if (f.y + f.h <= y || f.y >= y + Math.max(oh, 0.01)) continue
      if (f.side === 'left') l = Math.max(l, f.x + f.w); else r = Math.min(r, f.x)
      nextY = Math.min(nextY, f.y + f.h)
    }
    if (r - l >= ow - 0.01 || nextY === Infinity) {
      const x = side === 'left' ? l : r - ow
      bfc.floats.push({ x, y, w: ow, h: oh, side })
      bfc.lastTop = y
      return { x, y }
    }
    y = nextY
  }
  return { x: x0, y }
}

function layoutFloatBox(box, c, cw, chDef, bfc, cox, coy, yProv) {
  resolveEdges(c, cw)
  layoutBox(c, { cbw: cw, cbh: chDef, shrink: true, availW: cw - c.mar[1] - c.mar[3] })
  const ow = c.w + c.mar[1] + c.mar[3], oh = c.h + c.mar[0] + c.mar[2]
  const pos = placeFloat(bfc, c.floatSide, ow, oh, cox, cox + cw, coy + yProv)
  c.rx = pos.x - cox + c.mar[3]
  c.ry = pos.y - coy + c.mar[0]
}

function layoutBox(box, o) {
  const cs = box.cs
  if (box.type === 'replaced') return layoutReplacedBox(box, o)
  const bfcRoot = isBFC(box)
  let key
  if (bfcRoot && box !== C.rootBox) {
    key = [o.w, o.h, o.cbw, o.cbh, o.shrink ? 1 : 0, o.availW].join('|')
    if (box._lk === key) return
  }
  resolveEdges(box, o.cbw)
  const [pt, pr, pb, pl] = box.pad, [bt, br, bb, bl] = box.bor
  const edgeX = pl + pr + bl + br, edgeY = pt + pb + bt + bb
  const bsB = cs.boxSizing === 'border-box'
  const cbw = o.cbw, finite = cbw === cbw && isFinite(cbw)
  const toBW = v => bsB ? v : v + edgeX
  const toBH = v => bsB ? v : v + edgeY
  const sw = res(cs.width, cbw)
  let W = o.w != null ? o.w : sw != null ? toBW(sw) : null
  if (W == null) {
    if (o.shrink || box.type === 'table') {
      const avail = o.availW != null ? o.availW : finite ? cbw - box.mar[1] - box.mar[3] : Infinity
      const mx = intrinsicW(box, 'max'), mn = intrinsicW(box, 'min')
      W = isFinite(avail) ? Math.min(Math.max(mn, avail), mx) : mx
    } else W = finite ? cbw - box.mar[1] - box.mar[3] : intrinsicW(box, 'max')
  }
  if (o.w == null) {
    const mnw = res(cs.minW, cbw), mxw = cs.maxW == null ? null : res(cs.maxW, cbw)
    W = clampSize(W, mnw != null ? toBW(mnw) : null, mxw != null ? toBW(mxw) : null)
  }
  W = Math.max(W, edgeX)
  const cw = Math.max(0, W - edgeX)
  const sh = res(cs.height, o.cbh)
  let H = o.h != null ? o.h : sh != null ? toBH(sh) : null
  if (H == null && cs.aspect) H = cw / cs.aspect + edgeY
  const mnh = res(cs.minH, o.cbh), mxh = cs.maxH == null ? null : res(cs.maxH, o.cbh)
  const clampH = h => clampSize(h, mnh ? toBH(mnh) : null, mxh != null ? toBH(mxh) : null)
  const autoH = H == null
  if (o.h == null && H != null) H = clampH(H)
  let chDef = H != null ? Math.max(0, H - edgeY) : NaN
  box.w = W; box.cw = cw
  const bfc = bfcRoot ? { floats: [], lastTop: 0 } : o.bfc
  const cox = bfcRoot ? 0 : (o.ox || 0) + bl + pl, coy = bfcRoot ? 0 : (o.oy || 0) + bt + pt
  const run = () => {
    switch (box.type) {
      case 'flex': return layoutFlex(box, cw, chDef)
      case 'grid': return layoutGrid(box, cw, chDef)
      case 'table': return layoutTable(box, cw, chDef)
      default: return layoutFlow(box, cw, chDef, bfc, cox, coy, bfcRoot, autoH && !(mnh > 0), pt + bt === 0, pb + bb === 0)
    }
  }
  let out = run()
  let ch = out.ch
  if (bfcRoot && bfc.floats.length) ch = Math.max(ch, maxFloatBottom(bfc) - coy)
  if (H == null) {
    H = ch + edgeY
    const H2 = clampH(H)
    if (H2 !== H) {
      H = H2
      if (box.type === 'flex' || box.type === 'grid') { chDef = Math.max(0, H - edgeY); out = run(); ch = Math.max(out.ch, chDef) }
    }
  }
  box.h = H
  box.ch = Math.max(0, H - edgeY)
  box.vshift = 0
  box.baseline = out.baseline != null ? bt + pt + out.baseline : null
  box.mtEff = cpair(box.mar[0], out.mtB)
  box.mbEff = cpair(box.mar[2], out.mbB)
  box.empty = !!out.empty && autoH && edgeY === 0 && !bfcRoot && !(mnh > 0)
  if (box.absList) for (const a of box.absList) layoutAbsSize(a, box)
  if (key !== undefined) box._lk = key
}

function layoutFlow(box, cw, chDef, bfc, cox, coy, bfcRoot, autoH, noTop, noBottom) {
  if (box.ifc) {
    const r = layoutInline(box, cw, bfc, cox, coy)
    return { ch: r.height, baseline: r.baseline, empty: r.height === 0 && !r.lines }
  }
  const cs = box.cs
  let cy = 0, started = false, accP = 0, accN = 0, bubTop = null, bubBot = null, baseline = null
  const topCollapse = noTop && !bfcRoot, botCollapse = noBottom && !bfcRoot && autoH
  const add = m => { if (m > 0) { if (m > accP) accP = m } else if (m < accN) accN = m }
  const total = () => accP + accN
  for (const c of box.children) {
    if (c.oof) { c.static = { x: 0, y: cy + total(), p: box }; continue }
    if (c.floatSide !== 'none') { layoutFloatBox(box, c, cw, chDef, bfc, cox, coy, cy + total()); continue }
    if (c.cs.clear !== 'none' && bfc.floats.length) {
      let fb = -Infinity
      for (const f of bfc.floats) if (c.cs.clear === 'both' || c.cs.clear === f.side) fb = Math.max(fb, f.y + f.h)
      if (fb > coy + cy + total()) { cy = fb - coy; accP = 0; accN = 0; started = true }
    }
    resolveEdges(c, cw)
    layoutBox(c, { cbw: cw, cbh: chDef, bfc, ox: cox + c.mar[3], oy: coy + cy + total() })
    add(c.mtEff)
    if (c.empty) { add(c.mbEff); c.ry = cy + total(); c.rx = c.mar[3]; continue }
    if (!started && topCollapse) { bubTop = { p: accP, n: accN }; accP = 0; accN = 0 }
    else { cy += total(); accP = 0; accN = 0 }
    started = true
    c.ry = cy
    let rx = c.mar[3]
    const free = cw - c.w - c.mar[1] - c.mar[3]
    if (free > 0) {
      if (c.mauto[3] && c.mauto[1]) rx = free / 2
      else if (c.mauto[3]) rx = free + c.mar[1] * 0
      else if (c.mauto[1]) rx = 0
    }
    c.rx = rx
    if (baseline == null && (c.baseline != null)) baseline = cy + c.baseline
    cy += c.h
    add(c.mbEff)
  }
  const empty = !started
  if (botCollapse && started) bubBot = { p: accP, n: accN }
  else if (!(empty && topCollapse && botCollapse)) { cy += total() }
  if (empty && topCollapse && botCollapse) { bubTop = { p: accP, n: accN }; bubBot = null }
  return { ch: cy, mtB: bubTop, mbB: bubBot, empty, baseline }
}

function vAlignShift(cs, fi) {
  const v = cs.verticalAlign
  switch (v) {
    case 'baseline': case 'top': case 'bottom': case 'text-top': case 'text-bottom': case 'middle': return 0
    case 'sub': return -fi.size * 0.2
    case 'super': return fi.size * 0.33
  }
  const r = parseLen(v, cs.E)
  if (typeof r === 'number') return r
  if (typeof r === 'function') return r(lhPx(cs, fi))
  return 0
}

function layoutInline(box, cw, bfc, cox, coy) {
  const cs = box.cs
  const items = collectItems(box, 'layout', cw)
  const fiRoot = fontInfo(cs)
  const rootLH = lhPx(cs, fiRoot)
  const rootL = rootLH - (fiRoot.asc + fiRoot.desc)
  const strutA = fiRoot.asc + rootL / 2, strutD = fiRoot.desc + rootL / 2
  const br = makeBreaker(items)
  const lines = []
  box.ifcBoxes = []
  box.ifcOof = []
  const stack = []
  let y = 0, first = true, guard = 0
  const indent = typeof cs.textIndent === 'function' ? cs.textIndent(cw) : cs.textIndent || 0
  const align = cs.textAlign
  const placeFloatItem = f => {
    if (!bfc) { layoutAtom(f.box, cw); f.box.rx = 0; f.box.ry = y; box.ifcBoxes.push(f.box); return }
    layoutFloatBox(box, f.box, cw, NaN, bfc, cox, coy, y)
    box.ifcBoxes.push(f.box)
  }
  let lastBaseline = null
  while (!br.done() && guard++ < 200000) {
    while (!br.done() && br.peek().t === 'float') { placeFloatItem(br.peek()); br.skip() }
    if (br.done()) break
    const av = bfc && bfc.floats.length ? floatAvail(bfc, coy + y, rootLH, cox, cox + cw) : { left: 0, right: 0 }
    const W = Math.max(0, cw - av.left - av.right)
    const ind = first ? indent : 0
    const line = br.next(W, ind)
    for (const f of line.floats) placeFloatItem(f)
    const startStack = stack.slice()
    let maxA = strutA, maxD = strutD, tbH = 0
    const shifts = startStack.map(s => s.shift)
    const addBox = (fi, bcs, shift) => {
      const lh = lhPx(bcs, fi), L = lh - (fi.asc + fi.desc)
      const a = fi.asc + L / 2 + shift, d = fi.desc + L / 2 - shift
      if (a > maxA) maxA = a
      if (d > maxD) maxD = d
    }
    for (const s of startStack) addBox(fontInfo(s.box.cs), s.box.cs, s.shift)
    let cur = shifts.length ? shifts[shifts.length - 1] : 0
    const sstack = startStack.slice()
    const meta = new Map()
    for (const it of line.items) {
      if (it.t === 'open') {
        const fi = fontInfo(it.box.cs)
        const own = vAlignShift(it.box.cs, fi)
        const sh = (sstack.length ? sstack[sstack.length - 1].shift : 0) + own
        sstack.push({ box: it.box, shift: sh })
        addBox(fi, it.box.cs, sh)
      } else if (it.t === 'close') sstack.pop()
      else if (it.t === 'text' || it.t === 'space') {
        const sh = sstack.length ? sstack[sstack.length - 1].shift : 0
        addBox(it.fi, it.cs, sh)
      } else if (it.t === 'atom') {
        const a = it.box, ac = a.cs
        const bl = a.baseline != null && ac.overflowX === 'visible' ? a.baseline : a.h
        let asc = bl + a.mar[0], desc = a.h - bl + a.mar[2]
        const base = sstack.length ? sstack[sstack.length - 1].shift : 0
        const va = ac.verticalAlign
        if (va === 'top' || va === 'bottom' || va === 'text-top' || va === 'text-bottom') { tbH = Math.max(tbH, asc + desc); meta.set(it, { va, asc, desc }) }
        else {
          let sh = base
          if (va === 'middle') { const pfi = sstack.length ? fontInfo(sstack[sstack.length - 1].box.cs) : fiRoot; sh = base + pfi.xh / 2 - (asc - desc) / 2 + 0 }
          else { const fiA = fiRoot; sh = base + vAlignShift(ac, fiA) }
          if (va === 'middle') { const half = (asc + desc) / 2; const pfi = sstack.length ? fontInfo(sstack[sstack.length - 1].box.cs) : fiRoot; sh = base + pfi.xh / 2 - (half - desc) }
          maxA = Math.max(maxA, asc + sh); maxD = Math.max(maxD, desc - sh)
          meta.set(it, { va, asc, desc, sh })
        }
      }
    }
    const contentW = lineContentWidth(line)
    const hasAny = line.hasContent || line.br
    const lineH = Math.max(maxA + maxD, tbH)
    const free = W - ind - contentW
    let off = 0, extra = 0
    const last = br.done() || line.br
    if (align === 'right') off = Math.max(0, free)
    else if (align === 'center') off = Math.max(0, free / 2)
    else if (align === 'justify' && !last && free > 0) { const sp = line.items.filter(i => i.t === 'space').length; if (sp) extra = free / sp }
    const baseY = y + maxA
    let x = av.left + ind + off
    const frags = []
    const openF = startStack.map(s => ({ box: s.box, x0: av.left + ind + off, shift: s.shift, first: false }))
    const st2 = startStack.slice()
    let lastText = null
    for (const it of line.items) {
      if (it.t === 'open') {
        const own = vAlignShift(it.box.cs, fontInfo(it.box.cs))
        const sh = (st2.length ? st2[st2.length - 1].shift : 0) + own
        st2.push({ box: it.box, shift: sh })
        openF.push({ box: it.box, x0: x + it.ml, shift: sh, first: true })
        x += it.el; lastText = null
      } else if (it.t === 'close') {
        const f = openF.pop()
        st2.pop()
        if (f) frags.push({ k: 'inl', box: f.box, x0: f.x0, x1: x + (it.er - it.mr), base: baseY - f.shift, first: f.first, last: true })
        x += it.er; lastText = null
      } else if (it.t === 'text' || it.t === 'space') {
        const sh = st2.length ? st2[st2.length - 1].shift : 0
        const w = it.w + (it.t === 'space' && extra ? extra : 0)
        if (lastText && lastText.box === it.box && lastText.shift === sh) { lastText.str += it.str; lastText.w += w }
        else { lastText = { k: 'text', x, y: baseY - sh, str: it.str, w, fi: it.fi, cs: it.cs, box: it.box, shift: sh }; frags.push(lastText) }
        x += w
      } else if (it.t === 'atom') {
        const a = it.box, m = meta.get(it)
        let top
        if (m.va === 'top' || m.va === 'text-top') top = y + a.mar[0]
        else if (m.va === 'bottom' || m.va === 'text-bottom') top = y + lineH - a.h - a.mar[2]
        else top = baseY - m.sh - m.asc + a.mar[0]
        a.rx = x + a.mar[3]; a.ry = top
        box.ifcBoxes.push(a)
        x += it.w; lastText = null
      } else if (it.t === 'oof') {
        it.box.static = { x, y, p: box }
        box.ifcOof.push(it.box)
      } else if (it.t === 'br') lastText = null
    }
    for (const f of openF) frags.push({ k: 'inl', box: f.box, x0: f.x0, x1: x, base: baseY - f.shift, first: f.first, last: false })
    for (const it of line.items) {
      if (it.t === 'open') stack.push({ box: it.box, shift: (stack.length ? stack[stack.length - 1].shift : 0) + vAlignShift(it.box.cs, fontInfo(it.box.cs)) })
      else if (it.t === 'close') stack.pop()
    }
    if (hasAny) {
      lines.push({ y, h: lineH, base: baseY, frags, x0: av.left, w: contentW + ind, avail: W, forced: line.br })
      lastBaseline = baseY
      y += lineH
      first = false
    }
    if (!line.items.length && !line.floats.length && !hasAny && br.done()) break
  }
  applyClamp(box, lines, cw)
  y = lines.length ? lines[lines.length - 1].y + lines[lines.length - 1].h : 0
  box.lines = lines
  return { height: y, baseline: lines.length ? lines[lines.length - 1].base : null, lines: lines.length }
}

function applyClamp(box, lines, cw) {
  const cs = box.cs
  let target = null
  if (cs.lineClamp > 0 && lines.length > cs.lineClamp && cs.clips) {
    lines.length = cs.lineClamp
    target = lines[lines.length - 1]
    target.clampEll = true
  } else if (cs.textOverflow === 'ellipsis' && cs.clips) {
    for (const ln of lines) if (ln.w > cw + 0.5) ellipsize(ln, cw)
    return
  }
  if (target) ellipsize(target, cw, true)
}

function ellipsize(ln, cw, force) {
  const tf = ln.frags.filter(f => f.k === 'text')
  if (!tf.length) return
  const lastF = tf[tf.length - 1]
  const ell = '…'
  const ew = measureText(lastF.fi, ell)
  const fits = ln.w <= cw + 0.5
  if (fits && !force) return
  if (fits && force && !ln.forcedMore) { ln.noEll = false }
  const limit = cw - ew
  let used = ln.x0 + 0
  for (const f of ln.frags) { if (f.k === 'text') f.cut = false }
  let acc = 0
  let stop = -1
  for (let i = 0; i < ln.frags.length; i++) {
    const f = ln.frags[i]
    if (f.k !== 'text') continue
    if (acc + f.w <= limit) { acc += f.w; continue }
    const chars = Array.from(f.str)
    let s = '', w = 0
    for (const ch of chars) { const nw = measureText(f.fi, s + ch); if (acc + nw > limit) break; s += ch }
    s = s.replace(/\s+$/, '')
    f.str = s + ell
    f.w = measureText(f.fi, f.str)
    stop = i
    break
  }
  if (stop < 0) {
    if (force) { lastF.str = lastF.str.replace(/\s+$/, '') + ell; lastF.w = measureText(lastF.fi, lastF.str) }
    return
  }
  ln.frags = ln.frags.filter((f, i) => i <= stop || f.k !== 'text')
  ln.w = cw
}

function layoutReplacedBox(box, o) {
  const cs = box.cs
  resolveEdges(box, o.cbw)
  const edgeX = box.pad[1] + box.pad[3] + box.bor[1] + box.bor[3], edgeY = box.pad[0] + box.pad[2] + box.bor[0] + box.bor[2]
  const bsB = cs.boxSizing === 'border-box'
  const nat = replacedSize(box)
  const cbw = o.cbw
  let sw = res(cs.width, cbw), sh = res(cs.height, o.cbh)
  if (sw != null && bsB) sw = Math.max(0, sw - edgeX)
  if (sh != null && bsB) sh = Math.max(0, sh - edgeY)
  if (o.w != null) sw = Math.max(0, o.w - edgeX)
  if (o.h != null) sh = Math.max(0, o.h - edgeY)
  let cw, chh
  const ratio = nat.ratio || (cs.aspect || 0)
  if (sw != null && sh != null) { cw = sw; chh = sh }
  else if (sw != null) { cw = sw; chh = ratio ? sw / ratio : nat.h }
  else if (sh != null) { chh = sh; cw = ratio ? sh * ratio : nat.w }
  else {
    cw = nat.w; chh = nat.h
    if (cs.aspect && !nat.ratio) chh = cw / cs.aspect
  }
  const mnw = res(cs.minW, cbw), mxw = cs.maxW == null ? null : res(cs.maxW, cbw)
  const mnh = res(cs.minH, o.cbh), mxh = cs.maxH == null ? null : res(cs.maxH, o.cbh)
  const toC = (v, e) => bsB ? v - e : v
  const ow = cw, oh = chh
  if (mxw != null && cw > toC(mxw, edgeX)) { cw = toC(mxw, edgeX); if (sh == null && ratio) chh = cw / ratio }
  if (mxh != null && chh > toC(mxh, edgeY)) { chh = toC(mxh, edgeY); if (sw == null && ratio) cw = chh * ratio }
  if (mnw != null && cw < toC(mnw, edgeX)) { cw = toC(mnw, edgeX); if (sh == null && ratio) chh = cw / ratio }
  if (mnh != null && chh < toC(mnh, edgeY)) { chh = toC(mnh, edgeY); if (sw == null && ratio) cw = chh * ratio }
  cw = Math.max(0, cw); chh = Math.max(0, chh)
  box.w = cw + edgeX; box.h = chh + edgeY; box.cw = cw; box.ch = chh
  box.baseline = null
  const rk = box.rep.kind
  if (rk === 'input' && !/^(checkbox|radio|range|color|image)$/.test(box.rep.type) || rk === 'select' || rk === 'textarea') { const fi = fontInfo(cs); box.baseline = box.bor[0] + box.pad[0] + fi.asc + (chh - (fi.asc + fi.desc)) / 2 }
  else if (rk === 'marker') box.baseline = box.h
  box.mtEff = box.mar[0]; box.mbEff = box.mar[2]; box.empty = false; box.vshift = 0
  if (box.absList) for (const a of box.absList) layoutAbsSize(a, box)
}

function layoutAbsSize(a, cb) {
  const cs = a.cs
  let cbW, cbH
  if (cb === C.rootBox) { cbW = C.vw; cbH = C.vh }
  else { cbW = cb.w - cb.bor[1] - cb.bor[3]; cbH = cb.h - cb.bor[0] - cb.bor[2] }
  resolveEdges(a, cbW)
  const l = res(cs.left, cbW), r = res(cs.right, cbW), t = res(cs.top, cbH), b = res(cs.bottom, cbH)
  const o = { cbw: cbW, cbh: cbH, shrink: true }
  const bsB = cs.boxSizing === 'border-box'
  const edgeX = a.pad[1] + a.pad[3] + a.bor[1] + a.bor[3], edgeY = a.pad[0] + a.pad[2] + a.bor[0] + a.bor[2]
  if (res(cs.width, cbW) == null && l != null && r != null) o.w = Math.max(0, cbW - l - r - a.mar[1] - a.mar[3])
  else o.availW = Math.max(0, cbW - (l || 0) - (r || 0) - a.mar[1] - a.mar[3])
  if (res(cs.height, cbH) == null && t != null && b != null && a.type !== 'replaced') o.h = Math.max(0, cbH - t - b - a.mar[0] - a.mar[2])
  a._lk = undefined
  layoutBox(a, o)
  a.cbSize = { w: cbW, h: cbH }
}

function placeBox(box, ax, ay) {
  box.ax = ax; box.ay = ay
  const cx = ax + box.bor[3] + box.pad[3], cy = ay + box.bor[0] + box.pad[0] + (box.vshift || 0)
  box.cx = cx; box.cy = cy
  const rel = c => {
    if (c.cs.position !== 'relative') return [0, 0]
    const cb = box.cw
    const l = res(c.cs.left, cb), r = res(c.cs.right, cb), t = res(c.cs.top, box.ch), b = res(c.cs.bottom, box.ch)
    return [l != null ? l : r != null ? -r : 0, t != null ? t : b != null ? -b : 0]
  }
  if (box.ifc) {
    for (const a of box.ifcBoxes || []) { const [dx, dy] = rel(a); placeBox(a, cx + a.rx + dx - a.mar[3] * 0, cy + a.ry + dy) }
    for (const a of box.ifcOof || []) placeAbs(a)
    return
  }
  for (const c of box.children) {
    if (c.oof) { placeAbs(c); continue }
    const [dx, dy] = rel(c)
    placeBox(c, cx + c.rx + dx, cy + c.ry + dy)
  }
}

function placeAbs(a) {
  const cb = a.cbBox, cs = a.cs
  let cbx, cby, cbW, cbH
  if (cb === C.rootBox) { cbx = 0; cby = 0; cbW = C.vw; cbH = C.vh }
  else { cbx = cb.ax + cb.bor[3]; cby = cb.ay + cb.bor[0]; cbW = cb.w - cb.bor[1] - cb.bor[3]; cbH = cb.h - cb.bor[0] - cb.bor[2] }
  const l = res(cs.left, cbW), r = res(cs.right, cbW), t = res(cs.top, cbH), b = res(cs.bottom, cbH)
  const st = a.static || { x: 0, y: 0, p: a.parent }
  const sp = st.p || a.parent
  const sx = (sp && sp.cx != null ? sp.cx : cbx) + st.x, sy = (sp && sp.cy != null ? sp.cy : cby) + st.y
  let x, y
  if (l != null && r != null && a.mauto[3] && a.mauto[1]) x = cbx + l + Math.max(0, (cbW - l - r - a.w)) / 2
  else if (l != null) x = cbx + l + a.mar[3]
  else if (r != null) x = cbx + cbW - r - a.w - a.mar[1]
  else x = sx + a.mar[3]
  if (t != null && b != null && a.mauto[0] && a.mauto[2]) y = cby + t + Math.max(0, (cbH - t - b - a.h)) / 2
  else if (t != null) y = cby + t + a.mar[0]
  else if (b != null) y = cby + cbH - b - a.h - a.mar[2]
  else y = sy + a.mar[0]
  placeBox(a, x, y)
}

function normAlign(v, dflt) {
  v = (v || dflt).toLowerCase().replace(/^(safe|unsafe)\s+/, '')
  if (v === 'normal' || v === 'auto') return dflt
  if (v === 'start' || v === 'self-start' || v === 'flex-start' || v === 'left') return 'start'
  if (v === 'end' || v === 'self-end' || v === 'flex-end' || v === 'right') return 'end'
  if (v === 'first baseline' || v === 'baseline') return 'baseline'
  if (v === 'last baseline') return 'end'
  return v
}

function layoutFlex(box, cw, chDef) {
  const cs = box.cs
  const row = !/^column/.test(cs.flexDir), rev = /reverse/.test(cs.flexDir)
  const wrap = cs.flexWrap !== 'nowrap', wrapRev = cs.flexWrap === 'wrap-reverse'
  const gapMain = res(row ? cs.colGap : cs.rowGap, row ? cw : chDef) || 0
  const gapCross = res(row ? cs.rowGap : cs.colGap, row ? chDef : cw) || 0
  const mainAvail = row ? cw : chDef
  const crossAvail = row ? chDef : cw
  const defMain = mainAvail === mainAvail
  for (const c of box.children) if (c.oof) c.static = { x: 0, y: 0, p: box }
  const kids = box.children.filter(c => !c.oof).map((c, i) => ({ c, i })).sort((a, b) => a.c.cs.order - b.c.cs.order || a.i - b.i).map(x => x.c)
  const alignOf = c => normAlign(c.cs.alignSelf !== 'auto' ? c.cs.alignSelf : cs.alignItems, 'stretch')
  const items = kids.map(c => {
    resolveEdges(c, cw)
    const ics = c.cs, bsB = ics.boxSizing === 'border-box'
    const it = { c }
    it.m0 = row ? c.mar[3] : c.mar[0]; it.m1 = row ? c.mar[1] : c.mar[2]
    it.ma0 = row ? c.mauto[3] : c.mauto[0]; it.ma1 = row ? c.mauto[1] : c.mauto[2]
    it.c0 = row ? c.mar[0] : c.mar[3]; it.c1 = row ? c.mar[2] : c.mar[1]
    it.ca0 = row ? c.mauto[0] : c.mauto[3]; it.ca1 = row ? c.mauto[2] : c.mauto[1]
    it.edgeM = row ? c.pad[1] + c.pad[3] + c.bor[1] + c.bor[3] : c.pad[0] + c.pad[2] + c.bor[0] + c.bor[2]
    it.edgeC = row ? c.pad[0] + c.pad[2] + c.bor[0] + c.bor[2] : c.pad[1] + c.pad[3] + c.bor[1] + c.bor[3]
    it.grow = ics.flexGrow; it.shrink = ics.flexShrink
    it.align = alignOf(c)
    const crossSpec = res(row ? ics.height : ics.width, crossAvail)
    it.crossAuto = crossSpec == null && !(row && ics.aspect)
    const specRaw = res(row ? ics.width : ics.height, mainAvail)
    const specMain = specRaw != null ? (bsB ? specRaw : specRaw + it.edgeM) : null
    let base = null
    const fb = ics.flexBasis
    if (fb !== 'auto' && fb !== 'content') { const v = res(fb, mainAvail); if (v != null) base = bsB ? v : v + it.edgeM }
    if (base == null && fb !== 'content') base = specMain
    const colW = () => it.align === 'stretch' && it.crossAuto && !it.ca0 && !it.ca1 ? Math.max(0, cw - it.c0 - it.c1) : null
    let natH = null
    if (!row) {
      const fw = colW()
      layoutBox(c, { cbw: cw, cbh: NaN, w: fw, shrink: fw == null, availW: cw - it.c0 - it.c1 })
      natH = c.h
    }
    if (base == null) base = row ? intrinsicW(c, 'max') : natH
    it.base = Math.max(base, it.edgeM)
    const minRaw = res(row ? ics.minW : ics.minH, mainAvail)
    let minMain = minRaw != null && minRaw > 0 ? (bsB ? minRaw : minRaw + it.edgeM) : 0
    if ((row ? ics.minWAuto : ics.minHAuto) && !ics.clips) {
      const content = row ? intrinsicW(c, 'min') : natH
      minMain = Math.max(minMain, Math.min(content, specMain != null ? specMain : Infinity))
    }
    const maxRaw = (row ? ics.maxW : ics.maxH)
    const mx = maxRaw == null ? null : res(maxRaw, mainAvail)
    it.min = Math.max(minMain, it.edgeM)
    it.max = mx != null ? (bsB ? mx : mx + it.edgeM) : null
    it.hyp = clampSize(it.base, it.min, it.max)
    return it
  })
  const lines = []
  if (wrap && defMain) {
    let cur = [], sum = 0
    for (const it of items) {
      const outer = it.hyp + it.m0 + it.m1
      if (cur.length && sum + gapMain + outer > mainAvail + 0.01) { lines.push(cur); cur = []; sum = 0 }
      sum += (cur.length ? gapMain : 0) + outer
      cur.push(it)
    }
    if (cur.length) lines.push(cur)
  } else if (items.length) lines.push(items)
  for (const line of lines) {
    const gaps = gapMain * Math.max(0, line.length - 1)
    if (!defMain) { for (const it of line) it.main = it.hyp; continue }
    const sumHyp = line.reduce((s, it) => s + it.hyp + it.m0 + it.m1, 0) + gaps
    const growing = sumHyp < mainAvail
    const frozen = new Set()
    for (const it of line) {
      it.main = it.base
      if (growing ? (it.grow === 0 || it.base > it.hyp) : (it.shrink === 0 || it.base < it.hyp)) { frozen.add(it); it.main = it.hyp }
    }
    for (let g = 0; g < 12; g++) {
      const un = line.filter(it => !frozen.has(it))
      if (!un.length) break
      const usedF = line.filter(it => frozen.has(it)).reduce((s, it) => s + it.main + it.m0 + it.m1, 0)
      const usedU = un.reduce((s, it) => s + it.base + it.m0 + it.m1, 0)
      let free = mainAvail - gaps - usedF - usedU
      if (growing) {
        const sg = un.reduce((s, it) => s + it.grow, 0)
        if (sg > 0) { if (sg < 1) free *= sg; for (const it of un) it.main = it.base + free * it.grow / sg }
        else for (const it of un) it.main = it.base
      } else {
        const ss = un.reduce((s, it) => s + it.shrink * it.base, 0)
        if (ss > 0) for (const it of un) it.main = it.base + free * (it.shrink * it.base) / ss
        else for (const it of un) it.main = it.base
      }
      let tv = 0
      for (const it of un) { const c = clampSize(it.main, it.min, it.max); it.viol = c - it.main; tv += it.viol; it.main = c }
      if (Math.abs(tv) < 0.001) break
      for (const it of un) if (tv > 0 ? it.viol > 0 : it.viol < 0) frozen.add(it)
    }
  }
  for (const line of lines) for (const it of line) {
    const c = it.c
    it.main = Math.max(it.main, it.edgeM)
    if (row) { layoutBox(c, { w: it.main, cbw: cw, cbh: chDef }); it.cross = c.h }
    else {
      const fw = it.align === 'stretch' && it.crossAuto && !it.ca0 && !it.ca1 ? Math.max(0, cw - it.c0 - it.c1) : null
      layoutBox(c, { h: it.main, w: fw, cbw: cw, cbh: it.main, shrink: fw == null, availW: cw - it.c0 - it.c1 })
      it.cross = c.w
    }
    it.crossOuter = it.cross + it.c0 + it.c1
  }
  const lineCross = lines.map(line => {
    let m = 0, asc = 0, desc = 0, hasB = false
    for (const it of line) {
      if (row && it.align === 'baseline') { const b = it.c.baseline != null ? it.c.baseline : it.c.h; asc = Math.max(asc, b + it.c0); desc = Math.max(desc, it.c.h - b + it.c1); hasB = true }
      m = Math.max(m, it.crossOuter)
    }
    line.baselineAsc = asc
    return hasB ? Math.max(m, asc + desc) : m
  })
  const crossDef = crossAvail === crossAvail
  if (lines.length === 1 && crossDef && !wrap) lineCross[0] = crossAvail
  const totalGapC = gapCross * Math.max(0, lines.length - 1)
  let crossTotal = lineCross.reduce((a, b) => a + b, 0) + totalGapC
  let crossStart = 0, crossBetween = 0
  if (crossDef && lines.length) {
    const free = crossAvail - crossTotal
    const ac = normAlign(cs.alignContent, 'stretch')
    if (wrap && free > 0) {
      if (ac === 'stretch') { for (let i = 0; i < lineCross.length; i++) lineCross[i] += free / lineCross.length }
      else if (ac === 'end') crossStart = free
      else if (ac === 'center') crossStart = free / 2
      else if (ac === 'space-between') crossBetween = lines.length > 1 ? free / (lines.length - 1) : 0
      else if (ac === 'space-around') { crossBetween = free / lines.length; crossStart = crossBetween / 2 }
      else if (ac === 'space-evenly') { crossBetween = free / (lines.length + 1); crossStart = crossBetween }
    }
    crossTotal = crossAvail
  }
  const order = lines.map((_, i) => i)
  if (wrapRev) order.reverse()
  let cpos = crossStart
  let maxMainUsed = 0
  let baseline = null
  for (const li of order) {
    const line = lines[li], lc = lineCross[li]
    const gaps = gapMain * Math.max(0, line.length - 1)
    const used = line.reduce((s, it) => s + it.main + it.m0 + it.m1, 0) + gaps
    maxMainUsed = Math.max(maxMainUsed, used)
    let free = defMain ? mainAvail - used : 0
    const autoCount = line.reduce((s, it) => s + (it.ma0 ? 1 : 0) + (it.ma1 ? 1 : 0), 0)
    let pos0 = 0, between = 0, autoEach = 0
    if (autoCount && free > 0) autoEach = free / autoCount
    else {
      const jc = normAlign(cs.justifyContent, 'start')
      if (jc === 'end') pos0 = free
      else if (jc === 'center') pos0 = free / 2
      else if (free > 0 && jc === 'space-between') between = line.length > 1 ? free / (line.length - 1) : 0
      else if (free > 0 && jc === 'space-around') { between = free / line.length; pos0 = between / 2 }
      else if (free > 0 && jc === 'space-evenly') { between = free / (line.length + 1); pos0 = between }
    }
    let p = pos0
    const extent = defMain ? mainAvail : used
    for (const it of line) {
      const c = it.c
      const m0 = it.m0 + (it.ma0 ? autoEach : 0), m1 = it.m1 + (it.ma1 ? autoEach : 0)
      let ms = p + m0
      p += m0 + it.main + m1 + gapMain + between
      if (rev) ms = extent - ms - it.main
      let cross = it.cross
      const avail = lc - it.c0 - it.c1
      let off = it.c0
      if (it.ca0 && it.ca1) off = it.c0 + Math.max(0, (lc - it.crossOuter) / 2)
      else if (it.ca0) off = it.c0 + Math.max(0, lc - it.crossOuter)
      else if (it.ca1) off = it.c0
      else if (it.align === 'stretch' && it.crossAuto) {
        if (row && avail > c.h + 0.01) {
          if (c.type === 'flex' || c.type === 'grid') layoutBox(c, { w: it.main, h: avail, cbw: cw, cbh: chDef })
          else { c.h = avail; c.ch = Math.max(0, avail - c.pad[0] - c.pad[2] - c.bor[0] - c.bor[2]) }
        }
      } else if (it.align === 'end') off = it.c0 + Math.max(0, lc - it.crossOuter)
      else if (it.align === 'center') off = it.c0 + (lc - it.crossOuter) / 2
      else if (it.align === 'baseline' && row) { const b = c.baseline != null ? c.baseline : c.h; off = line.baselineAsc - b }
      if (row) { c.rx = ms; c.ry = cpos + off } else { c.rx = cpos + off; c.ry = ms }
    }
    cpos += lc + gapCross + crossBetween
  }
  const first = kids[0]
  if (first) baseline = (row ? first.ry : first.ry) + (first.baseline != null ? first.baseline : first.h)
  const mainTotal = defMain ? mainAvail : maxMainUsed
  const ch = row ? (crossDef ? crossAvail : crossTotal) : (defMain ? mainAvail : maxMainUsed)
  void mainTotal
  return { ch, baseline, empty: !items.length }
}

function trackBound(s, E) {
  s = s.trim().toLowerCase()
  if (s === 'auto') return { k: 'auto' }
  if (s === 'min-content') return { k: 'min' }
  if (s === 'max-content') return { k: 'max' }
  const fr = /^([\d.]+)fr$/.exec(s)
  if (fr) return { k: 'fr', v: parseFloat(fr[1]) }
  const v = parseLen(s, E)
  if (v == null || v === 'auto') return { k: 'auto' }
  return { k: 'len', v }
}

function trackDef(tok, E) {
  const lt = tok.toLowerCase()
  let m
  if ((m = /^minmax\((.*)\)$/.exec(lt))) {
    const p = splitTop(m[1], ',')
    const a = trackBound(p[0], E), b = trackBound(p[1] || 'auto', E)
    return { min: a.k === 'fr' ? { k: 'auto' } : a, max: b }
  }
  if ((m = /^fit-content\((.*)\)$/.exec(lt))) { const b = trackBound(m[1], E); return { min: { k: 'auto' }, max: b.k === 'len' ? b : { k: 'auto' }, fit: true } }
  const b = trackBound(lt, E)
  if (b.k === 'fr') return { min: { k: 'auto' }, max: b }
  return { min: b, max: b }
}

function parseTracks(str, E, avail, gap) {
  const out = []
  if (!str || /^none$/i.test(str.trim())) return out
  const toks = tokens(str.replace(/\[[^\]]*\]/g, ' '))
  for (const tok of toks) {
    const m = /^repeat\((\s*[^,]+),(.*)\)$/is.exec(tok)
    if (m) {
      const cnt = m[1].trim().toLowerCase()
      const defs = tokens(m[2].replace(/\[[^\]]*\]/g, ' ')).map(t => trackDef(t, E))
      let n = parseInt(cnt, 10)
      let auto = null
      if (cnt === 'auto-fill' || cnt === 'auto-fit') {
        auto = cnt
        const unit = defs.reduce((s, d) => { const b = d.min.k === 'len' ? res(d.min.v, avail) : d.max.k === 'len' ? res(d.max.v, avail) : 0; return s + (b || 0) }, 0)
        if (avail === avail && isFinite(avail) && unit > 0) n = Math.max(1, Math.floor((avail + gap) / (unit + defs.length * gap)))
        else n = 1
      }
      if (!(n >= 1)) n = 1
      for (let i = 0; i < Math.min(n, 500); i++) for (const d of defs) out.push({ def: d, auto })
    } else out.push({ def: trackDef(tok, E), auto: null })
  }
  return out
}

function parseAreas(str) {
  const areas = {}
  let cols = 0, rows = 0
  if (!str || /^none$/i.test(str.trim())) return { areas, cols, rows }
  const lines = []
  str.replace(/"([^"]*)"|'([^']*)'/g, (m, a, b) => { lines.push((a ?? b).trim().split(/\s+/)); return m })
  rows = lines.length
  lines.forEach((names, r) => {
    cols = Math.max(cols, names.length)
    names.forEach((n, c) => {
      if (n === '.' || /^\.+$/.test(n)) return
      const a = areas[n]
      if (!a) areas[n] = { r0: r, r1: r + 1, c0: c, c1: c + 1 }
      else { a.r1 = Math.max(a.r1, r + 1); a.c1 = Math.max(a.c1, c + 1); a.r0 = Math.min(a.r0, r); a.c0 = Math.min(a.c0, c) }
    })
  })
  return { areas, cols, rows }
}

function lineSpec(s, areas, end, explicit, axis) {
  s = (s || 'auto').trim().toLowerCase()
  if (s === 'auto') return {}
  let m
  if ((m = /^span\s+(\d+)$/.exec(s))) return { span: parseInt(m[1], 10) }
  if ((m = /^(-?\d+)(?:\s+\S+)?$/.exec(s))) { const n = parseInt(m[1], 10); if (n === 0) return {}; return { line: n > 0 ? n - 1 : explicit + 1 + n } }
  const a = areas[s]
  if (a) return { line: axis === 'c' ? (end ? a.c1 : a.c0) : (end ? a.r1 : a.r0) }
  if ((m = /^(.+)-(start|end)$/.exec(s)) && areas[m[1]]) { const ar = areas[m[1]]; return { line: axis === 'c' ? (m[2] === 'end' ? ar.c1 : ar.c0) : (m[2] === 'end' ? ar.r1 : ar.r0) } }
  return {}
}

function resolveAxis(st, en, total) {
  let start = null, span = 1
  if (st.line != null && en.line != null) { start = Math.min(st.line, en.line); span = Math.max(1, Math.abs(en.line - st.line)) }
  else if (st.line != null) { start = st.line; span = en.span || 1 }
  else if (en.line != null) { span = st.span || 1; start = Math.max(0, en.line - span) }
  else span = st.span || en.span || 1
  return { start, span }
}

function placeGrid(box, cw, chDef) {
  const cs = box.cs, E = cs.E
  const colGap = res(cs.colGap, cw) || 0, rowGap = res(cs.rowGap, chDef) || 0
  const cols = parseTracks(cs.gridCols, E, cw, colGap), rows = parseTracks(cs.gridRows, E, chDef, rowGap)
  const ar = parseAreas(cs.gridAreas)
  while (cols.length < ar.cols) cols.push({ def: trackDef('auto', E), auto: null })
  while (rows.length < ar.rows) rows.push({ def: trackDef('auto', E), auto: null })
  const explicitC = cols.length, explicitR = rows.length
  const kids = box.children.filter(c => !c.oof).map((c, i) => ({ c, i })).sort((a, b) => a.c.cs.order - b.c.cs.order || a.i - b.i).map(x => x.c)
  for (const c of box.children) if (c.oof) c.static = { x: 0, y: 0, p: box }
  const colFlow = /column/.test(cs.gridFlow)
  const occ = new Set()
  const placed = []
  const fits = (r, c, rs, cs2) => { for (let i = 0; i < rs; i++) for (let j = 0; j < cs2; j++) if (occ.has((r + i) + ',' + (c + j))) return false; return true }
  const mark = (r, c, rs, cs2) => { for (let i = 0; i < rs; i++) for (let j = 0; j < cs2; j++) occ.add((r + i) + ',' + (c + j)) }
  const specs = kids.map(c => {
    const ics = c.cs
    let cStart = ics.gridColStart, cEnd = ics.gridColEnd, rStart = ics.gridRowStart, rEnd = ics.gridRowEnd
    const cA = resolveAxis(lineSpec(cStart, ar.areas, false, explicitC, 'c'), lineSpec(cEnd, ar.areas, true, explicitC, 'c'))
    const rA = resolveAxis(lineSpec(rStart, ar.areas, false, explicitR, 'r'), lineSpec(rEnd, ar.areas, true, explicitR, 'r'))
    return { c, cs: cA, rs: rA }
  })
  let maxC = Math.max(explicitC, 1), maxR = explicitR
  for (const s of specs) { if (s.cs.start != null) maxC = Math.max(maxC, s.cs.start + s.cs.span); if (s.rs.start != null) maxR = Math.max(maxR, s.rs.start + s.rs.span); maxC = Math.max(maxC, s.cs.span) }
  for (const s of specs) if (s.cs.start != null && s.rs.start != null) { mark(s.rs.start, s.cs.start, s.rs.span, s.cs.span); placed.push({ c: s.c, r0: s.rs.start, c0: s.cs.start, rs: s.rs.span, cs: s.cs.span }); s.done = true }
  let cr = 0, cc = 0
  for (const s of specs) {
    if (s.done) continue
    let r, c
    if (!colFlow) {
      if (s.rs.start != null) {
        r = s.rs.start
        c = 0
        while (!fits(r, c, s.rs.span, s.cs.span) && c < 2000) c++
      } else if (s.cs.start != null) {
        c = s.cs.start
        if (c < cc && false) cr++
        r = cr
        if (c < cc) r = cr + 1
        while (!fits(r, c, s.rs.span, s.cs.span) && r < 5000) r++
        cr = r; cc = c + s.cs.span
        if (cc > maxC) { cc = 0; cr++ }
      } else {
        r = cr; c = cc
        for (let g = 0; g < 100000; g++) {
          if (c + s.cs.span > maxC) { c = 0; r++ }
          if (fits(r, c, s.rs.span, s.cs.span)) break
          c++
        }
        cr = r; cc = c + s.cs.span
      }
    } else {
      const maxRows = Math.max(explicitR, 1, ...specs.map(x => x.rs.span))
      if (s.cs.start != null) {
        c = s.cs.start
        r = 0
        while (!fits(r, c, s.rs.span, s.cs.span) && r < 5000) r++
      } else {
        r = cr; c = cc
        for (let g = 0; g < 100000; g++) {
          if (r + s.rs.span > maxRows) { r = 0; c++ }
          if (fits(r, c, s.rs.span, s.cs.span)) break
          r++
        }
        cr = r + s.rs.span; cc = c
      }
    }
    mark(r, c, s.rs.span, s.cs.span)
    placed.push({ c: s.c, r0: r, c0: c, rs: s.rs.span, cs: s.cs.span })
  }
  let nC = explicitC, nR = explicitR
  for (const p of placed) { nC = Math.max(nC, p.c0 + p.cs); nR = Math.max(nR, p.r0 + p.rs) }
  const autoDefs = (str, n) => { const l = tokens(str || 'auto'); return Array.from({ length: n }, (_, i) => ({ def: trackDef(l[i % l.length] || 'auto', E), auto: null })) }
  const ac = autoDefs(cs.gridAutoCols, 2000), ar2 = autoDefs(cs.gridAutoRows, 2000)
  while (cols.length < nC) cols.push(ac[cols.length - explicitC])
  while (rows.length < nR) rows.push(ar2[rows.length - explicitR])
  return { cols, rows, placed, colGap, rowGap, explicitC, explicitR }
}

function sizeAxis(tracks, avail, gap, contribs, mode, stretchAuto) {
  const n = tracks.length
  const finite = avail === avail && isFinite(avail)
  for (const t of tracks) {
    const d = t.def
    t.base = d.min.k === 'len' ? Math.max(0, res(d.min.v, avail) || 0) : 0
    t.fixedMax = d.max.k === 'len' ? res(d.max.v, avail) : null
    t.fr = d.max.k === 'fr' ? d.max.v : 0
    t.cmin = 0; t.cmax = 0
    t.used = false
  }
  for (const it of contribs) {
    for (let i = it.a0; i < it.a1; i++) tracks[i].used = true
    if (it.a1 - it.a0 !== 1) continue
    const t = tracks[it.a0]
    t.cmin = Math.max(t.cmin, it.min); t.cmax = Math.max(t.cmax, it.max)
  }
  for (const t of tracks) {
    const d = t.def
    if (d.min.k === 'auto' || d.min.k === 'min') t.base = Math.max(t.base, t.cmin)
    else if (d.min.k === 'max') t.base = Math.max(t.base, t.cmax)
    if (t.fr) t.limit = Infinity
    else if (d.max.k === 'len') t.limit = Math.max(t.base, t.fixedMax == null ? t.cmax : t.fixedMax)
    else if (d.max.k === 'min') t.limit = Math.max(t.base, t.cmin)
    else t.limit = Math.max(t.base, t.cmax)
    if (d.fit && t.fixedMax != null) t.limit = Math.max(t.base, Math.min(t.cmax, t.fixedMax))
  }
  for (const it of contribs) {
    const span = it.a1 - it.a0
    if (span <= 1) continue
    const ts = tracks.slice(it.a0, it.a1)
    const cur = ts.reduce((s, t) => s + t.base, 0) + gap * (span - 1)
    const flexible = ts.filter(t => t.def.min.k === 'auto' || t.def.min.k === 'min' || t.def.min.k === 'max')
    if (it.min > cur && flexible.length) { const add = (it.min - cur) / flexible.length; for (const t of flexible) { t.base += add; if (t.limit < t.base) t.limit = t.base } }
    const curL = ts.reduce((s, t) => s + (t.fr ? t.base : t.limit), 0) + gap * (span - 1)
    const grow = ts.filter(t => !t.fr && (t.def.max.k === 'auto' || t.def.max.k === 'max'))
    if (it.max > curL && grow.length) { const add = (it.max - curL) / grow.length; for (const t of grow) t.limit += add }
  }
  const totalGap = gap * Math.max(0, n - 1)
  const hasFr = tracks.some(t => t.fr)
  for (const t of tracks) t.size = t.base
  if (mode === 'min') {
    for (const t of tracks) t.size = t.base
    return
  }
  if (finite) {
    let free = avail - tracks.reduce((s, t) => s + (t.fr ? 0 : t.base), 0) - totalGap - tracks.reduce((s, t) => s + (t.fr ? t.base : 0), 0) * 0
    const nonFr = tracks.filter(t => !t.fr)
    if (!hasFr) {
      for (let g = 0; g < 50 && free > 0.01; g++) {
        const gr = nonFr.filter(t => t.base < t.limit - 0.001)
        if (!gr.length) break
        const share = free / gr.length
        for (const t of gr) { const add = Math.min(share, t.limit - t.base); t.base += add; free -= add }
      }
      if (free > 0.01 && stretchAuto) {
        const st = nonFr.filter(t => t.def.max.k === 'auto')
        if (st.length) for (const t of st) t.base += free / st.length
      }
      for (const t of tracks) t.size = t.base
    } else {
      for (const t of nonFr) { const target = t.limit; if (free > 0 && t.base < target && t.def.max.k !== 'auto') { const add = Math.min(target - t.base, free); t.base += add; free -= add } }
      const left = avail - totalGap - nonFr.reduce((s, t) => s + t.base, 0)
      let pool = tracks.filter(t => t.fr)
      let fixed = new Set()
      let unit = 0
      for (let g = 0; g < 20; g++) {
        const act = pool.filter(t => !fixed.has(t))
        const sumFr = act.reduce((s, t) => s + t.fr, 0)
        const used = pool.filter(t => fixed.has(t)).reduce((s, t) => s + t.base, 0)
        unit = Math.max(0, left - used) / Math.max(1, sumFr)
        let changed = false
        for (const t of act) if (t.base > unit * t.fr + 0.001) { fixed.add(t); changed = true }
        if (!changed) break
      }
      for (const t of tracks) t.size = t.fr ? Math.max(t.base, unit * t.fr) : t.base
    }
  } else {
    let unit = 0
    for (const t of tracks) if (t.fr) unit = Math.max(unit, Math.max(t.base, t.cmax) / t.fr)
    for (const t of tracks) t.size = t.fr ? Math.max(t.base, unit * t.fr) : (mode === 'max' ? Math.max(t.base, t.limit === Infinity ? t.cmax : t.limit) : t.base)
  }
}

function gridIntrinsic(box, mode) {
  const cs = box.cs
  const pl = placeGrid(box, NaN, NaN)
  const contribs = []
  for (const p of pl.placed) {
    resolveEdges(p.c, 0)
    const mm = p.c.mar[1] + p.c.mar[3]
    contribs.push({ a0: p.c0, a1: p.c0 + p.cs, min: intrinsicW(p.c, 'min') + mm, max: intrinsicW(p.c, 'max') + mm })
  }
  sizeAxis(pl.cols, NaN, pl.colGap, contribs, mode === 'max' ? 'max' : 'min', false)
  return pl.cols.reduce((s, t) => s + t.size, 0) + pl.colGap * Math.max(0, pl.cols.length - 1)
}

function layoutGrid(box, cw, chDef) {
  const cs = box.cs
  const pl = placeGrid(box, cw, chDef)
  const { cols, rows, placed, colGap, rowGap } = pl
  const colContribs = placed.map(p => { resolveEdges(p.c, cw); const mm = p.c.mar[1] + p.c.mar[3]; const sw = res(p.c.cs.width, cw); return { a0: p.c0, a1: p.c0 + p.cs, min: intrinsicW(p.c, 'min') + mm, max: intrinsicW(p.c, 'max') + mm, p } })
  const jc = normAlign(cs.justifyContent, 'stretch')
  sizeAxis(cols, cw, colGap, colContribs, 'normal', jc === 'stretch')
  const colX = []
  let x = 0
  const colTotal = cols.reduce((s, t) => s + t.size, 0) + colGap * Math.max(0, cols.length - 1)
  let startX = 0
  const freeX = cw - colTotal
  if (freeX > 0) { if (jc === 'end') startX = freeX; else if (jc === 'center') startX = freeX / 2 }
  x = startX
  const collapsedCol = i => cols[i].auto === 'auto-fit' && !placed.some(p => i >= p.c0 && i < p.c0 + p.cs)
  cols.forEach((t, i) => { if (collapsedCol(i)) { t.size = 0; colX.push(x); return } colX.push(x); x += t.size + colGap })
  const spanW = p => { let w = 0; for (let i = p.c0; i < p.c0 + p.cs; i++) w += cols[i].size; return w + colGap * (p.cs - 1) }
  const rowContribs = placed.map(p => {
    const w = spanW(p)
    const c = p.c
    const ics = c.cs
    const jself = normAlign(ics.justifySelf !== 'auto' ? ics.justifySelf : cs.justifyItems, 'stretch')
    const stretchW = jself === 'stretch' && res(ics.width, w) == null && c.type !== 'replaced' && !c.mauto[1] && !c.mauto[3]
    p.jself = jself
    const mw = c.mar[1] + c.mar[3]
    layoutBox(c, { cbw: w, cbh: NaN, w: stretchW ? Math.max(0, w - mw) : null, shrink: !stretchW, availW: Math.max(0, w - mw) })
    const mh = c.mar[0] + c.mar[2]
    return { a0: p.r0, a1: p.r0 + p.rs, min: c.h + mh, max: c.h + mh, p }
  })
  const ra = normAlign(cs.alignContent, 'stretch')
  sizeAxis(rows, chDef, rowGap, rowContribs, 'normal', ra === 'stretch')
  const rowY = []
  let y = 0
  const collapsedRow = i => rows[i].auto === 'auto-fit' && !placed.some(p => i >= p.r0 && i < p.r0 + p.rs)
  const rowTotal = rows.reduce((s, t) => s + t.size, 0) + rowGap * Math.max(0, rows.length - 1)
  let startY = 0
  if (chDef === chDef) { const freeY = chDef - rowTotal; if (freeY > 0) { if (ra === 'end') startY = freeY; else if (ra === 'center') startY = freeY / 2 } }
  y = startY
  rows.forEach((t, i) => { rowY.push(y); y += t.size + rowGap })
  const spanH = p => { let h = 0; for (let i = p.r0; i < p.r0 + p.rs; i++) h += rows[i].size; return h + rowGap * (p.rs - 1) }
  let baseline = null
  for (const p of placed) {
    const c = p.c, ics = c.cs
    const w = spanW(p), h = spanH(p)
    const jself = p.jself
    const aself = normAlign(ics.alignSelf !== 'auto' ? ics.alignSelf : cs.alignItems, 'stretch')
    const stretchW = jself === 'stretch' && res(ics.width, w) == null && c.type !== 'replaced' && !c.mauto[1] && !c.mauto[3]
    const stretchH = aself === 'stretch' && res(ics.height, h) == null && c.type !== 'replaced' && !c.mauto[0] && !c.mauto[2] && !ics.aspect
    const mw = c.mar[1] + c.mar[3], mh = c.mar[0] + c.mar[2]
    layoutBox(c, { cbw: w, cbh: h, w: stretchW ? Math.max(0, w - mw) : null, h: stretchH ? Math.max(0, h - mh) : null, shrink: !stretchW, availW: Math.max(0, w - mw) })
    let dx = c.mar[3], dy = c.mar[0]
    const fx = w - c.w - mw, fy = h - c.h - mh
    if (c.mauto[3] && c.mauto[1]) dx += fx / 2; else if (c.mauto[3]) dx += fx
    else if (!stretchW) { if (jself === 'end') dx += fx; else if (jself === 'center') dx += fx / 2 }
    if (c.mauto[0] && c.mauto[2]) dy += fy / 2; else if (c.mauto[0]) dy += fy
    else if (!stretchH) { if (aself === 'end') dy += fy; else if (aself === 'center') dy += fy / 2 }
    c.rx = colX[p.c0] + dx
    c.ry = rowY[p.r0] + dy
    if (baseline == null && p.r0 === 0) baseline = c.ry + (c.baseline != null ? c.baseline : c.h)
  }
  const ch = chDef === chDef ? chDef : rowTotal
  return { ch: Math.max(ch, 0), baseline, empty: !placed.length }
}

function wrapAsCell(tbl, boxes) {
  const cell = new Box('block', 'flow', null, anonCS(C, tbl.cs, 'table-cell'))
  cell.tableRole = 'table-cell'; cell.anon = true; cell.parent = null; cell.posAnc = tbl.posAnc
  cell.children = boxes
  for (const b of boxes) b.parent = cell
  finalizeBox(C, cell)
  return cell
}

function anonRowBox(tbl) {
  const r = new Box('block', 'flow', null, anonCS(C, tbl.cs, 'table-row'))
  r.tableRole = 'table-row'; r.anon = true; r.posAnc = tbl.posAnc; r.children = []
  return r
}

function normalizeTable(tbl) {
  if (tbl._norm) return
  tbl._norm = true
  const caps = [], items = [], rows = [], colSpecs = []
  let loose = null
  const flushLoose = () => { loose = null }
  const addRow = (rowBox, group) => {
    const cells = []
    let pendingNon = []
    const flushNon = () => { if (pendingNon.some(b => !isBlankText(b))) cells.push(wrapAsCell(tbl, pendingNon)); pendingNon = [] }
    for (const c of rowBox.children) {
      if (c.tableRole === 'table-cell') { flushNon(); cells.push(c) }
      else if (c.oof) continue
      else pendingNon.push(c)
    }
    flushNon()
    for (const c of cells) c.parent = rowBox
    rowBox.children = cells
    rows.push({ box: rowBox, cells, group })
  }
  for (const c of tbl.children) {
    const role = c.tableRole
    if (role === 'table-caption') { caps.push(c); flushLoose() }
    else if (role === 'table-row-group' || role === 'table-header-group' || role === 'table-footer-group') {
      flushLoose()
      const g = { box: c, role, rows: [] }
      const kids = []
      let loose2 = null
      for (const r of c.children) {
        if (r.tableRole === 'table-row') { loose2 = null; kids.push(r); addRow(r, g); g.rows.push(r) }
        else if (r.oof) kids.push(r)
        else {
          if (!loose2) { loose2 = anonRowBox(tbl); loose2.parent = c; kids.push(loose2); loose2.children = []; addRow(loose2, g); g.rows.push(loose2); loose2._pend = [] }
          loose2._pend.push(r)
        }
      }
      for (const k of kids) if (k._pend) { const cell = wrapAsCell(tbl, k._pend); cell.parent = k; k.children = [cell]; const rr = rows.find(x => x.box === k); rr.cells = [cell] }
      c.children = kids
      items.push({ g, box: c })
    } else if (role === 'table-row') { flushLoose(); const g = null; addRow(c, g); items.push({ g: null, box: c, row: true }) }
    else if (role === 'table-column') colSpecs.push({ box: c, span: parseInt(c.el && c.el.attrs.span, 10) || 1 })
    else if (role === 'table-column-group') {
      if (c.children.length) for (const k of c.children) colSpecs.push({ box: k, span: parseInt(k.el && k.el.attrs.span, 10) || 1 })
      else colSpecs.push({ box: c, span: parseInt(c.el && c.el.attrs.span, 10) || 1 })
    } else if (c.oof) continue
    else {
      if (!loose) { loose = anonRowBox(tbl); loose.parent = tbl; loose.children = []; loose._pend = []; items.push({ g: null, box: loose, row: true, anon: true }); rows.push({ box: loose, cells: [], group: null }) }
      loose._pend.push(c)
      const rr = rows.find(x => x.box === loose)
      rr.cells = [wrapAsCell(tbl, loose._pend.slice())]
      loose.children = rr.cells
      rr.cells[0].parent = loose
    }
  }
  const head = items.filter(i => i.g && i.g.role === 'table-header-group'), foot = items.filter(i => i.g && i.g.role === 'table-footer-group')
  const body = items.filter(i => !head.includes(i) && !foot.includes(i))
  tbl.tItems = [...head, ...body, ...foot]
  tbl.tRows = []
  for (const it of tbl.tItems) { if (it.row) tbl.tRows.push(rows.find(r => r.box === it.box)); else for (const rb of it.g.rows) tbl.tRows.push(rows.find(r => r.box === rb)) }
  tbl.tCaps = caps
  tbl.colSpecs = colSpecs
  const occ = []
  let ncols = 0
  tbl.tRows.forEach((row, ri) => {
    occ[ri] = occ[ri] || []
    let col = 0
    row.cellInfo = []
    for (const cell of row.cells) {
      while (occ[ri][col]) col++
      const a = cell.el ? cell.el.attrs : {}
      const cspan = Math.max(1, Math.min(1000, parseInt(a.colspan, 10) || 1)), rspan = Math.max(1, Math.min(200, parseInt(a.rowspan, 10) || 1))
      row.cellInfo.push({ box: cell, col, ri, cspan, rspan })
      for (let r = 0; r < rspan; r++) { occ[ri + r] = occ[ri + r] || []; for (let c = 0; c < cspan; c++) occ[ri + r][col + c] = true }
      col += cspan
      ncols = Math.max(ncols, col)
    }
  })
  tbl.ncols = ncols
  tbl.tFlat = tbl.tRows.flatMap(r => r.cellInfo)
  const ordered = [...caps.filter(c => c.cs.captionSide !== 'bottom'), ...tbl.tItems.map(i => i.box), ...caps.filter(c => c.cs.captionSide === 'bottom')]
  const oofs = tbl.children.filter(c => c.oof)
  tbl.children = [...ordered, ...oofs]
  for (const c of tbl.children) c.parent = tbl
}

function tableMetrics(tbl) {
  normalizeTable(tbl)
  const n = tbl.ncols
  const mins = new Array(n).fill(0), maxs = new Array(n).fill(0), pct = new Array(n).fill(null), fixed = new Array(n).fill(null)
  const multi = []
  for (const ci of tbl.tFlat) {
    const c = ci.box
    resolveEdges(c, 0)
    const mn = intrinsicW(c, 'min'), mx = intrinsicW(c, 'max')
    const w = c.cs.width
    if (ci.cspan === 1) {
      mins[ci.col] = Math.max(mins[ci.col], mn); maxs[ci.col] = Math.max(maxs[ci.col], mx)
      if (typeof w === 'function' && w.pct) { const p = w(100); pct[ci.col] = Math.max(pct[ci.col] || 0, p) }
      else if (typeof w === 'number') fixed[ci.col] = Math.max(fixed[ci.col] || 0, w + (c.cs.boxSizing === 'border-box' ? 0 : c.pad[1] + c.pad[3] + c.bor[1] + c.bor[3]))
    } else multi.push({ ci, mn, mx })
  }
  let ci = 0
  for (const cs of tbl.colSpecs) {
    for (let k = 0; k < cs.span && ci < n; k++, ci++) {
      const w = cs.box.cs.width
      if (typeof w === 'number') { fixed[ci] = Math.max(fixed[ci] || 0, w) }
      else if (typeof w === 'function' && w.pct) pct[ci] = w(100)
    }
  }
  for (const { ci: info, mn, mx } of multi) {
    const idx = []
    for (let i = info.col; i < Math.min(n, info.col + info.cspan); i++) idx.push(i)
    const curMin = idx.reduce((s, i) => s + mins[i], 0), curMax = idx.reduce((s, i) => s + maxs[i], 0)
    if (mn > curMin) for (const i of idx) mins[i] += (mn - curMin) / idx.length
    if (mx > curMax) for (const i of idx) maxs[i] += (mx - curMax) / idx.length
  }
  for (let i = 0; i < n; i++) { if (fixed[i] != null) { mins[i] = Math.max(mins[i], fixed[i]); maxs[i] = Math.max(maxs[i], fixed[i]) } if (maxs[i] < mins[i]) maxs[i] = mins[i] }
  return { mins, maxs, pct, fixed, n }
}

function tableIntrinsic(tbl, mode) {
  const m = tableMetrics(tbl)
  const sp = tbl.cs.borderCollapse === 'collapse' ? 0 : tbl.cs.spacingH
  const arr = mode === 'max' ? m.maxs : m.mins
  let sum = arr.reduce((a, b) => a + b, 0)
  if (mode === 'max') { for (let i = 0; i < m.n; i++) if (m.pct[i]) { sum = Math.max(sum, arr[i] * 100 / Math.max(1, m.pct[i])) } }
  return sum + sp * (m.n + 1)
}

function layoutTable(tbl, cw, chDef) {
  const cs = tbl.cs
  normalizeTable(tbl)
  const collapse = cs.borderCollapse === 'collapse'
  const spH = collapse ? 0 : cs.spacingH, spV = collapse ? 0 : cs.spacingV
  const m = tableMetrics(tbl)
  const n = m.n
  if (collapse) {
    for (const row of tbl.tRows) for (const ci of row.cellInfo) {
      const c = ci.box
      const rb = row.box.cs.bw
      const bw = c.cs.bw.slice(), bs = c.cs.bs.slice(), bc = c.cs.bc.slice()
      if (row.box.cs.bs[2] !== 'none' && bs[2] === 'none') { bw[2] = rb[2]; bs[2] = row.box.cs.bs[2]; bc[2] = row.box.cs.bc[2] }
      if (row.box.cs.bs[0] !== 'none' && bs[0] === 'none') { bw[0] = rb[0]; bs[0] = row.box.cs.bs[0]; bc[0] = row.box.cs.bc[0] }
      c.cs.bw = bw; c.cs.bs = bs; c.cs.bc = bc
    }
    const grid = []
    for (const row of tbl.tRows) for (const ci of row.cellInfo) for (let r = 0; r < ci.rspan; r++) for (let k = 0; k < ci.cspan; k++) { grid[ci.ri + r] = grid[ci.ri + r] || []; grid[ci.ri + r][ci.col + k] = ci }
    for (const row of tbl.tRows) for (const ci of row.cellInfo) {
      const c = ci.box
      const left = ci.col > 0 && grid[ci.ri] && grid[ci.ri][ci.col - 1], up = ci.ri > 0 && grid[ci.ri - 1] && grid[ci.ri - 1][ci.col]
      if (left && left !== ci && left.box.cs.bw[1] > 0 && c.cs.bw[3] > 0) { c.cs.bw = c.cs.bw.slice(); c.cs.bw[3] = 0 }
      if (up && up !== ci && up.box.cs.bw[2] > 0 && c.cs.bw[0] > 0) { c.cs.bw = c.cs.bw.slice(); c.cs.bw[0] = 0 }
    }
    if (n) for (const row of tbl.tRows) for (const ci of row.cellInfo) { ci.box._imax = undefined; ci.box._imin = undefined }
  }
  const mm = collapse ? tableMetrics(tbl) : m
  const avail = Math.max(0, cw - spH * (n + 1))
  const widths = new Array(n).fill(0)
  if (n) {
    const pctCols = []
    let pctSum = 0
    for (let i = 0; i < n; i++) if (mm.pct[i]) { pctCols.push(i); pctSum += mm.pct[i] }
    const scale = pctSum > 100 ? 100 / pctSum : 1
    let rest = avail
    for (const i of pctCols) { widths[i] = Math.max(mm.mins[i], avail * mm.pct[i] * scale / 100); rest -= widths[i] }
    const others = []
    for (let i = 0; i < n; i++) if (!pctCols.includes(i)) others.push(i)
    const fixedLayout = cs.tableLayout === 'fixed' && cs.width !== 'auto'
    if (fixedLayout) {
      const spec = others.filter(i => mm.fixed[i] != null)
      let used = 0
      for (const i of spec) { widths[i] = mm.fixed[i]; used += widths[i] }
      const free = others.filter(i => mm.fixed[i] == null)
      const each = free.length ? Math.max(0, rest - used) / free.length : 0
      for (const i of free) widths[i] = each
    } else {
      const sMin = others.reduce((s, i) => s + mm.mins[i], 0), sMax = others.reduce((s, i) => s + mm.maxs[i], 0)
      if (rest >= sMax) {
        const extra = rest - sMax
        for (const i of others) widths[i] = mm.maxs[i] + (sMax > 0 ? extra * mm.maxs[i] / sMax : extra / others.length)
      } else if (rest > sMin && sMax > sMin) {
        for (const i of others) widths[i] = mm.mins[i] + (rest - sMin) * (mm.maxs[i] - mm.mins[i]) / (sMax - sMin)
      } else for (const i of others) widths[i] = mm.mins[i]
    }
  }
  const colX = []
  let x = spH
  for (let i = 0; i < n; i++) { colX.push(x); x += widths[i] + spH }
  const tableW = n ? x : cw
  const rowH = []
  const top = tbl.tCaps.filter(c => c.cs.captionSide !== 'bottom'), bottom = tbl.tCaps.filter(c => c.cs.captionSide === 'bottom')
  let capTop = 0
  for (const cp of top) { resolveEdges(cp, cw); layoutBox(cp, { cbw: cw, cbh: NaN }); cp.rx = cp.mar[3]; cp.ry = capTop + cp.mar[0]; capTop += cp.h + cp.mar[0] + cp.mar[2] }
  const spanW = ci => { let w = 0; for (let k = 0; k < ci.cspan && ci.col + k < n; k++) w += widths[ci.col + k]; return w + spH * (Math.min(ci.cspan, n - ci.col) - 1) }
  tbl.tRows.forEach((row, ri) => {
    let h = 0
    for (const ci of row.cellInfo) {
      layoutBox(ci.box, { w: spanW(ci), cbw: cw, cbh: NaN })
      ci.nat = ci.box.h
      if (ci.rspan === 1) h = Math.max(h, ci.box.h)
    }
    const rs = res(row.box.cs.height, NaN)
    if (rs != null) h = Math.max(h, rs)
    rowH[ri] = h
  })
  tbl.tRows.forEach((row, ri) => {
    for (const ci of row.cellInfo) {
      if (ci.rspan === 1) continue
      const end = Math.min(rowH.length, ri + ci.rspan)
      let cur = spV * (end - ri - 1)
      for (let k = ri; k < end; k++) cur += rowH[k]
      if (ci.nat > cur) rowH[end - 1] += ci.nat - cur
    }
  })
  const nr = rowH.length
  let total = spV * (nr + 1) + rowH.reduce((a, b) => a + b, 0)
  if (chDef === chDef) {
    const free = chDef - capTop - total - bottom.reduce((s, c) => s + c.h, 0)
    if (free > 0 && nr) { const sum = rowH.reduce((a, b) => a + b, 0); for (let i = 0; i < nr; i++) rowH[i] += sum > 0 ? free * rowH[i] / sum : free / nr; total += free }
  }
  const rowY = []
  let y = capTop + spV
  for (let i = 0; i < nr; i++) { rowY.push(y); y += rowH[i] + spV }
  tbl.tRows.forEach((row, ri) => {
    for (const ci of row.cellInfo) {
      const c = ci.box
      const end = Math.min(nr, ri + ci.rspan)
      let hh = spV * (end - ri - 1)
      for (let k = ri; k < end; k++) hh += rowH[k]
      const va = c.cs.verticalAlign
      const f = va === 'bottom' ? 1 : va === 'top' || va === 'text-top' ? 0 : 0.5
      const natCh = c.h
      c.h = hh
      c.ch = Math.max(0, hh - c.pad[0] - c.pad[2] - c.bor[0] - c.bor[2])
      c.vshift = Math.max(0, (hh - natCh) * f)
      c.rx = colX[ci.col]; c.ry = 0
      c.baseline = null
    }
  })
  const tcw = n ? tableW : cw
  for (const it of tbl.tItems) {
    if (it.row) {
      const ri = tbl.tRows.findIndex(r => r.box === it.box)
      const rb = it.box
      resolveEdges(rb, cw)
      rb.rx = 0; rb.ry = rowY[ri]; rb.w = tcw; rb.h = rowH[ri]; rb.ch = rb.h; rb.vshift = 0; rb.baseline = null
    } else {
      const first = tbl.tRows.findIndex(r => r.group === it.g)
      const idxs = []
      tbl.tRows.forEach((r, i) => { if (r.group === it.g) idxs.push(i) })
      const gb = it.box
      resolveEdges(gb, cw)
      const gy = rowY[idxs[0]] - (idxs.length ? 0 : 0)
      gb.rx = 0; gb.ry = idxs.length ? gy : 0
      gb.w = tcw; gb.h = idxs.length ? rowY[idxs[idxs.length - 1]] + rowH[idxs[idxs.length - 1]] - gy : 0; gb.ch = gb.h; gb.vshift = 0; gb.baseline = null
      for (const i of idxs) {
        const rb = tbl.tRows[i].box
        resolveEdges(rb, cw)
        rb.rx = 0; rb.ry = rowY[i] - gy; rb.w = tcw; rb.h = rowH[i]; rb.ch = rb.h; rb.vshift = 0; rb.baseline = null
      }
      void first
    }
  }
  let yEnd = nr ? y : capTop + spV
  if (!nr) yEnd = capTop
  for (const cp of bottom) { resolveEdges(cp, cw); layoutBox(cp, { cbw: cw, cbh: NaN }); cp.rx = cp.mar[3]; cp.ry = yEnd + cp.mar[0]; yEnd += cp.h + cp.mar[0] + cp.mar[2] }
  for (const c of tbl.children) if (c.oof) c.static = { x: 0, y: 0, p: tbl }
  return { ch: yEnd, baseline: null, empty: !nr }
}

function boxPass(src, dst, w, h, n, horiz) {
  const r1 = n >> 1, r2 = n - 1 - r1, inv = 1 / n
  const len = horiz ? w : h, lines = horiz ? h : w
  const step = horiz ? 1 : w, lstep = horiz ? w : 1
  for (let l = 0; l < lines; l++) {
    const base = l * lstep
    let sum = 0
    for (let k = 0; k <= r2 && k < len; k++) sum += src[base + k * step]
    for (let i = 0; i < len; i++) {
      dst[base + i * step] = sum * inv
      const add = i + r2 + 1, sub = i - r1
      if (add < len) sum += src[base + add * step]
      if (sub >= 0) sum -= src[base + sub * step]
    }
  }
}

function blurCov(data, w, h, sigma) {
  if (sigma < 0.3 || !w || !h) return data
  const n = Math.max(1, Math.round(Math.sqrt(12 * sigma * sigma / 3 + 1)))
  const t = new Float32Array(data.length), o = new Float32Array(data.length)
  boxPass(data, t, w, h, n, true); boxPass(t, o, w, h, n, false)
  boxPass(o, t, w, h, n, true); boxPass(t, o, w, h, n, false)
  boxPass(o, t, w, h, n, true); boxPass(t, o, w, h, n, false)
  return o
}

class Painter {
  constructor(w, h, ox = 0, oy = 0) {
    this.w = w; this.h = h; this.ox = ox; this.oy = oy
    this.buf = Buffer.alloc(w * h * 4)
    this.M = [1, 0, 0, 1, 0, 0]
    this.clip = { x0: 0, y0: 0, x1: w, y1: h, mask: null }
    this.stack = []
  }
  save() { this.stack.push({ M: this.M, clip: this.clip }) }
  restore() { const s = this.stack.pop(); if (s) { this.M = s.M; this.clip = s.clip } }
  mul(m) { this.M = mulM(this.M, m) }
  map(p) { const M = this.M; return { x: M[0] * p.x + M[2] * p.y + M[4] - this.ox, y: M[1] * p.x + M[3] * p.y + M[5] - this.oy } }
  mapPolys(polys) {
    const M = this.M, ox = this.ox, oy = this.oy
    return polys.map(poly => poly.map(p => ({ x: M[0] * p.x + M[2] * p.y + M[4] - ox, y: M[1] * p.x + M[3] * p.y + M[5] - oy })))
  }
  scale() { return Math.sqrt(Math.abs(this.M[0] * this.M[3] - this.M[1] * this.M[2])) || 1 }
  bounds(dp) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const poly of dp) for (const p of poly) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y }
    return { x0, y0, x1, y1 }
  }
  cover(polys, rule = 'nonzero', noClip = false, pad = 0) {
    const dp = this.mapPolys(polys)
    const b = this.bounds(dp)
    if (!(b.x0 <= b.x1)) return null
    const c = this.clip
    let x0 = Math.floor(b.x0) - pad, y0 = Math.floor(b.y0) - pad, x1 = Math.ceil(b.x1) + pad, y1 = Math.ceil(b.y1) + pad
    if (!noClip) { x0 = Math.max(x0, c.x0); y0 = Math.max(y0, c.y0); x1 = Math.min(x1, c.x1); y1 = Math.min(y1, c.y1) }
    else { x0 = Math.max(x0, c.x0 - pad); y0 = Math.max(y0, c.y0 - pad); x1 = Math.min(x1, c.x1 + pad); y1 = Math.min(y1, c.y1 + pad) }
    const w = x1 - x0, h = y1 - y0
    if (w <= 0 || h <= 0 || w * h > 120e6) return null
    const sh = dp.map(poly => poly.map(p => ({ x: p.x - x0, y: p.y - y0 })))
    return { x0, y0, w, h, data: fillPolygons(sh, w, h, rule) }
  }
  coverIn(polys, rule, region) {
    const dp = this.mapPolys(polys)
    const sh = dp.map(poly => poly.map(p => ({ x: p.x - region.x0, y: p.y - region.y0 })))
    return fillPolygons(sh, region.w, region.h, rule)
  }
  paint(cov, src, alpha = 1, blend) {
    if (!cov || alpha <= 0) return
    const W = this.w, buf = this.buf, clip = this.clip, mask = clip.mask
    const isFn = typeof src === 'function'
    let cr = 0, cg = 0, cb = 0, ca = alpha
    if (!isFn) { cr = src.r; cg = src.g; cb = src.b; ca = src.a * alpha }
    if (ca <= 0) return
    const inv = isFn ? invertM(this.M) : null
    const out = [0, 0, 0, 0]
    const ox = this.ox, oy = this.oy
    const xa = Math.max(cov.x0, clip.x0), xb = Math.min(cov.x0 + cov.w, clip.x1)
    const ya = Math.max(cov.y0, clip.y0), yb = Math.min(cov.y0 + cov.h, clip.y1)
    for (let py = ya; py < yb; py++) {
      const crow = (py - cov.y0) * cov.w - cov.x0
      for (let px = xa; px < xb; px++) {
        let c = cov.data[crow + px]
        if (c <= 0.002) continue
        if (mask) { const mv = mask.data[(py - mask.y0) * mask.w + (px - mask.x0)]; if (mv <= 0) continue; c *= mv }
        let r = cr, g = cg, b = cb, a = ca
        if (isFn) {
          const dx = px + 0.5 + ox, dy = py + 0.5 + oy
          src(inv[0] * dx + inv[2] * dy + inv[4], inv[1] * dx + inv[3] * dy + inv[5], out)
          r = out[0]; g = out[1]; b = out[2]; a = out[3] * alpha
          if (a <= 0) continue
        }
        const sa = c * a
        const di = (py * W + px) * 4
        if (blend) { const o = blend(buf, di, r, g, b, sa); if (o) continue }
        if (sa >= 0.999) { buf[di] = r; buf[di + 1] = g; buf[di + 2] = b; buf[di + 3] = 255; continue }
        const da = buf[di + 3] / 255, oa = sa + da * (1 - sa)
        if (oa <= 0) continue
        const k = da * (1 - sa)
        buf[di] = (r * sa + buf[di] * k) / oa + 0.5
        buf[di + 1] = (g * sa + buf[di + 1] * k) / oa + 0.5
        buf[di + 2] = (b * sa + buf[di + 2] * k) / oa + 0.5
        buf[di + 3] = oa * 255 + 0.5
      }
    }
  }
  fill(polys, src, alpha = 1, rule = 'nonzero') { this.paint(this.cover(polys, rule), src, alpha) }
  clipPolys(polys, rule = 'nonzero') {
    const old = this.clip
    const cov = this.cover(polys, rule)
    if (!cov) { this.clip = { x0: 0, y0: 0, x1: 0, y1: 0, mask: null }; return }
    const x0 = Math.max(cov.x0, old.x0), y0 = Math.max(cov.y0, old.y0), x1 = Math.min(cov.x0 + cov.w, old.x1), y1 = Math.min(cov.y0 + cov.h, old.y1)
    if (x1 <= x0 || y1 <= y0) { this.clip = { x0: 0, y0: 0, x1: 0, y1: 0, mask: null }; return }
    const w = x1 - x0, h = y1 - y0
    const data = new Float32Array(w * h)
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      let v = cov.data[(y - cov.y0) * cov.w + (x - cov.x0)]
      if (old.mask && v > 0) v *= old.mask.data[(y - old.mask.y0) * old.mask.w + (x - old.mask.x0)]
      data[(y - y0) * w + (x - x0)] = v
    }
    this.clip = { x0, y0, x1, y1, mask: { x0, y0, w, h, data } }
  }
  clipRect(x, y, w, h) {
    const a = this.map({ x, y }), b = this.map({ x: x + w, y: y + h }), c = this.map({ x: x + w, y }), d = this.map({ x, y: y + h })
    const axis = Math.abs(this.M[1]) < 1e-9 && Math.abs(this.M[2]) < 1e-9
    const old = this.clip
    if (axis) {
      const ix0 = Math.round(Math.min(a.x, b.x)), iy0 = Math.round(Math.min(a.y, b.y)), ix1 = Math.round(Math.max(a.x, b.x)), iy1 = Math.round(Math.max(a.y, b.y))
      if (Math.abs(a.x - ix0) < 0.02 && Math.abs(a.y - iy0) < 0.02 || true) {
        this.clip = { x0: Math.max(old.x0, ix0), y0: Math.max(old.y0, iy0), x1: Math.min(old.x1, ix1), y1: Math.min(old.y1, iy1), mask: old.mask }
        if (this.clip.x1 < this.clip.x0 || this.clip.y1 < this.clip.y0) this.clip = { x0: 0, y0: 0, x1: 0, y1: 0, mask: null }
        return
      }
    }
    this.clipPolys([[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]])
  }
  layer(bx, by, bw, bh) {
    const L = new Painter(bw, bh, this.ox + bx, this.oy + by)
    L.M = this.M
    return L
  }
  composite(L, opacity, filterFn, mode) {
    if (filterFn) filterFn(L)
    const bx = L.ox - this.ox, by = L.oy - this.oy
    const clip = this.clip, mask = clip.mask, W = this.w, buf = this.buf, lb = L.buf
    const xa = Math.max(bx, clip.x0), xb = Math.min(bx + L.w, clip.x1), ya = Math.max(by, clip.y0), yb = Math.min(by + L.h, clip.y1)
    for (let py = ya; py < yb; py++) for (let px = xa; px < xb; px++) {
      const li = ((py - by) * L.w + (px - bx)) * 4
      const la = lb[li + 3]
      if (!la) continue
      let sa = la / 255 * opacity
      if (mask) { const mv = mask.data[(py - mask.y0) * mask.w + (px - mask.x0)]; if (mv <= 0) continue; sa *= mv }
      const di = (py * W + px) * 4
      let sr = lb[li], sg = lb[li + 1], sb = lb[li + 2]
      if (mode) {
        const dA = buf[di + 3] / 255
        if (dA > 0) {
          const br = blendChannel(mode, buf[di], sr), bg = blendChannel(mode, buf[di + 1], sg), bb = blendChannel(mode, buf[di + 2], sb)
          sr = (1 - dA) * sr + dA * br; sg = (1 - dA) * sg + dA * bg; sb = (1 - dA) * sb + dA * bb
        }
      }
      if (sa >= 0.999) { buf[di] = sr; buf[di + 1] = sg; buf[di + 2] = sb; buf[di + 3] = 255; continue }
      const da = buf[di + 3] / 255, oa = sa + da * (1 - sa)
      if (oa <= 0) continue
      const k = da * (1 - sa)
      buf[di] = (sr * sa + buf[di] * k) / oa + 0.5
      buf[di + 1] = (sg * sa + buf[di + 1] * k) / oa + 0.5
      buf[di + 2] = (sb * sa + buf[di + 2] * k) / oa + 0.5
      buf[di + 3] = oa * 255 + 0.5
    }
  }
}

function blendChannel(mode, b, s) {
  b /= 255; s /= 255
  let r
  switch (mode) {
    case 'multiply': r = b * s; break
    case 'screen': r = b + s - b * s; break
    case 'overlay': r = b <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b); break
    case 'hard-light': r = s <= 0.5 ? 2 * s * b : 1 - 2 * (1 - s) * (1 - b); break
    case 'darken': r = Math.min(b, s); break
    case 'lighten': r = Math.max(b, s); break
    case 'difference': r = Math.abs(b - s); break
    case 'exclusion': r = b + s - 2 * b * s; break
    case 'color-dodge': r = b === 0 ? 0 : s >= 1 ? 1 : Math.min(1, b / (1 - s)); break
    case 'color-burn': r = b >= 1 ? 1 : s <= 0 ? 0 : 1 - Math.min(1, (1 - b) / s); break
    case 'soft-light': r = s <= 0.5 ? b - (1 - 2 * s) * b * (1 - b) : b + (2 * s - 1) * ((b <= 0.25 ? ((16 * b - 12) * b + 4) * b : Math.sqrt(b)) - b); break
    default: r = s
  }
  return r * 255
}

function rrPolys(x, y, w, h, r) {
  const [tl, tr, br, bl] = r
  const any = tl[0] > 0 || tl[1] > 0 || tr[0] > 0 || tr[1] > 0 || br[0] > 0 || br[1] > 0 || bl[0] > 0 || bl[1] > 0
  if (!any) return [[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]]
  const pts = []
  const arc = (cx, cy, rx, ry, a0, a1) => {
    if (rx <= 0 || ry <= 0) { pts.push({ x: cx, y: cy }); return }
    const steps = Math.max(4, Math.ceil(Math.max(rx, ry) * 0.9 * Math.abs(a1 - a0) / 1.57 / 2 + 3))
    for (let i = 0; i <= steps; i++) { const a = a0 + (a1 - a0) * i / steps; pts.push({ x: cx + rx * Math.cos(a), y: cy + ry * Math.sin(a) }) }
  }
  arc(x + tl[0], y + tl[1], tl[0], tl[1], Math.PI, Math.PI * 1.5)
  arc(x + w - tr[0], y + tr[1], tr[0], tr[1], Math.PI * 1.5, Math.PI * 2)
  arc(x + w - br[0], y + h - br[1], br[0], br[1], 0, Math.PI / 2)
  arc(x + bl[0], y + h - bl[1], bl[0], bl[1], Math.PI / 2, Math.PI)
  return [pts]
}

function resolveRadii(cs, w, h, sides) {
  const out = cs.radius.map(([a, b]) => {
    const rh = typeof a === 'function' ? a(w) : a, rv = typeof b === 'function' ? b(h) : b
    return [Math.max(0, rh || 0), Math.max(0, rv || 0)]
  })
  if (sides) {
    if (!sides.first) { out[0] = [0, 0]; out[3] = [0, 0] }
    if (!sides.last) { out[1] = [0, 0]; out[2] = [0, 0] }
  }
  let f = 1
  const chk = (a, b, len) => { const s = a + b; if (s > len && s > 0) f = Math.min(f, len / s) }
  chk(out[0][0], out[1][0], w); chk(out[3][0], out[2][0], w)
  chk(out[0][1], out[3][1], h); chk(out[1][1], out[2][1], h)
  if (f < 1) for (const r of out) { r[0] *= f; r[1] *= f }
  return out
}

function shrinkRadii(r, t, rr, b, l) {
  return [[Math.max(0, r[0][0] - l), Math.max(0, r[0][1] - t)], [Math.max(0, r[1][0] - rr), Math.max(0, r[1][1] - t)], [Math.max(0, r[2][0] - rr), Math.max(0, r[2][1] - b)], [Math.max(0, r[3][0] - l), Math.max(0, r[3][1] - b)]]
}

function growRadii(r, d) { return r.map(([a, b]) => [a > 0 ? Math.max(0, a + d) : 0, b > 0 ? Math.max(0, b + d) : 0]) }

function mixColor(c1, c2, t) { return { r: c1.r + (c2.r - c1.r) * t, g: c1.g + (c2.g - c1.g) * t, b: c1.b + (c2.b - c1.b) * t, a: c1.a + (c2.a - c1.a) * t } }

function resolvePos(str, E, aw, ah, ow, oh) {
  const t = tokens(String(str || '').trim().toLowerCase())
  const isX = k => k === 'left' || k === 'right', isY = k => k === 'top' || k === 'bottom'
  const kw = k => /^(left|right|top|bottom|center)$/.test(k)
  const val = (k, area, obj) => {
    if (k === 'center') return (area - obj) / 2
    if (k === 'left' || k === 'top') return 0
    if (k === 'right' || k === 'bottom') return area - obj
    const v = parseLen(k, E)
    if (typeof v === 'number') return v
    if (typeof v === 'function') return v(area - obj)
    return 0
  }
  const off = (k, o, area, obj) => {
    const v = parseLen(o, E)
    const n = typeof v === 'number' ? v : typeof v === 'function' ? v(area - obj) : 0
    return k === 'left' || k === 'top' ? n : area - obj - n
  }
  let x = null, y = null
  const items = []
  for (let i = 0; i < t.length; i++) {
    const k = t[i]
    if ((isX(k) || isY(k)) && t[i + 1] !== undefined && !kw(t[i + 1])) { items.push({ k, o: t[i + 1] }); i++ }
    else items.push({ k })
  }
  if (items.some(i => i.o !== undefined)) {
    for (const it of items) {
      if (isX(it.k)) x = it.o !== undefined ? off(it.k, it.o, aw, ow) : val(it.k, aw, ow)
      else if (isY(it.k)) y = it.o !== undefined ? off(it.k, it.o, ah, oh) : val(it.k, ah, oh)
      else if (it.k === 'center') { if (x == null) x = val('center', aw, ow); else y = val('center', ah, oh) }
    }
  } else {
    const k = items.map(i => i.k)
    if (k.length === 1) {
      if (isY(k[0])) { x = (aw - ow) / 2; y = val(k[0], ah, oh) } else { x = val(k[0], aw, ow); y = (ah - oh) / 2 }
    } else if (k.length >= 2) {
      let a = k[0], b = k[1]
      if (isY(a) || isX(b)) { const s = a; a = b; b = s }
      x = val(a, aw, ow); y = val(b, ah, oh)
    }
  }
  if (x == null) x = (aw - ow) / 2
  if (y == null) y = (ah - oh) / 2
  return [x, y]
}

function parseGradient(str, cur, E) {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\(([\s\S]*)\)$/i.exec(str.trim())
  if (!m) return null
  const g = { kind: m[2].toLowerCase(), repeating: !!m[1], E }
  let args = splitTop(m[3], ',').map(a => a.trim())
  const first = args[0] || ''
  const ft = tokens(first)
  const isColorTok = k => !!cssColor(k, cur)
  let prelude = null
  if (g.kind === 'linear') {
    if (/^to\s/i.test(first) || (ft.length === 1 && parseAngle(ft[0]) != null)) prelude = first
  } else if (g.kind === 'radial') {
    if (ft.length && (!isColorTok(ft[0]) || /^(circle|ellipse|closest|farthest|at)$/i.test(ft[0]))) prelude = first
  } else {
    if (/^(from|at)\b/i.test(first)) prelude = first
  }
  if (prelude != null) args = args.slice(1)
  const stops = []
  for (const a of args) {
    const tk = tokens(a)
    let col = null
    const pos = []
    for (const k of tk) {
      const c = /^[+-]?[\d.]/.test(k) ? null : cssColor(k, cur)
      if (c) col = c; else pos.push(k)
    }
    if (!col) { if (pos.length) stops.push({ hint: pos[0] }); continue }
    if (!pos.length) stops.push({ c: col, p: null })
    else for (const p of pos.slice(0, 2)) stops.push({ c: col, p })
  }
  g.stops = stops.filter(s => s.c)
  if (g.stops.length < 1) return null
  if (g.stops.length === 1) g.stops.push({ c: g.stops[0].c, p: null })
  const pl = (prelude || '').toLowerCase()
  if (g.kind === 'linear') {
    g.angle = 180
    if (prelude) {
      if (/^to\s/.test(pl)) {
        const w = pl.slice(2).trim().split(/\s+/)
        const sx = w.includes('right') ? 1 : w.includes('left') ? -1 : 0
        const sy = w.includes('bottom') ? 1 : w.includes('top') ? -1 : 0
        if (sx && sy) g.corner = [sx, sy]
        else g.angle = sx === 1 ? 90 : sx === -1 ? 270 : sy === -1 ? 0 : 180
      } else g.angle = parseAngle(pl)
    }
  } else if (g.kind === 'radial') {
    const at = /\bat\s+(.*)$/.exec(pl)
    g.at = at ? at[1] : '50% 50%'
    const head = at ? pl.slice(0, at.index).trim() : pl
    g.circle = /\bcircle\b/.test(head)
    const sz = /(closest-side|farthest-side|closest-corner|farthest-corner)/.exec(head)
    g.size = sz ? sz[1] : null
    const lens = tokens(head).filter(k => /^[+-]?[\d.]/.test(k) || /^(calc|min|max|clamp)\(/.test(k))
    if (lens.length) { g.lens = lens; if (lens.length === 1 && !/\bellipse\b/.test(head)) g.circle = true }
    if (!g.size && !g.lens) g.size = 'farthest-corner'
  } else {
    const fr = /\bfrom\s+(\S+)/.exec(pl), at = /\bat\s+(.*)$/.exec(pl)
    g.from = fr ? (parseAngle(fr[1]) || 0) : 0
    g.at = at ? at[1] : '50% 50%'
  }
  return g
}

function resolveStops(stops, basis, isAngle, E) {
  const arr = stops.map(s => {
    let f = null
    if (s.p != null) {
      if (isAngle) {
        const a = parseAngle(s.p)
        if (a != null && !/%$/.test(s.p)) f = a / 360
        else if (/%$/.test(s.p)) f = parseFloat(s.p) / 100
      } else {
        const v = parseLen(s.p, E)
        if (typeof v === 'number') f = basis > 0 ? v / basis : 0
        else if (typeof v === 'function') f = basis > 0 ? v(basis) / basis : 0
      }
    }
    return { c: s.c, f }
  })
  if (arr[0].f == null) arr[0].f = 0
  if (arr[arr.length - 1].f == null) arr[arr.length - 1].f = isAngle ? 1 : 1
  let prev = arr[0].f
  for (let i = 1; i < arr.length; i++) { if (arr[i].f != null) { if (arr[i].f < prev) arr[i].f = prev; prev = arr[i].f } }
  let i = 0
  while (i < arr.length) {
    if (arr[i].f != null) { i++; continue }
    let j = i
    while (arr[j].f == null) j++
    const a = arr[i - 1].f, b = arr[j].f
    for (let k = i; k < j; k++) arr[k].f = a + (b - a) * (k - i + 1) / (j - i + 1)
    i = j
  }
  return arr
}

function buildLut(stops, n = 2048) {
  const lut = new Float32Array((n + 1) * 4)
  const f0 = stops[0].f, f1 = stops[stops.length - 1].f
  let j = 0
  for (let i = 0; i <= n; i++) {
    const t = f0 + (f1 - f0) * i / n
    while (j < stops.length - 2 && stops[j + 1].f <= t) j++
    const a = stops[j], b = stops[j + 1]
    let u = b.f > a.f ? (t - a.f) / (b.f - a.f) : 1
    if (u < 0) u = 0; else if (u > 1) u = 1
    const pa = a.c.a, pb = b.c.a
    const al = pa * (1 - u) + pb * u
    const o = i * 4
    if (al > 0) {
      lut[o] = (a.c.r * pa * (1 - u) + b.c.r * pb * u) / al
      lut[o + 1] = (a.c.g * pa * (1 - u) + b.c.g * pb * u) / al
      lut[o + 2] = (a.c.b * pa * (1 - u) + b.c.b * pb * u) / al
    }
    lut[o + 3] = al
  }
  return { lut, f0, f1, n }
}

function lutLookup(L, t, repeating, out) {
  const f0 = L.f0, f1 = L.f1
  if (repeating) {
    const span = f1 - f0
    if (span <= 1e-9) t = f0
    else { t = (t - f0) % span; if (t < 0) t += span; t += f0 }
  } else if (t < f0) t = f0
  else if (t > f1) t = f1
  const idx = f1 > f0 ? Math.round((t - f0) / (f1 - f0) * L.n) * 4 : 0
  out[0] = L.lut[idx]; out[1] = L.lut[idx + 1]; out[2] = L.lut[idx + 2]; out[3] = L.lut[idx + 3]
}

function makeGradientFn(g, W, H) {
  const E = g.E
  if (g.kind === 'linear') {
    let dx, dy
    if (g.corner) {
      const sx = g.corner[0], sy = g.corner[1]
      const nrm = Math.hypot(H, W) || 1
      dx = sx * H / nrm; dy = sy * W / nrm
    } else {
      const a = g.angle * Math.PI / 180
      dx = Math.sin(a); dy = -Math.cos(a)
    }
    const L = Math.abs(W * dx) + Math.abs(H * dy) || 1
    const lut = buildLut(resolveStops(g.stops, L, false, E))
    const cx = W / 2, cy = H / 2, rep = g.repeating
    return (u, v, out) => lutLookup(lut, ((u - cx) * dx + (v - cy) * dy) / L + 0.5, rep, out)
  }
  const [cx, cy] = resolvePos(g.at, E, W, H, 0, 0)
  if (g.kind === 'radial') {
    const clX = Math.min(Math.abs(cx), Math.abs(W - cx)), faX = Math.max(Math.abs(cx), Math.abs(W - cx))
    const clY = Math.min(Math.abs(cy), Math.abs(H - cy)), faY = Math.max(Math.abs(cy), Math.abs(H - cy))
    let rx, ry
    if (g.lens) {
      const pr = (k, base) => { const v = parseLen(k, E); return typeof v === 'number' ? v : typeof v === 'function' ? v(base) : 0 }
      if (g.circle) { rx = ry = pr(g.lens[0], W) } else { rx = pr(g.lens[0], W); ry = pr(g.lens[1] !== undefined ? g.lens[1] : g.lens[0], H) }
    } else {
      switch (g.size) {
        case 'closest-side': if (g.circle) rx = ry = Math.min(clX, clY); else { rx = clX; ry = clY } break
        case 'farthest-side': if (g.circle) rx = ry = Math.max(faX, faY); else { rx = faX; ry = faY } break
        case 'closest-corner': if (g.circle) rx = ry = Math.hypot(clX, clY); else { rx = clX * Math.SQRT2; ry = clY * Math.SQRT2 } break
        default: if (g.circle) rx = ry = Math.hypot(faX, faY); else { rx = faX * Math.SQRT2; ry = faY * Math.SQRT2 }
      }
    }
    rx = Math.max(rx, 1e-4); ry = Math.max(ry, 1e-4)
    const lut = buildLut(resolveStops(g.stops, rx, false, E))
    const rep = g.repeating
    return (u, v, out) => lutLookup(lut, Math.hypot((u - cx) / rx, (v - cy) / ry), rep, out)
  }
  const lut = buildLut(resolveStops(g.stops, 1, true, E))
  const from = g.from / 360, rep = g.repeating
  return (u, v, out) => {
    let t = Math.atan2(u - cx, -(v - cy)) / (Math.PI * 2) - from
    t -= Math.floor(t)
    lutLookup(lut, t, rep, out)
  }
}

function mipOf(bm) {
  if (bm.mip) return bm.mip
  const w = Math.max(1, bm.w >> 1), h = Math.max(1, bm.h >> 1)
  const d = Buffer.alloc(w * h * 4)
  const s = bm.data
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(bm.h - 1, y * 2), y1 = Math.min(bm.h - 1, y * 2 + 1)
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(bm.w - 1, x * 2), x1 = Math.min(bm.w - 1, x * 2 + 1)
      const i0 = (y0 * bm.w + x0) * 4, i1 = (y0 * bm.w + x1) * 4, i2 = (y1 * bm.w + x0) * 4, i3 = (y1 * bm.w + x1) * 4
      const a0 = s[i0 + 3], a1 = s[i1 + 3], a2 = s[i2 + 3], a3 = s[i3 + 3]
      const at = a0 + a1 + a2 + a3
      const o = (y * w + x) * 4
      if (at > 0) {
        d[o] = (s[i0] * a0 + s[i1] * a1 + s[i2] * a2 + s[i3] * a3) / at + 0.5
        d[o + 1] = (s[i0 + 1] * a0 + s[i1 + 1] * a1 + s[i2 + 1] * a2 + s[i3 + 1] * a3) / at + 0.5
        d[o + 2] = (s[i0 + 2] * a0 + s[i1 + 2] * a1 + s[i2 + 2] * a2 + s[i3 + 2] * a3) / at + 0.5
      }
      d[o + 3] = at / 4 + 0.5
    }
  }
  bm.mip = { w, h, data: d }
  return bm.mip
}

function bitmapFor(img, tw, th, sc, noMip) {
  if (img.svg) {
    const pw = Math.max(1, Math.min(4096, Math.ceil(tw * sc))), ph = Math.max(1, Math.min(4096, Math.ceil(th * sc)))
    const key = pw + 'x' + ph
    img.rast = img.rast || new Map()
    let r = img.rast.get(key)
    if (!r) { r = rasterSvgImage(img, pw, ph); if (img.rast.size > 8) img.rast.clear(); img.rast.set(key, r) }
    return r
  }
  let bm = img
  const tpw = tw * sc, tph = th * sc
  let guard = 0
  while (!noMip && guard++ < 12 && bm.w >= tpw * 2 && bm.h >= tph * 2 && bm.w > 1 && bm.h > 1) bm = mipOf(bm)
  return bm
}

function sampleBilinear(bm, x, y, out) {
  const w = bm.w, h = bm.h, d = bm.data
  const fx = x - 0.5, fy = y - 0.5
  let x0 = Math.floor(fx), y0 = Math.floor(fy)
  const tx = fx - x0, ty = fy - y0
  let x1 = x0 + 1, y1 = y0 + 1
  x0 = x0 < 0 ? 0 : x0 >= w ? w - 1 : x0; x1 = x1 < 0 ? 0 : x1 >= w ? w - 1 : x1
  y0 = y0 < 0 ? 0 : y0 >= h ? h - 1 : y0; y1 = y1 < 0 ? 0 : y1 >= h ? h - 1 : y1
  const i0 = (y0 * w + x0) * 4, i1 = (y0 * w + x1) * 4, i2 = (y1 * w + x0) * 4, i3 = (y1 * w + x1) * 4
  const w0 = (1 - tx) * (1 - ty), w1 = tx * (1 - ty), w2 = (1 - tx) * ty, w3 = tx * ty
  const a0 = d[i0 + 3] * w0, a1 = d[i1 + 3] * w1, a2 = d[i2 + 3] * w2, a3 = d[i3 + 3] * w3
  const a = a0 + a1 + a2 + a3
  if (a <= 0) { out[3] = 0; return }
  out[0] = (d[i0] * a0 + d[i1] * a1 + d[i2] * a2 + d[i3] * a3) / a
  out[1] = (d[i0 + 1] * a0 + d[i1 + 1] * a1 + d[i2 + 1] * a2 + d[i3 + 1] * a3) / a
  out[2] = (d[i0 + 2] * a0 + d[i1 + 2] * a1 + d[i2 + 2] * a2 + d[i3 + 2] * a3) / a
  out[3] = a / 255
}

function sampleNearest(bm, x, y, out) {
  let xi = Math.floor(x), yi = Math.floor(y)
  xi = xi < 0 ? 0 : xi >= bm.w ? bm.w - 1 : xi; yi = yi < 0 ? 0 : yi >= bm.h ? bm.h - 1 : yi
  const i = (yi * bm.w + xi) * 4
  out[0] = bm.data[i]; out[1] = bm.data[i + 1]; out[2] = bm.data[i + 2]; out[3] = bm.data[i + 3] / 255
}

function imageTileFn(img, tw, th, sc, pixelated, sub) {
  const bm = bitmapFor(img, tw, th, sc, pixelated)
  const sample = pixelated ? sampleNearest : sampleBilinear
  if (img.svg) {
    const kx = bm.w / tw, ky = bm.h / th
    return (u, v, out) => sample(bm, u * kx, v * ky, out)
  }
  const s = sub || { x: 0, y: 0, w: img.w, h: img.h }
  const fx = bm.w / img.w, fy = bm.h / img.h
  const ax = s.w / tw, ay = s.h / th
  return (u, v, out) => sample(bm, (s.x + u * ax) * fx, (s.y + v * ay) * fy, out)
}

function parseBgSize(str, E, aw, ah, nat) {
  const s = (str || 'auto').trim().toLowerCase()
  const nw = nat && nat.w > 0 ? nat.w : null, nh = nat && nat.h > 0 ? nat.h : null
  const ratio = nw && nh ? nw / nh : null
  if (s === 'cover' || s === 'contain') {
    if (!ratio) return [aw, ah]
    const k = s === 'cover' ? Math.max(aw / nw, ah / nh) : Math.min(aw / nw, ah / nh)
    return [nw * k, nh * k]
  }
  const t = tokens(s)
  const one = (k, base) => { if (k === undefined || k === 'auto') return null; const v = parseLen(k, E); return typeof v === 'number' ? v : typeof v === 'function' ? v(base) : null }
  let w = one(t[0], aw), h = one(t[1], ah)
  if (w == null && h == null) {
    if (nw != null && nh != null) { w = nw; h = nh }
    else if (ratio) { w = aw; h = aw / ratio; if (nw == null && nh != null) { h = nh; w = nh * ratio } }
    else { w = nw != null ? nw : aw; h = nh != null ? nh : ah }
  } else if (w == null) w = ratio ? h * ratio : nw != null ? nw : aw
  else if (h == null) h = ratio ? w / ratio : nh != null ? nh : ah
  return [Math.max(0, w), Math.max(0, h)]
}

function bgLayerShader(layer, area, E, cur, sc) {
  let natural = null, tileFn = null, g = null, img = null
  const im = layer.image.trim()
  if (/^(repeating-)?(linear|radial|conic)-gradient\(/i.test(im)) {
    if (layer.__g === undefined) layer.__g = parseGradient(im, cur, E)
    g = layer.__g
    if (!g) return null
  } else if (/^url\(/i.test(im)) {
    const u = im.replace(/^url\(\s*["']?|["']?\s*\)$/g, '')
    const key = C.resolveUrl(u)
    img = key ? C.images.get(key) : null
    if (!img || !(img.w > 0)) return null
    natural = { w: img.w, h: img.h }
  } else return null
  let [tw, th] = parseBgSize(layer.size, E, area.w, area.h, natural)
  const rep = tokens((layer.repeat || 'repeat').toLowerCase())
  let rx = rep[0] || 'repeat', ry = rep[1] || (rep[0] === 'repeat-x' ? 'no-repeat' : rep[0] === 'repeat-y' ? 'no-repeat' : rep[0] || 'repeat')
  if (rx === 'repeat-x') { rx = 'repeat'; ry = 'no-repeat' } else if (rx === 'repeat-y') { rx = 'no-repeat'; ry = 'repeat' }
  if (tw <= 0 || th <= 0) return null
  if (rx === 'round' && tw > 0) tw = area.w / Math.max(1, Math.round(area.w / tw))
  if (ry === 'round' && th > 0) th = area.h / Math.max(1, Math.round(area.h / th))
  const fn = g ? makeGradientFn(g, tw, th) : imageTileFn(img, tw, th, sc, /pixelated|crisp-edges/.test(layer.rendering || ''))
  let [px, py] = resolvePos(layer.pos, E, area.w, area.h, tw, th)
  let gapX = 0, gapY = 0
  if (rx === 'space') { const n = Math.floor(area.w / tw); if (n >= 2) { gapX = (area.w - n * tw) / (n - 1); px = 0 } else rx = 'no-repeat' }
  if (ry === 'space') { const n = Math.floor(area.h / th); if (n >= 2) { gapY = (area.h - n * th) / (n - 1); py = 0 } else ry = 'no-repeat' }
  const ox = area.x + px, oy = area.y + py
  const perX = tw + gapX, perY = th + gapY
  const repX = rx === 'repeat' || rx === 'round' || rx === 'space', repY = ry === 'repeat' || ry === 'round' || ry === 'space'
  return (lx, ly, out) => {
    let u = lx - ox, v = ly - oy
    if (repX) { u %= perX; if (u < 0) u += perX; if (u >= tw) { out[3] = 0; return } }
    else if (u < 0 || u >= tw) { out[3] = 0; return }
    if (repY) { v %= perY; if (v < 0) v += perY; if (v >= th) { out[3] = 0; return } }
    else if (v < 0 || v >= th) { out[3] = 0; return }
    fn(u, v, out)
  }
}

function boxRects(box) {
  const x = box.ax, y = box.ay, w = box.w, h = box.h
  const [bt, br, bb, bl] = box.bor, [pt, pr, pb, pl] = box.pad
  const border = { x, y, w, h }
  const padding = { x: x + bl, y: y + bt, w: Math.max(0, w - bl - br), h: Math.max(0, h - bt - bb) }
  const content = { x: padding.x + pl, y: padding.y + pt, w: Math.max(0, padding.w - pl - pr), h: Math.max(0, padding.h - pt - pb) }
  return { border, padding, content }
}

function rectRadii(cs, R, radii) {
  const [bt, br, bb, bl] = [R.padding.y - R.border.y, R.border.x + R.border.w - R.padding.x - R.padding.w, R.border.y + R.border.h - R.padding.y - R.padding.h, R.padding.x - R.border.x]
  const pr = shrinkRadii(radii, bt, br, bb, bl)
  const ct = R.content.y - R.padding.y, cr = R.padding.x + R.padding.w - R.content.x - R.content.w, cb = R.padding.y + R.padding.h - R.content.y - R.content.h, cl = R.content.x - R.padding.x
  return { border: radii, padding: pr, content: shrinkRadii(pr, ct, cr, cb, cl) }
}

function paintBackground(P, cs, R, radii, opt = {}) {
  const RR = rectRadii(cs, R, radii)
  const polysOf = k => { const r = R[k]; return rrPolys(r.x, r.y, r.w, r.h, RR[k]) }
  const sc = P.scale()
  const clipName = (cs.raw['background-clip'] || 'border-box').split(',').pop().trim()
  if (cs.bgColor.a > 0 && (clipName !== 'text' || opt.textClip)) {
    const k = clipName === 'padding-box' ? 'padding' : clipName === 'content-box' ? 'content' : 'border'
    const polys = opt.canvas ? [[{ x: opt.canvas.x, y: opt.canvas.y }, { x: opt.canvas.x + opt.canvas.w, y: opt.canvas.y }, { x: opt.canvas.x + opt.canvas.w, y: opt.canvas.y + opt.canvas.h }, { x: opt.canvas.x, y: opt.canvas.y + opt.canvas.h }]] : polysOf(k)
    P.fill(polys, cs.bgColor)
  }
  const rendering = cs.raw['image-rendering'] || ''
  for (let i = cs.bgLayers.length - 1; i >= 0; i--) {
    const layer = cs.bgLayers[i]
    layer.rendering = rendering
    const origin = layer.origin === 'border-box' ? R.border : layer.origin === 'content-box' ? R.content : R.padding
    const ck = layer.clip === 'padding-box' ? 'padding' : layer.clip === 'content-box' ? 'content' : 'border'
    if (layer.clip === 'text' && !opt.textClip) continue
    const shader = bgLayerShader(layer, origin, cs.E, cs.color, sc)
    if (!shader) continue
    const polys = opt.canvas ? [[{ x: opt.canvas.x, y: opt.canvas.y }, { x: opt.canvas.x + opt.canvas.w, y: opt.canvas.y }, { x: opt.canvas.x + opt.canvas.w, y: opt.canvas.y + opt.canvas.h }, { x: opt.canvas.x, y: opt.canvas.y + opt.canvas.h }]] : polysOf(ck)
    P.fill(polys, shader)
  }
}

function shade(c, k) {
  if (k < 0) return { r: c.r * (1 + k), g: c.g * (1 + k), b: c.b * (1 + k), a: c.a }
  return { r: c.r + (255 - c.r) * k, g: c.g + (255 - c.g) * k, b: c.b + (255 - c.b) * k, a: c.a }
}

function bandPolys(x, y, w, h, R, bw, f0, f1) {
  const o0 = bw.map(v => v * f0), o1 = bw.map(v => v * f1)
  const one = o => rrPolys(x + o[3], y + o[0], Math.max(0, w - o[1] - o[3]), Math.max(0, h - o[0] - o[2]), shrinkRadii(R, o[0], o[1], o[2], o[3]))
  return one(o0).concat(one(o1))
}

function wedgePoly(i, x, y, w, h, bw) {
  const [t, r, b, l] = bw
  switch (i) {
    case 0: return [{ x, y }, { x: x + w, y }, { x: x + w - r, y: y + t }, { x: x + l, y: y + t }]
    case 1: return [{ x: x + w, y }, { x: x + w, y: y + h }, { x: x + w - r, y: y + h - b }, { x: x + w - r, y: y + t }]
    case 2: return [{ x: x + w, y: y + h }, { x, y: y + h }, { x: x + l, y: y + h - b }, { x: x + w - r, y: y + h - b }]
    default: return [{ x, y: y + h }, { x, y }, { x: x + l, y: y + t }, { x: x + l, y: y + h - b }]
  }
}

function sideColor(style, c, i) {
  if (style === 'inset') return i === 0 || i === 3 ? shade(c, -0.4) : shade(c, 0.0)
  if (style === 'outset') return i === 0 || i === 3 ? shade(c, 0.0) : shade(c, -0.4)
  return c
}

function dashPolysSide(i, x, y, w, h, bw, style) {
  const [t, r, b, l] = bw
  const polys = []
  const horiz = i === 0 || i === 2
  const th = bw[i]
  const x0 = horiz ? x : i === 1 ? x + w - th : x
  const y0 = horiz ? (i === 0 ? y : y + h - th) : y
  const len = horiz ? w : h
  const dash = style === 'dotted' ? th : th * 3, gap = style === 'dotted' ? th : th * 2
  const n = Math.max(1, Math.round((len + gap) / (dash + gap)))
  const per = len / n
  const dl = per * dash / (dash + gap)
  for (let k = 0; k < n; k++) {
    const s = k * per
    if (style === 'dotted') {
      const cx = horiz ? x0 + s + per / 2 : x0 + th / 2, cy = horiz ? y0 + th / 2 : y0 + s + per / 2
      const rr = th / 2, steps = Math.max(8, Math.ceil(rr * 4))
      const p = []
      for (let q = 0; q < steps; q++) p.push({ x: cx + rr * Math.cos(q / steps * Math.PI * 2), y: cy + rr * Math.sin(q / steps * Math.PI * 2) })
      polys.push(p)
    } else if (horiz) polys.push([{ x: x0 + s, y: y0 }, { x: x0 + s + dl, y: y0 }, { x: x0 + s + dl, y: y0 + th }, { x: x0 + s, y: y0 + th }])
    else polys.push([{ x: x0, y: y0 + s }, { x: x0 + th, y: y0 + s }, { x: x0 + th, y: y0 + s + dl }, { x: x0, y: y0 + s + dl }])
  }
  return polys
}

function dashedRing(P, x, y, w, h, R, th, style, color) {
  const path = rrPolys(x + th / 2, y + th / 2, Math.max(0, w - th), Math.max(0, h - th), shrinkRadii(R, th / 2, th / 2, th / 2, th / 2))[0]
  const pts = path.concat([path[0]])
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  const total = cum[cum.length - 1]
  if (total <= 0) return
  const dash = style === 'dotted' ? th : th * 3, gap = style === 'dotted' ? th : th * 2
  const n = Math.max(1, Math.round(total / (dash + gap)))
  const per = total / n, dl = style === 'dotted' ? th : per * dash / (dash + gap)
  const at = s => {
    let lo = 0, hi = cum.length - 1
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] <= s) lo = m; else hi = m }
    const seg = cum[hi] - cum[lo] || 1, f = (s - cum[lo]) / seg
    return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * f, y: pts[lo].y + (pts[hi].y - pts[lo].y) * f, i: lo }
  }
  const polys = []
  for (let k = 0; k < n; k++) {
    if (style === 'dotted') {
      const c = at(k * per + per / 2), rr = th / 2, steps = Math.max(8, Math.ceil(rr * 4))
      const p = []
      for (let q = 0; q < steps; q++) p.push({ x: c.x + rr * Math.cos(q / steps * Math.PI * 2), y: c.y + rr * Math.sin(q / steps * Math.PI * 2) })
      polys.push(p)
    } else {
      const s0 = k * per, s1 = s0 + dl
      const a = at(s0), b = at(Math.min(total, s1))
      const sub = [{ x: a.x, y: a.y }]
      for (let i = a.i + 1; i <= b.i; i++) sub.push(pts[i])
      sub.push({ x: b.x, y: b.y })
      polys.push(...strokeToPolygons([{ pts: sub, closed: false }], th, 'butt', 'miter'))
    }
  }
  P.fill(polys, color, 1, 'nonzero')
}

function paintBorderRect(P, x, y, w, h, R, bw, bs, bc, native) {
  if (bw.every(v => !(v > 0))) return
  if (native) {
    const c = bc[0]
    P.fill(bandPolys(x, y, w, h, R, [1, 1, 1, 1], 0, 1), c, 1, 'evenodd')
    return
  }
  const same = i => bs[i] === bs[0] && bw[i] === bw[0] && bc[i].r === bc[0].r && bc[i].g === bc[0].g && bc[i].b === bc[0].b && bc[i].a === bc[0].a
  const uniform = [1, 2, 3].every(same)
  if (uniform && (bs[0] === 'dashed' || bs[0] === 'dotted')) { dashedRing(P, x, y, w, h, R, bw[0], bs[0], bc[0]); return }
  const sameColorSolid = bs.every(s => s === 'solid') && bc.every(c => c.r === bc[0].r && c.g === bc[0].g && c.b === bc[0].b && c.a === bc[0].a)
  if (sameColorSolid) { P.fill(bandPolys(x, y, w, h, R, bw, 0, 1), bc[0], 1, 'evenodd'); return }
  for (let i = 0; i < 4; i++) {
    if (!(bw[i] > 0) || bs[i] === 'none' || bs[i] === 'hidden') continue
    const st = bs[i]
    P.save()
    if (!uniform || st === 'inset' || st === 'outset' || st === 'groove' || st === 'ridge' || st === 'double' || bs.some(s => s !== st)) P.clipPolys([wedgePoly(i, x, y, w, h, bw)])
    let bands
    const c = bc[i]
    switch (st) {
      case 'double': bands = bw[i] >= 3 ? [[0, 1 / 3, c], [2 / 3, 1, c]] : [[0, 1, c]]; break
      case 'groove': bands = [[0, 0.5, shade(c, i === 0 || i === 3 ? -0.4 : 0)], [0.5, 1, shade(c, i === 0 || i === 3 ? 0 : -0.4)]]; break
      case 'ridge': bands = [[0, 0.5, shade(c, i === 0 || i === 3 ? 0 : -0.4)], [0.5, 1, shade(c, i === 0 || i === 3 ? -0.4 : 0)]]; break
      case 'inset': case 'outset': bands = [[0, 1, sideColor(st, c, i)]]; break
      case 'dashed': case 'dotted': {
        const polys = dashPolysSide(i, x, y, w, h, bw, st)
        P.clipPolys(bandPolys(x, y, w, h, R, bw, 0, 1), 'evenodd')
        P.fill(polys, c, 1, 'nonzero')
        P.restore()
        continue
      }
      default: bands = [[0, 1, c]]
    }
    for (const [f0, f1, col] of bands) P.fill(bandPolys(x, y, w, h, R, bw, f0, f1), col, 1, 'evenodd')
    P.restore()
  }
}

function paintOutline(P, cs, R, radii) {
  const o = cs.outline
  if (!o || !(o.w > 0)) return
  const d = o.offset + o.w
  const b = R.border
  const x = b.x - d, y = b.y - d, w = b.w + d * 2, h = b.h + d * 2
  const rr = growRadii(radii, d)
  const st = o.style === 'auto' ? 'solid' : o.style
  paintBorderRect(P, x, y, w, h, rr, [o.w, o.w, o.w, o.w], [st, st, st, st], [o.color, o.color, o.color, o.color], false)
}

function paintBoxShadows(P, cs, R, radii, inset) {
  const list = cs.shadows.filter(s => !!s.inset === inset)
  if (!list.length) return
  const b = R.border
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i]
    if (!inset) {
      const sp = s.spread
      const rr = growRadii(radii, sp)
      const polys = rrPolys(b.x + s.x - sp, b.y + s.y - sp, Math.max(0, b.w + sp * 2), Math.max(0, b.h + sp * 2), rr)
      const sigma = s.blur / 2
      const cov = P.cover(polys, 'nonzero', true, Math.ceil(sigma * 3 * P.scale()) + 2)
      if (!cov) continue
      if (sigma >= 0.3) cov.data = blurCov(cov.data, cov.w, cov.h, sigma * P.scale())
      const inner = P.coverIn(rrPolys(b.x, b.y, b.w, b.h, radii), 'nonzero', cov)
      for (let k = 0; k < cov.data.length; k++) if (inner[k] > 0) cov.data[k] *= 1 - inner[k]
      P.paint(cov, s.color, 1)
    } else {
      const pad = R.padding
      const rp = rectRadii(cs, R, radii).padding
      const sp = s.spread
      const hx = pad.x + s.x + sp, hy = pad.y + s.y + sp, hw = pad.w - sp * 2, hh = pad.h - sp * 2
      const hole = hw > 0 && hh > 0 ? rrPolys(hx, hy, hw, hh, growRadii(rp, -sp)) : []
      const m = Math.ceil(s.blur * 1.5) + Math.abs(s.x) + Math.abs(s.y) + Math.abs(sp) + 4
      const outer = [[{ x: pad.x - m, y: pad.y - m }, { x: pad.x + pad.w + m, y: pad.y - m }, { x: pad.x + pad.w + m, y: pad.y + pad.h + m }, { x: pad.x - m, y: pad.y + pad.h + m }]]
      const sigma = s.blur / 2
      const cov = P.cover(outer.concat(hole), 'evenodd', false, 0)
      if (!cov) continue
      if (sigma >= 0.3) cov.data = blurCov(cov.data, cov.w, cov.h, sigma * P.scale())
      P.save()
      P.clipPolys(rrPolys(pad.x, pad.y, pad.w, pad.h, rp))
      P.paint(cov, s.color, 1)
      P.restore()
    }
  }
}

function glyphPolysFor(fi, str, X, Y, width, synthItalic) {
  const run = glyphRun(fi, str)
  let extra = 0
  if (width != null) {
    let n = 0
    for (const gl of run.glyphs) if (gl.cp === 32 || gl.cp === 0xa0) n++
    if (n && Math.abs(width - run.width) > 0.01) extra = (width - run.width) / n
  }
  const polys = []
  let acc = 0
  for (const gl of run.glyphs) {
    if (gl.cp === 32 || gl.cp === 0xa0) { acc += extra; continue }
    if (!gl.t) continue
    const base = glyphBase(fi, gl)
    const gx = X + gl.x + acc
    for (const poly of base) {
      const q = new Array(poly.length)
      for (let i = 0; i < poly.length; i++) {
        const p = poly[i]
        q[i] = { x: p.x + gx - (synthItalic ? p.y * 0.2 : 0), y: p.y + Y }
      }
      polys.push(q)
    }
  }
  return { polys, width: run.width }
}

function shiftPolys(polys, dx, dy) {
  return polys.map(poly => poly.map(p => ({ x: p.x + dx, y: p.y + dy })))
}

function inChain(cs, target) {
  for (let c = cs; c; c = c.parent) if (c === target) return true
  return false
}

function paintDecoration(P, f, X, Y, w) {
  const fi = f.fi
  for (const d of f.cs.decos) {
    const size = fi.size
    const th = Math.max(1, size * 0.07)
    let top
    if (d.line === 'underline') top = Y + size * 0.1
    else if (d.line === 'overline') top = Y - fi.asc
    else top = Y - fi.xh * 0.55 - th / 2
    const col = d.color
    const rect = (x, y, ww, hh) => [{ x, y }, { x: x + ww, y }, { x: x + ww, y: y + hh }, { x, y: y + hh }]
    if (d.style === 'double') { P.fill([rect(X, top, w, th), rect(X, top + th * 2, w, th)], col) }
    else if (d.style === 'dotted' || d.style === 'dashed') {
      const dl = d.style === 'dotted' ? th : th * 3, gp = d.style === 'dotted' ? th : th * 2
      const polys = []
      for (let s = 0; s < w; s += dl + gp) polys.push(rect(X + s, top, Math.min(dl, w - s), th))
      P.fill(polys, col)
    } else if (d.style === 'wavy') {
      const amp = Math.max(1, size * 0.06), per = amp * 4
      const top2 = [], bot = []
      for (let s = 0; s <= w; s += 1) { const yy = top + amp + Math.sin(s / per * Math.PI * 2) * amp; top2.push({ x: X + s, y: yy }); bot.push({ x: X + s, y: yy + th }) }
      P.fill([top2.concat(bot.reverse())], col)
    } else P.fill([rect(X, top, w, th)], col)
  }
}

function paintTextFrag(P, f, ox, oy, forMask) {
  const cs = f.cs, fi = f.fi
  if (cs.visibility !== 'visible' && !forMask) return
  const X = ox + f.x, Y = oy + f.y
  const g = glyphPolysFor(fi, f.str, X, Y, f.w, fi.synthItalic)
  let polys = g.polys
  if (!polys.length && !cs.decos.length) return
  if (fi.synthBold) { const e = Math.max(0.4, fi.size / 32); polys = polys.concat(shiftPolys(polys, e, 0)) }
  if (forMask) return polys
  const fill = cs.textFill || cs.color
  for (let i = cs.textShadow.length - 1; i >= 0; i--) {
    const s = cs.textShadow[i]
    const sp = shiftPolys(polys, s.x, s.y)
    if (s.blur > 0) {
      const sigma = s.blur / 2 * P.scale()
      const cov = P.cover(sp, 'nonzero', true, Math.ceil(sigma * 3) + 2)
      if (cov) { cov.data = blurCov(cov.data, cov.w, cov.h, sigma); P.paint(cov, s.color, 1) }
    } else P.fill(sp, s.color, 1, 'nonzero')
  }
  if (fill.a > 0) P.fill(polys, fill, 1, 'nonzero')
  if (cs.textStrokeW > 0) {
    const sub = polys.map(p => ({ pts: p, closed: true }))
    P.fill(strokeToPolygons(sub, cs.textStrokeW, 'butt', 'miter'), cs.textStrokeC, 1, 'nonzero')
  }
  if (cs.decos.length) paintDecoration(P, f, X, Y, f.w)
}

function px0(v, base) { return typeof v === 'number' ? v : typeof v === 'function' ? v(base) : 0 }

function paintInlineFrag(P, f, ox, oy, cw, line) {
  const box = f.box, cs = box.cs
  if (cs.visibility !== 'visible') return
  const fi = fontInfo(cs)
  const pad = cs.padding.map(v => Math.max(0, px0(v, cw)))
  const bor = cs.bw
  const hasBg = cs.bgColor.a > 0 || cs.bgLayers.length
  const hasBorder = bor.some(v => v > 0)
  if (!hasBg && !hasBorder && !cs.shadows.length && !cs.outline) return
  const x0 = ox + f.x0, x1 = ox + f.x1
  const top = oy + f.base - fi.asc - pad[0] - bor[0]
  const h = fi.asc + fi.desc + pad[0] + pad[2] + bor[0] + bor[2]
  const w = Math.max(0, x1 - x0)
  const bw = [bor[0], f.last ? bor[1] : 0, bor[2], f.first ? bor[3] : 0]
  const pd = [pad[0], f.last ? pad[1] : 0, pad[2], f.first ? pad[3] : 0]
  const R = { border: { x: x0, y: top, w, h } }
  R.padding = { x: x0 + bw[3], y: top + bw[0], w: Math.max(0, w - bw[1] - bw[3]), h: Math.max(0, h - bw[0] - bw[2]) }
  R.content = { x: R.padding.x + pd[3], y: R.padding.y + pd[0], w: Math.max(0, R.padding.w - pd[1] - pd[3]), h: Math.max(0, R.padding.h - pd[0] - pd[2]) }
  const radii = resolveRadii(cs, w, h, { first: f.first, last: f.last })
  paintBoxShadows(P, cs, R, radii, false)
  if (cs.bgClipText) paintBgClipText(P, cs, R, radii, () => line.frags.filter(t => t.k === 'text' && inChain(t.cs, cs)).map(t => paintTextFrag(P, t, ox, oy, true) || []).flat(), true)
  else paintBackground(P, cs, R, radii)
  paintBoxShadows(P, cs, R, radii, true)
  paintBorderRect(P, x0, top, w, h, radii, bw, cs.bs, cs.bc, false)
}

function paintLines(P, box) {
  if (!box.lines) return
  const ox = box.cx, oy = box.cy
  for (const ln of box.lines) {
    for (const f of ln.frags) if (f.k === 'inl') paintInlineFrag(P, f, ox, oy, box.cw, ln)
    for (const f of ln.frags) if (f.k === 'text') paintTextFrag(P, f, ox, oy, false)
  }
}

function deviceBounds(P, rect) {
  const pts = [P.map({ x: rect.x, y: rect.y }), P.map({ x: rect.x + rect.w, y: rect.y }), P.map({ x: rect.x + rect.w, y: rect.y + rect.h }), P.map({ x: rect.x, y: rect.y + rect.h })]
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const p of pts) { if (p.x < x0) x0 = p.x; if (p.y < y0) y0 = p.y; if (p.x > x1) x1 = p.x; if (p.y > y1) y1 = p.y }
  const c = P.clip
  x0 = Math.max(Math.floor(x0), c.x0); y0 = Math.max(Math.floor(y0), c.y0); x1 = Math.min(Math.ceil(x1), c.x1); y1 = Math.min(Math.ceil(y1), c.y1)
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

function paintBgClipText(P, cs, R, radii, getPolys) {
  const db = deviceBounds(P, R.border)
  if (!db) return
  const L = P.layer(db.x, db.y, db.w, db.h)
  paintBackground(L, cs, R, radii, { textClip: true })
  const polys = getPolys()
  const M = P.layer(db.x, db.y, db.w, db.h)
  if (polys.length) M.fill(polys, { r: 0, g: 0, b: 0, a: 1 })
  const lb = L.buf, mb = M.buf
  for (let i = 0; i < lb.length; i += 4) lb[i + 3] = lb[i + 3] * mb[i + 3] / 255
  P.composite(L, 1)
}

function textPolysDeep(box, cs, out) {
  if (box.ifc && box.lines) {
    for (const ln of box.lines) for (const f of ln.frags) if (f.k === 'text' && inChain(f.cs, cs)) { const p = paintTextFrag(null, f, box.cx, box.cy, true); if (p) out.push(...p) }
    for (const a of box.ifcBoxes || []) textPolysDeep(a, cs, out)
  } else for (const c of box.children) textPolysDeep(c, cs, out)
  return out
}

function paintMarkerShape(P, kind, cx, cy, d, color, fillOnly) {
  const r = d / 2
  if (kind === 'square') { P.fill([[{ x: cx - r, y: cy - r }, { x: cx + r, y: cy - r }, { x: cx + r, y: cy + r }, { x: cx - r, y: cy + r }]], color); return }
  const circ = rad => { const n = Math.max(12, Math.ceil(rad * 4)); const p = []; for (let i = 0; i < n; i++) p.push({ x: cx + rad * Math.cos(i / n * Math.PI * 2), y: cy + rad * Math.sin(i / n * Math.PI * 2) }); return p }
  if (kind === 'circle') P.fill([circ(r), circ(Math.max(0, r - 1)).reverse()], color, 1, 'evenodd')
  else P.fill([circ(r)], color)
}

function firstBaseline(box) {
  if (box.ifc && box.lines && box.lines.length) return box.cy + box.lines[0].base
  for (const c of box.children) { if (c.oof || c.floatSide !== 'none') continue; const b = firstBaseline(c); if (b != null) return b }
  return null
}

function paintListMarker(P, box) {
  const m = box.marker, cs = box.cs
  if (!m || cs.visibility !== 'visible') return
  const fs = cs.fontSize, fi = fontInfo(cs)
  let base = firstBaseline(box)
  if (base == null) base = box.cy + fi.asc
  const cl = box.cx
  if (m.kind === 'disc' || m.kind === 'circle' || m.kind === 'square') {
    const d = Math.max(3, fs * 0.33)
    paintMarkerShape(P, m.kind, cl - fs * 0.65, base - fs * 0.375, d, cs.color)
  } else if (m.kind === 'text') {
    const w = measureText(fi, m.text)
    const g = glyphPolysFor(fi, m.text, cl - w, base, null, fi.synthItalic)
    P.fill(g.polys, cs.color)
  } else if (m.kind === 'image') {
    const key = C.resolveUrl(m.src)
    const img = key ? C.images.get(key) : null
    if (img && img.w > 0) {
      const h = fs, w = h * img.w / img.h
      drawImageRect(P, img, cl - w - fs * 0.3, base - h * 0.85, w, h, false, null)
    }
  }
}

function drawImageRect(P, img, x, y, w, h, pixelated, sub) {
  if (!(w > 0) || !(h > 0)) return
  const fn = imageTileFn(img, w, h, P.scale(), pixelated, sub)
  P.fill([[{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]], (lx, ly, out) => fn(lx - x, ly - y, out))
}

function paintImageObject(P, box, img, cr) {
  const cs = box.cs
  const nw = img.w, nh = img.h
  let dw = cr.w, dh = cr.h
  const fit = cs.objectFit
  if (fit === 'contain' || fit === 'scale-down') { const k = Math.min(cr.w / nw, cr.h / nh); dw = nw * k; dh = nh * k; if (fit === 'scale-down' && (nw < dw)) { dw = nw; dh = nh } }
  else if (fit === 'cover') { const k = Math.max(cr.w / nw, cr.h / nh); dw = nw * k; dh = nh * k }
  else if (fit === 'none') { dw = nw; dh = nh }
  const [px, py] = resolvePos(cs.objectPos, cs.E, cr.w, cr.h, dw, dh)
  P.save()
  P.clipRect(cr.x, cr.y, cr.w, cr.h)
  drawImageRect(P, img, cr.x + px, cr.y + py, dw, dh, /pixelated|crisp-edges/.test(cs.raw['image-rendering'] || ''), null)
  P.restore()
}

function wrapLines(fi, text, width, pre) {
  const out = []
  for (const para of text.split(/\r\n|\r|\n/)) {
    if (pre === false || width <= 0) { out.push(para); continue }
    let cur = ''
    for (const word of para.split(/(?<=\s)/)) {
      if (cur && measureText(fi, (cur + word).replace(/\s+$/, '')) > width) { out.push(cur); cur = word } else cur += word
    }
    out.push(cur)
  }
  return out
}

function paintFormText(P, cs, text, x, y, w, h, color, align) {
  const fi = fontInfo(cs)
  const tw = measureText(fi, text)
  let X = x
  if (align === 'center') X = x + (w - tw) / 2
  else if (align === 'right') X = x + w - tw
  const Y = y + (h - (fi.asc + fi.desc)) / 2 + fi.asc
  P.save()
  P.clipRect(x, y, w, h)
  const g = glyphPolysFor(fi, text, X, Y, null, fi.synthItalic)
  P.fill(g.polys, color)
  P.restore()
}

function paintReplaced(P, box) {
  const rep = box.rep, cs = box.cs
  if (cs.visibility !== 'visible') return
  const R = boxRects(box)
  const cr = R.content
  const radii = resolveRadii(cs, box.w, box.h)
  const RR = rectRadii(cs, R, radii)
  const rounded = radii.some(r => r[0] > 0 || r[1] > 0)
  P.save()
  if (rounded) P.clipPolys(rrPolys(R.padding.x, R.padding.y, R.padding.w, R.padding.h, RR.padding))
  const BLUE = { r: 0, g: 117, b: 255, a: 1 }, GRAY = { r: 118, g: 118, b: 118, a: 1 }
  switch (rep.kind) {
    case 'img': {
      const key = rep.src ? C.images.get(rep.src) : null
      if (key && key.w > 0) paintImageObject(P, box, key, cr)
      break
    }
    case 'svg': paintSvgBox(P, box, cr); break
    case 'marker': paintMarkerShape(P, rep.marker.kind === 'image' ? 'disc' : rep.marker.kind, cr.x + cs.fontSize * 0.35, cr.y + cr.h - cs.fontSize * 0.375, Math.max(3, cs.fontSize * 0.33), cs.color); break
    case 'input': {
      const t = rep.type
      const a = box.el.attrs
      if (t === 'checkbox') {
        const on = rep.checked
        const rr = [[2, 2], [2, 2], [2, 2], [2, 2]]
        P.fill(rrPolys(cr.x, cr.y, cr.w, cr.h, rr), on ? BLUE : GRAY)
        if (!on) P.fill(rrPolys(cr.x + 1, cr.y + 1, cr.w - 2, cr.h - 2, [[1, 1], [1, 1], [1, 1], [1, 1]]), { r: 255, g: 255, b: 255, a: 1 })
        else P.fill(strokeToPolygons([{ pts: [{ x: cr.x + cr.w * 0.24, y: cr.y + cr.h * 0.52 }, { x: cr.x + cr.w * 0.43, y: cr.y + cr.h * 0.71 }, { x: cr.x + cr.w * 0.78, y: cr.y + cr.h * 0.29 }], closed: false }], 1.6, 'round', 'round'), { r: 255, g: 255, b: 255, a: 1 })
      } else if (t === 'radio') {
        const c = { x: cr.x + cr.w / 2, y: cr.y + cr.h / 2 }
        const circ = (rad) => { const n = 32, p = []; for (let i = 0; i < n; i++) p.push({ x: c.x + rad * Math.cos(i / n * Math.PI * 2), y: c.y + rad * Math.sin(i / n * Math.PI * 2) }); return p }
        P.fill([circ(cr.w / 2)], rep.checked ? BLUE : GRAY)
        P.fill([circ(cr.w / 2 - 1)], { r: 255, g: 255, b: 255, a: 1 })
        if (rep.checked) P.fill([circ(cr.w / 2 - 3)], BLUE)
      } else if (t === 'range') {
        const min = parseFloat(a.min) || 0, max = a.max !== undefined ? parseFloat(a.max) : 100
        let val = a.value !== undefined ? parseFloat(a.value) : (min + max) / 2
        const f = max > min ? Math.min(1, Math.max(0, (val - min) / (max - min))) : 0
        const ty = cr.y + cr.h / 2 - 2
        P.fill(rrPolys(cr.x, ty, cr.w, 4, [[2, 2], [2, 2], [2, 2], [2, 2]]), { r: 196, g: 196, b: 196, a: 1 })
        const tx = cr.x + 8 + (cr.w - 16) * f
        P.fill(rrPolys(cr.x, ty, tx - cr.x, 4, [[2, 2], [0, 0], [0, 0], [2, 2]]), BLUE)
        const n = 28, p = []
        for (let i = 0; i < n; i++) p.push({ x: tx + 8 * Math.cos(i / n * Math.PI * 2), y: cr.y + cr.h / 2 + 8 * Math.sin(i / n * Math.PI * 2) })
        P.fill([p], BLUE)
      } else if (t === 'color') {
        P.fill(rrPolys(cr.x, cr.y, cr.w, cr.h, [[3, 3], [3, 3], [3, 3], [3, 3]]), { r: 239, g: 239, b: 239, a: 1 })
        P.fill(bandPolys(cr.x, cr.y, cr.w, cr.h, [[3, 3], [3, 3], [3, 3], [3, 3]], [1, 1, 1, 1], 0, 1), GRAY, 1, 'evenodd')
        const col = cssColor(a.value || '#000000', cs.color) || { r: 0, g: 0, b: 0, a: 1 }
        P.fill(rrPolys(cr.x + 4, cr.y + 4, cr.w - 8, cr.h - 8, [[1, 1], [1, 1], [1, 1], [1, 1]]), col)
      } else if (t === 'submit' || t === 'button' || t === 'reset') {
        paintFormText(P, cs, rep.value || (t === 'submit' ? 'Submit' : t === 'reset' ? 'Reset' : ''), cr.x, cr.y, cr.w, cr.h, cs.color, 'center')
      } else if (t === 'file') {
        const fi = fontInfo(cs)
        P.fill(rrPolys(cr.x, cr.y + 1, 82, cr.h - 2, [[3, 3], [3, 3], [3, 3], [3, 3]]), { r: 239, g: 239, b: 239, a: 1 })
        P.fill(bandPolys(cr.x, cr.y + 1, 82, cr.h - 2, [[3, 3], [3, 3], [3, 3], [3, 3]], [1, 1, 1, 1], 0, 1), GRAY, 1, 'evenodd')
        paintFormText(P, cs, 'Choose File', cr.x, cr.y, 82, cr.h, cs.color, 'center')
        paintFormText(P, cs, 'No file chosen', cr.x + 90, cr.y, cr.w - 90, cr.h, cs.color, 'left')
      } else if (t === 'hidden') {
      } else {
        let text = rep.value
        let col = cs.color
        if (t === 'password') text = '•'.repeat(Array.from(text).length)
        if (!text && rep.placeholder) { text = rep.placeholder; col = { r: 117, g: 117, b: 117, a: 1 } }
        if (text) paintFormText(P, cs, text, cr.x, cr.y, cr.w, cr.h, col, 'left')
      }
      break
    }
    case 'textarea': {
      const fi = fontInfo(cs)
      let text = rep.value, col = cs.color
      if (!text && rep.placeholder) { text = rep.placeholder; col = { r: 117, g: 117, b: 117, a: 1 } }
      const lines = wrapLines(fi, text, cr.w, true)
      const lh = lhPx(cs, fi)
      P.save()
      P.clipRect(cr.x, cr.y, cr.w, cr.h)
      lines.forEach((ln, i) => {
        const g = glyphPolysFor(fi, ln.replace(/\s+$/, ''), cr.x, cr.y + i * lh + (lh - (fi.asc + fi.desc)) / 2 + fi.asc, null, fi.synthItalic)
        P.fill(g.polys, col)
      })
      P.restore()
      break
    }
    case 'select': {
      paintFormText(P, cs, rep.text, cr.x, cr.y, Math.max(0, cr.w - 16), cr.h, cs.color, 'left')
      const ax = cr.x + cr.w - 8, ay = cr.y + cr.h / 2
      P.fill(strokeToPolygons([{ pts: [{ x: ax - 3.5, y: ay - 1.5 }, { x: ax, y: ay + 2 }, { x: ax + 3.5, y: ay - 1.5 }], closed: false }], 1.5, 'round', 'round'), { r: 70, g: 70, b: 70, a: 1 })
      break
    }
    case 'progress': {
      const rr = [[cr.h / 2, cr.h / 2], [cr.h / 2, cr.h / 2], [cr.h / 2, cr.h / 2], [cr.h / 2, cr.h / 2]]
      P.fill(rrPolys(cr.x, cr.y, cr.w, cr.h, rr), { r: 239, g: 239, b: 239, a: 1 })
      const f = rep.value === rep.value ? Math.max(0, Math.min(1, rep.value / rep.max)) : 0.5
      P.fill(rrPolys(cr.x, cr.y, cr.w * f, cr.h, rr), BLUE)
      break
    }
    case 'meter': {
      const rr = [[cr.h / 2, cr.h / 2], [cr.h / 2, cr.h / 2], [cr.h / 2, cr.h / 2], [cr.h / 2, cr.h / 2]]
      P.fill(rrPolys(cr.x, cr.y, cr.w, cr.h, rr), { r: 239, g: 239, b: 239, a: 1 })
      const f = Math.max(0, Math.min(1, (rep.value - rep.min) / ((rep.max - rep.min) || 1)))
      P.fill(rrPolys(cr.x, cr.y, cr.w * f, cr.h, rr), { r: 31, g: 195, b: 63, a: 1 })
      break
    }
    default:
      if (rep.tag === 'video') P.fill([[{ x: cr.x, y: cr.y }, { x: cr.x + cr.w, y: cr.y }, { x: cr.x + cr.w, y: cr.y + cr.h }, { x: cr.x, y: cr.y + cr.h }]], { r: 0, g: 0, b: 0, a: 1 })
  }
  P.restore()
}

function parseFnList(str) {
  const out = []
  if (!str) return out
  const re = /([a-z-]+)\(/gi
  let m
  while ((m = re.exec(str))) {
    let depth = 1, i = re.lastIndex
    while (i < str.length && depth > 0) { if (str[i] === '(') depth++; else if (str[i] === ')') depth--; i++ }
    out.push({ fn: m[1].toLowerCase(), arg: str.slice(re.lastIndex, i - 1).trim() })
    re.lastIndex = i
  }
  return out
}

function numArg(s, def) {
  if (s == null || s === '') return def
  s = String(s).trim()
  const n = s.endsWith('%') ? parseFloat(s) / 100 : parseFloat(s)
  return n === n ? n : def
}

function filterMargin(str) {
  let m = 0
  for (const f of parseFnList(str)) {
    if (f.fn === 'blur') m = Math.max(m, (parseFloat(f.arg) || 0) * 3)
    else if (f.fn === 'drop-shadow') { const t = tokens(f.arg).filter(k => /^[+-]?[\d.]/.test(k)).map(parseFloat); m = Math.max(m, Math.abs(t[0] || 0) + Math.abs(t[1] || 0) + (t[2] || 0) * 3) }
  }
  return Math.ceil(m) + 2
}

function blurRGBA(buf, w, h, sigma) {
  if (sigma < 0.3) return
  const n = w * h
  const ch = [new Float32Array(n), new Float32Array(n), new Float32Array(n), new Float32Array(n)]
  for (let i = 0; i < n; i++) {
    const a = buf[i * 4 + 3] / 255
    ch[0][i] = buf[i * 4] * a; ch[1][i] = buf[i * 4 + 1] * a; ch[2][i] = buf[i * 4 + 2] * a; ch[3][i] = a
  }
  const b = ch.map(c => blurCov(c, w, h, sigma))
  for (let i = 0; i < n; i++) {
    const a = b[3][i]
    buf[i * 4 + 3] = a * 255 + 0.5
    if (a > 0.0005) { buf[i * 4] = Math.min(255, b[0][i] / a + 0.5); buf[i * 4 + 1] = Math.min(255, b[1][i] / a + 0.5); buf[i * 4 + 2] = Math.min(255, b[2][i] / a + 0.5) }
  }
}

function applyFilter(buf, w, h, str, E, sc) {
  const n = w * h
  const clamp = v => v < 0 ? 0 : v > 255 ? 255 : v
  for (const f of parseFnList(str)) {
    const a = numArg(f.arg, 1)
    switch (f.fn) {
      case 'blur': { const r = parseLen(f.arg, E); blurRGBA(buf, w, h, (typeof r === 'number' ? r : 0) * sc); break }
      case 'brightness': for (let i = 0; i < n; i++) { buf[i * 4] = clamp(buf[i * 4] * a); buf[i * 4 + 1] = clamp(buf[i * 4 + 1] * a); buf[i * 4 + 2] = clamp(buf[i * 4 + 2] * a) } break
      case 'contrast': for (let i = 0; i < n; i++) { buf[i * 4] = clamp((buf[i * 4] - 127.5) * a + 127.5); buf[i * 4 + 1] = clamp((buf[i * 4 + 1] - 127.5) * a + 127.5); buf[i * 4 + 2] = clamp((buf[i * 4 + 2] - 127.5) * a + 127.5) } break
      case 'invert': { const k = Math.min(1, a); for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) buf[i * 4 + c] = buf[i * 4 + c] * (1 - k) + (255 - buf[i * 4 + c]) * k } break
      case 'opacity': for (let i = 0; i < n; i++) buf[i * 4 + 3] = buf[i * 4 + 3] * Math.min(1, a); break
      case 'grayscale': case 'sepia': case 'saturate': case 'hue-rotate': {
        let m
        if (f.fn === 'grayscale') { const k = 1 - Math.min(1, a); m = [0.2126 + 0.7874 * k, 0.7152 - 0.7152 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 + 0.2848 * k, 0.0722 - 0.0722 * k, 0.2126 - 0.2126 * k, 0.7152 - 0.7152 * k, 0.0722 + 0.9278 * k] }
        else if (f.fn === 'sepia') { const k = 1 - Math.min(1, a); m = [0.393 + 0.607 * k, 0.769 - 0.769 * k, 0.189 - 0.189 * k, 0.349 - 0.349 * k, 0.686 + 0.314 * k, 0.168 - 0.168 * k, 0.272 - 0.272 * k, 0.534 - 0.534 * k, 0.131 + 0.869 * k] }
        else if (f.fn === 'saturate') m = [0.213 + 0.787 * a, 0.715 - 0.715 * a, 0.072 - 0.072 * a, 0.213 - 0.213 * a, 0.715 + 0.285 * a, 0.072 - 0.072 * a, 0.213 - 0.213 * a, 0.715 - 0.715 * a, 0.072 + 0.928 * a]
        else {
          const ang = (parseAngle(f.arg) || 0) * Math.PI / 180, c = Math.cos(ang), s = Math.sin(ang)
          m = [0.213 + c * 0.787 - s * 0.213, 0.715 - c * 0.715 - s * 0.715, 0.072 - c * 0.072 + s * 0.928, 0.213 - c * 0.213 + s * 0.143, 0.715 + c * 0.285 + s * 0.140, 0.072 - c * 0.072 - s * 0.283, 0.213 - c * 0.213 - s * 0.787, 0.715 - c * 0.715 + s * 0.715, 0.072 + c * 0.928 + s * 0.072]
        }
        for (let i = 0; i < n; i++) {
          const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2]
          buf[i * 4] = clamp(m[0] * r + m[1] * g + m[2] * b); buf[i * 4 + 1] = clamp(m[3] * r + m[4] * g + m[5] * b); buf[i * 4 + 2] = clamp(m[6] * r + m[7] * g + m[8] * b)
        }
        break
      }
      case 'drop-shadow': {
        const tk = tokens(f.arg)
        const nums = [], rest = []
        for (const k of tk) { if (!cssColor(k) && /^[+-]?[\d.]/.test(k)) { const v = parseLen(k, E); nums.push(typeof v === 'number' ? v : 0) } else rest.push(k) }
        const col = cssColor(rest.join(' '), { r: 0, g: 0, b: 0, a: 1 }) || { r: 0, g: 0, b: 0, a: 1 }
        const dx = Math.round((nums[0] || 0) * sc), dy = Math.round((nums[1] || 0) * sc)
        const sh = Buffer.alloc(n * 4)
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
          const sx = x - dx, sy = y - dy
          if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue
          const al = buf[(sy * w + sx) * 4 + 3]
          if (al) { const o = (y * w + x) * 4; sh[o] = col.r; sh[o + 1] = col.g; sh[o + 2] = col.b; sh[o + 3] = al * col.a }
        }
        blurRGBA(sh, w, h, (nums[2] || 0) / 2 * sc)
        for (let i = 0; i < n; i++) {
          const o = i * 4
          const sa = buf[o + 3] / 255, da = sh[o + 3] / 255
          const oa = sa + da * (1 - sa)
          if (oa <= 0) continue
          const k = da * (1 - sa)
          buf[o] = (buf[o] * sa + sh[o] * k) / oa; buf[o + 1] = (buf[o + 1] * sa + sh[o + 1] * k) / oa; buf[o + 2] = (buf[o + 2] * sa + sh[o + 2] * k) / oa
          buf[o + 3] = oa * 255
        }
        break
      }
    }
  }
}

function applyBackdrop(P, box, R, radii) {
  const cs = box.cs
  const b = R.border
  const cov = P.cover(rrPolys(b.x, b.y, b.w, b.h, radii))
  if (!cov) return
  const pad = Math.ceil(filterMargin(cs.backdrop) * P.scale())
  const x0 = Math.max(0, cov.x0 - pad), y0 = Math.max(0, cov.y0 - pad)
  const x1 = Math.min(P.w, cov.x0 + cov.w + pad), y1 = Math.min(P.h, cov.y0 + cov.h + pad)
  const rw = x1 - x0, rh = y1 - y0
  if (rw <= 0 || rh <= 0) return
  const tmp = Buffer.alloc(rw * rh * 4)
  for (let y = 0; y < rh; y++) P.buf.copy(tmp, y * rw * 4, ((y0 + y) * P.w + x0) * 4, ((y0 + y) * P.w + x0 + rw) * 4)
  applyFilter(tmp, rw, rh, cs.backdrop, cs.E, P.scale())
  for (let y = 0; y < cov.h; y++) {
    const py = cov.y0 + y
    if (py < P.clip.y0 || py >= P.clip.y1) continue
    for (let x = 0; x < cov.w; x++) {
      const px = cov.x0 + x
      if (px < P.clip.x0 || px >= P.clip.x1) continue
      const c = cov.data[y * cov.w + x]
      if (c <= 0.002) continue
      const di = (py * P.w + px) * 4, ti = ((py - y0) * rw + (px - x0)) * 4
      for (let k = 0; k < 4; k++) P.buf[di + k] = P.buf[di + k] * (1 - c) + tmp[ti + k] * c
    }
  }
}

function boxMatrix(box) {
  const cs = box.cs
  if (!cs.transform.length) return null
  const w = box.w, h = box.h
  const [ox, oy] = resolvePos(cs.transformOrigin, cs.E, w, h, 0, 0)
  const cx = box.ax + ox, cy = box.ay + oy
  let m = [1, 0, 0, 1, cx, cy]
  const len = (s, base) => { const v = parseLen(s, cs.E); return typeof v === 'number' ? v : typeof v === 'function' ? v(base) : 0 }
  const ang = s => (parseAngle(s) || 0) * Math.PI / 180
  const num = (s, d) => { const v = parseFloat(s); return v === v ? (/%$/.test(String(s)) ? v / 100 : v) : d }
  for (const op of cs.transform) {
    const a = op.args
    let t = null
    switch (op.fn) {
      case 'translate': t = [1, 0, 0, 1, len(a[0] || '0', w), a[1] !== undefined ? len(a[1], h) : 0]; break
      case 'translatex': t = [1, 0, 0, 1, len(a[0] || '0', w), 0]; break
      case 'translatey': t = [1, 0, 0, 1, 0, len(a[0] || '0', h)]; break
      case 'translate3d': t = [1, 0, 0, 1, len(a[0] || '0', w), len(a[1] || '0', h)]; break
      case 'scale': { const sx = num(a[0], 1); t = [sx, 0, 0, a[1] !== undefined ? num(a[1], 1) : sx, 0, 0]; break }
      case 'scalex': t = [num(a[0], 1), 0, 0, 1, 0, 0]; break
      case 'scaley': t = [1, 0, 0, num(a[0], 1), 0, 0]; break
      case 'scale3d': t = [num(a[0], 1), 0, 0, num(a[1], 1), 0, 0]; break
      case 'rotate': case 'rotatez': { const r = ang(a[0]), c = Math.cos(r), s = Math.sin(r); t = [c, s, -s, c, 0, 0]; break }
      case 'skew': t = [1, Math.tan(a[1] !== undefined ? ang(a[1]) : 0), Math.tan(ang(a[0])), 1, 0, 0]; break
      case 'skewx': t = [1, 0, Math.tan(ang(a[0])), 1, 0, 0]; break
      case 'skewy': t = [1, Math.tan(ang(a[0])), 0, 1, 0, 0]; break
      case 'matrix': { const v = a.map(parseFloat); if (v.length >= 6 && v.every(x => x === x)) t = [v[0], v[1], v[2], v[3], v[4], v[5]]; break }
      case 'matrix3d': { const v = a.map(parseFloat); if (v.length >= 16 && v.every(x => x === x)) t = [v[0], v[1], v[4], v[5], v[12], v[13]]; break }
    }
    if (t) m = mulM(m, t)
  }
  return mulM(m, [1, 0, 0, 1, -cx, -cy])
}

function clipPathShape(box) {
  const cs = box.cs
  const fns = parseFnList(cs.clipPath)
  if (!fns.length) return null
  const f = fns[0]
  const w = box.w, h = box.h, x = box.ax, y = box.ay
  const E = cs.E
  const L = (s, base) => { const v = parseLen(s, E); return typeof v === 'number' ? v : typeof v === 'function' ? v(base) : 0 }
  if (f.fn === 'inset') {
    const parts = f.arg.split(/\bround\b/i)
    const vs = tokens(parts[0]).map(s => s)
    const v4 = vs.length === 1 ? [vs[0], vs[0], vs[0], vs[0]] : vs.length === 2 ? [vs[0], vs[1], vs[0], vs[1]] : vs.length === 3 ? [vs[0], vs[1], vs[2], vs[1]] : vs
    const t = L(v4[0] || '0', h), r = L(v4[1] || '0', w), b = L(v4[2] || '0', h), l = L(v4[3] || '0', w)
    let rad = [[0, 0], [0, 0], [0, 0], [0, 0]]
    if (parts[1]) { const rr = tokens(parts[1].split('/')[0]).map(s => L(s, w)); const q = rr.length === 1 ? [rr[0], rr[0], rr[0], rr[0]] : rr.length === 2 ? [rr[0], rr[1], rr[0], rr[1]] : rr.length === 3 ? [rr[0], rr[1], rr[2], rr[1]] : rr; rad = q.map(v => [v || 0, v || 0]) }
    return { polys: rrPolys(x + l, y + t, Math.max(0, w - l - r), Math.max(0, h - t - b), rad), rule: 'nonzero' }
  }
  if (f.fn === 'circle' || f.fn === 'ellipse') {
    const at = /\bat\s+(.*)$/i.exec(f.arg)
    const head = (at ? f.arg.slice(0, at.index) : f.arg).trim()
    const [cx, cy] = resolvePos(at ? at[1] : '50% 50%', E, w, h, 0, 0)
    const dl = Math.min(cx, w - cx), dr = Math.max(cx, w - cx), dt = Math.min(cy, h - cy), db = Math.max(cy, h - cy)
    let rx, ry
    const tk = tokens(head)
    const side = (k, closest, fa) => k === 'farthest-side' ? fa : closest
    if (f.fn === 'circle') {
      const k = tk[0]
      let r
      if (!k || k === 'closest-side') r = Math.min(dl, dt)
      else if (k === 'farthest-side') r = Math.max(dr, db)
      else r = L(k, Math.sqrt((w * w + h * h) / 2))
      rx = ry = r
    } else {
      rx = !tk[0] || tk[0] === 'closest-side' ? dl : tk[0] === 'farthest-side' ? dr : L(tk[0], w)
      ry = !tk[1] || tk[1] === 'closest-side' ? dt : tk[1] === 'farthest-side' ? db : L(tk[1], h)
    }
    const n = Math.max(24, Math.ceil(Math.max(rx, ry)))
    const p = []
    for (let i = 0; i < n; i++) p.push({ x: x + cx + rx * Math.cos(i / n * Math.PI * 2), y: y + cy + ry * Math.sin(i / n * Math.PI * 2) })
    return { polys: [p], rule: 'nonzero' }
  }
  if (f.fn === 'polygon') {
    let args = splitTop(f.arg, ',').map(s => s.trim())
    let rule = 'nonzero'
    if (/^(nonzero|evenodd)$/i.test(args[0])) { rule = args[0].toLowerCase(); args = args.slice(1) }
    const p = args.map(s => { const t = tokens(s); return { x: x + L(t[0] || '0', w), y: y + L(t[1] || '0', h) } })
    return p.length >= 3 ? { polys: [p], rule } : null
  }
  if (f.fn === 'path' && typeof pathToPolys === 'function') {
    const m = /^(?:(nonzero|evenodd)\s*,\s*)?["']([^"']*)["']$/i.exec(f.arg)
    if (m) return { polys: pathToPolys(m[2], x, y), rule: (m[1] || 'nonzero').toLowerCase() }
  }
  return null
}

function isUnit(box) {
  const cs = box.cs
  if (box.oof || cs.position !== 'static') return true
  if (cs.opacity < 1 || cs.transform.length || cs.filter || cs.mixBlend !== 'normal' || cs.clipPath) return true
  if (cs.zIndex !== 'auto' && box.parent && (box.parent.type === 'flex' || box.parent.type === 'grid')) return true
  return false
}

function overflowClip(P, box) {
  const R = boxRects(box)
  const radii = resolveRadii(box.cs, box.w, box.h)
  const rr = rectRadii(box.cs, R, radii).padding
  const any = rr.some(r => r[0] > 0 || r[1] > 0)
  return { rect: R.padding, polys: any ? rrPolys(R.padding.x, R.padding.y, R.padding.w, R.padding.h, rr) : null }
}

function applyOverflowClip(P, c) {
  if (c.polys) P.clipPolys(c.polys)
  else P.clipRect(c.rect.x, c.rect.y, c.rect.w, c.rect.h)
}

function isAncestorBox(a, b) {
  for (let n = b; n; n = n.parent) if (n === a) return true
  return false
}

function defer(D, S) {
  const cb = D.oof ? D.cbBox : null
  D._clips = S.clips.filter(c => !cb || c.box === cb || isAncestorBox(c.box, cb))
  const z = D.cs.zIndex === 'auto' ? 0 : D.cs.zIndex
  ;(z < 0 ? S.lists.neg : z > 0 ? S.lists.pos : S.lists.zero).push(D)
}

function paintChild(P, c, S, collect) {
  if (isUnit(c)) { if (collect) defer(c, S); return }
  if (!collect) paintBoxSelf(P, c)
  paintContent(P, c, S, collect)
}

function paintContent(P, box, S, collect) {
  const cs = box.cs
  if (box.type === 'replaced') { if (!collect) paintReplaced(P, box); return }
  let clip = null
  if (cs.clips && box !== C.rootBox) {
    clip = overflowClip(P, box)
    if (collect) S.clips.push({ box, rect: clip.rect, polys: clip.polys })
    else { P.save(); applyOverflowClip(P, clip) }
  }
  if (box.ifc) {
    const ib = box.ifcBoxes || []
    for (const a of ib) if (a.floatSide !== 'none') paintChild(P, a, S, collect)
    if (!collect) paintLines(P, box)
    for (const a of ib) if (a.floatSide === 'none') paintChild(P, a, S, collect)
    for (const a of box.ifcOof || []) paintChild(P, a, S, collect)
  } else {
    let kids = box.children
    if ((box.type === 'flex' || box.type === 'grid') && kids.some(k => k.cs.order !== 0)) kids = kids.map((k, i) => [k, i]).sort((a, b) => a[0].cs.order - b[0].cs.order || a[1] - b[1]).map(x => x[0])
    for (const c of kids) if (c.oof) paintChild(P, c, S, collect)
    for (const c of kids) if (!c.oof && c.floatSide === 'none') paintChild(P, c, S, collect)
    for (const c of kids) if (!c.oof && c.floatSide !== 'none') paintChild(P, c, S, collect)
  }
  if (!collect && box.marker) paintListMarker(P, box)
  if (clip) { if (collect) S.clips.pop(); else P.restore() }
}

function paintBoxSelf(P, box) {
  const cs = box.cs
  if (box.anon || !box.el) return
  if (cs.visibility !== 'visible') return
  if (!(box.w > 0) && !(box.h > 0)) return
  const R = boxRects(box)
  const radii = resolveRadii(cs, box.w, box.h)
  if (cs.backdrop) applyBackdrop(P, box, R, radii)
  paintBoxShadows(P, cs, R, radii, false)
  if (!box.noBg) {
    if (cs.bgClipText) paintBgClipText(P, cs, R, radii, () => textPolysDeep(box, cs, []))
    else paintBackground(P, cs, R, radii)
  }
  paintBoxShadows(P, cs, R, radii, true)
  const b = R.border
  const tag = box.el.tag
  const native = (tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button') && (cs.bs[0] === 'inset' || cs.bs[0] === 'outset') && cs.bs.every(s => s === cs.bs[0]) && cs.bw.every(v => v === cs.bw[0])
  paintBorderRect(P, b.x, b.y, b.w, b.h, radii, cs.bw, cs.bs, cs.bc, native)
  if (cs.outline) paintOutline(P, cs, R, radii)
}

function subtreeBounds(b, acc) {
  if (!acc) acc = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  let m = 0
  const cs = b.cs
  for (const s of cs.shadows) if (!s.inset) m = Math.max(m, Math.max(Math.abs(s.x), Math.abs(s.y)) + s.blur * 1.5 + Math.max(0, s.spread) + 2)
  for (const s of cs.textShadow) m = Math.max(m, Math.max(Math.abs(s.x), Math.abs(s.y)) + s.blur * 1.5 + 2)
  if (cs.outline) m = Math.max(m, cs.outline.w + cs.outline.offset)
  if (cs.filter) m = Math.max(m, filterMargin(cs.filter))
  if (b.w > 0 || b.h > 0 || b.ax !== undefined) {
    acc.x0 = Math.min(acc.x0, b.ax - m); acc.y0 = Math.min(acc.y0, b.ay - m)
    acc.x1 = Math.max(acc.x1, b.ax + b.w + m); acc.y1 = Math.max(acc.y1, b.ay + b.h + m)
  }
  if (b.ifc && b.lines) for (const ln of b.lines) { acc.x1 = Math.max(acc.x1, b.cx + ln.x0 + ln.w + m); acc.y1 = Math.max(acc.y1, b.cy + ln.y + ln.h + m); acc.x0 = Math.min(acc.x0, b.cx + ln.x0 - m) }
  if (!b.cs.clips || b.type === 'replaced') {
    if (b.ifc) { for (const a of b.ifcBoxes || []) subtreeBounds(a, acc); for (const a of b.ifcOof || []) subtreeBounds(a, acc) }
    else for (const c of b.children) subtreeBounds(c, acc)
  }
  return acc
}

function paintUnit(P, D) {
  const cs = D.cs
  P.save()
  for (const c of D._clips || []) applyOverflowClip(P, c)
  const m = boxMatrix(D)
  if (m) P.mul(m)
  if (cs.clipPath) { const sh = clipPathShape(D); if (sh) P.clipPolys(sh.polys, sh.rule) }
  const layered = cs.opacity < 1 || cs.filter || cs.mixBlend !== 'normal'
  if (layered) {
    const bb = subtreeBounds(D)
    const db = isFinite(bb.x0) ? deviceBounds(P, { x: bb.x0, y: bb.y0, w: bb.x1 - bb.x0, h: bb.y1 - bb.y0 }) : null
    if (db) {
      const L = P.layer(db.x, db.y, db.w, db.h)
      paintStackRoot(L, D)
      const sc = P.scale()
      P.composite(L, cs.opacity, cs.filter ? Lp => applyFilter(Lp.buf, Lp.w, Lp.h, cs.filter, cs.E, sc) : null, cs.mixBlend !== 'normal' ? cs.mixBlend : null)
    }
  } else paintStackRoot(P, D)
  P.restore()
}

function paintStackRoot(P, box) {
  const S = { lists: { neg: [], zero: [], pos: [] }, clips: [] }
  paintBoxSelf(P, box)
  paintContent(P, box, S, true)
  const byZ = (a, b) => a.cs.zIndex - b.cs.zIndex
  for (const D of S.lists.neg.sort(byZ)) paintUnit(P, D)
  S.clips = []
  paintContent(P, box, S, false)
  for (const D of S.lists.zero) paintUnit(P, D)
  for (const D of S.lists.pos.sort(byZ)) paintUnit(P, D)
}

const SVG_SKIP = new Set(['defs', 'clippath', 'mask', 'lineargradient', 'radialgradient', 'pattern', 'filter', 'marker', 'symbol', 'style', 'script', 'title', 'desc', 'metadata', 'stop', 'foreignobject', 'fegaussianblur', 'fedropshadow', 'feoffset', 'feflood', 'fecolormatrix', 'femerge', 'femergenode', 'feblend', 'fecomposite'])
const SVG_SHAPES = new Set(['rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'path'])

function svgProp(el, name, inherit) {
  for (let e = el; e && e.type === 1; e = inherit ? (e._vparent || e.parent) : null) {
    const o = e.own && e.own[name]
    if (typeof o === 'string') { if (o.trim().toLowerCase() === 'inherit') continue; return o.trim() }
    const a = e.attrs && e.attrs[name]
    if (a !== undefined && a.trim().toLowerCase() !== 'inherit') return a.trim()
    if (!inherit) break
  }
  return undefined
}

function svgLen(el, str, base, def) {
  if (str == null) return def
  const v = parseLen(str, el.cs ? el.cs.E : { fs: 16, rfs: 16, vw: 800, vh: 600 })
  if (typeof v === 'number') return v
  if (typeof v === 'function') return v(base)
  return def
}

function svgAttrLen(el, name, base, def) { return svgLen(el, svgProp(el, name, false), base, def) }

function svgTransform(str) {
  if (!str) return null
  let m = [1, 0, 0, 1, 0, 0]
  const re = /([a-z]+)\s*\(([^)]*)\)/gi
  let r, any = false
  while ((r = re.exec(str))) {
    const a = r[2].split(/[\s,]+/).filter(Boolean).map(parseFloat)
    let t = null
    switch (r[1].toLowerCase()) {
      case 'matrix': if (a.length >= 6) t = a.slice(0, 6); break
      case 'translate': t = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break
      case 'translatex': t = [1, 0, 0, 1, a[0] || 0, 0]; break
      case 'translatey': t = [1, 0, 0, 1, 0, a[0] || 0]; break
      case 'scale': t = [a[0] === undefined ? 1 : a[0], 0, 0, a[1] === undefined ? (a[0] === undefined ? 1 : a[0]) : a[1], 0, 0]; break
      case 'scalex': t = [a[0], 0, 0, 1, 0, 0]; break
      case 'scaley': t = [1, 0, 0, a[0], 0, 0]; break
      case 'rotate': {
        const g = (a[0] || 0) * Math.PI / 180, c = Math.cos(g), s = Math.sin(g)
        t = [c, s, -s, c, 0, 0]
        if (a.length >= 3) t = mulM(mulM([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]])
        break
      }
      case 'skewx': t = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0]; break
      case 'skewy': t = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0]; break
    }
    if (t && t.every(v => v === v)) { m = mulM(m, t); any = true }
  }
  return any ? m : null
}

function viewBoxMatrix(vb, par, x, y, w, h) {
  const p = String(par || 'xMidYMid meet').trim().split(/\s+/)
  if (!(vb[2] > 0) || !(vb[3] > 0)) return [1, 0, 0, 1, x, y]
  if (p[0] === 'none') return [w / vb[2], 0, 0, h / vb[3], x - vb[0] * w / vb[2], y - vb[1] * h / vb[3]]
  const slice = p[1] === 'slice'
  const s = slice ? Math.max(w / vb[2], h / vb[3]) : Math.min(w / vb[2], h / vb[3])
  const al = p[0] || 'xMidYMid'
  const fx = /xMin/.test(al) ? 0 : /xMax/.test(al) ? 1 : 0.5, fy = /YMin/.test(al) ? 0 : /YMax/.test(al) ? 1 : 0.5
  return [s, 0, 0, s, x + (w - vb[2] * s) * fx - vb[0] * s, y + (h - vb[3] * s) * fy - vb[1] * s]
}

function svgArc(out, x1, y1, rx, ry, phiDeg, fa, fs, x2, y2, tol) {
  if (x1 === x2 && y1 === y2) return
  rx = Math.abs(rx); ry = Math.abs(ry)
  if (!rx || !ry) { out.push({ x: x2, y: y2 }); return }
  const phi = phiDeg * Math.PI / 180, c = Math.cos(phi), s = Math.sin(phi)
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2
  const x1p = c * dx + s * dy, y1p = -s * dx + c * dy
  const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry)
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k }
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
  let co = den === 0 ? 0 : Math.sqrt(Math.max(0, num / den))
  if (fa === fs) co = -co
  const cxp = co * rx * y1p / ry, cyp = -co * ry * x1p / rx
  const cx = c * cxp - s * cyp + (x1 + x2) / 2, cy = s * cxp + c * cyp + (y1 + y2) / 2
  const ang = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy)
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry
  const th1 = ang(1, 0, ux, uy)
  let dth = ang(ux, uy, (-x1p - cxp) / rx, (-y1p - cyp) / ry)
  if (!fs && dth > 0) dth -= Math.PI * 2
  else if (fs && dth < 0) dth += Math.PI * 2
  const seg = 2 * Math.acos(Math.max(0, 1 - tol / Math.max(rx, ry))) || 0.2
  const steps = Math.min(240, Math.max(4, Math.ceil(Math.abs(dth) / seg)))
  for (let i = 1; i <= steps; i++) {
    const t = th1 + dth * i / steps
    out.push({ x: cx + c * rx * Math.cos(t) - s * ry * Math.sin(t), y: cy + s * rx * Math.cos(t) + c * ry * Math.sin(t) })
  }
  out[out.length - 1] = { x: x2, y: y2 }
}

function parsePathData(d, tol) {
  const subs = []
  let cur = null
  let i = 0
  const n = d.length
  const numRe = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y
  const skip = () => { while (i < n && /[\s,]/.test(d[i])) i++ }
  const readNum = () => { skip(); numRe.lastIndex = i; const m = numRe.exec(d); if (!m) return null; i = numRe.lastIndex; return parseFloat(m[0]) }
  const readFlag = () => { skip(); const c = d[i]; if (c === '0' || c === '1') { i++; return +c } return null }
  const more = () => { skip(); return i < n && !/[a-zA-Z]/.test(d[i]) }
  let cmd = '', x = 0, y = 0, sx = 0, sy = 0, cpx = 0, cpy = 0, prev = ''
  const start = (px, py) => { cur = { pts: [{ x: px, y: py }], closed: false }; subs.push(cur) }
  while (true) {
    skip()
    if (i >= n) break
    if (/[a-zA-Z]/.test(d[i])) { cmd = d[i++] } else if (!cmd) break
    const rel = cmd === cmd.toLowerCase()
    const C0 = cmd.toUpperCase()
    if (C0 === 'Z') { if (cur) { cur.closed = true; x = sx; y = sy; cur = null } prev = 'Z'; continue }
    if (!more() && C0 !== 'Z') { if (!/[a-zA-Z]/.test(d[i] || '')) break; continue }
    let ok = true
    switch (C0) {
      case 'M': {
        const a = readNum(), b = readNum()
        if (a == null || b == null) { ok = false; break }
        x = rel ? x + a : a; y = rel ? y + b : b
        sx = x; sy = y; start(x, y)
        cmd = rel ? 'l' : 'L'
        break
      }
      case 'L': {
        const a = readNum(), b = readNum()
        if (a == null || b == null) { ok = false; break }
        x = rel ? x + a : a; y = rel ? y + b : b
        if (!cur) start(sx, sy)
        cur.pts.push({ x, y })
        break
      }
      case 'H': { const a = readNum(); if (a == null) { ok = false; break } x = rel ? x + a : a; if (!cur) start(sx, sy); cur.pts.push({ x, y }); break }
      case 'V': { const a = readNum(); if (a == null) { ok = false; break } y = rel ? y + a : a; if (!cur) start(sx, sy); cur.pts.push({ x, y }); break }
      case 'C': {
        const v = [readNum(), readNum(), readNum(), readNum(), readNum(), readNum()]
        if (v.some(q => q == null)) { ok = false; break }
        const ox = rel ? x : 0, oy = rel ? y : 0
        if (!cur) start(sx, sy)
        flattenCubic(cur.pts, x, y, v[0] + ox, v[1] + oy, v[2] + ox, v[3] + oy, v[4] + ox, v[5] + oy, tol)
        cpx = v[2] + ox; cpy = v[3] + oy; x = v[4] + ox; y = v[5] + oy
        break
      }
      case 'S': {
        const v = [readNum(), readNum(), readNum(), readNum()]
        if (v.some(q => q == null)) { ok = false; break }
        const ox = rel ? x : 0, oy = rel ? y : 0
        const c1x = prev === 'C' || prev === 'S' ? 2 * x - cpx : x, c1y = prev === 'C' || prev === 'S' ? 2 * y - cpy : y
        if (!cur) start(sx, sy)
        flattenCubic(cur.pts, x, y, c1x, c1y, v[0] + ox, v[1] + oy, v[2] + ox, v[3] + oy, tol)
        cpx = v[0] + ox; cpy = v[1] + oy; x = v[2] + ox; y = v[3] + oy
        break
      }
      case 'Q': {
        const v = [readNum(), readNum(), readNum(), readNum()]
        if (v.some(q => q == null)) { ok = false; break }
        const ox = rel ? x : 0, oy = rel ? y : 0
        if (!cur) start(sx, sy)
        flattenQuad(cur.pts, x, y, v[0] + ox, v[1] + oy, v[2] + ox, v[3] + oy, tol)
        cpx = v[0] + ox; cpy = v[1] + oy; x = v[2] + ox; y = v[3] + oy
        break
      }
      case 'T': {
        const a = readNum(), b = readNum()
        if (a == null || b == null) { ok = false; break }
        const qx = prev === 'Q' || prev === 'T' ? 2 * x - cpx : x, qy = prev === 'Q' || prev === 'T' ? 2 * y - cpy : y
        const ex = rel ? x + a : a, ey = rel ? y + b : b
        if (!cur) start(sx, sy)
        flattenQuad(cur.pts, x, y, qx, qy, ex, ey, tol)
        cpx = qx; cpy = qy; x = ex; y = ey
        break
      }
      case 'A': {
        const rx = readNum(), ry = readNum(), rot = readNum(), fa = readFlag(), fs = readFlag(), a = readNum(), b = readNum()
        if ([rx, ry, rot, fa, fs, a, b].some(q => q == null)) { ok = false; break }
        const ex = rel ? x + a : a, ey = rel ? y + b : b
        if (!cur) start(sx, sy)
        svgArc(cur.pts, x, y, rx, ry, rot, fa, fs, ex, ey, tol)
        x = ex; y = ey
        break
      }
      default: ok = false
    }
    if (!ok) break
    prev = C0 === 'M' ? 'M' : C0
  }
  return subs
}

function pathToPolys(d, ox, oy) {
  return parsePathData(d, 0.2).filter(s => s.pts.length >= 2).map(s => s.pts.map(p => ({ x: p.x + ox, y: p.y + oy })))
}

function svgShapeSubpaths(el, S, tol) {
  const t = el.tag
  const vw = S.vw, vh = S.vh
  const A = (n, base, d) => svgAttrLen(el, n, base, d)
  switch (t) {
    case 'rect': {
      const x = A('x', vw, 0), y = A('y', vh, 0), w = A('width', vw, 0), h = A('height', vh, 0)
      if (!(w > 0) || !(h > 0)) return []
      let rx = A('rx', vw, null), ry = A('ry', vh, null)
      if (rx == null && ry == null) rx = ry = 0
      else if (rx == null) rx = ry
      else if (ry == null) ry = rx
      rx = Math.min(Math.max(0, rx), w / 2); ry = Math.min(Math.max(0, ry), h / 2)
      const rr = [[rx, ry], [rx, ry], [rx, ry], [rx, ry]]
      return [{ pts: rrPolys(x, y, w, h, rr)[0], closed: true }]
    }
    case 'circle': case 'ellipse': {
      const cx = A('cx', vw, 0), cy = A('cy', vh, 0)
      let rx, ry
      if (t === 'circle') { rx = ry = A('r', Math.sqrt((vw * vw + vh * vh) / 2), 0) } else { rx = A('rx', vw, 0); ry = A('ry', vh, 0) }
      if (!(rx > 0) || !(ry > 0)) return []
      const n = Math.max(16, Math.min(400, Math.ceil(Math.PI * 2 / (2 * Math.acos(Math.max(0, 1 - tol / Math.max(rx, ry))) || 0.2))))
      const p = []
      for (let i = 0; i < n; i++) p.push({ x: cx + rx * Math.cos(i / n * Math.PI * 2), y: cy + ry * Math.sin(i / n * Math.PI * 2) })
      return [{ pts: p, closed: true }]
    }
    case 'line': return [{ pts: [{ x: A('x1', vw, 0), y: A('y1', vh, 0) }, { x: A('x2', vw, 0), y: A('y2', vh, 0) }], closed: false }]
    case 'polyline': case 'polygon': {
      const nums = (el.attrs.points || '').split(/[\s,]+/).filter(Boolean).map(parseFloat).filter(v => v === v)
      const p = []
      for (let i = 0; i + 1 < nums.length; i += 2) p.push({ x: nums[i], y: nums[i + 1] })
      return p.length >= 2 ? [{ pts: p, closed: t === 'polygon' }] : []
    }
    case 'path': return parsePathData(el.attrs.d || '', tol).filter(s => s.pts.length >= 1)
  }
  return []
}

function subBBox(subs) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const s of subs) for (const p of s.pts) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y }
  return x0 <= x1 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null
}

function svgIds(root) {
  if (root._ids) return root._ids
  const m = new Map()
  const walkE = e => { if (e.type !== 1) return; if (e.attrs && e.attrs.id !== undefined) m.set(e.attrs.id, e); for (const c of e.children) walkE(c) }
  walkE(root)
  root._ids = m
  return m
}

function svgRef(S, v) {
  if (!v) return null
  const m = /url\(\s*["']?#([^"')\s]+)["']?\s*\)/.exec(v)
  if (m) return S.ids.get(m[1]) || null
  return null
}

function svgHref(el) { const h = el.attrs.href || el.attrs['xlink:href']; return h ? h.trim() : '' }

function svgGradientProps(g, S) {
  const chain = []
  for (let e = g, k = 0; e && k < 8; k++) {
    chain.push(e)
    const h = svgHref(e)
    e = h.startsWith('#') ? S.ids.get(h.slice(1)) : null
  }
  const attr = n => { for (const e of chain) if (e.attrs[n] !== undefined) return e.attrs[n]; return undefined }
  let stops = []
  for (const e of chain) {
    const ss = e.children.filter(c => c.type === 1 && c.tag === 'stop')
    if (ss.length) { stops = ss; break }
  }
  return { attr, stops }
}

function svgStops(stops, cur) {
  const out = []
  let last = 0
  for (const s of stops) {
    let off = svgProp(s, 'offset', false)
    let f = 0
    if (off !== undefined) f = /%$/.test(off) ? parseFloat(off) / 100 : parseFloat(off)
    if (f !== f) f = 0
    f = Math.min(1, Math.max(0, f))
    if (f < last) f = last
    last = f
    const cv = svgProp(s, 'stop-color', false) || 'black'
    let c = cssColor(cv, s.cs ? s.cs.color : cur) || { r: 0, g: 0, b: 0, a: 1 }
    const so = parseFloat(svgProp(s, 'stop-opacity', false))
    c = { r: c.r, g: c.g, b: c.b, a: c.a * (so === so ? so : 1) }
    out.push({ c, f })
  }
  return out
}

function svgGradientShader(g, S, bb, opacity, cur) {
  const { attr, stops } = svgGradientProps(g, S)
  const st = svgStops(stops, cur)
  if (!st.length) return null
  if (st.length === 1) return { solid: { r: st[0].c.r, g: st[0].c.g, b: st[0].c.b, a: st[0].c.a * opacity } }
  const units = attr('gradientunits') || 'objectBoundingBox'
  const obb = units !== 'userSpaceOnUse'
  if (obb && (!bb || !(bb.w > 0) || !(bb.h > 0))) return null
  let G = obb ? [bb.w, 0, 0, bb.h, bb.x, bb.y] : [1, 0, 0, 1, 0, 0]
  const gt = svgTransform(attr('gradienttransform'))
  if (gt) G = mulM(G, gt)
  const inv = invertM(G)
  if (!inv) return null
  const val = (name, def, base) => {
    const v = attr(name)
    if (v === undefined) return def
    if (obb) return /%$/.test(v) ? parseFloat(v) / 100 : parseFloat(v)
    return svgLen(g, v, base, def)
  }
  const spread = (attr('spreadmethod') || 'pad').toLowerCase()
  const lut = buildLut(st)
  const apply = t => {
    if (spread === 'repeat') { t -= Math.floor(t) }
    else if (spread === 'reflect') { t = Math.abs(t) % 2; if (t > 1) t = 2 - t }
    return t
  }
  const tmp = [0, 0, 0, 0]
  if (g.tag === 'lineargradient') {
    const x1 = val('x1', 0, S.vw), y1 = val('y1', 0, S.vh), x2 = val('x2', obb ? 1 : S.vw, S.vw), y2 = val('y2', 0, S.vh)
    const dx = x2 - x1, dy = y2 - y1, dd = dx * dx + dy * dy
    return {
      fn: (u, v, out) => {
        const px = inv[0] * u + inv[2] * v + inv[4], py = inv[1] * u + inv[3] * v + inv[5]
        const t = dd > 0 ? ((px - x1) * dx + (py - y1) * dy) / dd : 0
        lutLookup(lut, apply(t), false, out)
        out[3] *= opacity
      }
    }
  }
  const half = Math.sqrt((S.vw * S.vw + S.vh * S.vh) / 2)
  const cx = val('cx', obb ? 0.5 : S.vw / 2, S.vw), cy = val('cy', obb ? 0.5 : S.vh / 2, S.vh), r = val('r', obb ? 0.5 : half / 2, half)
  const fx = attr('fx') !== undefined ? val('fx', cx, S.vw) : cx, fy = attr('fy') !== undefined ? val('fy', cy, S.vh) : cy
  return {
    fn: (u, v, out) => {
      const px = inv[0] * u + inv[2] * v + inv[4], py = inv[1] * u + inv[3] * v + inv[5]
      let t
      if (fx === cx && fy === cy) t = r > 0 ? Math.hypot(px - cx, py - cy) / r : 1
      else {
        const dx = px - fx, dy = py - fy
        const a = dx * dx + dy * dy
        if (a === 0) t = 0
        else {
          const b = 2 * (dx * (fx - cx) + dy * (fy - cy)), c = (fx - cx) ** 2 + (fy - cy) ** 2 - r * r
          const disc = b * b - 4 * a * c
          const s = disc < 0 ? 1 : (-b + Math.sqrt(disc)) / (2 * a)
          t = s > 0 ? 1 / s : 1
        }
      }
      lutLookup(lut, apply(t), false, out)
      out[3] *= opacity
    }
  }
}

function svgPaintSource(el, name, S, bb) {
  const def = name === 'fill' ? 'black' : 'none'
  let v = svgProp(el, name, true)
  if (v === undefined) v = def
  const cur = el.cs ? el.cs.color : { r: 0, g: 0, b: 0, a: 1 }
  const opv = parseFloat(svgProp(el, name + '-opacity', true))
  const opacity = opv === opv ? Math.min(1, Math.max(0, opv)) : 1
  if (v === 'none') return null
  const m = /^url\(\s*["']?#([^"')\s]+)["']?\s*\)\s*(.*)$/.exec(v)
  if (m) {
    const ref = S.ids.get(m[1])
    if (ref && (ref.tag === 'lineargradient' || ref.tag === 'radialgradient')) {
      const g = svgGradientShader(ref, S, bb, opacity, cur)
      if (g) return g.solid ? { color: g.solid } : { shader: g.fn }
      return null
    }
    if (m[2]) { const c = cssColor(m[2], cur); return c ? { color: { r: c.r, g: c.g, b: c.b, a: c.a * opacity } } : null }
    return null
  }
  const c = cssColor(v, cur)
  if (!c) return null
  return { color: { r: c.r, g: c.g, b: c.b, a: c.a * opacity } }
}

function dashSubpaths(subs, dashes, offset) {
  const total = dashes.reduce((a, b) => a + b, 0)
  if (!(total > 0)) return subs
  const out = []
  for (const sp of subs) {
    const pts = sp.closed ? sp.pts.concat([sp.pts[0]]) : sp.pts
    let di = 0, rem = dashes[0], on = true
    let off = offset % total
    if (off < 0) off += total
    while (off > 0) { if (off >= rem) { off -= rem; di = (di + 1) % dashes.length; rem = dashes[di]; on = !on } else { rem -= off; off = 0 } }
    let curPts = on ? [pts[0]] : null
    for (let i = 1; i < pts.length; i++) {
      let a = pts[i - 1]
      const b = pts[i]
      let segLen = Math.hypot(b.x - a.x, b.y - a.y)
      while (segLen > rem) {
        const f = rem / segLen
        const m = { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
        if (on) { curPts.push(m); out.push({ pts: curPts, closed: false }); curPts = null } else curPts = [m]
        on = !on
        segLen -= rem
        a = m
        di = (di + 1) % dashes.length; rem = dashes[di]
        if (!(rem > 0)) rem = 1e-6
      }
      rem -= segLen
      if (on && curPts) curPts.push(b)
    }
    if (on && curPts && curPts.length > 1) out.push({ pts: curPts, closed: false })
  }
  return out
}

function paintSvgShape(P, el, S) {
  const tol = 0.2 / P.scale()
  const subs = svgShapeSubpaths(el, S, tol)
  if (!subs.length) return
  const vis = svgProp(el, 'visibility', true)
  if (vis === 'hidden' || vis === 'collapse') return
  const bb = subBBox(subs)
  const fillSrc = svgPaintSource(el, 'fill', S, bb)
  if (fillSrc) {
    const polys = subs.filter(s => s.pts.length >= 3).map(s => s.pts)
    if (polys.length) {
      const rule = (svgProp(el, 'fill-rule', true) || 'nonzero').toLowerCase() === 'evenodd' ? 'evenodd' : 'nonzero'
      if (fillSrc.shader) P.fill(polys, fillSrc.shader, 1, rule); else P.fill(polys, fillSrc.color, 1, rule)
    }
  }
  const strokeSrc = svgPaintSource(el, 'stroke', S, bb)
  if (strokeSrc) {
    const sw = svgLen(el, svgProp(el, 'stroke-width', true), Math.sqrt((S.vw * S.vw + S.vh * S.vh) / 2), 1)
    if (sw > 0) {
      let sub2 = subs
      const da = svgProp(el, 'stroke-dasharray', true)
      if (da && da !== 'none') {
        let arr = da.split(/[\s,]+/).filter(Boolean).map(v => svgLen(el, v, S.vw, 0))
        if (arr.length % 2) arr = arr.concat(arr)
        if (arr.every(v => v >= 0) && arr.some(v => v > 0)) sub2 = dashSubpaths(subs, arr, svgLen(el, svgProp(el, 'stroke-dashoffset', true), S.vw, 0))
      }
      const cap = (svgProp(el, 'stroke-linecap', true) || 'butt').toLowerCase()
      const join = (svgProp(el, 'stroke-linejoin', true) || 'miter').toLowerCase()
      const polys = strokeToPolygons(sub2, sw, cap === 'round' || cap === 'square' ? cap : 'butt', join === 'round' ? 'round' : join === 'bevel' ? 'bevel' : 'miter')
      if (polys.length) { if (strokeSrc.shader) P.fill(polys, strokeSrc.shader, 1, 'nonzero'); else P.fill(polys, strokeSrc.color, 1, 'nonzero') }
    }
  }
}

function svgNodeBBox(el, S, m) {
  if (el.type !== 1) return null
  let acc = null
  const add = (b) => { if (!b) return; acc = acc ? { x0: Math.min(acc.x0, b.x0), y0: Math.min(acc.y0, b.y0), x1: Math.max(acc.x1, b.x1), y1: Math.max(acc.y1, b.y1) } : b }
  const tr = svgTransform(svgProp(el, 'transform', false))
  const mm = tr ? mulM(m, tr) : m
  if (SVG_SHAPES.has(el.tag)) {
    for (const s of svgShapeSubpaths(el, S, 0.5)) for (const p of s.pts) {
      const x = mm[0] * p.x + mm[2] * p.y + mm[4], y = mm[1] * p.x + mm[3] * p.y + mm[5]
      add({ x0: x, y0: y, x1: x, y1: y })
    }
  } else if (el.tag === 'g' || el.tag === 'a' || el.tag === 'svg') for (const c of el.children) add(svgNodeBBox(c, S, mm))
  return acc
}

function svgBBoxOf(el, S) {
  const b = svgNodeBBox(el, S, [1, 0, 0, 1, 0, 0])
  if (!b) return null
  const tr = svgTransform(svgProp(el, 'transform', false))
  if (tr) { const inv = invertM(tr); if (inv) { const pts = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]].map(([x, y]) => ({ x: inv[0] * x + inv[2] * y + inv[4], y: inv[1] * x + inv[3] * y + inv[5] })); const xs = pts.map(p => p.x), ys = pts.map(p => p.y); return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) } } }
  return { x: b.x0, y: b.y0, w: b.x1 - b.x0, h: b.y1 - b.y0 }
}

function svgClipPolys(cp, S, bb, tol) {
  const polys = []
  const obb = (cp.attrs.clippathunits || '') === 'objectBoundingBox'
  const base = obb ? (bb ? [bb.w, 0, 0, bb.h, bb.x, bb.y] : null) : [1, 0, 0, 1, 0, 0]
  if (!base) return polys
  const cpT = svgTransform(svgProp(cp, 'transform', false))
  const root = cpT ? mulM(base, cpT) : base
  const visit = (e, m) => {
    if (e.type !== 1) return
    const tr = svgTransform(svgProp(e, 'transform', false))
    const mm = tr ? mulM(m, tr) : m
    if (SVG_SHAPES.has(e.tag)) {
      if (svgProp(e, 'display', false) === 'none') return
      for (const s of svgShapeSubpaths(e, S, tol)) if (s.pts.length >= 3) polys.push(s.pts.map(p => ({ x: mm[0] * p.x + mm[2] * p.y + mm[4], y: mm[1] * p.x + mm[3] * p.y + mm[5] })))
    } else if (e.tag === 'use') {
      const h = svgHref(e)
      const ref = h.startsWith('#') ? S.ids.get(h.slice(1)) : null
      if (ref) visit(ref, mulM(mm, [1, 0, 0, 1, svgAttrLen(e, 'x', S.vw, 0), svgAttrLen(e, 'y', S.vh, 0)]))
    } else if (e.tag === 'g') for (const c of e.children) visit(c, mm)
  }
  for (const c of cp.children) visit(c, root)
  return polys
}

function svgFontCS(el) {
  const cs = el.cs
  const out = { fontFamily: cs.fontFamily, fontWeight: cs.fontWeight, fontStyle: cs.fontStyle, fontSize: cs.fontSize, letterSpacing: cs.letterSpacing }
  const ff = svgProp(el, 'font-family', true)
  if (ff && !(el.own && typeof el.own['font-family'] === 'string')) out.fontFamily = splitTop(ff, ',').map(x => x.trim().replace(/^["']|["']$/g, '').toLowerCase()).filter(Boolean)
  const fw = svgProp(el, 'font-weight', true)
  if (fw && !(el.own && typeof el.own['font-weight'] === 'string')) out.fontWeight = fw === 'bold' ? 700 : fw === 'normal' ? 400 : (parseFloat(fw) || cs.fontWeight)
  const fst = svgProp(el, 'font-style', true)
  if (fst && !(el.own && typeof el.own['font-style'] === 'string')) out.fontStyle = /italic|oblique/.test(fst) ? 'italic' : 'normal'
  const fs = svgProp(el, 'font-size', true)
  if (fs && !(el.own && typeof el.own['font-size'] === 'string')) { const v = parseLen(fs, { fs: cs.fontSize, rfs: 16, vw: 800, vh: 600 }); if (typeof v === 'number') out.fontSize = v; else if (typeof v === 'function') out.fontSize = v(cs.fontSize) }
  const ls = svgProp(el, 'letter-spacing', true)
  if (ls && ls !== 'normal') { const v = parseLen(ls, cs.E); if (typeof v === 'number') out.letterSpacing = v }
  return out
}

function svgTextRuns(el, S) {
  const runs = []
  const pen = { x: 0, y: 0 }
  let pending = null
  const lenList = (e, n, base) => { const v = e.attrs[n]; return v ? v.split(/[\s,]+/).filter(Boolean).map(s => svgLen(e, s, base, 0)) : [] }
  let first = true
  const visit = (e, inheritedFirst) => {
    const xs = lenList(e, 'x', S.vw), ys = lenList(e, 'y', S.vh), dxs = lenList(e, 'dx', S.vw), dys = lenList(e, 'dy', S.vh)
    let newChunk = false
    if (xs.length) { pen.x = xs[0]; newChunk = true }
    if (ys.length) { pen.y = ys[0]; newChunk = true }
    if (dxs.length) pen.x += dxs[0]
    if (dys.length) pen.y += dys[0]
    if (newChunk || first) { pending = { runs: [], anchor: null }; runs.push(pending); first = false }
    for (const c of e.children) {
      if (c.type === 3) {
        let t = c.text.replace(/[\r\n\t]+/g, ' ')
        if (svgProp(e, 'xml:space', false) !== 'preserve') t = t.replace(/ +/g, ' ')
        if (!t) continue
        const fcs = svgFontCS(e)
        const fi = fontInfo(fcs)
        const w = measureText(fi, t)
        pending.runs.push({ el: e, text: t, x: pen.x, y: pen.y, w, fi })
        pen.x += w
      } else if (c.type === 1 && (c.tag === 'tspan' || c.tag === 'a')) visit(c)
    }
  }
  visit(el)
  for (const ch of runs) {
    if (!ch.runs.length) continue
    const total = ch.runs.reduce((a, r) => a + r.w, 0)
    const anchor = (svgProp(el, 'text-anchor', true) || 'start')
    const sh = anchor === 'middle' ? -total / 2 : anchor === 'end' ? -total : 0
    for (const r of ch.runs) r.x += sh
  }
  return runs.flatMap(c => c.runs)
}

function paintSvgText(P, el, S) {
  const runs = svgTextRuns(el, S)
  const allPolys = []
  for (const r of runs) {
    let y = r.y
    const db = (svgProp(r.el, 'dominant-baseline', true) || svgProp(r.el, 'alignment-baseline', true) || '').toLowerCase()
    if (db === 'middle') y += r.fi.xh / 2
    else if (db === 'central') y += (r.fi.asc - r.fi.desc) / 2
    else if (db === 'hanging') y += r.fi.asc * 0.8
    const g = glyphPolysFor(r.fi, r.text, r.x, y, null, r.fi.synthItalic)
    let polys = g.polys
    if (r.fi.synthBold) { const e = Math.max(0.4, r.fi.size / 32); polys = polys.concat(shiftPolys(polys, e, 0)) }
    r.polys = polys
    allPolys.push(...polys)
  }
  if (!allPolys.length) return
  const bb = subBBox([{ pts: allPolys.flat() }])
  for (const r of runs) {
    const f = svgPaintSource(r.el, 'fill', S, bb)
    if (f) { if (f.shader) P.fill(r.polys, f.shader); else P.fill(r.polys, f.color) }
    const s = svgPaintSource(r.el, 'stroke', S, bb)
    if (s) {
      const sw = svgLen(r.el, svgProp(r.el, 'stroke-width', true), S.vw, 1)
      const sp = strokeToPolygons(r.polys.map(p => ({ pts: p, closed: true })), sw, 'butt', 'miter')
      if (s.shader) P.fill(sp, s.shader); else P.fill(sp, s.color)
    }
  }
}

function svgDrawImage(P, el, S) {
  const h = svgHref(el)
  const key = h ? C.resolveUrl(h) : null
  const img = key ? C.images.get(key) : null
  if (!img || !(img.w > 0)) return
  const x = svgAttrLen(el, 'x', S.vw, 0), y = svgAttrLen(el, 'y', S.vh, 0)
  let w = svgAttrLen(el, 'width', S.vw, img.w), hh = svgAttrLen(el, 'height', S.vh, img.h)
  const m = viewBoxMatrix([0, 0, img.w, img.h], el.attrs.preserveaspectratio, x, y, w, hh)
  P.save()
  P.clipRect(x, y, w, hh)
  drawImageRect(P, img, m[4], m[5], img.w * m[0], img.h * m[3], false, null)
  P.restore()
}

function renderSvgChildren(P, el, S) {
  for (const c of el.children) renderSvgNode(P, c, S)
}

function renderSvgNode(P, el, S, override) {
  if (el.type !== 1) return
  const t = el.tag
  if (SVG_SKIP.has(t) && !override) return
  if (el.cs && el.cs.display === 'none') return
  if (svgProp(el, 'display', false) === 'none') return
  const clipRef = svgRef(S, svgProp(el, 'clip-path', false))
  const maskRef = svgRef(S, svgProp(el, 'mask', false))
  const filtRef = svgRef(S, svgProp(el, 'filter', false))
  const opv = parseFloat(svgProp(el, 'opacity', false))
  const opacity = opv === opv ? Math.min(1, Math.max(0, opv)) : 1
  P.save()
  const tr = svgTransform(svgProp(el, 'transform', false))
  if (tr) P.mul(tr)
  if (override && override.matrix) P.mul(override.matrix)
  let bb = null
  const getBB = () => bb || (bb = svgBBoxOf(el, S))
  if (clipRef && clipRef.tag === 'clippath') {
    const polys = svgClipPolys(clipRef, S, (clipRef.attrs.clippathunits || '') === 'objectBoundingBox' ? getBB() : null, 0.2 / P.scale())
    if (polys.length) P.clipPolys(polys); else { P.restore(); return }
  }
  const draw = Q => {
    switch (t) {
      case 'g': case 'a': renderSvgChildren(Q, el, S); break
      case 'switch': { const c = el.children.find(k => k.type === 1); if (c) renderSvgNode(Q, c, S); break }
      case 'svg': paintNestedSvg(Q, el, S); break
      case 'use': paintSvgUse(Q, el, S); break
      case 'text': paintSvgText(Q, el, S); break
      case 'image': svgDrawImage(Q, el, S); break
      default: if (SVG_SHAPES.has(t)) paintSvgShape(Q, el, S)
    }
  }
  if (opacity < 1 || maskRef || filtRef) {
    const c = P.clip
    const w = c.x1 - c.x0, h = c.y1 - c.y0
    if (w > 0 && h > 0) {
      const L = P.layer(c.x0, c.y0, w, h)
      draw(L)
      if (maskRef && maskRef.tag === 'mask') {
        const Mk = P.layer(c.x0, c.y0, w, h)
        const mbb = (maskRef.attrs.maskcontentunits || '') === 'objectBoundingBox' ? getBB() : null
        if (mbb) Mk.mul([mbb.w, 0, 0, mbb.h, mbb.x, mbb.y])
        renderSvgChildren(Mk, maskRef, S)
        const lb = L.buf, mb = Mk.buf
        for (let i = 0; i < lb.length; i += 4) {
          const lum = (0.2126 * mb[i] + 0.7152 * mb[i + 1] + 0.0722 * mb[i + 2]) / 255
          lb[i + 3] = lb[i + 3] * lum * mb[i + 3] / 255
        }
      }
      let filt = null
      if (filtRef && filtRef.tag === 'filter') {
        const parts = []
        const sc = P.scale()
        for (const f of filtRef.children) {
          if (f.type !== 1) continue
          if (f.tag === 'fegaussianblur') { const sd = parseFloat((f.attrs.stddeviation || '0').split(/[\s,]+/)[0]) || 0; parts.push(`blur(${sd}px)`) }
          else if (f.tag === 'fedropshadow') { const sd = parseFloat((f.attrs.stddeviation || '2').split(/[\s,]+/)[0]) || 0; const fc = svgProp(f, 'flood-color', false) || 'black'; const fo = parseFloat(svgProp(f, 'flood-opacity', false)); const cc = cssColor(fc, el.cs.color) || { r: 0, g: 0, b: 0, a: 1 }; parts.push(`drop-shadow(${parseFloat(f.attrs.dx) || 0}px ${parseFloat(f.attrs.dy) || 0}px ${sd * 2}px rgba(${cc.r},${cc.g},${cc.b},${cc.a * (fo === fo ? fo : 1)}))`) }
        }
        filt = parts.join(' ')
      }
      if (filt) applyFilter(L.buf, L.w, L.h, filt, el.cs.E, P.scale())
      P.composite(L, opacity)
    }
  } else draw(P)
  P.restore()
}

function paintNestedSvg(P, el, S) {
  const x = svgAttrLen(el, 'x', S.vw, 0), y = svgAttrLen(el, 'y', S.vh, 0)
  const w = svgAttrLen(el, 'width', S.vw, S.vw), h = svgAttrLen(el, 'height', S.vh, S.vh)
  const vbs = el.attrs.viewbox
  let vb = null
  if (vbs) { const p = vbs.trim().split(/[\s,]+/).map(Number); if (p.length === 4 && p[2] > 0 && p[3] > 0) vb = p }
  const S2 = Object.assign({}, S)
  P.save()
  P.clipRect(x, y, w, h)
  if (vb) { P.mul(viewBoxMatrix(vb, el.attrs.preserveaspectratio, x, y, w, h)); S2.vw = vb[2]; S2.vh = vb[3] }
  else { P.mul([1, 0, 0, 1, x, y]); S2.vw = w; S2.vh = h }
  renderSvgChildren(P, el, S2)
  P.restore()
}

function paintSvgUse(P, el, S) {
  const h = svgHref(el)
  const ref = h.startsWith('#') ? S.ids.get(h.slice(1)) : null
  if (!ref || (S.depth || 0) > 12) return
  const x = svgAttrLen(el, 'x', S.vw, 0), y = svgAttrLen(el, 'y', S.vh, 0)
  const S2 = Object.assign({}, S, { depth: (S.depth || 0) + 1 })
  P.save()
  P.mul([1, 0, 0, 1, x, y])
  ref._vparent = el
  if (ref.tag === 'symbol' || ref.tag === 'svg') {
    const w = svgAttrLen(el, 'width', S.vw, svgAttrLen(ref, 'width', S.vw, S.vw)), hh = svgAttrLen(el, 'height', S.vh, svgAttrLen(ref, 'height', S.vh, S.vh))
    const vbs = ref.attrs.viewbox
    let vb = null
    if (vbs) { const p = vbs.trim().split(/[\s,]+/).map(Number); if (p.length === 4 && p[2] > 0 && p[3] > 0) vb = p }
    P.save()
    if (vb) { P.clipRect(0, 0, w, hh); P.mul(viewBoxMatrix(vb, ref.attrs.preserveaspectratio, 0, 0, w, hh)); S2.vw = vb[2]; S2.vh = vb[3] }
    renderSvgChildren(P, ref, S2)
    P.restore()
  } else renderSvgNode(P, ref, S2, { matrix: null })
  ref._vparent = null
  P.restore()
}

function svgRootState(root, w, h) {
  const s = svgIntrinsic(root)
  const vb = s.vb || [0, 0, s.w, s.h]
  return { ids: svgIds(root), vw: vb[2], vh: vb[3], depth: 0 }
}

function paintSvgBox(P, box, cr) {
  const el = box.el
  const s = svgIntrinsic(el)
  const vb = s.vb || [0, 0, s.w, s.h]
  if (!(cr.w > 0) || !(cr.h > 0)) return
  P.save()
  P.clipRect(cr.x, cr.y, cr.w, cr.h)
  P.mul(viewBoxMatrix(vb, el.attrs.preserveaspectratio, cr.x, cr.y, cr.w, cr.h))
  const S = svgRootState(el)
  renderSvgChildren(P, el, S)
  P.restore()
}

function rasterSvgImage(img, pw, ph) {
  const root = img.svg.root
  const s = svgIntrinsic(root)
  const vb = s.vb || [0, 0, s.w, s.h]
  const P = new Painter(pw, ph)
  P.mul(viewBoxMatrix(vb, root.attrs.preserveaspectratio, 0, 0, pw, ph))
  renderSvgChildren(P, root, svgRootState(root))
  return { w: pw, h: ph, data: P.buf }
}

const MAX_IMG_BYTES = 25 * 1024 * 1024
const MAX_CSS_BYTES = 4 * 1024 * 1024
const MAX_IMAGES = 300
let uaRules = null

function isPrivateHost(host) {
  host = host.replace(/^\[|\]$/g, '').toLowerCase()
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === 'metadata.google.internal') return true
  const v = isIP(host)
  if (v === 4) {
    const p = host.split('.').map(Number)
    return p[0] === 0 || p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
  }
  if (v === 6) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || /^::ffff:/.test(host)
  return false
}

function makeResolver(o) {
  let baseReal = null
  if (o.baseDir) { try { baseReal = realpathSync(nodePath.resolve(o.baseDir)) } catch { baseReal = null } }
  const inside = p => {
    if (!baseReal) return null
    let real
    try { real = realpathSync(p) } catch { return null }
    return real === baseReal || real.startsWith(baseReal + nodePath.sep) ? real : null
  }
  const netOk = u => {
    if (!o.allowNetwork) return null
    let h
    try { h = new URL(u) } catch { return null }
    if (h.protocol !== 'http:' && h.protocol !== 'https:') return null
    if (!o.allowPrivateNetwork && isPrivateHost(h.hostname)) return null
    return h.href
  }
  const norm = (u0, relTo) => {
    let u = String(u0 || '').trim()
    if (!u || u === 'none') return null
    if (/^data:/i.test(u)) return u
    if (/^https?:\/\//i.test(u)) return netOk(u)
    if (/^\/\//.test(u)) return netOk((relTo && /^https?:/i.test(relTo) ? new URL(relTo).protocol : o.baseUrl ? new URL(o.baseUrl).protocol : 'https:') + u)
    if (/^file:/i.test(u)) { if (!baseReal) return null; try { const r = inside(fileURLToPath(u)); return r ? 'file://' + r : null } catch { return null } }
    if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return null
    if (relTo && /^https?:/i.test(relTo)) { try { return netOk(new URL(u, relTo).href) } catch { return null } }
    if (o.baseUrl) { try { return netOk(new URL(u, o.baseUrl).href) } catch { return null } }
    if (baseReal) {
      let p = u.split('#')[0].split('?')[0]
      try { p = decodeURIComponent(p) } catch {}
      const abs = p.startsWith('/') ? nodePath.join(baseReal, p) : relTo && relTo.startsWith('file://') ? nodePath.resolve(nodePath.dirname(relTo.slice(7)), p) : nodePath.resolve(baseReal, p)
      const r = inside(abs)
      return r ? 'file://' + r : null
    }
    return null
  }
  return norm
}

async function fetchBytes(key, o, maxBytes) {
  if (/^data:/i.test(key)) {
    const i = key.indexOf(',')
    if (i < 0) return null
    const meta = key.slice(5, i), body = key.slice(i + 1)
    try { return /;base64/i.test(meta) ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8') } catch { return Buffer.from(body, 'utf8') }
  }
  if (/^file:\/\//.test(key)) {
    const p = key.slice(7)
    const st = statSync(p)
    if (!st.isFile() || st.size > maxBytes) return null
    return readFileSync(p)
  }
  const ac = new AbortController()
  const tm = setTimeout(() => ac.abort(), o.timeout)
  try {
    const res = await fetch(key, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/4.0 (compatible; canvas-html)', accept: '*/*' } })
    if (!res.ok) return null
    try { const fu = new URL(res.url); if (!o.allowPrivateNetwork && isPrivateHost(fu.hostname)) return null } catch {}
    const len = parseInt(res.headers.get('content-length') || '0', 10)
    if (len > maxBytes) return null
    const reader = res.body.getReader()
    const chunks = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.length
      if (total > maxBytes) { try { await reader.cancel() } catch {} return null }
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks)
  } catch { return null } finally { clearTimeout(tm) }
}

function woffToTtf(buf) {
  if (buf.length < 44 || buf.toString('latin1', 0, 4) !== 'wOFF') return null
  const flavor = buf.readUInt32BE(4), n = buf.readUInt16BE(12)
  const tables = []
  for (let i = 0; i < n; i++) {
    const o = 44 + i * 20
    tables.push({ tag: buf.toString('latin1', o, o + 4), off: buf.readUInt32BE(o + 4), clen: buf.readUInt32BE(o + 8), olen: buf.readUInt32BE(o + 12), sum: buf.readUInt32BE(o + 16) })
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : 1))
  let pos = 12 + n * 16
  const parts = []
  const dir = Buffer.alloc(12 + n * 16)
  dir.writeUInt32BE(flavor, 0); dir.writeUInt16BE(n, 4)
  let sr = 1, es = 0
  while (sr * 2 <= n) { sr *= 2; es++ }
  dir.writeUInt16BE(sr * 16, 6); dir.writeUInt16BE(es, 8); dir.writeUInt16BE(n * 16 - sr * 16, 10)
  tables.forEach((t, i) => {
    let data = buf.subarray(t.off, t.off + t.clen)
    if (t.clen < t.olen) data = zlib.inflateSync(data)
    const o = 12 + i * 16
    dir.write(t.tag, o, 'latin1'); dir.writeUInt32BE(t.sum >>> 0, o + 4); dir.writeUInt32BE(pos, o + 8); dir.writeUInt32BE(data.length, o + 12)
    parts.push(data)
    const pad = (4 - (data.length & 3)) & 3
    if (pad) parts.push(Buffer.alloc(pad))
    pos += data.length + pad
  })
  return Buffer.concat([dir, ...parts])
}

function parseSvgDoc(text) {
  const doc = normalizeDoc(parseHTML(text))
  indexTree(doc.html)
  let root = null
  walk(doc.html, n => { if (!root && n.type === 1 && n.tag === 'svg') { root = n; return false } })
  if (!root) return null
  const out = { rules: [], fontFaces: [], order: 0 }
  for (const r of uaRules) out.rules.push(r)
  out.order = uaRules.length
  walk(root, n => { if (n.type === 1 && n.tag === 'style') parseStylesheet(textOf(n), { width: 300, height: 150 }, out, 1) })
  const s = svgIntrinsic(root)
  const ctx2 = { idx: buildIndex(out.rules), vw: s.w, vh: s.h, rootFs: 16, counters: new Map(), images: new Map() }
  computeTree(root, null, ctx2)
  return root
}

function uaRuleList() {
  if (uaRules) return uaRules
  const out = { rules: [], fontFaces: [], order: 0 }
  parseStylesheet(UA_CSS, { width: 800, height: 600 }, out, 0)
  uaRules = out.rules
  return uaRules
}

async function decodeImageBytes(buf, key) {
  const head = buf.subarray(0, 512).toString('utf8').trimStart()
  if (/^(<\?xml|<svg|<!doctype svg|<!--)/i.test(head) || /\.svg(\?|#|$)/i.test(key) || /^data:image\/svg/i.test(key)) {
    const root = parseSvgDoc(buf.toString('utf8'))
    if (!root) return null
    const s = svgIntrinsic(root)
    return { w: s.w, h: s.h, svg: { root } }
  }
  const j = await Jimp.read(buf)
  return { w: j.width, h: j.height, data: j.bitmap.data }
}

async function loadFonts(faces, o, norm, custom) {
  for (const f of faces) {
    const d = {}
    for (const x of f) d[x.p.toLowerCase()] = x.v
    if (!d['font-family'] || !d.src) continue
    const fam = d['font-family'].trim().replace(/^["']|["']$/g, '').toLowerCase()
    const wv = (d['font-weight'] || '400').trim().toLowerCase()
    const weight = wv === 'bold' ? 700 : wv === 'normal' ? 400 : (parseFloat(wv) || 400)
    const italic = /italic|oblique/i.test(d['font-style'] || '')
    const srcs = splitTop(d.src, ',').map(s => s.trim())
    for (const s of srcs) {
      const m = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)/i.exec(s)
      if (!m) continue
      const fmt = /format\(\s*["']?([^"')]*)/i.exec(s)
      if (fmt && /woff2|svg|embedded-opentype/i.test(fmt[1])) continue
      const key = norm(m[1] ?? m[2] ?? m[3], f.__base)
      if (!key) continue
      let buf = await fetchBytes(key, o, MAX_IMG_BYTES)
      if (!buf) continue
      try {
        if (buf.toString('latin1', 0, 4) === 'wOFF') buf = woffToTtf(buf)
        if (!buf) continue
        const ttf = new TTFont(buf)
        ttf._id = ++fontSeq
        custom.push({ family: fam, weight, italic, ttf, variable: false })
        break
      } catch {}
    }
  }
}

function walkBoxes(b, fn) {
  fn(b)
  for (const c of b.children) walkBoxes(c, fn)
}

function scrollExtent(b, acc) {
  if (b.ax !== undefined && b.type !== 'text') { acc.x = Math.max(acc.x, b.ax + b.w); acc.y = Math.max(acc.y, b.ay + b.h) }
  if (b.ifc && b.lines) for (const ln of b.lines) { acc.x = Math.max(acc.x, b.cx + ln.x0 + ln.w); acc.y = Math.max(acc.y, b.cy + ln.y + ln.h) }
  if (b.cs.clips && b.type !== 'replaced' && b !== C.rootBox) return acc
  if (b.ifc) { for (const a of b.ifcBoxes || []) scrollExtent(a, acc); for (const a of b.ifcOof || []) scrollExtent(a, acc) }
  else for (const c of b.children) scrollExtent(c, acc)
  return acc
}

function normalizeOptions(opts) {
  const o = Object.assign({ width: 800, height: null, scale: 1, background: '#ffffff', transparent: false, baseDir: null, baseUrl: null, allowNetwork: true, allowPrivateNetwork: false, timeout: 10000, fonts: [], maxPixels: 100_000_000, maxHeight: 40000 }, opts || {})
  o.width = Math.max(1, Math.min(8192, Math.round(+o.width || 800)))
  o.scale = Math.max(0.1, Math.min(8, +o.scale || 1))
  if (o.height != null) o.height = Math.max(1, Math.min(o.maxHeight, Math.round(+o.height)))
  o.timeout = Math.max(500, +o.timeout || 10000)
  return o
}

async function renderHtmlInner(input, opts) {
  const o = normalizeOptions(opts)
  if (Buffer.isBuffer(input)) input = input.toString('utf8')
  let html = String(input)
  if (!/</.test(html) && html.length < 4096 && /\.html?$/i.test(html.trim())) {
    const fp = nodePath.resolve(html.trim())
    html = readFileSync(fp, 'utf8')
    if (!o.baseDir) o.baseDir = nodePath.dirname(fp)
  }
  if (html.length > 20 * 1024 * 1024) throw new Error('html: input terlalu besar')
  const norm = makeResolver(o)
  uaRuleList()
  fontState.custom = []
  fontState.loaded.clear()
  fontInfoCache.clear()
  fontState.fallback = null
  for (const rf of registeredFonts.values()) { if (rf.font) { rf.font._id = rf.font._id || ++fontSeq; fontState.custom.push({ family: rf.family.toLowerCase(), weight: 400, italic: false, ttf: rf.font, variable: false }) } }
  const custom = fontState.custom
  for (const uf of o.fonts || []) {
    try {
      const buf = Buffer.isBuffer(uf.data) ? uf.data : Buffer.isBuffer(uf.buffer) ? uf.buffer : readFileSync(uf.path || uf.src)
      const ttf = new TTFont(buf.toString('latin1', 0, 4) === 'wOFF' ? woffToTtf(buf) : buf)
      ttf._id = ++fontSeq
      custom.push({ family: String(uf.family).toLowerCase(), weight: uf.weight || 400, italic: uf.style === 'italic', ttf, variable: false })
    } catch {}
  }

  const doc = normalizeDoc(parseHTML(html))
  indexTree(doc.html)
  const vw = o.width, vh = o.height || Math.round(o.width * 0.75)
  const env = { width: vw, height: vh }
  const sheet = { rules: uaRules.slice(), fontFaces: [], order: uaRules.length }
  const sources = []
  walk(doc.html, n => {
    if (n.type !== 1) return
    if (n.tag === 'style' && !n.svgInner) { if (!n.attrs.media || matchMedia(n.attrs.media, env)) sources.push({ css: textOf(n), base: null }) }
    else if (n.tag === 'link' && /stylesheet/i.test(n.attrs.rel || '') && n.attrs.href && (!n.attrs.media || matchMedia(n.attrs.media, env))) sources.push({ href: n.attrs.href })
  })
  const loadCss = async (href, base, depth) => {
    const key = norm(href, base)
    if (!key) return ''
    const b = await fetchBytes(key, o, MAX_CSS_BYTES)
    if (!b) return ''
    return await expandImports(b.toString('utf8'), key, depth + 1)
  }
  const expandImports = async (css, base, depth) => {
    if (depth > 3) return css
    const re = /@import\s+(?:url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*?))\s*\)|"([^"]*)"|'([^']*)')[^;]*;/gi
    const jobs = []
    let m
    while ((m = re.exec(css))) jobs.push({ whole: m[0], href: m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5] })
    for (const j of jobs.slice(0, 8)) css = css.replace(j.whole, await loadCss(j.href, base, depth))
    return css
  }
  const faceSets = []
  for (const s of sources) {
    let css = s.css
    let base = null
    if (s.href) { const key = norm(s.href, null); if (!key) continue; const b = await fetchBytes(key, o, MAX_CSS_BYTES); if (!b) continue; css = b.toString('utf8'); base = key }
    css = await expandImports(css || '', base, 0)
    const before = sheet.fontFaces.length
    parseStylesheet(css, env, sheet, 1)
    for (let i = before; i < sheet.fontFaces.length; i++) sheet.fontFaces[i].__base = base
  }
  await loadFonts(sheet.fontFaces, o, norm, custom)

  const pending = new Map()
  const images = new Map()
  const ctx = {
    idx: buildIndex(sheet.rules), vw, vh, rootFs: 16, counters: new Map(), images,
    want(u) { const k = norm(u, null); if (!k) return null; if (!images.has(k) && !pending.has(k) && pending.size + images.size < MAX_IMAGES) pending.set(k, true); return k },
    resolveUrl(u) { return norm(u, null) }
  }
  const rootEl = { type: 1, tag: '#root', attrs: {}, children: [], kids: [], parent: null, anon: true }
  rootEl.cs = makeCS(rootEl, { display: 'block' }, Object.create(null), null, ctx)
  computeTree(doc.html, null, ctx)
  const noClip = e => { if (e && e.cs) { e.cs.clips = false; e.cs.overflowX = 'visible'; e.cs.overflowY = 'visible' } }
  const bodyEl = doc.body
  if (doc.html.cs.overflowX === 'visible' && doc.html.cs.overflowY === 'visible') noClip(bodyEl)
  noClip(doc.html)
  const rootBox = new Box('block', 'flow', null, rootEl.cs)
  rootBox.absList = []; rootBox.posAnc = null; rootBox.anon = true
  ctx.rootBox = rootBox
  C = ctx
  for (const b of makeBoxes(ctx, doc.html, rootBox)) { rootBox.children.push(b); b.parent = rootBox }
  const htmlBox = rootBox.children[0]
  let bodyBox = null
  if (htmlBox) walkBoxes(htmlBox, b => { if (!bodyBox && b.el && b.el.tag === 'body') bodyBox = b })
  const wantCss = cs => {
    for (const l of cs.bgLayers) { const m = /^url\(\s*["']?([^"')]*)["']?\s*\)/i.exec(l.image.trim()); if (m) ctx.want(m[1]) }
  }
  walkBoxes(rootBox, b => {
    wantCss(b.cs)
    if (b.el && b.el.tag === 'svg' && !(b.el.parent && b.el.parent.svg)) walk(b.el, n => { if (n.type === 1 && n.tag === 'image') { const h = n.attrs.href || n.attrs['xlink:href']; if (h) ctx.want(h) } })
  })
  const keys = [...pending.keys()]
  pending.clear()
  let qi = 0
  const worker = async () => {
    while (qi < keys.length) {
      const k = keys[qi++]
      try {
        const b = await fetchBytes(k, o, MAX_IMG_BYTES)
        if (!b) continue
        const img = await decodeImageBytes(b, k)
        if (img && img.w > 0 && img.h > 0) images.set(k, img)
      } catch {}
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])

  C = ctx
  fontInfoCache.clear()
  for (const b of rootBox.children) b.parent = rootBox
  layoutBox(rootBox, { cbw: vw, cbh: NaN, w: vw })
  rootBox.rx = 0; rootBox.ry = 0
  placeBox(rootBox, 0, 0)
  const ext = scrollExtent(rootBox, { x: 0, y: 0 })
  let docH = Math.max(rootBox.h, ext.y)
  if (o.height) docH = o.height
  docH = Math.max(1, Math.ceil(docH))
  const pw = Math.ceil(vw * o.scale), ph = Math.ceil(docH * o.scale)
  if (pw * ph > o.maxPixels) throw new Error(`html: hasil terlalu besar (${pw}x${ph} px, batas ${(o.maxPixels / 1e6).toFixed(0)} MP)`)
  const P = new Painter(pw, ph)
  P.M = [o.scale, 0, 0, o.scale, 0, 0]
  if (!o.transparent) {
    const bgc = cssColor(o.background, { r: 0, g: 0, b: 0, a: 1 }) || { r: 255, g: 255, b: 255, a: 1 }
    for (let i = 0; i < P.buf.length; i += 4) { P.buf[i] = bgc.r; P.buf[i + 1] = bgc.g; P.buf[i + 2] = bgc.b; P.buf[i + 3] = bgc.a * 255 }
  }
  if (htmlBox) {
    const hcs = htmlBox.cs
    let src = null
    if (hcs.bgColor.a > 0 || hcs.bgLayers.length) { src = htmlBox }
    else if (bodyBox && (bodyBox.cs.bgColor.a > 0 || bodyBox.cs.bgLayers.length)) src = bodyBox
    if (src) {
      src.noBg = true
      if (src !== htmlBox) htmlBox.noBg = true
      const R = boxRects(htmlBox)
      paintBackground(P, src.cs, R, [[0, 0], [0, 0], [0, 0], [0, 0]], { canvas: { x: 0, y: 0, w: vw, h: docH } })
    }
  }
  paintStackRoot(P, rootBox)
  const cv = new Canvas(1, 1)
  cv.width = pw; cv.height = ph; cv._raw = P.buf; cv._ctx = null
  C = null
  return cv
}

let renderQueue = Promise.resolve()

function renderHtml(input, opts) {
  const run = () => renderHtmlInner(input, opts)
  const p = renderQueue.then(run, run)
  renderQueue = p.then(() => {}, () => {})
  return p
}

function isHtmlInput(v) {
  if (v && typeof v === 'object' && !Buffer.isBuffer(v) && !ArrayBuffer.isView(v) && !(v instanceof ArrayBuffer) && typeof v.html === 'string') return true
  return typeof v === 'string' && /^\s*(?:<!doctype\s+html|<!--|<\?xml|<[a-z][a-z0-9-]*[\s>\/])/i.test(v)
}

async function htmlToJimp(v, opts) {
  let html = v, o = opts
  if (v && typeof v === 'object' && typeof v.html === 'string') { html = v.html; o = Object.assign({}, v, opts); delete o.html }
  const cv = await renderHtml(html, o)
  return new Jimp({ data: cv._raw, width: cv.width, height: cv.height })
}

return { renderHtml, isHtmlInput, htmlToJimp }
})()

const jimp = {
  Jimp,
  read: src => Jimp.read(src),
  fromHtml: (html, opts) => htmlEngine.htmlToJimp(html, opts),
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
  TTFont, loadFontBuffer, loadFontFace, fillPolygons, BuiltinFont, getBuiltinFont,

  metadata(buf) {
    const format = detectFormat(buf)
    if (!format) throw new Error('metadata: format gambar tidak dikenali')
    const d = readDimensions(buf)
    if (!d) throw new Error('metadata: dimensi tidak terbaca')
    return { format, width: d.width, height: d.height }
  },

  async resize(input, w, h, { fit = 'fill', position = 'center', background, out = 'png', quality, kernel } = {}) {
    const img = await Jimp.read(input)
    img.resize(w, h, { fit, position, background, kernel })
    return img.getBuffer(FORMAT_MIME[out], { quality })
  },

  async extract(input, { left, top, width, height }, out = 'jpeg', quality) {
    const img = await Jimp.read(input)
    img.crop(left, top, width, height)
    return img.getBuffer(FORMAT_MIME[out], { quality })
  },

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
  createCanvas, loadImage, registerFont, loadFont, loadFontFace, getBuiltinFont,
  html: (input, opts) => htmlEngine.renderHtml(input, opts),
  htmlToCanvas: (input, opts) => htmlEngine.renderHtml(input, opts),
  Canvas, CanvasRenderingContext2D, Image, Path2D
}

export { canvas, jimp }
