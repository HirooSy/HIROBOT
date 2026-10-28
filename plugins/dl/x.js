const { twitter, gifToMp4, fixVideoMetadata, isLink } = global.scraper.x;
import * as fs from 'fs';

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

let handler = async (m, { conn, text, usedPrefix, command, platform }) => {

    if (!text) return await m.reply(`Inout Twitter/X URL!\nExample: ${usedPrefix + command} https://x.com/username/status/123456789`);

    const txt = isLink(text);
    if (!txt) return await m.reply('Invalid URL!');

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
            return await m.reply(`Content not found.`);

        const mp4Entries = videoUrls.filter(v => v.type === 'MP4');
        const jpgEntries = videoUrls.filter(v => v.type === 'JPG');
        const isCarousel = jpgEntries.some(v => Array.isArray(v.link) && v.link.length > 1);

        if (isCarousel) {
            for (const item of videoUrls) {
                for (const i of item.link) {
                    if (item.type === 'MP3') {
                        await sendOut(conn, m, { audio: { url: i }, mimetype: 'audio/mpeg' });
                    } else if (item.type === 'JPG') {
                        await sendOut(conn, m, { image: { url: i }, caption: `- *Caption :* \n${twitterData.description}` });
                    } else {
                        await sendOut(conn, m, { video: { url: i }, caption: `- *Caption :* \n${twitterData.description}` });
                    }
                }
            }
            return;
        }

        if (mp4Entries.length >= 1 && twitterData.type !== 'gif') {
            const best = mp4Entries[0];
            for (const i of best.link) {
                const tmpPath = await fixVideoMetadata(i);
                try {
                    await sendOut(conn, m, { video: fs.readFileSync(tmpPath), caption: `- *Caption :* \n${twitterData.description}` });
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
            }
            return;
        }

        if (twitterData.type === 'gif') {
            const gifEntry = videoUrls.find(v => v.type === 'GIF');
            if (gifEntry) {
                for (const i of gifEntry.link) {
                    const tmpPath = await gifToMp4(i);
                    try {
                        await sendOut(conn, m, { video: fs.readFileSync(tmpPath), gifPlayback: true, caption: `- *Caption :* \n${twitterData.description}` });
                    } finally {
                        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    }
                }
                return;
            }
        }

        if (platform === 'discord') {
            const pick = videoUrls[0];
            const kind = pick.type === 'MP3' ? 'audio' : pick.type === 'JPG' ? 'image' : 'video';
            await conn.discord(m.chat, { [kind]: { url: pick.link[0] }, text: `- *Caption :* \n${twitterData.description}` });
            return;
        }

        const menu = videoUrls.map((item, i) => `*_${i + 1}. ${item.type} - ${item.quality}_*`).join('\n');
        await m.reply(`Choose content by typing its number:\n${menu}`);

        conn.twitter[m.sender] = {
            url: input,
            caption: twitterData.description,
            allLinks: videoUrls.map(v => v.link),
            allTypes: videoUrls.map(v => v.type),
            isGif: twitterData.type === 'gif',
            timeout: setTimeout(() => delete conn.twitter[m.sender], 160000)
        };
    } catch (e) {
        console.error(e);
        await m.reply(`Error: ${e.message}`);
        m.error = e
    }
};

handler.before = async (m, { conn }) => {
    conn.twitter = conn.twitter || {};
    if (!(m.sender in conn.twitter)) return;

    const { caption, allLinks, allTypes, timeout, isGif } = conn.twitter[m.sender];
    const input = m.text.match(/\d+/g);
    if (!input) return;

    try {
        const index = parseInt(input[0]) - 1;
        if (index < 0 || index >= allLinks.length)
            return await m.reply(`Please select valid number!`);

        const downloadLinks  = allLinks[index];
        const isSelectedGif  = index === 0 && isGif;

        for (const i of downloadLinks) {
            if (isSelectedGif) {
                const tmpPath = await gifToMp4(i);
                try {
                    await sendOut(conn, m, { video: fs.readFileSync(tmpPath), gifPlayback: true, caption: `` });
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
            } else {
                const byType = { MP3: 'mp3', JPG: 'jpg', MP4: 'mp4' }[allTypes?.[index]];
                const ext = byType || (i.includes('.mp3') ? 'mp3' : (i.includes('.jpg') || i.includes('.jpeg')) ? 'jpg' : 'mp4');
                if (ext === 'mp3') {
                    await sendOut(conn, m, { audio: { url: i }, mimetype: 'audio/mpeg', caption: `` });
                } else if (ext === 'jpg') {
                    await sendOut(conn, m, { image: { url: i }, caption: `` });
                } else {
                    const tmpPath = await fixVideoMetadata(i);
                    try {
                        await sendOut(conn, m, { video: fs.readFileSync(tmpPath), caption: `` });
                    } finally {
                        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                    }
                }
            }
        }
    } catch (e) {
        console.error(e);
        await m.reply(`Error: ${e.message}`);
        m.error = e
    } finally {
        clearTimeout(timeout);
        delete conn.twitter[m.sender];
    }
};

handler.help = [
    ...['twitter', 'x'].map(v => v + ' <url>'),
    { command: 'twitter', name: 'text', description: 'Twitter/X post URL', type: 'string', required: true }
];
handler.tags = ['downloader'];
handler.command = ['twitter', 'x'];
handler.description = 'Download media from a Twitter/X post';
handler.limit = 1;
handler.ai = { risk: "low", description: "download twitter/x post" }

handler.platform = { whatsapp: true, discord: true }

export default handler;