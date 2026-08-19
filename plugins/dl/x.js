const { twitter, gifToMp4, isLink } = global.scraper.x;
import * as fs from 'fs';

let handler = async (m, { conn, text, usedPrefix, command }) => {

    if (!text) return await conn.reply(m.chat, `Inout Twitter/X URL!\nExample: ${usedPrefix + command} https://x.com/username/status/123456789`, m);

    const txt = isLink(text);
    if (!txt) return await conn.reply(m.chat, 'Invalid URL!', m);

    const input = txt[0];
    conn.twitter = conn.twitter || {};

    try {
        const twitterData = await twitter(input);
        let videoUrls = twitterData.videoUrls || [];

        if (twitterData.type === 'gif') {
            videoUrls.unshift({ type: 'GIF', quality: 'GIF format', link: [twitterData.gif] });
            if (twitterData.image) videoUrls.push({ type: 'JPG', quality: 'Image', link: [twitterData.image] });
        }

        if (videoUrls.length === 0)
            return await conn.reply(m.chat, `Content not found.`, m);

        const mp4Entries = videoUrls.filter(v => v.type === 'MP4');
        const jpgEntries = videoUrls.filter(v => v.type === 'JPG');
        const isCarousel = jpgEntries.some(v => Array.isArray(v.link) && v.link.length > 1);

        // Carousel (multi-image post): send all media, no menu.
        if (isCarousel) {
            for (const item of videoUrls) {
                for (const i of item.link) {
                    if (item.type === 'MP3') {
                        await conn.sendMessage(m.chat, { audio: { url: i }, mimetype: 'audio/mpeg' }, { quoted: m });
                    } else if (item.type === 'JPG') {
                        await conn.sendMessage(m.chat, { image: { url: i }, caption: `- *Caption :* \n${twitterData.description}` }, { quoted: m });
                    } else {
                        await conn.sendMessage(m.chat, { video: { url: i }, caption: `- *Caption :* \n${twitterData.description}` }, { quoted: m });
                    }
                }
            }
            return;
        }

        // Single video (one or more quality options, but only one actual video): send best quality directly.
        if (mp4Entries.length >= 1 && twitterData.type !== 'gif') {
            const best = mp4Entries[0]; // scraper lists qualities in page order, highest first
            for (const i of best.link) {
                await conn.sendMessage(m.chat, { video: { url: i }, caption: `- *Caption :* \n${twitterData.description}` }, { quoted: m });
            }
            return;
        }

        // Single gif: send directly as gif-playback video.
        if (twitterData.type === 'gif') {
            const gifEntry = videoUrls.find(v => v.type === 'GIF');
            if (gifEntry) {
                for (const i of gifEntry.link) {
                    const tmpPath = await gifToMp4(i);
                    try {
                        await conn.sendMessage(m.chat, { video: fs.readFileSync(tmpPath), gifPlayback: true, caption: `- *Caption :* \n${twitterData.description}` }, { quoted: m });
                    } finally {
                        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    }
                }
                return;
            }
        }

        // Fallback: anything else (e.g. single non-multi image + separate mp3, etc.) — keep menu selection.
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
        await conn.reply(m.chat, `Error: ${e.message}`, m);
        m.error = e
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
            return await conn.reply(m.chat, `Please select valid number!`, m);

        const downloadLinks  = allLinks[index];
        const isSelectedGif  = index === 0 && isGif;

        for (const i of downloadLinks) {
            if (isSelectedGif) {
                const tmpPath = await gifToMp4(i);
                try {
                    await conn.sendMessage(m.chat, { video: fs.readFileSync(tmpPath), gifPlayback: true, caption: `` }, { quoted: m });
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
            } else {
                const ext = i.includes('.mp3') ? 'mp3' : (i.includes('.jpg') || i.includes('.jpeg')) ? 'jpg' : 'mp4';
                if (ext === 'mp3') {
                    await conn.sendMessage(m.chat, { audio: { url: i }, mimetype: 'audio/mpeg', caption: `` }, { quoted: m });
                } else if (ext === 'jpg') {
                    await conn.sendMessage(m.chat, { image: { url: i }, caption: `` }, { quoted: m });
                } else {
                    await conn.sendMessage(m.chat, { video: { url: i }, caption: `` }, { quoted: m });
                }
            }
        }
    } catch (e) {
        console.error(e);
        await conn.reply(m.chat, `Error: ${e.message}`, m);
        m.error = e
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
