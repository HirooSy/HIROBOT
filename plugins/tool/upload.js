import upload from '../../lib/scraper/upload.js';

let handler = async (m, { conn, command, usedPrefix }) => {
    let q = m.quoted ? m.quoted : m;
    if (!q) throw "- Reply or caption an image or video";
    let mime = (q.msg || q).mimetype || '';
    if (!mime) throw "- File type not supported";

    const buffer = await q.download();
    const filename = `file_${Date.now()}`;
    const url = await upload(buffer, filename);

    await conn.sendButton(m.chat, {
        text: '\u0000',
        nativeFlow: [
            {},
            { text: 'Copy', copy: url },
            { text: 'View', url: url, useWebview: true },
        ]
    }, { 
            key: { participant: "0@s.whatsapp.net" }, 
            message: { 
                newsletterAdminInviteMessage: { 
                    newsletterJid: '120363280758084443@newsletter', 
                    newsletterName: '.', 
                    caption: `Size: ${formatSize(buffer.length)}` 
                } 
            } 
        });
};

handler.dym = ["tourl", "upload"];
handler.help = ['upload', 'tourl'].map(v => v + ' (reply media)');
handler.tags = ['tools'];
handler.command = /^(tourl|upload)$/i;
handler.risk = 'low'

export default handler;

function formatSize(size) {
    if (size >= 1024 * 1024 * 1024) return (size / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
    if (size >= 1024 * 1024) return (size / (1024 * 1024)).toFixed(2) + ' MB';
    if (size >= 1024) return (size / 1024).toFixed(2) + ' KB';
    return size + ' B';
}