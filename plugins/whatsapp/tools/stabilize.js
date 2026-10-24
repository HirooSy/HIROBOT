import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFile)
const TMP_DIR = path.join(process.cwd(), 'data/tmp')
const MAX_SIZE = 50 * 1024 * 1024
const MAX_DURATION = 120
const SCALE = "scale='trunc(min(720,iw)/2)*2':-2"

const formatBytes = (bytes) => {
    if (!bytes) return '0 Bytes'
    const sizes = ['Bytes', 'KB', 'MB', 'GB']
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), sizes.length - 1)
    return `${parseFloat((bytes / Math.pow(1024, i)).toFixed(2))} ${sizes[i]}`
}

const formatDuration = (seconds) => {
    const sec = Math.floor(seconds || 0)
    const h = Math.floor(sec / 3600)
    const mn = Math.floor((sec % 3600) / 60)
    const s = sec % 60
    if (h > 0) return `${h}h ${mn}m ${s}s`
    if (mn > 0) return `${mn}m ${s}s`
    return `${s}s`
}

const remove = (file) => fs.promises.unlink(file).catch(() => null)

let handler = async (m, { conn, text, usedPrefix, command }) => {
    const q = m.quoted ? m.quoted : m
    const mime = (q.msg || q).mimetype || q.mediaType || ''

    if (!/video|gif/i.test(mime)) {
        throw `*Video Stabilizer*\n\nReply to or send a video/GIF with the caption:\n- ${usedPrefix + command}\n\nModes:\n- ${usedPrefix + command} low : gentle, keeps natural motion\n- ${usedPrefix + command} normal : default\n- ${usedPrefix + command} high : for very shaky videos\n- ${usedPrefix + command} tripod : static camera\n- ${usedPrefix + command} <number> : custom smoothing 3-30, e.g. ${usedPrefix + command} 12`
    }

    let presetName = 'Natural (Normal)'
    let shakiness = 5
    let accuracy = 9
    let smoothing = 10
    let maxshift = 25
    let maxangle = 0.03
    let zoom = 2
    let isTripod = false

    const opt = (text || '').trim().toLowerCase()
    if (['low', 'soft', 'gentle'].includes(opt)) {
        presetName = 'Gentle (Low)'
        shakiness = 4
        smoothing = 6
        maxshift = 15
        maxangle = 0.02
        zoom = 1
    } else if (['high', 'hard', 'strong'].includes(opt)) {
        presetName = 'Strong (High)'
        shakiness = 7
        smoothing = 16
        maxshift = 35
        maxangle = 0.04
        zoom = 4
    } else if (['tripod', 'static', 'still'].includes(opt)) {
        presetName = 'Tripod'
        isTripod = true
        zoom = 3
    } else if (/^\d+$/.test(opt)) {
        smoothing = Math.min(30, Math.max(3, parseInt(opt, 10)))
        presetName = `Custom (Smoothing ${smoothing})`
        maxshift = Math.min(40, smoothing * 2.5)
        maxangle = 0.035
        zoom = Math.min(6, Math.max(1, Math.round(smoothing / 4)))
    }

    await m.react('⏳')

    await fs.promises.mkdir(TMP_DIR, { recursive: true })
    const id = `${Date.now()}_${crypto.randomBytes(4).toString('hex')}`
    const tmpIn = path.join(TMP_DIR, `stab_in_${id}.mp4`)
    const trfFile = path.join(TMP_DIR, `stab_trf_${id}.trf`)
    const tmpOut = path.join(TMP_DIR, `stab_out_${id}.mp4`)

    try {
        const media = await q.download()
        if (!media || !Buffer.isBuffer(media) || !media.length) throw new Error('Failed to download the video.')
        if (media.length > MAX_SIZE) throw new Error('Video is too large, maximum size is 50 MB.')

        await fs.promises.writeFile(tmpIn, media)

        let duration = 0
        try {
            const probe = await execFileAsync('ffprobe', ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', tmpIn])
            const data = JSON.parse(probe.stdout || '{}')
            duration = parseFloat(data.format?.duration || (data.streams || []).find(s => s.codec_type === 'video')?.duration || 0) || 0
        } catch {}

        if (duration > MAX_DURATION) throw new Error(`Video is too long (${formatDuration(duration)}), maximum duration is ${MAX_DURATION} seconds.`)

        try {
            await execFileAsync('ffmpeg', [
                '-y', '-loglevel', 'error',
                '-i', tmpIn,
                '-vf', `${SCALE},vidstabdetect=stepsize=6:shakiness=${shakiness}:accuracy=${accuracy}:result=${trfFile}`,
                '-f', 'null', '-'
            ], { maxBuffer: 10 * 1024 * 1024 })
        } catch (e) {
            if (/No such filter|vidstab/i.test(String(e?.stderr || e?.message))) throw new Error('FFmpeg on this server does not support libvidstab.')
            throw e
        }

        if (!fs.existsSync(trfFile)) throw new Error('Failed to analyze the video shake.')

        const transform = isTripod
            ? `${SCALE},vidstabtransform=input=${trfFile}:tripod=1:crop=keep:optzoom=0:zoom=${zoom}:interpol=bilinear`
            : `${SCALE},vidstabtransform=input=${trfFile}:smoothing=${smoothing}:optalgo=gauss:maxshift=${maxshift}:maxangle=${maxangle}:crop=keep:optzoom=0:zoom=${zoom}:interpol=bilinear`

        await execFileAsync('ffmpeg', [
            '-y', '-loglevel', 'error',
            '-i', tmpIn,
            '-vf', transform,
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '128k',
            '-movflags', '+faststart',
            tmpOut
        ], { maxBuffer: 10 * 1024 * 1024 })

        if (!fs.existsSync(tmpOut) || fs.statSync(tmpOut).size === 0) throw new Error('Stabilized output is empty.')

        const out = await fs.promises.readFile(tmpOut)
        const caption = `*Video Stabilizer*\n- *Mode:* ${presetName}\n- *Smoothing:* ${isTripod ? 'Tripod' : smoothing}\n- *Zoom:* ${zoom}%\n- *Duration:* ${formatDuration(duration)}\n- *Size:* ${formatBytes(media.length)} > ${formatBytes(out.length)}`

        await conn.sendMessage(m.chat, { video: out, mimetype: 'video/mp4', caption }, { quoted: m })
        await m.react('✅')
    } catch (e) {
        await m.react('❌')
        throw `Error: ${e?.message || e}`
    } finally {
        await Promise.all([remove(tmpIn), remove(trfFile), remove(tmpOut)])
    }
}

handler.help = ['stabilize']
handler.tags = ['tools']
handler.command = /^(stabilize)$/i
handler.limit = true

export default handler