import axios from '../../lib/package/axios.js';
import * as cheerio from '../../lib/package/cheerio.js';
import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = '/usr/bin/ffmpeg';

const TMP_DIR = path.join(process.cwd(), 'data/tmp');

const PH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.pornhub.com',
};

function ensureTmp() {
    try {
        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.accessSync(TMP_DIR, fs.constants.W_OK);
        return TMP_DIR;
    } catch {
        return '/tmp';
    }
}

async function hlsToMp4(m3u8Url) {
    const tmpDir = ensureTmp();

    try {
        fs.readdirSync(tmpDir)
            .filter(f => f.startsWith('ph_tmp_'))
            .forEach(f => { try { fs.unlinkSync(path.join(tmpDir, f)); } catch {} });
    } catch {}

    const ts = Date.now();
    const tmpOutput = path.join(tmpDir, `ph_tmp_${ts}.mp4`);

    try {
        const args = [
            '-y',
            '-allowed_extensions', 'ALL',
            '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
            '-headers', `User-Agent: ${PH_HEADERS['User-Agent']}\r\nReferer: https://www.pornhub.com\r\n`,
            '-i', m3u8Url,
            '-c', 'copy',
            '-movflags', 'faststart',
            '-bsf:a', 'aac_adtstoasc',
            '-f', 'mp4',
            tmpOutput
        ];
        console.log('[ph ffmpeg]', FFMPEG_PATH, args.join(' '));
        await execFileAsync(FFMPEG_PATH, args);
        console.log('[ph ffmpeg] done:', tmpOutput);
    } catch (err) {
        console.error('[ph ffmpeg stderr]', err.stderr);
        throw new Error(`ffmpeg: ${err.message}\n${err.stderr || ''}`);
    }

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0)
        throw new Error('Remux failed — output empty.');

    return tmpOutput;
}


function extractViewkey(url) {
    const qMatch = url.match(/[?&]viewkey=([a-zA-Z0-9]+)/);
    if (qMatch) return qMatch[1];
    const pathMatch = url.match(/\/video\/([a-zA-Z0-9]+)/);
    if (pathMatch) return pathMatch[1];
    return null;
}

async function scrapePornhub(url) {
    const viewkey = extractViewkey(url);
    if (!viewkey) throw new Error('Could not extract viewkey from URL.');

    const canonicalUrl = `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`;
    const response = await axios.get(canonicalUrl, { headers: PH_HEADERS, timeout: 20000 });
    const $ = cheerio.load(response.data);

    const title = $('title').text().replace(/\s*[-–]\s*Pornhub\.com\s*$/i, '').trim()
        || $('meta[property="og:title"]').attr('content')?.trim()
        || 'Unknown Title';

    const thumbnail = $('meta[property="og:image"]').attr('content') || null;

    const uploader = $('.usernameBadgesWrapper a').first().text().trim()
        || $('a.bolded').first().text().trim()
        || 'Unknown';

    let flashvars = null;
    $('script').each(function () {
        if (flashvars) return;
        const raw = $(this).html() || '';
        if (!raw.includes('mediaDefinitions')) return;
        const m = raw.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\})\s*;/);
        if (!m) return;
        try {
            flashvars = JSON.parse(m[1]);
        } catch {
            try {
                const start = raw.indexOf('{', raw.indexOf('flashvars_'));
                const end = raw.lastIndexOf('}', raw.indexOf(';\n', start)) + 1;
                flashvars = JSON.parse(raw.slice(start, end));
            } catch {}
        }
    });

    if (!flashvars) throw new Error('Could not locate flashvars. Video may be age-gated or geo-blocked.');

    const mediaDefinitions = flashvars.mediaDefinitions || [];
    const videoUrls = [];

    for (const def of mediaDefinitions) {
        if (!def.videoUrl) continue;
        if (def.format === 'mp4') {
            videoUrls.push({
                type: 'MP4',
                quality: def.quality ? `${def.quality}p` : 'Default',
                link: [def.videoUrl],
            });
        } else if (def.format === 'hls') {
            videoUrls.push({
                type: 'HLS',
                quality: def.quality ? `${def.quality}p` : 'Auto',
                link: [def.videoUrl],
            });
        }
    }

    videoUrls.sort((a, b) => {
        if (a.type === 'JPG') return 1;
        if (b.type === 'JPG') return -1;
        if (a.type === 'HLS' && b.type !== 'HLS') return 1;
        if (b.type === 'HLS' && a.type !== 'HLS') return -1;
        return (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0);
    });

    if (videoUrls.length === 0) throw new Error('No downloadable media found — video may be premium-only.');

    if (thumbnail) videoUrls.push({ type: 'JPG', quality: 'Thumbnail', link: [thumbnail] });

    return { title, uploader, thumbnail, videoUrls };
}


const sendFileOut = (conn, m, url, name, caption) => m.platform === 'discord'
    ? conn.discord(m.chat, { [/\.(jpe?g|png|webp)$/i.test(name) ? 'image' : 'video']: url, fileName: name, text: caption.replace(/\*([^*\n]+)\*/g, '**$1**') })
    : conn.sendFile(m.chat, url, name, caption, m);

async function deliver(conn, m, session, index) {
    const links = session.allLinks[index];
    const type = session.types[index];
    const cap = `*${session.title}*`;

    for (const url of links) {
        if (type === 'JPG') {
            await sendFileOut(conn, m, url, 'thumbnail.jpg', cap);
        } else if (type === 'HLS') {
            let tmpPath = null;
            try {
                tmpPath = await hlsToMp4(url);
                await sendFileOut(conn, m, tmpPath, 'video.mp4', cap);
            } catch (e) {
                console.error('[ph HLS send error]', e);
                await m.reply(`⚠️ Send failed: ${e.message}`);
                m.error = e
            } finally {
                if (tmpPath) try { fs.unlinkSync(tmpPath); } catch {}
            }
        } else {
            await sendFileOut(conn, m, url, 'video.mp4', cap);
        }
    }
}

let handler = async (m, { conn, text, usedPrefix, command, platform }) => {
    if (platform === 'discord') {
        const pick = String(text || '').trim().match(/^pick\s+(\w+)\s+(\d+)$/i);
        if (pick) {
            const session = global.phSessions?.[pick[1]];
            if (!session) return m.reply('This menu has expired, please run the command again.');
            await m.react('⬇️');
            try {
                await deliver(conn, m, session, Number(pick[2]));
            } catch (e) {
                await m.reply(`⚠️ Error: ${e.message}`);
            }
            return;
        }
    }

    const links = isLink(text);
    if (!text || !links) {
        return m.reply(`Please send a Pornhub video link.\n> Example: ${usedPrefix + command} https://www.pornhub.com/view_video.php?viewkey=XXXX`);
    }

    const input = links[0];
    conn.pornhub = conn.pornhub || {};

    let data;
    try {
        await m.react('⏳')
        data = await scrapePornhub(input);
    } catch (e) {
        m.error = e
        return m.reply(`⚠️ Failed: ${e.message}`);
    }

    if (platform === 'discord') {
        const token = Math.random().toString(36).slice(2, 10);
        global.phSessions = global.phSessions || {};
        global.phSessions[token] = { title: data.title, allLinks: data.videoUrls.map(v => v.link), types: data.videoUrls.map(v => v.type) };
        setTimeout(() => { delete global.phSessions[token]; }, 30 * 60 * 1000).unref?.();
        return conn.discord(m.chat, {
            text: `**${data.title}**\nUploader: ${data.uploader}\n\nSelect a format.`,
            select: {
                placeholder: 'Select a format',
                options: data.videoUrls.slice(0, 25).map((item, i) => ({ label: `${item.type} — ${item.quality}`.slice(0, 100), action: `ph pick ${token} ${i}` }))
            }
        });
    }

    const menu = data.videoUrls
        .map((item, i) => `*_${i + 1}. ${item.type} — ${item.quality}_*`)
        .join('\n');

    await m.reply(`*${data.title}*\nUploader: ${data.uploader}\n──────────────\n\nSelect a format:\n${menu}`);

    conn.pornhub[m.sender] = {
        title: data.title,
        allLinks: data.videoUrls.map(v => v.link),
        types: data.videoUrls.map(v => v.type),
        timeout: setTimeout(() => { delete conn.pornhub[m.sender]; }, 160000),
    };
};

handler.before = async (m, { conn }) => {
    conn.pornhub = conn.pornhub || {};
    if (!(m.sender in conn.pornhub)) return;

    const session = conn.pornhub[m.sender];
    const input = m.text?.match(/\d+/g);
    if (!input) return;

    const index = parseInt(input[0]) - 1;

    if (index < 0 || index >= session.allLinks.length) {
        return m.reply('Please pick a valid number from the list.');
    }

    try {
        await m.react("⬇️")
        await deliver(conn, m, session, index);
    } catch (e) {
        console.error(e);
        await m.reply(`⚠️ Error: ${e.message}`);
        m.error = e
    } finally {
        clearTimeout(session.timeout);
        delete conn.pornhub[m.sender];
    }
};

handler.help = [
    ...['ph', 'pornhub'].map(v => v + ' <url>'),
    { command: 'ph', name: 'text', description: 'Pornhub video URL', type: 'string', required: true }
];
handler.tags  = ['adult'];
handler.command = ['ph', 'pornhub'];
handler.description = 'Download a video from Pornhub';
handler.limit = 1;
handler.level = 1;
handler.ai = { risk: "low", description: "download p#rnhub post using url" }

handler.platform = { whatsapp: true, discord: true }

export default handler;


function isLink(text) {
    if (!text) return null;
    return text.match(/https?:\/\/\S+/gi);
}
