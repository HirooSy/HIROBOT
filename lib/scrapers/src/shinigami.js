import axios from 'hiro/axios';

const apiBase = "https://api.shngm.io/v1";
const commentBase = "https://commento.shngm.io/api";

const client = axios.create({
    baseURL: apiBase,
    headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Origin: "https://g.shinigami.asia",
        Referer: "https://g.shinigami.asia/",
        "User-Agent": "Mozilla/5.0"
    },
    timeout: 20000
});

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
        const firstCommentRes = await axios.get(`${commentBase}/comment`, {
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
            const res = await axios.get(`${commentBase}/comment`, {
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

export { stripHtml, searchManga, getProjectUpdateManga, getDetailsWithChapters, getChapterImages, downloadChapterImages }
