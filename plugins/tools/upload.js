const upload = global.scraper.upload.default;

let handler = async (m, { conn, command, usedPrefix, platform }) => {
    let q = m.quoted ? m.quoted : m;
    if (!q) throw "- Reply or caption an image or video";
    let mime = (q.msg || q).mimetype || '';
    if (!mime) throw "- File type not supported";

    const buffer = await q.download();
    const ext = (mime.split('/')[1] || 'bin').split(';')[0];
    const filename = `file_${Date.now()}.${ext}`;
    const url = await upload(buffer, filename);

    const isLocal = global.opts?.server && url.startsWith(global.opts.server);
    const status = isLocal ? 'Expired In 7 Days' : '7 days with no views';

    if (platform === 'discord') {
        return conn.discord(m.chat, {
            text: `${url}\n${formatSize(buffer.length)} • ${status}`,
            button: [{ label: 'View', url }]
        });
    }

    await conn.sendButton(m.chat, {
        text: `${formatSize(buffer.length)} • ${status}`,
        nativeFlow: [
            {},
            { text: 'Copy', copy: url },
            { text: 'View', url: url, useWebview: true },
        ]
    }, m);
};

handler.help = [
    ...(['upload', 'tourl'].map(v => v + ' (reply media)')),
    { command: 'upload', name: 'file', description: 'File to upload (or reply to one)', type: 'attachment' }
]
handler.tags = ['tools'];
handler.command = ['tourl', 'upload']
handler.description = 'Upload media and get a link'
handler.ai = { risk: "banned", description: "upload a media into url" }

handler.platform = { whatsapp: true, discord: true }

export default handler;

function formatSize(size) {
    if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
    if (size >= 1024) return (size / 1024).toFixed(2) + ' KB';
    return size + ' B';
}