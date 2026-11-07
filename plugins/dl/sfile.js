const handler = async (m, { conn, text, usedPrefix, command }) => {
    const quoted = m.quoted || m;
    const isMediaReply = Boolean(
        m.quoted &&
        (m.quoted.mimetype ||
            m.quoted.msg?.mimetype ||
            m.quoted.fileName ||
            m.quoted.filename ||
            typeof m.quoted.download === 'function')
    );

    if (!text && !isMediaReply) {
        return m.reply(`*Sfile*\n\n▸ ${usedPrefix + command} <query> — search files\n▸ ${usedPrefix + command} <reply file> — upload a file\n▸ ${usedPrefix + command} <url> — download from sfile`);
    }

    const trimmed = (text || '').trim();

    if (isMediaReply) {
        try {
            const buffer = await quoted.download();
            if (!buffer || !Buffer.isBuffer(buffer)) {
                return m.reply('Failed to download the replied file.');
            }

            const fileName =
                quoted.fileName ||
                quoted.filename ||
                quoted.msg?.fileName ||
                quoted.msg?.filename ||
                `file_${Date.now()}`;
            const mimeType = quoted.mimetype || quoted.msg?.mimetype || global.scraper.sfile.getMimeTypeFromFilename(fileName);

            const result = await global.scraper.sfile.sfileUpload(buffer, fileName, mimeType);
            return m.reply(`*Uploaded to Sfile*\n\n▸ File: ${result.fileName}\n▸ Size: ${result.sizeLabel}\n▸ URL: ${result.shareUrl}`);
        } catch (e) {
            return m.reply(`${e.message}`);
        }
    }

    if (/^https?:\/\/(sfile\.(co|mobi))\/.+/i.test(trimmed)) {
        try {
            const info = await global.scraper.sfile.sfileDownload(trimmed);
            await conn.sendMessage(m.chat, {
                document: { url: info.downloadUrl },
                mimetype: info.mimetype,
                fileName: info.filename,
                caption: `*${info.title}*\nSize: ${info.size}`
            }, { quoted: m });
        } catch (e) {
            return m.reply(`${e.message}`);
        }
        return;
    }

    try {
        const results = await global.scraper.sfile.sfileSearch(trimmed);
        if (!results.length) {
            return m.reply(`No results found for *${trimmed}*.`);
        }

        const top = results.slice(0, 10);
        const list = top.map((r, i) =>
            `${i + 1}. *${r.title}*\n   Size: ${r.size}${r.uploadDate ? `\n   Date: ${r.uploadDate}` : ''}\n   ${r.url}`
        ).join('\n\n');

        return m.reply(`*Sfile Search — ${trimmed}*\n\n${list}`);
    } catch (e) {
        return m.reply(`${e.message}`);
    }
};

handler.help = ['sfile <query|url|reply>'];
handler.command = /^(sfile)$/i;
handler.tags = ['tools'];
handler.limit = 0;

handler.platform = { whatsapp: true, discord: true };

export default handler;