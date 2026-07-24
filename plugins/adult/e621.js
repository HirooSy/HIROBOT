
import e621 from "../../lib/scraper/e621.js"
import { default as axios } from 'axios';
import { default as ffmpeg } from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';

function getTmpDir() {
    const TMP_DIR = path.join(process.cwd(), 'data', 'tmp');
    try {
        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
        fs.accessSync(TMP_DIR, fs.constants.W_OK);
        return TMP_DIR;
    } catch (e) {
        console.error('[E621] Gagal buat folder tmp:', e);
        return './tmp';
    }
}

function cleanupTmp(tmpDir) {
    try {
        const oldFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('tmp_'));
        for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        }
    } catch {}
}

async function convertToMp4(fileUrl, inputExt) {
    const tmpDir = getTmpDir();
    cleanupTmp(tmpDir);

    const ts = Date.now();
    const tmpInput = path.join(tmpDir, `tmp_in_${ts}.${inputExt}`);
    const tmpOutput = path.join(tmpDir, `tmp_out_${ts}.mp4`);

    const headers = e621.getHeaders();
    const res = await axios.get(fileUrl, {
        responseType: 'stream',
        headers: headers,
        timeout: 60000
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpInput);
        res.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    if (!fs.existsSync(tmpInput) || fs.statSync(tmpInput).size === 0) {
        throw new Error('Download failed, input file is empty');
    }

    await new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
            .outputOptions([
                '-movflags faststart',
                '-pix_fmt yuv420p',
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-c:v libx264',
                '-c:a aac',
            ])
            .toFormat('mp4')
            .output(tmpOutput)
            .on('end', () => resolve())
            .on('error', (err, stdout, stderr) => reject(new Error(`ffmpeg error: ${err.message}`)))
            .run();
    });

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
        throw new Error('Conversion failed, output file is empty or not found');
    }

    return tmpOutput;
}

let handler = async (m, { conn, text }) => {
    if (!text) return m.reply(`How to use:\n.e621 <keywords>\n.e621 <url>`);
    
    const ratingMap = { s: 'Safe', q: 'Questionable', e: 'Explicit' };
    
    try {
        if (/^(https?:\/\/[^\s]+)$/i.test(text)) {
            const post = await e621.getPost(text);
            if (!post || !post.url) return m.reply('Post not found or invalid URL.');

            if (post.size > 300 * 1024 * 1024) {
                return m.reply(`File is too large (${(post.size / 1024 / 1024).toFixed(1)} MB), maximum 300MB.\n${post.url}`);
            }

            const caption =
`*#${post.id}*
${post.favCount} Favorites • ${ratingMap[post.rating] || post.rating}${(post.tags.character || []).length >= 1 ? `\n- *Character:* ${(post.tags.character || []).map(v => `${v}`).join(', ')}` : ''}
- *Species:* ${(post.tags.species || []).map(v => `${v}`).join(', ')}
- *Artist:* ${(post.tags.artist || []).map(v => `${v}`).join(', ')}
- *Tags:* ${global.readmore || ' '}
> ${(post.tags.general || []).map(v => `${v}`).join(', ')}`;

            if (post.ext === 'gif') {
                const tmpPath = await convertToMp4(post.url, 'gif');
                try {
                    if (fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
                        await conn.sendMessage(m.chat, {
                            video: fs.readFileSync(tmpPath),
                            gifPlayback: true,
                            caption
                        }, { quoted: m });
                    } else {
                        throw new Error('Processed file is invalid.');
                    }
                } finally {
                    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
                }
                return;
            }

            if (post.ext === 'webm') {
                return conn.sendMessage(m.chat, {
                    document: { url: post.url },
                    mimetype: 'video/webm',
                    fileName: `e621_${post.id}.webm`,
                    caption
                }, { quoted: m });
            }

            if (post.ext === 'mp4') {
                return conn.sendMessage(m.chat, { video: { url: post.url }, caption }, { quoted: m });
            }

            return conn.sendMessage(m.chat, { image: { url: post.url }, caption }, { quoted: m });
        }

        let keywords = text;
        let page = 1;

        const pageMatch = text.match(/^(.+?)\s*\|\s*page\s*(\d+)$/i);
        if (pageMatch) {
            keywords = pageMatch[1].trim();
            page = Math.max(1, parseInt(pageMatch[2]));
        }

        const results = await e621.tagsSearch(keywords, page);
        if (!results || results.length === 0) return m.reply(`No results found${page > 1 ? ` on page ${page}` : ''}.`);

        const buttonJson = results.map((p, i) =>
            ({
                header: `${(page - 1) * 50 + i + 1}. ${(p.url).replace("https://e621.net/posts/", "#")}`,
                title: `• ${p.favCount} Favorites — ${ratingMap[p.rating] || p.rating} — ${(p.type).charAt(0).toUpperCase() + p.type.slice(1)}`,
                description: `• By: ${(p.artist || []).map(v => `${v}`).join(', ')}`,
                id: `.e621 ${p.url}`
            })
        );

        return conn.sendButton(m.chat, {
            document: { url: 'https://e621.net/favicon-96x96.png' },
            jpegThumbnail: await conn.resize(
                await (await (await import('node-fetch')).default("https://e621.net/favicon-96x96.png")).buffer(),
                100, 100
            ),
            mimetype: 'image/webp',
            caption: `Page ${page}`,
            fileName: "E621",
            fileLength: '665666646645000',
            optionText: 'Select',
            optionTitle: 'Select',
            nativeFlow: [
                { text: 'Select', sections: [{ rows: buttonJson }] },
                ...(page > 1 ? [{ text: '◀️ Previous', id: `.e621 ${keywords} | page ${page - 1}` }] : []),
                { text: 'Next ▶️', id: `.e621 ${keywords} | page ${page + 1}` },
            ],
        }, m);
        
    } catch (e) {
        m.error = e;
        console.error('[E621] Handler error:', e);
        await m.reply(`⚠️ Error: ${e.message}`);
    }
};

handler.help = ['e621'];
handler.tags = ['adult'];
handler.command = ["e621"];
handler.limit = 1;
handler.ai = { risk: "low", description: "search e621 posts using keywords, download post using post id" }

export default handler;
