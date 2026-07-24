import axios from 'axios';

function extractDriveId(url) {
    let m = url.match(/\/d\/([\w-]+)/);
    if (m) return { id: m[1], type: 'drive' };
    m = url.match(/[?&]id=([\w-]+)/);
    if (m) return { id: m[1], type: 'drive' };
    m = url.match(/\/videos\/d\/([\w-]+)/);
    if (m) return { id: m[1], type: 'docs_video' };
    return null;
}

function isGdriveUrl(text) {
    try {
        const u = new URL(text.trim());
        return ['drive.google.com', 'docs.google.com'].includes(u.hostname);
    } catch { return false; }
}

async function gdrive(url) {
    const extracted = extractDriveId(url);
    if (!extracted) return { status: false, error: 'Invalid Google Drive URL.' };

    const { id, type } = extracted;

    if (type === 'docs_video') {
        return { status: false, error: 'Video yang diupload ke Google Docs/Slides tidak dapat didownload — Google memerlukan login untuk mengaksesnya. Coba minta pengirim upload ulang ke Google Drive biasa.' };
    }

    try {
        const downloadUrl = `https://drive.usercontent.google.com/download?id=${id}&export=download&confirm=t`;

        const res = await axios.get(downloadUrl, {
            headers: {
                'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
            },
            responseType: 'stream',
            maxRedirects: 5,
            timeout: 10000
        });
        res.data.destroy();

        if (res.status !== 200) throw new Error(`Server returned ${res.status}`);

        const disposition = res.headers['content-disposition'] || '';
        const nameMatch = disposition.match(/filename="?([^"]+)"?/);
        const fileName = nameMatch ? nameMatch[1] : `file_${id}`;
        const mimetype = res.headers['content-type'] || 'application/octet-stream';
        const sizeBytes = parseInt(res.headers['content-length'] || '0');

        return {
            status: true,
            fileName,
            fileSize: sizeBytes ? `${(sizeBytes / (1024 * 1024)).toFixed(2)} MB` : 'Unknown',
            mimetype,
            extension: fileName.split('.').pop().toLowerCase(),
            downloadUrl
        };
    } catch (err) {
        return { status: false, error: err.message };
    }
}

let handler = async (m, { conn, args, prefix, command }) => {
    if (!args[0]) return m.reply(`Mana URL-nya?\n${prefix + command} https://drive.google.com/...`);

    const url = args[0].trim();
    if (!isGdriveUrl(url)) return m.reply('> URL tidak valid, pastikan dari drive.google.com atau docs.google.com');

    await m.react('⬇️');

    const result = await gdrive(url);
    if (!result.status) return m.reply(`> *Gagal:* ${result.error}`);

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
            await conn.sendMessage(m.chat, { video: { url: downloadUrl }, caption: info, mimetype }, { quoted: m });
        } else if (isImage) {
            await conn.sendMessage(m.chat, { image: { url: downloadUrl }, caption: info }, { quoted: m });
        } else if (isAudio) {
            await conn.sendMessage(m.chat, { audio: { url: downloadUrl }, mimetype, ptt: false }, { quoted: m });
        } else {
            await conn.sendMessage(m.chat, {
                document: { url: downloadUrl },
                mimetype: mimetype || 'application/octet-stream',
                fileName,
                caption: info
            }, { quoted: m });
        }
        await m.react('✅');
    } catch (err) {
        await m.reply(`> *Gagal kirim file:* ${err.message}`);
    }
};

handler.help = ['gdrive', 'gd'].map(v => v + ' <url>');
handler.tags = ['downloader'];
handler.command = /^(gdrive|gd)$/i;
handler.limit = true;
handler.ai = { risk: "low", description: "download drive file" }

export default handler;