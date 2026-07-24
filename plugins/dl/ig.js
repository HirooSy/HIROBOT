import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import { instagram } from "../../lib/scraper/ig.js"

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');

if (!global.igDownloadState) global.igDownloadState = {};

const STATE_TTL = 5 * 60 * 1000;

function setState(sender, data) {
    global.igDownloadState[sender] = { ...data, timestamp: Date.now() };
}

function getState(sender) {
    const s = global.igDownloadState[sender];
    if (!s) return null;
    if (Date.now() - s.timestamp > STATE_TTL) {
        delete global.igDownloadState[sender];
        return null;
    }
    return s;
}

function clearState(sender) {
    delete global.igDownloadState[sender];
}

function isIgUrl(text) {
    try {
        const u = new URL(text.trim());
        return ['instagram.com', 'www.instagram.com'].includes(u.hostname);
    } catch { return false; }
}

function tmpFile(ext) {
    return path.join('/data/tmp', `ig_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
}

function cleanFiles(...files) {
    for (const f of files) {
        try { if (f && fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    }
}

async function mergeVideoAudio(videoUrl, audioUrl, output) {
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoUrl)
            .input(audioUrl)
            .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
            .on('error', reject)
            .on('end', () => resolve(output))
            .save(output);
    });
}

async function sendSingleVideo(conn, m, videoUrl, audios) {
    if (audios.length > 0) {
        const tmpOut = tmpFile('mp4');
        try {
            await mergeVideoAudio(videoUrl, audios[0].url, tmpOut);
            await conn.sendMessage(m.chat, { video: { url: tmpOut }, mimetype: 'video/mp4' }, { quoted: m });
        } finally {
            cleanFiles(tmpOut);
        }
    } else {
        await conn.sendMessage(m.chat, { video: { url: videoUrl }, mimetype: 'video/mp4' }, { quoted: m });
    }
}

function buildCarouselMenu(items) {
    const total = items.length;
    const choice_text = [
        `━━━━━━━━━━━━━━━━━━━━`,
        `*Select the item you want to download:*`,
        ...items.map((item, i) => {
            const icon = item.type === 'video' ? '▶︎' : '▢';
            return `${i + 1}. Slide ${item.index} (${icon})`;
        }),
        `${total + 1}. Download All`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `> *Option valid for 5 minutes*, type the number directly or reply to this message`
    ].join('\n');
    return { choice_text };
}

async function processSelection(conn, m, state, choice) {
    const { type, result } = state;

    if (type === 'carousel') {
        const { items } = result.media;
        const maxChoice = items.length + 1;

        if (choice < 1 || choice > maxChoice) {
            await m.reply(`> *Invalid choice*, enter number 1—${maxChoice}.`);
            return false;
        }

        if (choice === maxChoice) {
            const albumItems = items.map(item => {
                if (item.type === 'video') {
                    const v0 = item.videos?.[0];
                    if (!v0?.url) return null;
                    return { video: { url: v0.url } };
                } else {
                    const imageUrl = item.images?.[0]?.url;
                    if (!imageUrl) return null;
                    return { image: { url: imageUrl } };
                }
            }).filter(Boolean);

            if (albumItems.length === 0) {
                await m.reply('No valid items found.');
                return false;
            }

            try {
                await conn.sendMessage(m.chat, { album: albumItems }, { quoted: m });
                await m.react('✅');
                return true;
            } catch (err) {
                console.error('[IG Album Error]', err);
                await m.reply(`Failed: ${err.message}`);
                return false;
            }
        }

        const item = items[choice - 1];
        if (item.type === 'video') {
            const v0 = item.videos?.[0];
            if (!v0?.url) {
                await m.reply('Video URL not found.');
                return false;
            }
            try {
                await conn.sendMessage(m.chat, { video: { url: v0.url }, mimetype: 'video/mp4' }, { quoted: m });
                await m.react('✅');
                return true;
            } catch (err) {
                console.error('[IG Video Error]', err);
                await m.reply(`Failed: ${err.message}`);
                return false;
            }
        } else {
            const imageUrl = item.images?.[0]?.url;
            if (!imageUrl) {
                await m.reply('Image URL not found.');
                return false;
            }
            try {
                await conn.sendMessage(m.chat, { image: { url: imageUrl } }, { quoted: m });
                await m.react('✅');
                return true;
            } catch (err) {
                console.error('[IG Image Error]', err);
                await m.reply(`Failed: ${err.message}`);
                return false;
            }
        }
    }

    return false;
}

let handler = async (m, { conn, args, prefix, command }) => {
    if (!args[0]) {
        return m.reply(`Where's the URL?\n${prefix + command} https://instagram.com/....`);
    }

    const url = args[0].trim();
    if (!isIgUrl(url)) return m.reply('> Invalid URL, make sure the URL is from Instagram.com');

    await m.react('⬇️');

    try {
        const igResult = await instagram(url);

        if (!igResult.status) {
            await m.reply(`Failed: ${igResult.error}`);
            return;
        }

        const { metadata, media } = igResult.result;

        if (metadata.type === 'single_image') {
            const best = media.images?.[0];
            if (!best?.url) {
                await m.reply('No image found.');
                return;
            }
            await conn.sendMessage(m.chat, { image: { url: best.url } }, { quoted: m });
            await m.react('✅');
            return;
        }

        if (metadata.type === 'video' || metadata.type === 'reels') {
            const best = media.videos?.[0];
            if (!best?.url) {
                await m.reply('No video found.');
                return;
            }
            await sendSingleVideo(conn, m, best.url, media.audios || []);
            await m.react('✅');
            return;
        }

        if (metadata.type === 'carousel') {
            const items = media.items;
            if (!items || items.length === 0) {
                await m.reply('No items in carousel.');
                return;
            }
            const menu = buildCarouselMenu(items);
            await conn.reply(m.chat, menu.choice_text, m);
            setState(m.sender, { type: 'carousel', result: igResult.result });
            return;
        }

        await m.reply('Content type not supported.');

    } catch (err) {
        console.error('[IG Handler Error]', err);
        await m.reply(`Error: ${err.message}`);
    }
};

handler.before = async (m, { conn }) => {
    const text = (m.text || '').trim();
    if (!/^\d+$/.test(text)) return;

    const state = getState(m.sender);
    if (!state) return;

    const choice = parseInt(text);

    try {
        const success = await processSelection(conn, m, state, choice);
        if (success) clearState(m.sender);
    } catch (err) {
        console.error('[IG Before Error]', err);
        await m.reply(`Error: ${err.message}`);
        clearState(m.sender);
    }

    return true;
};

handler.help = ['ig', 'instagram', 'igdl'].map(v => v + ' <url>');
handler.tags = ['downloader'];
handler.command = /^(ig|instagram|igdl)$/i;
handler.limit = true;

export default handler;
