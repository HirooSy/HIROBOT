import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { facebook } from "../../lib/scraper/facebook.js"

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

function tmpFile(ext) {
    return path.join('/data/tmp', `fb_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

function cleanFiles(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
}

function isFbUrl(text) {
    try {
        const u = new URL(text.trim());
        return /(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/i.test(u.hostname);
    } catch { return false; }
}

let handler = async (m, { conn, args, usedPrefix, command }) => {
    if (!args[0]) {
        return m.reply(`Where's the URL?\n${usedPrefix + command} https://facebook.com/....`);
    }

    const url = args[0].trim();
    if (!isFbUrl(url)) return m.reply('> Invalid URL, make sure the URL is from Facebook.com');

    await m.react('⬇️');

    try {
        const fbResult = await facebook(url);

        if (!fbResult.status) {
            await m.reply(`Failed: ${fbResult.error}`);
            return;
        }

        const { metadata, media } = fbResult.result;
        const videos = media.videos || [];

        if (videos.length === 0) {
            await m.reply('No video found.');
            return;
        }

        const best = videos.find(v => !v.needsRender) || videos[0];

        if (!best?.url) {
            await m.reply('Video URL not found.');
            return;
        }

        await conn.sendMessage(m.chat, { video: { url: best.url }, mimetype: 'video/mp4', caption: metadata.title || '' }, { quoted: m });
        await m.react('✅');

    } catch (err) {
        console.error('[FB Handler Error]', err);
        await m.reply(`Error: ${err.message}`);
    }
};

handler.help = ['fb', 'facebook', 'fbdl'].map(v => v + ' <url>');
handler.tags = ['downloader'];
handler.command = /^(fb|facebook|fbdl)$/i;
handler.limit = true;
handler.ai = { risk: "low", description: "download video from Facebook" }

export default handler;
