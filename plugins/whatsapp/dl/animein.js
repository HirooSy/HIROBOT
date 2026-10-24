import * as fs from 'fs';
import * as path from 'path';
const {
    searchAnime,
    getDetail,
    getEpisodes,
    getStream,
    getFileSize,
    downloadEpisode,
    formatSize,
    getLatest,
    getPopular,
    getByGenre,
    getSchedule,
    findGenre
} = global.scraper.animein

const SCHEDULE_DAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'];
const DAY_ALIASES = {
    SENIN: 'MONDAY',
    SELASA: 'TUESDAY',
    RABU: 'WEDNESDAY',
    KAMIS: 'THURSDAY',
    JUMAT: 'FRIDAY',
    "JUM'AT": 'FRIDAY',
    SABTU: 'SATURDAY',
    MINGGU: 'SUNDAY'
};

const TMP_DIR = path.isAbsolute(process.env.TMP || '')
    ? process.env.TMP
    : path.join(process.cwd(), process.env.TMP || 'data/tmp');

async function sendList(conn, m, caption, sections, buttonText = 'Select', extra = []) {
    return conn.sendButton(m.chat, {
        document: { url: 'https://animeinweb.com/favicon.ico' },
        jpegThumbnail: await conn.resize( Buffer.from(await (await fetch("https://files.catbox.moe/3a97sc.jpg")).arrayBuffer()), 100, 100),
        mimetype: 'image/webp',
        fileName: 'ANIMEIN',
        caption,
        fileLength: '665666646645000',
        optionText: buttonText,
        optionTitle: buttonText,
        nativeFlow: [{ text: buttonText, sections }, ...extra]
    }, m);
}

function animeRows(list, command) {
    return list.map((a, i) => ({
        header: `${i + 1}. ${a.title}`,
        title: `${a.type || '-'} | ${a.status || '-'} | ${a.year || '-'}`,
        description: `Views: ${a.views ?? '-'} | Favorites: ${a.favorites ?? '-'} | ${a.genre || '-'}`,
        id: `.${command} info ${a.id}`
    }));
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
        `*ANIMEIN*\n\nUsage: .${command} <title / genre>\n\nExample:\n.${command} pokemon\n.${command} action\n\nOptions:\n.${command} --new\n.${command} --top\n.${command} --schedule [day]`
    );

    const [sub, ...args] = text.trim().split(' ');
    const flag = sub.toLowerCase();

    const sendGenre = async (genre, page) => {
        const list = await getByGenre(genre.id, page);
        if (!list.length) return m.reply(page ? 'No more results.' : `No anime found for genre ${genre.name}.`);
        return sendList(
            conn, m,
            `*Genre: ${genre.name}* - ${list.length} result(s)${page ? ` (page ${page + 1})` : ''}`,
            [{ title: '', rows: animeRows(list, command) }],
            'Select Anime',
            [{ text: '➡️ Next', id: `.${command} genre ${genre.id} ${page + 1}` }]
        );
    };

    if (flag === '--new' || flag === '--top' || flag === '--popular') {
        const isNew = flag === '--new';
        const page = Math.max(0, parseInt(args[0]) || 0);
        await m.react(isNew ? '🆕' : '🔥');

        const list = await (isNew ? getLatest(page) : getPopular(page));
        if (!list.length) return m.reply(page ? 'No more results.' : 'No results found.');

        return sendList(
            conn, m,
            `*${isNew ? 'New' : 'Popular'} Anime* - ${list.length} result(s)${page ? ` (page ${page + 1})` : ''}`,
            [{ title: '', rows: animeRows(list, command) }],
            'Select Anime',
            [{ text: '➡️ Next', id: `.${command} ${isNew ? '--new' : '--top'} ${page + 1}` }]
        );
    }

    if (flag === '--schedule') {
        const input = (args[0] || '').toUpperCase();
        const day = DAY_ALIASES[input] || input;
        if (day && !SCHEDULE_DAYS.includes(day)) {
            return m.reply(`Invalid day.\n\nUsage: .${command} --schedule [day]\nDays: ${SCHEDULE_DAYS.join(', ')}`);
        }
        await m.react('📅');

        const days = day ? [day] : SCHEDULE_DAYS;
        const lists = await Promise.all(days.map(d => getSchedule(d)));
        const sections = days
            .map((d, i) => ({ title: d, rows: animeRows(lists[i], command) }))
            .filter(s => s.rows.length);
        if (!sections.length) return m.reply('No schedule found.');

        const total = sections.reduce((n, s) => n + s.rows.length, 0);
        return sendList(
            conn, m,
            `*Anime Schedule*${day ? ` - ${day}` : ''} - ${total} result(s)`,
            sections,
            'Select Anime'
        );
    }

    if (sub === 'genre') {
        const hasPage = args.length > 1 && /^\d+$/.test(args[args.length - 1]);
        const page = hasPage ? parseInt(args[args.length - 1]) : 0;
        const ref = (hasPage ? args.slice(0, -1) : args).join(' ');
        if (!ref) return m.reply(`Usage: .${command} genre <name>`);
        await m.react('🔍');

        const genre = await findGenre(ref, { allowId: true });
        if (!genre) return m.reply('Genre not found.');
        return sendGenre(genre, page);
    }

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
                jpegThumbnail: await conn.resize( Buffer.from(await (await fetch("https://files.catbox.moe/3a97sc.jpg")).arrayBuffer()), 100, 100),
                mimetype: 'image/webp',
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
            jpegThumbnail: await conn.resize( Buffer.from(await (await fetch("https://files.catbox.moe/3a97sc.jpg")).arrayBuffer()), 100, 100),
            mimetype: 'image/webp',
            fileName: 'ANIMEIN',
            caption: pageCaption,
            fileLength: '665666646645000',
            optionText: 'Select',
            optionTitle: 'Select',
            nativeFlow
        }, m);
    }

    if (sub === 'dl') {
        const [episodeId, quality] = args;
        if (!episodeId) return;
        await m.react('⬇️');

        const stream = await getStream(episodeId);
        if (!stream?.server?.length) return m.reply('Server not found.');

        const direct = stream.server.filter(s => s.type === 'direct');
        if (!direct.length) return m.reply('No direct servers available.');

        const qualityOrder = ['1080p', '720p', '480p', '360p'];
        const rank = s => {
            const i = qualityOrder.indexOf(s.quality);
            return i === -1 ? qualityOrder.length : i;
        };
        const sorted = [...direct].sort((a, b) => rank(a) - rank(b));
        const requestedRank = quality ? qualityOrder.indexOf(quality) : -1;
        const candidates = requestedRank === -1
            ? sorted
            : [
                ...sorted.filter(s => rank(s) === requestedRank),
                ...sorted.filter(s => rank(s) > requestedRank)
            ];
        if (!candidates.length) candidates.push(...sorted);

        const ep = stream.episode;

        if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

        const tmpPath = path.join(TMP_DIR, `animein_${episodeId}_${Date.now()}.mp4`);

        let target = null;
        let totalSize = 0;
        let lastError = null;
        const failures = [];

        try {
            for (const candidate of candidates) {
                try {
                    const expectedSize = await getFileSize(candidate.link);
                    const availableSpace = getAvailableDiskSpace(TMP_DIR);
                    if (expectedSize && availableSpace !== null) {
                        const SAFETY_MARGIN = 100 * 1024 * 1024;
                        if (expectedSize + SAFETY_MARGIN > availableSpace) {
                            await m.react('❌');
                            return m.reply(
                                `Server storage is not enough.\n` +
                                `Required: ${formatSize(expectedSize)}\n` +
                                `Available: ${formatSize(availableSpace)}\n\n` +
                                `Contact the server admin to clean up storage or increase the quota.`
                            );
                        }
                    }
                    totalSize = await downloadEpisode(candidate.link, tmpPath, expectedSize);
                    target = candidate;
                    break;
                } catch (error) {
                    lastError = error;
                    failures.push(`${candidate.quality} ${candidate.name}: ${error.detail || error.message}`);
                    if (error.code === 'ENOSPC') break;
                }
            }

            if (!target) {
                console.error('Download failed:', lastError);
                return m.reply(
                    lastError?.code === 'ENOSPC'
                        ? `Download failed: server storage is full. Contact owner to clean up storage.`
                        : `Download failed:\n${failures.slice(0, 6).join('\n')}${failures.length > 6 ? `\n+${failures.length - 6} more` : ''}`
                );
            }

            await m.react('✅');

            await conn.sendMessage(m.chat, {
                document: { url: tmpPath },
                mimetype: 'video/mp4',
                fileName: `${ep.title} - ${target.quality}.mp4`,
                caption: `*${ep.title}* | ${target.quality} | ${target.name} | ${formatSize(totalSize)}`
            }, { quoted: m });

        } catch (error) {
            console.error('Download failed:', error);
            await m.reply(`Download failed: ${error.message || 'Unknown error'}`);
        } finally {
            if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        }
        return;
    }

    await m.react('🔍');
    const keyword = text.trim();

    const [results, genre] = await Promise.all([searchAnime(keyword), findGenre(keyword)]);

    if (!results.length && genre) return sendGenre(genre, 0);
    if (!results.length) return m.reply('No results found.');

    const animeSection = {
        title: genre ? 'Anime' : '',
        rows: animeRows(results.slice(0, 1000), command)
    };

    if (!genre) {
        return sendList(conn, m,
            `*${keyword}* - ${results.length} result(s)`,
            [animeSection], 'Select Anime'
        );
    }

    const genreSection = {
        title: 'Genre',
        rows: [{
            header: genre.name,
            title: 'Genre',
            description: `Show anime with the ${genre.name} genre`,
            id: `.${command} genre ${genre.id}`
        }]
    };

    return sendList(conn, m,
        `*${keyword}* - ${results.length} result(s)`,
        [animeSection, genreSection], 'Select'
    );
};

handler.help = handler.command = ['animein'];
handler.tags = ['downloader', 'internet'];
handler.limit = 0;
handler.ai = { risk: 'low', description: "search/download anime" };

export default handler;