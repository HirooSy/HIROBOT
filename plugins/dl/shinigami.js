import { waToDiscord } from '../../lib/package/discord/text.js';
import { img2pdf } from '../../lib/utils/converter.js';

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });

function sendList(conn, m, caption, rows, buttonText = 'Select', location = null) {
    if (m.platform === 'discord') {
        return conn.discord(m.chat, { text: waToDiscord(caption), ...flowToDiscord([{ text: buttonText, sections: [{ rows }] }]) });
    }
    return conn.sendButton(m.chat, {
        text: caption,
        footer: '',
        optionText: buttonText,
        optionTitle: buttonText,
        ...(location ? { location } : {}),
        nativeFlow: [{ text: buttonText, sections: [{ rows }] }]
    }, m);
}

function buildDetailCaption(details) {
    let c = `━━━━━━━━━━━━━━\n`;
    if (details.alternative_title) c += `- *Alt:* ${details.alternative_title}\n`;
    c += `- *Status:* ${details.status}\n`;
    c += `- *Views:* ${details.views?.toLocaleString() || 0} | *Bookmarks:* ${details.bookmark?.toLocaleString() || 0}\n`;
    if (details.rank) c += `- *Rank:* ${details.rank}\n`;
    if (details.taxonomy.author.length) c += `- *Author:* ${details.taxonomy.author.join(', ')}\n`;
    if (details.taxonomy.artist.length) c += `- *Artist:* ${details.taxonomy.artist.join(', ')}\n`;
    if (details.taxonomy.genre.length) c += `- *Genre:* ${details.taxonomy.genre.join(', ')}\n`;
    c += `- *Chapters:* ${details.total_chapter}\n`;
    c += `━━━━━━━━━━━━━━\n`;
    if (details.description) c += `${global.scraper.shinigami.stripHtml(details.description).slice(0, 400)}...\n`;
    return c.trim();
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) return m.reply(
        `Usage:\n- ${usedPrefix + command} <title>\n- ${usedPrefix + command} hot`
    );

    const [sub, ...args] = text.trim().split(' ');

    if (sub === 'update' || sub === 'hot') {
        const page = parseInt(args[0]) || 1;
        await m.react('🔍');

        const updateData = await global.scraper.shinigami.getProjectUpdateManga(page, 24);
        if (!updateData.data?.length) return m.reply('No update data found.');

        const rows = updateData.data.map((manga, i) => ({
            header: `${i + 1}. ${manga.title}`,
            title: `Status: ${manga.status} | Ch. ${manga.latest_chapter_number || '?'}`,
            description: `Views: ${manga.view_count?.toLocaleString() || 0} | Bookmarks: ${manga.bookmark_count?.toLocaleString() || 0}`,
            id: `.${command} info ${manga.manga_id}`
        }));

        await m.react('✅');
        return sendList(conn, m,
            `*LATEST UPDATES* (Page ${page}/${Math.ceil(updateData.total / 24)})`,
            rows, 'Select Manga'
        );
    }

    if (sub === 'info') {
        const mangaId = args[0];
        if (!mangaId) return;
        await m.react('🔍');

        const details = await global.scraper.shinigami.getDetailsWithChapters(mangaId);
        if (!details.chapters?.length) {
            await m.react('❌');
            return m.reply('No chapters available for this manga.');
        }

        const orderedChapters = details.chapters.slice().reverse();
        const rows = orderedChapters.map(ch => ({
            header: `Chapter ${ch.chapter_number}${ch.title ? ' - ' + ch.title : ''}`,
            title: `Views: ${ch.views?.toLocaleString() || 0}`,
            description: '',
            id: `.${command} dl ${mangaId} ${ch.chapter_number}`
        }));

        await m.react('✅');
        const locationCard = {
            name: details.title,
            address: ``,
            image: details.cover
        };
        try {
            return await sendList(conn, m, buildDetailCaption(details), rows, 'Select Chapter', locationCard);
        } catch (error) {
            delete locationCard.image;
            return sendList(conn, m, buildDetailCaption(details), rows, 'Select Chapter', locationCard);
        }
    }

    if (sub === 'dl') {
        const [mangaId, chapterNumber] = args;
        if (!mangaId || !chapterNumber) return;
        await m.react('⬇️');

        const details = await global.scraper.shinigami.getDetailsWithChapters(mangaId);
        const foundChapter = details.chapters.find(ch => String(ch.chapter_number) === chapterNumber);
        if (!foundChapter) {
            await m.react('❌');
            return m.reply('Chapter not found.');
        }

        const chapterData = await global.scraper.shinigami.getChapterImages(foundChapter.chapter_id);
        if (!chapterData.images.length) {
            await m.react('❌');
            return m.reply('No images found for this chapter.');
        }

        const buffers = await global.scraper.shinigami.downloadChapterImages(chapterData.images);
        const pdfBuffer = await img2pdf(buffers);

        await m.react('✅');
        await sendOut(conn, m, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: `${details.title} - Chapter ${chapterNumber}.pdf`,
            caption: `*${details.title}*\nChapter ${chapterNumber} | ${chapterData.total_image} Pages` 
        });
        return;
    }

    await m.react('🔍');
    const keyword = text.trim();

    const searchResults = await global.scraper.shinigami.searchManga(keyword);
    if (!searchResults.data?.length) {
        await m.react('❌');
        return m.reply('No results found.');
    }

    const rows = searchResults.data.map((manga, i) => ({
        header: `${i + 1}. ${manga.title}`,
        title: `Status: ${manga.status}`,
        description: `Views: ${manga.view_count?.toLocaleString() || 0}`,
        id: `.${command} info ${manga.manga_id}`
    }));

    await m.react('✅');
    return sendList(conn, m,
        `*${keyword}* - ${searchResults.data.length} result(s)`,
        rows, 'Select Manga'
    );
};

handler.command = ['shinigami'];
handler.description = 'Search manga and download chapters as PDF';
handler.help = ['shinigami <title>', { command: 'shinigami', name: 'text', description: 'Manga title', type: 'string', required: true }];
handler.tags = ['downloader'];
handler.ai = { risk: 'low', description: "search/download manga" };

handler.platform = { whatsapp: true, discord: true }

export default handler;
