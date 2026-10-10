import axios from 'axios';

function getRandomIP() {
    return `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

function getRandomUserAgent() {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15',
    ];
    return agents[Math.floor(Math.random() * agents.length)];
}

function getHeaders() {
    return {
        'User-Agent': getRandomUserAgent(),
        'Accept': '*/*',
        'Referer': 'https://e621.net/',
        'X-Forwarded-For': getRandomIP(),
        'X-Real-IP': getRandomIP(),
    };
}

function mapPostData(post) {
    if (!post) return null;
    return {
        id: post.id,
        url: post.file?.url || null,
        pageUrl: `https://e621.net/posts/${post.id}`,
        previewUrl: post.preview?.url || post.sample?.url || null,
        ext: post.file?.ext || 'unknown',
        size: post.file?.size || 0,
        rating: post.rating || '?',
        favCount: post.fav_count || 0,
        tags: post.tags || {},
    };
}

async function tagsSearch(keywords, page = 1) {
    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: keywords, limit: 30, page },
            headers: getHeaders(),
            timeout: 15000
        });

        const posts = res.data?.posts;
        if (!posts?.length) return null;

        return posts.map(mapPostData);
    } catch (error) {
        console.error('[E621 Scraper] Search error:', error.message);
        return null;
    }
}

async function getPost(url) {
    const match = url.match(/\/posts\/(\d+)/);
    if (!match) return null;

    try {
        const res = await axios.get(`https://e621.net/posts/${match[1]}.json`, {
            headers: getHeaders(),
            timeout: 15000
        });

        return mapPostData(res.data?.post);
    } catch (error) {
        console.error('[E621 Scraper] GetPost error:', error.message);
        return null;
    }
}

const POOL_PAGE_SIZE = 30;

async function getPoolInfo(poolId) {
    try {
        const res = await axios.get(`https://e621.net/pools/${poolId}.json`, {
            headers: getHeaders(),
            timeout: 15000
        });

        const pool = res.data;
        if (!pool || !Array.isArray(pool.post_ids)) return null;

        return {
            id: pool.id,
            name: (pool.name || `Pool ${pool.id}`).replace(/_/g, ' '),
            description: pool.description || '',
            category: pool.category || 'series',
            isActive: pool.is_active !== false,
            postIds: pool.post_ids,
            postCount: pool.post_ids.length,
        };
    } catch (error) {
        if (error.response?.status !== 404) console.error('[E621 Scraper] GetPoolInfo error:', error.message);
        return null;
    }
}

async function getPoolPage(poolId, page = 1) {
    const info = await getPoolInfo(poolId);
    if (!info) return null;

    const start = (page - 1) * POOL_PAGE_SIZE;
    const idsSlice = info.postIds.slice(start, start + POOL_PAGE_SIZE);
    if (!idsSlice.length) return { ...info, posts: [], page, totalPages: Math.max(1, Math.ceil(info.postCount / POOL_PAGE_SIZE)) };

    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: `id:${idsSlice.join(',')}`, limit: idsSlice.length },
            headers: getHeaders(),
            timeout: 15000
        });

        const byId = new Map((res.data?.posts || []).map(p => [p.id, mapPostData(p)]));

        const posts = idsSlice.map(id => byId.get(id)).filter(Boolean);

        return {
            ...info,
            posts,
            page,
            totalPages: Math.max(1, Math.ceil(info.postCount / POOL_PAGE_SIZE)),
        };
    } catch (error) {
        console.error('[E621 Scraper] GetPoolPage error:', error.message);
        return null;
    }
}

export {
    tagsSearch,
    getPost,
    getPoolInfo,
    getPoolPage,
    getHeaders,
    getRandomIP,
    getRandomUserAgent,
};