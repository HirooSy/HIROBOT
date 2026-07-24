import { twitter, gifToMp4, isLink } from '../../lib/scraper/x.js';
import * as fs from 'fs';

let handler = async (m, { conn, text, usedPrefix, command }) => {
    // Validasi input
    if (!text) return await conn.reply(m.chat, `Masukkan URL Twitter/X!\n> Contoh: ${usedPrefix + command} https://x.com/username/status/123456789`, m);
    
    const txt = isLink(text);
    if (!txt) return await conn.reply(m.chat, 'Link tidak valid!', m);
    
    const input = txt[0];
    conn.twitter = conn.twitter || {};

    try {
        await conn.reply(m.chat, '[ ⏳ ] Mencari konten...', m);
        const twitterData = await twitter(input);
        let videoUrls = twitterData.videoUrls || [];

        if (twitterData.type === 'gif') {
            videoUrls.unshift({ type: 'GIF', quality: 'GIF format', link: [twitterData.gif] });
            if (twitterData.image) videoUrls.push({ type: 'JPG', quality: 'Image', link: [twitterData.image] });
        }

        if (videoUrls.length === 0)
            return await conn.reply(m.chat, `Konten tidak ditemukan.`, m);

        const menu = videoUrls.map((item, i) => `*_${i + 1}. ${item.type} - ${item.quality}_*`).join('\n');
        await conn.reply(m.chat, `Pilih konten dengan mengetik nomor:\n${menu}`, m);

        conn.twitter[m.sender] = {
            url: input,
            caption: twitterData.description,
            allLinks: videoUrls.map(v => v.link),
            isGif: twitterData.type === 'gif',
            timeout: setTimeout(() => delete conn.twitter[m.sender], 160000)
        };
    } catch (e) {
        console.error(e);
        await conn.reply(m.chat, `⚠️ Error: ${e.message}`, m);
    }
};

handler.before = async (m, { conn }) => {
    conn.twitter = conn.twitter || {};
    if (!(m.sender in conn.twitter)) return;

    const { caption, allLinks, timeout, isGif } = conn.twitter[m.sender];
    const input = m.text.match(/\d+/g);
    if (!input) return;

    try {
        const index = parseInt(input[0]) - 1;
        if (index < 0 || index >= allLinks.length)
            return await conn.reply(m.chat, `Pilih nomor yang valid!`, m);

        await conn.reply(m.chat, '[ ⏳ ] Mengunduh...', m);

        const downloadLinks  = allLinks[index];
        const isSelectedGif  = index === 0 && isGif;

        for (const i of downloadLinks) {
            if (isSelectedGif) {
                const tmpPath = await gifToMp4(i);
                try {
                    await conn.sendMessage(m.chat, { video: fs.readFileSync(tmpPath), gifPlayback: true, caption: `- *Caption :* \n${caption}` }, { quoted: m });
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
            } else {
                const ext = i.includes('.mp3') ? 'mp3' : (i.includes('.jpg') || i.includes('.jpeg')) ? 'jpg' : 'mp4';
                if (ext === 'mp3') {
                    await conn.sendMessage(m.chat, { audio: { url: i }, mimetype: 'audio/mpeg', caption: `- *Caption :* \n${caption}` }, { quoted: m });
                } else if (ext === 'jpg') {
                    await conn.sendMessage(m.chat, { image: { url: i }, caption: `- *Caption :* \n${caption}` }, { quoted: m });
                } else {
                    await conn.sendMessage(m.chat, { video: { url: i }, caption: `- *Caption :* \n${caption}` }, { quoted: m });
                }
            }
        }
    } catch (e) {
        console.error(e);
        await conn.reply(m.chat, `⚠️ Error: ${e.message}`, m);
    } finally {
        clearTimeout(timeout);
        delete conn.twitter[m.sender];
    }
};

handler.help = ['twitter', 'x'].map(v => v + ' <url>');
handler.tags = ['downloader'];
handler.command = ['twitter', 'x'];
handler.limit = 1;
handler.ai = { risk: "low", description: "download twitter/x post" }

export default handler;