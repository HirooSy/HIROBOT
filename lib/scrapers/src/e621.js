import http2 from 'http2';
import axios from 'hiro/axios';

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
        return null;
    }
}

const poolPageSize = 30;

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
        return null;
    }
}

async function getPoolPage(poolId, page = 1, pageSize = poolPageSize) {
    const info = await getPoolInfo(poolId);
    if (!info) return null;

    const start = (page - 1) * pageSize;
    const idsSlice = info.postIds.slice(start, start + pageSize);
    if (!idsSlice.length) return { ...info, posts: [], page, totalPages: Math.max(1, Math.ceil(info.postCount / pageSize)) };

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
            totalPages: Math.max(1, Math.ceil(info.postCount / pageSize)),
        };
    } catch (error) {
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

function mapE621Post(post) {
    if (!post) return null;
    return {
        id: post.id,
        url: post.file?.url || null,
        pageUrl: `https://e621.net/posts/${post.id}`,
        previewUrl: post.preview?.url || post.sample?.url || null,
        sampleUrl: post.sample?.url || null,
        ext: post.file?.ext || 'unknown',
        size: post.file?.size || 0,
        rating: post.rating || '?',
        favCount: post.fav_count || 0,
        tags: post.tags || {}
    };
}

const pageSize = 30;
async function searchTagsAccurate(keywords, page, size = pageSize) {
    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: keywords, limit: size, page },
            headers: getHeaders(),
            timeout: 15000
        });
        const raw = res.data?.posts || [];
        if (!raw.length) return { posts: [], hasNext: false };
        const hasNext = raw.length >= size;
        return { posts: raw.map(mapE621Post), hasNext };
    } catch (error) {
        return { posts: [], hasNext: false };
    }
}

async function fetchAllPoolPosts(poolId) {
    const info = await getPoolInfo(poolId);
    if (!info || !info.postIds.length) return null;

    const chunkSize = 100;
    const allPosts = [];
    for (let i = 0; i < info.postIds.length; i += chunkSize) {
        const idsChunk = info.postIds.slice(i, i + chunkSize);
        try {
            const res = await axios.get('https://e621.net/posts.json', {
                params: { tags: `id:${idsChunk.join(',')}`, limit: idsChunk.length },
                headers: getHeaders(),
                timeout: 20000
            });
            const byId = new Map((res.data?.posts || []).map(p => [p.id, mapE621Post(p)]));
            for (const id of idsChunk) {
                const post = byId.get(id);
                if (post) allPosts.push(post);
            }
        } catch (error) {
        }
    }
    return { info, posts: allPosts };
}

const previewUa = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36';

function createFetcher() {
    const sessions = new Map();
    let h2Broken = false;

    const getSession = (origin) => {
        let session = sessions.get(origin);
        if (session && !session.closed && !session.destroyed) return session;
        session = http2.connect(origin);
        session.on('error', () => sessions.delete(origin));
        session.on('close', () => sessions.delete(origin));
        sessions.set(origin, session);
        return session;
    };

    const headers = { 'user-agent': previewUa, 'accept': 'image/*,*/*', 'referer': 'https://e621.net/' };

    const viaHttp2 = (url) => new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = getSession(u.origin).request({ ':path': u.pathname + u.search, ...headers });
        const chunks = [];
        let status = 0;
        let type = '';
        const timer = setTimeout(() => {
            req.close(http2.constants.NGHTTP2_CANCEL);
            reject(new Error('timeout'));
        }, 15000);
        req.on('response', (h) => {
            status = h[':status'];
            type = h['content-type'] || '';
        });
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            clearTimeout(timer);
            if (status === 200) return resolve({ data: Buffer.concat(chunks), type });
            reject(Object.assign(new Error(`HTTP ${status}`), { response: { status } }));
        });
        req.on('error', (e) => {
            clearTimeout(timer);
            reject(e);
        });
        req.end();
    });

    const viaAxios = async (url) => {
        const res = await axios.get(url, {
            responseType: 'arraybuffer',
            headers: { 'User-Agent': previewUa, 'Accept': 'image/*,*/*', 'Referer': 'https://e621.net/' },
            timeout: 15000
        });
        return { data: res.data, type: res.headers?.['content-type'] || '' };
    };

    return {
        async get(url) {
            if (!h2Broken) {
                try {
                    return await viaHttp2(url);
                } catch (e) {
                    if (e.response?.status >= 400) throw e;
                    h2Broken = true;
                }
            }
            return viaAxios(url);
        },
        close() {
            for (const session of sessions.values()) session.close();
            sessions.clear();
        }
    };
}

async function getFileStream(url) {
    return axios.get(url, { responseType: 'stream', headers: getHeaders(), timeout: 60000 })
}

async function getFileBuffer(url) {
    return axios.get(url, { responseType: 'arraybuffer', headers: getHeaders(), timeout: 30000 })
}

export { pageSize, searchTagsAccurate, fetchAllPoolPosts, createFetcher, getFileStream, getFileBuffer }
