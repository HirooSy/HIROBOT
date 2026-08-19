
import axios from 'axios';

// ============== RANDOM IP & USER-AGENT ==============
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

// ============== SEARCH ==============
async function tagsSearch(keywords, page = 1) {
    try {
        const res = await axios.get('https://e621.net/posts.json', {
            params: { tags: keywords, limit: 50, page },
            headers: getHeaders(),
            timeout: 15000
        });

        const posts = res.data?.posts;
        if (!posts?.length) return null;

        return posts.map(post => ({
            url: `https://e621.net/posts/${post.id}`,
            favCount: post.fav_count || 0,
            rating: post.rating || '?',
            type: post.file?.ext || 'unknown',
            artist: post.tags?.artist || []
        }));
    } catch (error) {
        console.error('[E621 Scraper] Search error:', error.message);
        return null;
    }
}

// ============== GET POST ==============
async function getPost(url) {
    const match = url.match(/\/posts\/(\d+)/);
    if (!match) return null;

    try {
        const res = await axios.get(`https://e621.net/posts/${match[1]}.json`, {
            headers: getHeaders(),
            timeout: 15000
        });

        const post = res.data?.post;
        if (!post) return null;

        return {
            id: post.id,
            url: post.file?.url,
            ext: post.file?.ext || 'unknown',
            size: post.file?.size || 0,
            rating: post.rating || '?',
            favCount: post.fav_count || 0,
            tags: post.tags || {},
        };
    } catch (error) {
        console.error('[E621 Scraper] GetPost error:', error.message);
        return null;
    }
}

export default {
    tagsSearch,
    getPost,
    getHeaders,
    getRandomIP,
    getRandomUserAgent,
};