import * as fs from 'fs';
import * as path from 'path';
import {
    searchAnime,
    getDetail,
    getEpisodes,
    getStream,
    getFileSize,
    downloadEpisode,
    formatSize
} from '../../lib/scraper/animein.js'

const TMP_DIR = path.isAbsolute(process.env.TMP || '')
    ? process.env.TMP
    : path.join(process.cwd(), process.env.TMP || 'data/tmp');

function sendList(conn, m, caption, rows, buttonText = 'Select') {
    return conn.sendButton(m.chat, {
        document: { url: 'https://animeinweb.com/favicon.ico' },
        mimetype: 'image/png',
        fileName: 'ANIMEIN',
        caption,
        fileLength: '665666646645000',
        optionText: buttonText,
        optionTitle: buttonText,
        nativeFlow: [{ text: buttonText, sections: [{ rows }] }]
    }, m);
}

function getAvailableDiskSpace(dir) {
    try {
        const stats = fs.statfsSync(dir);
        return stats.bavail * stats.bsize;
    } catch (e) {
        return null;
    }
}

let handler = async (m, { conn, text, command }) => {
    if (!text) return m.reply(
        `*ANIMEIN*\n\nUsage: .${command} <title>\n\nExample:\n.${command} pokemon`
    );

    const [sub, ...args] = text.trim().split(' ');

    if (sub === 'info') {
        const animeId = args[0];
        const epPage = parseInt(args[1]) || 0;
        const EP_LIMIT = 200;
        if (!animeId) return;
        await m.react('🔍');

        const [detail, allEpisodes] = await Promise.all([
            getDetail(animeId),
            getEpisodes(animeId)
        ]);

        if (!detail?.movie) return m.reply('Anime not found.');

        const mv = detail.movie;
        const caption = `*${mv.title}*\n━━━━━━━━━━━━━━\n- Type: ${mv.type}\n- Year: ${mv.year}\n- Status: ${mv.status}\n- Studio: ${mv.studio || '-'}\n- Aired: ${mv.aired_start} ~ ${mv.aired_end || '?'}\n- Genre: ${mv.genre}\n- Views: ${mv.views} | Favorites: ${mv.favorites}\n━━━━━━━━━━━━━━\n${mv.synopsis?.slice(0, 400)}...\n\n${allEpisodes.length} episode(s) available`;

        if (!allEpisodes.length) return m.reply(caption);

        const start = epPage * EP_LIMIT;
        const episodes = allEpisodes.slice(start, start + EP_LIMIT);
        const hasNext = allEpisodes.length > start + EP_LIMIT;

        if (!episodes.length) return m.reply('No more episodes.');

        const qualityOrder = ['1080p', '720p', '480p', '360p'];
        const firstStream = await getStream(episodes[0].id);
        if (!firstStream) return m.reply('Failed to get stream data.');

        const directServers = firstStream?.server?.filter(s => s.type === 'direct') || [];
        const availableQualities = qualityOrder.filter(q => directServers.some(s => s.quality === q));

        const sizeByQuality = {};
        for (const s of directServers) {
            if (!sizeByQuality[s.quality]) {
                sizeByQuality[s.quality] = await getFileSize(s.link);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        const pageCaption = caption + (hasNext ? `\n\nPage ${epPage + 1} (showing ${start + 1}-${start + episodes.length})` : '');

        if (!availableQualities.length) {
            const rows = episodes.map(ep => ({
                header: ep.title,
                title: ep.key_time,
                description: `Views: ${ep.views}`,
                id: `.${command} dl ${ep.id}`
            }));

            const nativeFlow = [{ text: 'Select Episode', sections: [{ rows }] }];
            if (hasNext) {
                nativeFlow.push({ text: '➡️ Next', id: `.${command} info ${animeId} ${epPage + 1}` });
            }

            return conn.sendButton(m.chat, {
                document: { url: 'https://animeinweb.com/favicon.ico' },
                mimetype: 'image/png',
                fileName: 'ANIMEIN',
                caption: pageCaption,
                fileLength: '665666646645000',
                optionText: 'Select',
                optionTitle: 'Select',
                nativeFlow
            }, m);
        }

        const nativeFlow = availableQualities.map(q => ({
            text: q,
            sections: [{
                rows: episodes.map(ep => ({
                    header: ep.title,
                    title: ep.key_time,
                    description: `Views: ${ep.views} • Size: ${formatSize(sizeByQuality[q])}`,
                    id: `.${command} dl ${ep.id} ${q}`
                }))
            }]
        }));

        if (hasNext) {
            nativeFlow.push({ text: '➡️ Next', id: `.${command} info ${animeId} ${epPage + 1}` });
        }

        return conn.sendButton(m.chat, {
            document: { url: 'https://animeinweb.com/favicon.ico' },
            mimetype: 'image/png',
            fileName: 'ANIMEIN',
            caption: pageCaption,
            fileLength: '665666646645000',
            optionText: 'Select',
            optionTitle: 'Select',
            nativeFlow
        }, m);
    }

    // ── DOWNLOAD ──
    if (sub === 'dl') {
        const [episodeId, quality] = args;
        if (!episodeId) return;
        await m.react('⬇️');

        const stream = await getStream(episodeId);
        if (!stream?.server?.length) return m.reply('Server not found.');

        const direct = stream.server.filter(s => s.type === 'direct');
        if (!direct.length) return m.reply('No direct servers available.');

        const qualityOrder = ['1080p', '720p', '480p', '360p'];
        const target = quality
            ? direct.find(s => s.quality === quality) || direct.sort((a, b) => qualityOrder.indexOf(a.quality) - qualityOrder.indexOf(b.quality))[0]
            : direct.sort((a, b) => qualityOrder.indexOf(a.quality) - qualityOrder.indexOf(b.quality))[0];

        const ep = stream.episode;

        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

        const expectedSize = await getFileSize(target.link);
        const availableSpace = getAvailableDiskSpace(TMP_DIR);
        if (expectedSize && availableSpace !== null) {
            const SAFETY_MARGIN = 100 * 1024 * 1024;
            if (expectedSize + SAFETY_MARGIN > availableSpace) {
                await m.react('❌');
                return m.reply(
                    `Ruang penyimpanan server tidak cukup.\n` +
                    `Dibutuhkan: ${formatSize(expectedSize)}\n` +
                    `Tersedia: ${formatSize(availableSpace)}\n\n` +
                    `Hubungi admin server untuk membersihkan storage atau menambah kuota.`
                );
            }
        }

        const tmpPath = path.join(TMP_DIR, `animein_${episodeId}_${Date.now()}.mp4`);

        try {
            const totalSize = await downloadEpisode(target.link, tmpPath);
            await m.react('✅');

            await conn.sendMessage(m.chat, {
                document: { url: tmpPath },
                mimetype: 'video/mp4',
                fileName: `${ep.title} - ${target.quality}.mp4`,
                caption: `*${ep.title}* | ${target.quality} | ${target.name} | ${formatSize(totalSize)}`
            }, { quoted: m });

        } catch (error) {
            console.error('Download failed:', error);
            const isDiskFull = error.code === 'ENOSPC';
            await m.reply(
                isDiskFull
                    ? `Download failed: server storage is full. Contact owner to clean up storage.`
                    : `Download failed: ${error.message || 'Unknown error'}`
            );
        } finally {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
        return;
    }

    await m.react('🔍');
    const keyword = text.trim();

    const results = await searchAnime(keyword);
    if (!results.length) return m.reply('No results found.');

    const rows = results.slice(0, 1000).map((a, i) => ({
        header: `${i + 1}. ${a.title}`,
        title: `${a.type} | ${a.status} | ${a.year}`,
        description: `Views: ${a.views} | Favorites: ${a.favorites} | ${a.genre}`,
        id: `.${command} info ${a.id}`
    }));

    return sendList(conn, m,
        `*${keyword}* - ${results.length} result(s)`,
        rows, 'Select Anime'
    );
};

handler.help = handler.command = ['animein'];
handler.tags = ['downloader', 'internet'];
handler.limit = 1;
handler.ai = { risk: 'low', description: "search/download anime" };

export default handler;