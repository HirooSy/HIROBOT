import axios from 'axios';
import { img2pdf } from '../../lib/utils/converter.js';

const API_BASE = "https://api.shngm.io/v1";
const COMMENT_BASE = "https://commento.shngm.io/api";

const client = axios.create({
    baseURL: API_BASE,
    headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://g.shinigami.asia",
        Referer: "https://g.shinigami.asia/",
        "User-Agent": "Mozilla/5.0"
    },
    timeout: 20000
});

function sendList(conn, m, caption, rows, buttonText = 'Select', location = null) {
    return conn.sendButton(m.chat, {
        text: caption,
        footer: '',
        optionText: buttonText,
        optionTitle: buttonText,
        ...(location ? { location } : {}),
        nativeFlow: [{ text: buttonText, sections: [{ rows }] }]
    }, m);
}

function extractTaxonomyNames(taxonomyObj, key) {
    if (!taxonomyObj || !taxonomyObj[key]) return [];
    const items = taxonomyObj[key];
    if (!Array.isArray(items)) return [];
    return items.map(v => v?.name).filter(Boolean);
}

function stripHtml(html) {
    if (!html) return '';
    return html
        .replace(/<details[\s\S]*?<\/details>/gi, '[spoiler]')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

async function searchManga(query, page = 1, pageSize = 24) {
    const res = await client.get("/manga/list", {
        params: {
            page,
            page_size: pageSize,
            genre_include_mode: "or",
            genre_exclude_mode: "or",
            sort: "latest",
            sort_order: "desc",
            q: query
        }
    });
    return res.data;
}

async function getProjectUpdateManga(page = 1, pageSize = 24) {
    const res = await client.get("/manga/list", {
        params: {
            type: "project",
            page,
            page_size: pageSize,
            is_update: true,
            sort: "latest",
            sort_order: "desc"
        }
    });
    return res.data;
}

async function getDetailsWithChapters(mangaId, chapterPageSize = 50, commentPageSize = 10) {
    const detailRes = await client.get(`/manga/detail/${mangaId}`);
    const manga = detailRes?.data?.data;
    if (!manga) throw new Error("Manga detail not found");

    const firstChapterRes = await client.get(`/chapter/${mangaId}/list`, {
        params: { page: 1, page_size: chapterPageSize, sort_by: "chapter_number", sort_order: "desc" }
    });

    const chapterMeta = firstChapterRes?.data?.meta || {};
    const chapterTotalPage = chapterMeta.total_page || 1;

    let chapters = Array.isArray(firstChapterRes?.data?.data) ? [...firstChapterRes.data.data] : [];

    for (let page = 2; page <= chapterTotalPage; page++) {
        const res = await client.get(`/chapter/${mangaId}/list`, {
            params: { page, page_size: chapterPageSize, sort_by: "chapter_number", sort_order: "desc" }
        });
        if (Array.isArray(res?.data?.data)) chapters.push(...res.data.data);
    }

    chapters.sort((a, b) => a.chapter_number - b.chapter_number);

    let allComments = [];
    let totalComments = 0;
    try {
        const firstCommentRes = await axios.get(`${COMMENT_BASE}/comment`, {
            params: { path: `series/${mangaId}`, page: 1, pageSize: commentPageSize, lang: "en", sortBy: "like_desc" }
        });

        const commentData = firstCommentRes?.data?.data || {};
        const commentTotalPage = commentData.totalPages || 1;
        totalComments = commentData.count || 0;

        const flattenComments = (items) => {
            let result = [];
            if (!Array.isArray(items)) return result;
            for (const item of items) {
                if (item && item.nick && item.orig !== undefined) result.push(item);
                if (Array.isArray(item?.children)) result.push(...item.children.filter(c => c && c.nick));
            }
            return result;
        };

        allComments = flattenComments(commentData.data);

        for (let page = 2; page <= Math.min(commentTotalPage, 3); page++) {
            const res = await axios.get(`${COMMENT_BASE}/comment`, {
                params: { path: `series/${mangaId}`, page, pageSize: commentPageSize, lang: "en", sortBy: "like_desc" }
            });
            allComments.push(...flattenComments(res?.data?.data?.data));
        }
    } catch (_) {
    }

    const topComments = [...allComments].sort((a, b) => (b.like || 0) - (a.like || 0)).slice(0, 5);
    const taxonomy = manga.taxonomy || {};

    return {
        manga_id: manga.manga_id,
        title: manga.title,
        alternative_title: manga.alternative_title,
        description: manga.description,
        status: manga.status,
        cover: manga.cover_image_url,
        views: manga.view_count,
        bookmark: manga.bookmark_count,
        rank: manga.rank,
        taxonomy: {
            author: extractTaxonomyNames(taxonomy, 'Author'),
            artist: extractTaxonomyNames(taxonomy, 'Artist'),
            genre: extractTaxonomyNames(taxonomy, 'Genre'),
            format: extractTaxonomyNames(taxonomy, 'Format')
        },
        chapter_info: {
            first: chapters[0] || null,
            latest: chapters[chapters.length - 1] || null
        },
        total_chapter: chapters.length,
        chapters,
        comment_info: { total: totalComments },
        comments: topComments
    };
}

async function getChapterImages(chapterId) {
    const res = await client.get(`/chapter/detail/${chapterId}`);
    const data = res?.data?.data;
    if (!data) throw new Error("Chapter detail not found");

    const baseUrl = data.base_url || data.base_url_low || "";
    const chapterPath = data.chapter?.path || "";
    const files = data.chapter?.data || [];

    let images = files.map(filename => `${baseUrl}${chapterPath}${filename}`);
    if (images.length === 0 && Array.isArray(data.chapter_image)) {
        images = data.chapter_image.map(img => img.image_url).filter(Boolean);
    }

    return {
        chapter_id: data.chapter_id,
        chapter_number: data.chapter_number,
        images,
        total_image: images.length
    };
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
    if (details.description) c += `${stripHtml(details.description).slice(0, 400)}...\n`;
    return c.trim();
}

async function downloadChapterImages(imageUrls) {
    const buffers = [];
    for (const url of imageUrls) {
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://g.shinigami.asia/' },
            timeout: 30000
        });
        buffers.push(Buffer.from(response.data));
    }
    return buffers;
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
    if (!text) return m.reply(
        `Usage:\n- ${usedPrefix + command} <title>\n- ${usedPrefix + command} hot`
    );

    const [sub, ...args] = text.trim().split(' ');

    if (sub === 'update' || sub === 'hot') {
        const page = parseInt(args[0]) || 1;
        await m.react('🔍');

        const updateData = await getProjectUpdateManga(page, 24);
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

        const details = await getDetailsWithChapters(mangaId);
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

        const details = await getDetailsWithChapters(mangaId);
        const foundChapter = details.chapters.find(ch => String(ch.chapter_number) === chapterNumber);
        if (!foundChapter) {
            await m.react('❌');
            return m.reply('Chapter not found.');
        }

        const chapterData = await getChapterImages(foundChapter.chapter_id);
        if (!chapterData.images.length) {
            await m.react('❌');
            return m.reply('No images found for this chapter.');
        }

        const buffers = await downloadChapterImages(chapterData.images);
        const pdfBuffer = await img2pdf(buffers);

        await m.react('✅');
        await conn.sendMessage(m.chat, {
            document: pdfBuffer,
            mimetype: 'application/pdf',
            fileName: `${details.title} - Chapter ${chapterNumber}.pdf`,
            caption: `*${details.title}*\nChapter ${chapterNumber} | ${chapterData.total_image} Pages` 
        }, { quoted: m });
        return;
    }

    await m.react('🔍');
    const keyword = text.trim();

    const searchResults = await searchManga(keyword);
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

handler.help = handler.command = ['shinigami'];
handler.tags = ['downloader'];
handler.ai = { risk: 'low', description: "search/download manga" };

export default handler;