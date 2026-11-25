import http2 from 'http2';
import axios from 'hiro/axios';

const userAgent = 'hiro/1.0 (WhatsApp bot; e621 API client)';

function getHeaders() {
    return {
        'User-Agent': userAgent,
        'Accept': '*/*',
    };
}

function extractPosts(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.posts)) return data.posts;
    return null;
}

function extractPost(data) {
    if (data?.post) return data.post;
    if (data && typeof data === 'object' && !Array.isArray(data) && data.id) return data;
    return null;
}

function normalizeTags(tags) {
    if (Array.isArray(tags)) return { general: tags };
    return tags || {};
}

function mapPostData(post) {
    return mapE621Post(post);
}

async function tagsSearch(keywords, page = 1) {
    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: keywords, limit: 30, page, mode: 'extended' },
            headers: getHeaders(),
            timeout: 15000
        });

        const posts = extractPosts(res.data);
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
            params: { mode: 'extended' },
            headers: getHeaders(),
            timeout: 15000
        });

        return mapPostData(extractPost(res.data));
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
            params: { tags: `id:${idsSlice.join(',')}`, limit: idsSlice.length, mode: 'extended' },
            headers: getHeaders(),
            timeout: 15000
        });

        const byId = new Map((extractPosts(res.data) || []).map(p => [p.id, mapPostData(p)]));

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
};

function mapE621Post(post) {
    if (!post) return null;
    const files = post.files;
    const meta = files?.meta || post.file || {};
    const original = files?.original || post.file || {};
    const sample = files ? (meta.has_sample ? files.sample : null) : post.sample;
    const preview = files ? files.preview : post.preview;
    return {
        id: post.id,
        md5: meta.md5 || null,
        url: original.url || null,
        pageUrl: `https://e621.net/posts/${post.id}`,
        previewUrl: preview?.url || sample?.url || null,
        sampleUrl: sample?.url || null,
        ext: meta.ext || 'unknown',
        size: meta.size || 0,
        rating: post.rating || '?',
        favCount: post.stats?.fav_count ?? post.fav_count ?? 0,
        tags: normalizeTags(post.tags)
    };
}

const pageSize = 30;
async function searchTagsAccurate(keywords, page, size = pageSize) {
    const res = await axios.get('https://e621.net/posts.json', {
        params: { tags: keywords, limit: size, page, mode: 'extended' },
        headers: { ...getHeaders(), 'Accept': 'application/json' },
        timeout: 15000
    });
    const data = res.data;
    const raw = extractPosts(data);
    if (!raw) {
        const type = res.headers?.['content-type'] || 'unknown content-type';
        const text = typeof data === 'string' ? data : (JSON.stringify(data) ?? '');
        throw new Error(`e621 returned an unexpected response (${res.status}, ${type}): ${text.replace(/\s+/g, ' ').slice(0, 300)}`);
    }
    if (!raw.length) return { posts: [], hasNext: false };
    const hasNext = raw.length >= size;
    return { posts: raw.map(mapE621Post), hasNext };
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
                params: { tags: `id:${idsChunk.join(',')}`, limit: idsChunk.length, mode: 'extended' },
                headers: getHeaders(),
                timeout: 20000
            });
            const byId = new Map((extractPosts(res.data) || []).map(p => [p.id, mapE621Post(p)]));
            for (const id of idsChunk) {
                const post = byId.get(id);
                if (post) allPosts.push(post);
            }
        } catch (error) {
        }
    }
    return { info, posts: allPosts };
}

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

    const headers = { 'user-agent': userAgent, 'accept': 'image/*,*/*', 'referer': 'https://e621.net/' };

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
            headers: { 'User-Agent': userAgent, 'Accept': 'image/*,*/*', 'Referer': 'https://e621.net/' },
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
