import { jimp } from 'hiro/canvas';
import axios from 'hiro/axios';
import { probe, runFfmpegArgs } from 'hiro/ffmpeg';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import Helper, { getTmpDir } from '../../lib/utils/helper.js';
const { fileTypeFromBuffer } = Helper;

const execFileAsync = promisify(execFile);
const MAX_DURATION = 60;

const toEven = (value) => Math.max(2, 2 * Math.round(Number(value) / 2))

const probeMedia = async (file) => {
  try {
    const info = await probe(file)
    const video = (info.streams || []).find((s) => s.type === 'video') || {}
    return { duration: Number(info.format?.duration) || 0, width: video.width || 0, height: video.height || 0 }
  } catch {
    return { duration: 0, width: 0, height: 0 }
  }
}

const runFfmpeg = async (args) => {
  if (await runFfmpegArgs(args).catch(() => false)) return
  await execFileAsync('ffmpeg', args, { timeout: 180000, killSignal: 'SIGKILL', maxBuffer: 10 * 1024 * 1024 })
}

const resizeMotion = async (conn, m, platform, media, isGif, towidth, toheight) => {
  const width = toEven(towidth)
  const height = toEven(toheight)
  const dir = getTmpDir()
  await fs.promises.mkdir(dir, { recursive: true })
  const id = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
  const input = path.join(dir, `resize_in_${id}`)
  const output = path.join(dir, `resize_out_${id}.mp4`)
  try {
    await fs.promises.writeFile(input, media)
    const source = await probeMedia(input)
    if (source.duration > MAX_DURATION) throw `- Video is too long (${Math.round(source.duration)}s), maximum duration is ${MAX_DURATION} seconds.`
    const scale = platform === 'discord'
      ? `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height}`
      : `scale=${width}:${height}`
    await runFfmpeg([
      '-y', '-i', input, '-t', String(MAX_DURATION),
      '-vf', scale,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      output
    ])
    if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw '- Resize failed, output is empty.'
    const out = await fs.promises.readFile(output)
    const caption = `                 *\`Resize ${isGif ? 'GIF' : 'Video'}\`*\n- *Width  :* ${source.width || '?'} > ${width}\n- *Height:* ${source.height || '?'} > ${height}`
    if (platform === 'discord') return await conn.discord(m.chat, { video: out, fileName: 'resized.mp4', text: caption.replace(/\*([^*\n]+)\*/g, '**$1**') })
    return await conn.sendMessage(m.chat, { video: out, mimetype: 'video/mp4', gifPlayback: isGif, caption }, { quoted: m })
  } finally {
    await Promise.all([fs.promises.unlink(input).catch(() => null), fs.promises.unlink(output).catch(() => null)])
  }
}

let handler = async (m, { conn, args, usedPrefix, command, platform }) => {
  var towidth = platform === 'discord' ? args.width : args[0]
  var toheight = platform === 'discord' ? args.height : args[1]
  if (!towidth || !toheight) throw `- *Example:* ${usedPrefix + command} <width> <height>`
  var q = m.quoted ? m.quoted : m
  var mime = (q.msg || q).mimetype || ''
  if (!mime) throw "- Please Reply/caption the image, GIF or video you want to resize."
  var media = await q.download()
  if (/^(image\/gif|video\/)/.test(mime)) {
    const isGif = /gif/.test(mime) || Boolean((q.msg || q).gifPlayback)
    return resizeMotion(conn, m, platform, media, isGif, towidth, toheight)
  }
  var isMedia = /image\/(png|jpe?g)/.test(mime)
  if (!isMedia) throw `- Mime ${mime} not Supported`
  var sourceMeta = jimp.metadata(media)
  var size = { before:{ height: sourceMeta.height, width: sourceMeta.width },
               after:{ height: toheight, width: towidth } }
  var caption = `                 *\`Resize Image\`*\n- *Width  :* ${size.before.width} > ${size.after.width}\n- *Height:* ${size.before.height} > ${size.after.height}`
  if (platform === 'discord') {
    var resized = await jimp.resize(media, towidth - 0, toheight - 0, { fit: 'cover' })
    return conn.discord(m.chat, { image: resized, fileName: 'resized.png', text: caption.replace(/\*([^*\n]+)\*/g, '**$1**') })
  }
  var compres = await conn.resize(media, towidth - 0, toheight - 0)
  conn.sendFile(m.chat, compres, null, caption, m)
}
handler.help = [
    ...(['resize [ width ] [ height]']),
    { command: 'resize', name: 'width', description: 'New width in pixels', type: 'integer', required: true, min_value: 1, max_value: 8000 },
    { command: 'resize', name: 'height', description: 'New height in pixels', type: 'integer', required: true, min_value: 1, max_value: 8000 },
    { command: 'resize', name: 'file', description: 'Image, GIF or video to resize (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools']
handler.command = ['resize']
handler.description = 'Resize an image, GIF or video'

handler.platform = { whatsapp: true, discord: true }

export default handler
