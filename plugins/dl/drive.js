import axios from 'axios';

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });


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
        return { status: false, error: 'Videos uploaded to Google Docs/Slides cannot be downloaded — Google requires a login to access them. Ask the sender to upload it again to regular Google Drive.' };
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

let handler = async (m, { conn, args, text, usedPrefix: prefix, command }) => {
    const link = args[0] || text;
    if (!link) return m.reply(`Please provide a URL.\n${prefix + command} https://drive.google.com/...`);

    const url = String(link).trim();
    if (!isGdriveUrl(url)) return m.reply('> Invalid URL, make sure it is from drive.google.com or docs.google.com');

    await m.react('⬇️');

    const result = await gdrive(url);
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
