import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
const { instagram } = global.scraper.ig

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = '/usr/bin/ffmpeg';

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
    await execFileAsync(FFMPEG_PATH, [
        '-y',
        '-i', videoUrl,
        '-i', audioUrl,
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-shortest',
        output
    ]);
    return output;
}

async function sendSingleVideo(conn, m, videoUrl, audios) {
    if (audios.length > 0) {
        const tmpOut = tmpFile('mp4');
        try {
            await mergeVideoAudio(videoUrl, audios[0].url, tmpOut);
            await sendOut(conn, m, { video: { url: tmpOut }, mimetype: 'video/mp4' });
        } finally {
            cleanFiles(tmpOut);
        }
    } else {
        await sendOut(conn, m, { video: { url: videoUrl }, mimetype: 'video/mp4' });
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
            let sentAny = false;
            try {
                for (const item of items) {
                    if (item.type === 'video') {
                        const v0 = item.videos?.[0];
                        if (!v0?.url) continue;
                        await sendOut(conn, m, { video: { url: v0.url }, mimetype: 'video/mp4' });
                        sentAny = true;
                    } else {
                        const imageUrl = item.images?.[0]?.url;
                        if (!imageUrl) continue;
                        await sendOut(conn, m, { image: { url: imageUrl } });
                        sentAny = true;
                    }
                }

                if (!sentAny) {
                    await m.reply('No valid items found.');
                    return false;
                }

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
                await sendOut(conn, m, { video: { url: v0.url }, mimetype: 'video/mp4' });
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
                await sendOut(conn, m, { image: { url: imageUrl } });
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

let handler = async (m, { conn, args, usedPrefix: prefix, command, platform }) => {
    const input = platform === 'discord' ? args.url : args[0];
    if (!input) {
        return m.reply(`Where's the URL?\n${prefix + command} https://instagram.com/....`);
    }

    const url = String(input).trim();
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
            await sendOut(conn, m, { image: { url: best.url } });
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
            if (platform === 'discord') {
                const images = items.filter(item => item.type !== 'video').map(item => item.images?.[0]?.url).filter(Boolean);
                const videos = items.filter(item => item.type === 'video').map(item => item.videos?.[0]?.url).filter(Boolean);
                if (images.length) await conn.discord(m.chat, { image: images });
                for (const video of videos) await conn.discord(m.chat, { video: { url: video } });
                await m.react('✅');
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

handler.help = [
    ...['ig', 'instagram', 'igdl'].map(v => v + ' <url>'),
    { command: 'ig', name: 'url', description: 'Instagram post, reel or video URL', type: 'string', required: true }
];
handler.tags = ['downloader'];
handler.command = ['ig', 'instagram', 'igdl'];
handler.description = 'Download a post or reel from Instagram';
handler.limit = true;
handler.ai = { risk: "low", description: "download post/reel from Instagram" }

handler.platform = { whatsapp: true, discord: true }

export default handler;
