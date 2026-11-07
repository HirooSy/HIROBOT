const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

let handler = async (m, { conn, args, text, usedPrefix, command }) => {
    const link = args[0] || text
    if (!link) throw `- *Example:* ${usedPrefix + command} <url>`
    const file = await global.scraper.mediafire.mediafire(link)
    await sendOut(conn, m, {
        document: { url: file.url },
        fileName: file.filename,
        mimetype: 'application/' + file.ext.toLowerCase(),
        caption: `- *File Name :* ${file.filename}\n- *Type :* ${file.filetype}\n- *Size :* ${file.size}\n- *Uploaded :* ${file.upload}`
    })
}

handler.help = [
    ...(['mediafire', 'mf'].map(v => v + ' <url>')),
    { command: 'mediafire', name: 'text', description: 'MediaFire file URL', type: 'string', required: true }
]
handler.tags = ['downloader']
handler.command = ['mediafire', 'mf']
handler.description = 'Download a file from MediaFire'

handler.platform = { whatsapp: true, discord: true }

export default handler
