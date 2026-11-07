
const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });


let handler = async (m, { conn, args, text, usedPrefix: prefix, command }) => {
    const link = args[0] || text;
    if (!link) return m.reply(`Please provide a URL.\n${prefix + command} https://drive.google.com/...`);

    const url = String(link).trim();
    if (!global.scraper.drive.isGdriveUrl(url)) return m.reply('> Invalid URL, make sure it is from drive.google.com or docs.google.com');

    await m.react('⬇️');

    const result = await global.scraper.drive.gdrive(url);
    if (!result.status) return m.reply(`> *Failed:* ${result.error}`);

    const { fileName, fileSize, mimetype, downloadUrl } = result;

    const info = [
        `📁 *${fileName}*`,
        `📦 Size: ${fileSize}`,
        `🗂️ Type: ${mimetype}`,
    ].join('\n');

    const isVideo = mimetype?.startsWith('video/');
    const isImage = mimetype?.startsWith('image/');
    const isAudio = mimetype?.startsWith('audio/');

    try {
        if (isVideo) {
            await sendOut(conn, m, { video: { url: downloadUrl }, caption: info, mimetype });
        } else if (isImage) {
            await sendOut(conn, m, { image: { url: downloadUrl }, caption: info });
        } else if (isAudio) {
            await sendOut(conn, m, { audio: { url: downloadUrl }, mimetype, ptt: false });
        } else {
            await sendOut(conn, m, {
                document: { url: downloadUrl },
                mimetype: mimetype || 'application/octet-stream',
                fileName,
                caption: info
            });
        }
        await m.react('✅');
    } catch (err) {
        await m.reply(`> *Failed to send file:* ${err.message}`);
    }
};

handler.help = [
    ...(['gdrive', 'gd'].map(v => v + ' <url>')),
    { command: 'gdrive', name: 'text', description: 'Google Drive file URL', type: 'string', required: true }
]
handler.tags = ['downloader'];
handler.command = ['gdrive', 'gd']
handler.description = 'Download a file from Google Drive'
handler.limit = true;
handler.ai = { risk: "low", description: "download drive file" }

handler.platform = { whatsapp: true, discord: true }

export default handler;
