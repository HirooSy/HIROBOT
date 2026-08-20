import { format } from 'util'

// Minimal WebP EXIF chunk reader (RIFF container parsing) — replaces node-webpmux
function readWebpExifChunk(buffer) {
    if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') {
        throw new Error('Not a valid WebP file')
    }
    let offset = 12
    while (offset < buffer.length) {
        const fourCC = buffer.toString('ascii', offset, offset + 4)
        const size = buffer.readUInt32LE(offset + 4)
        const dataStart = offset + 8
        if (fourCC === 'EXIF') {
            return buffer.subarray(dataStart, dataStart + size)
        }
        offset = dataStart + size + (size % 2)
    }
    return null
}

let handler = async (m) => {
    if (!m.quoted) return m.reply('Tag stikernya!')
    if (/sticker/.test(m.quoted.mtype)) {
        const buffer = await m.quoted.download()
        const exif = readWebpExifChunk(buffer)
        if (!exif) return m.reply('Sticker ini tidak memiliki EXIF data.')

        // A raw '{' byte (0x7b) can appear inside the binary TIFF header by
        // coincidence, so try every occurrence and keep the first one that
        // actually parses as JSON instead of trusting the first match.
        let parsed = null
        let searchFrom = 0
        while (true) {
            const jsonStart = exif.indexOf(0x7b, searchFrom)
            if (jsonStart === -1) break
            try {
                parsed = JSON.parse(exif.slice(jsonStart).toString('utf8'))
                break
            } catch (e) {
                searchFrom = jsonStart + 1
            }
        }

        if (!parsed) return m.reply('EXIF data ditemukan, tapi tidak berisi JSON yang valid.')
        m.reply(format(parsed))
    }
}
handler.tags = ['sticker']

handler.help = handler.command = ["getexif"]

export default handler