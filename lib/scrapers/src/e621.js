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

// ============== SHARED POST MAPPER ==============
// Both tagsSearch and getPost run this over e621's raw post object, so
// every post coming out of search already has the exact same shape as
// a post fetched by URL (file url, ext, size, tags, preview) - no need
// to re-fetch each search result individually to get "real" data.
function mapPostData(post) {
    if (!post) return null;
    return {
        id: post.id,
        // file.url comes back null from e621's API for some posts (auth-
        // gated content, deleted files, etc). Leaving it null here - rather
        // than falling back to the post's page URL - matters because url
        // is used both to download/send the actual media and as an ffmpeg
        // input for gif/video frame previews; silently substituting an
        // HTML page URL made both of those fail in confusing ways (ffmpeg:
        // "Invalid data found when processing input") instead of a clear
        // "media unavailable" the caller can check for.
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

        return posts.map(mapPostData);
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

        return mapPostData(res.data?.post);
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