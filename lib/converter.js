import { createReadStream, promises, ReadStream } from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { Readable } from 'stream'
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

export {
  toAudio,
  toPTT,
  toVideo,
  ffmpeg,
}