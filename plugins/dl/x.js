import { twitter, gifToMp4, isLink } from '../../lib/scraper/x.js';
import * as fs from 'fs';

let handler = async (m, { conn, text, usedPrefix, command }) => {
    const txt = isLink(text);
    if (!text && !txt) return await conn.reply(m.chat, `Please enter a Twitter video/image link.\n> Example: ${usedPrefix + command} https://x.com/somevideo`, m);
    const input = txt ? txt[0] : text;

    conn.twitter = conn.twitter || {};

    const twitterData = await twitter(input);
    let videoUrls = twitterData.videoUrls || [];

    if (twitterData.type === 'gif') {
        videoUrls.unshift({ type: 'GIF', quality: 'GIF format', link: [twitterData.gif] });
        if (twitterData.image) videoUrls.push({ type: 'JPG', quality: 'Image', link: [twitterData.image] });
    }

    if (videoUrls.length === 0)
        return await conn.reply(m.chat, `Sorry, no downloadable content was found at the provided link.`, m);

    const menu = videoUrls.map((item, i) => `*_${i + 1}. ${item.type} - ${item.quality}_*`).join('\n');
    await conn.reply(m.chat, `Please select the video / image / audio you want by typing the number: \n${menu}`, m);

    conn.twitter[m.sender] = {
        url: input,
        caption: twitterData.description,
        allLinks: videoUrls.map(v => v.link),
        isGif: twitterData.type === 'gif',
        timeout: setTimeout(() => delete conn.twitter[m.sender], 160000)
    };
};

handler.before = async (m, { conn }) => {
    conn.twitter = conn.twitter || {};
    if (!(m.sender in conn.twitter)) return;

    const { caption, allLinks, timeout, isGif } = conn.twitter[m.sender];
    const input = m.text.match(/\d+/g);
    if (!input) return;

    try {
        const index = parseInt(input) - 1;
        if (index < 0 || index >= allLinks.length)
            return await conn.reply(m.chat, `Please choose a valid number from the options provided.`, m, { ephemeralExpiration: 86400 });

        await conn.reply(m.chat, '[ ⏳ ] Please wait...', m, { ephemeralExpiration: 86400 });

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
        m.error = e;
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
