import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';
import * as path from 'path';
import { default as ffmpeg } from 'fluent-ffmpeg';

// ─── Config ───────────────────────────────────────────────────────────────────

const TMP_DIR = path.join(process.cwd(), process.env.TMP || 'data/tmp');

const PH_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Referer': 'https://www.pornhub.com',
};

// ─── HLS → MP4 via ffmpeg ─────────────────────────────────────────────────────

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

    await new Promise((resolve, reject) => {
        ffmpeg(m3u8Url)
            .inputOptions([
                '-allowed_extensions', 'ALL',
                '-protocol_whitelist', 'file,http,https,tcp,tls,crypto',
                '-headers', `User-Agent: ${PH_HEADERS['User-Agent']}\r\nReferer: https://www.pornhub.com\r\n`,
            ])
            .outputOptions([
                '-c', 'copy',
                '-movflags', 'faststart',
                '-bsf:a', 'aac_adtstoasc',
            ])
            .toFormat('mp4')
            .output(tmpOutput)
            .on('start', cmd => console.log('[ph ffmpeg]', cmd))
            .on('end', () => { console.log('[ph ffmpeg] done:', tmpOutput); resolve(); })
            .on('error', (err, _stdout, stderr) => {
                console.error('[ph ffmpeg stderr]', stderr);
                reject(new Error(`ffmpeg: ${err.message}\n${stderr}`));
            })
            .run();
    });

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0)
        throw new Error('Remux failed — output empty.');

    return tmpOutput;
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

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

// ─── Plugin handler ───────────────────────────────────────────────────────────

let handler = async (m, { conn, text, usedPrefix, command }) => {
    const links = isLink(text);
    if (!text || !links) {
        return conn.reply(
            m.chat,
            `Please send a Pornhub video link.\n> Example: ${usedPrefix + command} https://www.pornhub.com/view_video.php?viewkey=XXXX`,
            m
        );
    }

    const input = links[0];
    conn.pornhub = conn.pornhub || {};

    let data;
    try {
        await m.react('⏳')
        data = await scrapePornhub(input);
    } catch (e) {
        return conn.reply(m.chat, `⚠️ Failed: ${e.message}`, m);
        m.error = e
    }

    const menu = data.videoUrls
        .map((item, i) => `*_${i + 1}. ${item.type} — ${item.quality}_*`)
        .join('\n');

    await conn.reply(
        m.chat,
        `*${data.title}*\nUploader: ${data.uploader}\n──────────────\n\nSelect a format:\n${menu}`,
        m
    );

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
        return conn.reply(m.chat, 'Please pick a valid number from the list.', m, { ephemeralExpiration: 86400 });
    }

    try {
        await m.react("⬇️")
        const links = session.allLinks[index];
        const type  = session.types[index];
        const cap   = `*${session.title}*`;

        for (const url of links) {
            if (type === 'JPG') {
                await conn.sendFile(m.chat, url, 'thumbnail.jpg', cap, m);

            } else if (type === 'HLS') {
                let tmpPath = null;
                try {
                    tmpPath = await hlsToMp4(url);
                    // path string directly — no readFileSync, no heap spike
                    await conn.sendFile(m.chat, tmpPath, 'video.mp4', cap, m);
                } catch (e) {
                    console.error('[ph HLS send error]', e);
                    await conn.reply(m.chat, `⚠️ Send failed: ${e.message}`, m);
                    m.error = e
                } finally {
                    // guarded — no ENOENT noise if OS already swept it
                    if (tmpPath) try { fs.unlinkSync(tmpPath); } catch {}
                }

            } else {
                await conn.sendFile(m.chat, url, 'video.mp4', cap, m);
            }
        }
    } catch (e) {
        console.error(e);
        await conn.reply(m.chat, `⚠️ Error: ${e.message}`, m);
        m.error = e
    } finally {
        clearTimeout(session.timeout);
        delete conn.pornhub[m.sender];
    }
};

handler.help = ['ph', 'pornhub'].map(v => v + ' <url>');
handler.tags  = ['adult'];
handler.command = ['ph', 'pornhub'];
handler.limit = 1;
handler.level = 3;

export default handler;

// ─── Util ─────────────────────────────────────────────────────────────────────

function isLink(text) {
    if (!text) return null;
    return text.match(/https?:\/\/\S+/gi);
}