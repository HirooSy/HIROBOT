import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateWAMessage } from 'baileys'
import Helper from '../../lib/utils/helper.js'

const { fileTypeFromBuffer } = Helper

const VIDEO_EXT = ['mp4', 'mkv', 'mov', 'avi', 'webm', '3gp']
const IMAGE_EXT = ['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif', 'heic']
const FFMPEG_TIMEOUT_MS = 120000
const OWNER_FLAG = /(?:^|\s)--owner(?=\s|$)/i
const OWNER_FLAG_GLOBAL = /(?:^|\s)--owner(?=\s|$)/gi

const mediaOf = item => item?.msg || item
const mimeOf = item => mediaOf(item)?.mimetype || ''
const isStatusMedia = item => /image|video|document/i.test(mimeOf(item)) || /(image|video|document)Message/i.test(item?.mtype || '')

const mediaKindOf = item => {
  const mtype = item?.mtype || ''
  if (/document/i.test(mtype)) return 'document'
  if (/video/i.test(mtype)) return 'video'
  if (/image/i.test(mtype)) return 'image'
  const mime = mimeOf(item)
  if (/video/i.test(mime)) return 'video'
  if (/image/i.test(mime)) return 'image'
  return 'document'
}

const downloadStatusMedia = async (conn, item) => {
  const buffer = await conn.downloadM(mediaOf(item), mediaKindOf(item), {}).catch(() => null)
  if (buffer?.length) return buffer
  if (typeof item.download === 'function') return item.download().catch(() => null)
  return null
}

const parseFlags = text => ({
  ownerOnly: OWNER_FLAG.test(text),
  content: text.replace(OWNER_FLAG_GLOBAL, '').trim()
})

const getOwnerJids = () => global.settings.owner
  .map(([number]) => String(number || '').replace(/[^\d]/g, ''))
  .filter(Boolean)
  .map(number => `${number}@s.whatsapp.net`)

const getUserJids = () => Object.keys(global.db?.data?.users || {})
  .filter(jid => jid.endsWith('@s.whatsapp.net') && !jid.startsWith('bf:'))

const resolveAudience = (ownerOnly, sender) => {
  if (ownerOnly) {
    const owners = new Set(getOwnerJids())
    if (sender) owners.add(sender)
    return [...owners]
  }
  return getUserJids()
}

const runProcess = (bin, args, timeoutMs) => new Promise((resolve, reject) => {
  const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
  proc.stdout.on('data', chunk => stdout.push(chunk))
  proc.stderr.on('data', chunk => stderr.push(chunk))
  proc.on('error', err => {
    clearTimeout(timer)
    reject(err)
  })
  proc.on('close', code => {
    clearTimeout(timer)
    if (code === 0) return resolve(Buffer.concat(stdout))
    reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${bin} exited with code ${code}`))
  })
})

const probeStreams = async file => {
  const output = await runProcess('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', file], FFMPEG_TIMEOUT_MS)
  return JSON.parse(output.toString('utf8')).streams || []
}

const normalizeVideo = async buffer => {
  const dir = await mkdtemp(join(tmpdir(), 'status-'))
  try {
    const input = join(dir, 'input')
    const output = join(dir, 'output.mp4')
    await writeFile(input, buffer)

    const streams = await probeStreams(input)
    const video = streams.find(stream => stream.codec_type === 'video')
    if (!video) throw new Error('The file does not contain a video stream.')

    const videoArgs = video.codec_name === 'h264' && video.pix_fmt === 'yuv420p'
      ? ['-c:v', 'copy']
      : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p']

    await runProcess('ffmpeg', [
      '-y', '-v', 'error',
      '-i', input,
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-sn', '-dn',
      ...videoArgs,
      '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4',
      output
    ], FFMPEG_TIMEOUT_MS)

    return await readFile(output)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  const { ownerOnly, content } = parseFlags(text || '')
  const quoted = m.quoted || null
  const source = [quoted, m].find(item => item && isStatusMedia(item))

  if (!source && !content && !quoted) return m.reply(`Reply a photo/video document with \`${usedPrefix + command} [--owner] <optional caption>\` to upload status.`)

  const audience = resolveAudience(ownerOnly, m.sender)
  if (!audience.length) return m.reply('No recipients found for the selected audience.')

  await m.react('⏳').catch(() => {})

  try {
    let messageContent

    if (source) {
      const buffer = await downloadStatusMedia(conn, source)
      if (!buffer?.length) {
        await m.react('❌').catch(() => {})
        return m.reply('Failed to download media.')
      }

      const typeInfo = await fileTypeFromBuffer(buffer).catch(() => null)
      const mime = typeInfo?.mime || mimeOf(source)
      const ext = typeInfo?.ext || ''
      const fileName = mediaOf(source)?.fileName || ''
      const caption = content || (source === quoted ? mediaOf(quoted)?.caption : '') || ''
      const kind = mediaKindOf(source)

      const isVideo = kind === 'video' || /video/i.test(mime) || VIDEO_EXT.includes(ext) || /\.(mp4|mkv|mov|avi|webm|3gp)$/i.test(fileName)
      const isImage = kind === 'image' || /image/i.test(mime) || IMAGE_EXT.includes(ext) || /\.(jpg|jpeg|png|webp|bmp|gif|heic)$/i.test(fileName)

      if (isVideo) {
        const video = await normalizeVideo(buffer)
        messageContent = { video, mimetype: 'video/mp4', caption: caption || undefined }
      } else if (isImage) {
        messageContent = { image: buffer, mimetype: /image/i.test(mime) ? mime : 'image/jpeg', caption: caption || undefined }
      } else {
        await m.react('❌').catch(() => {})
        return m.reply('The document is not a valid photo or video for status.')
      }
    } else {
      messageContent = { text: content, backgroundColor: '#34B7F1' }
    }

    const userJid = conn.decodeJid(conn.user.id)
    const fullMsg = await generateWAMessage('status@broadcast', messageContent, { userJid, upload: conn.waUploadToServer })

    await conn.relayMessage('status@broadcast', fullMsg.message, {
      messageId: fullMsg.key.id,
      statusJidList: audience
    })

    await m.react('✅').catch(() => {})
    return m.reply('Status uploaded successfully.')
  } catch (err) {
    await m.react('❌').catch(() => {})
    return m.reply(`Failed: ${err.message}`)
  }
}

handler.help = [
  'sw <text/reply>',
  'upsw <text/reply>',
  'swhd <text/reply>'
]
handler.tags = ['owner']
handler.command = /^(sw|upsw|swhd)$/i
handler.platform = { whatsapp: { permission: ['owner'] }, discord: false }
handler.ai = { risk: 'low', description: 'upload a photo or video to the WhatsApp status' }

export default handler