import axios from 'axios';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Scraper savereels.io tidak pernah menyediakan thumbnail/cover untuk video
// (cuma link .mp4 mentah). Supaya AI (fitur "peek"/view_link_post) bisa
// benar-benar menganalisa visual isi reels/video, kita extract 1 frame dari
// video pakai ffmpeg langsung dari URL remote-nya (tanpa perlu download
// videonya secara utuh dulu — ffmpeg bisa seek + ambil 1 frame dari stream).
async function extractVideoThumbnail(videoUrl, timeoutMs = 15000) {
    const outPath = path.join(os.tmpdir(), `ig_thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', [
            '-y',
            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            '-headers', 'Referer: https://savereels.io/\r\n',
            '-ss', '0.5',              // ambil frame di detik ke-0.5 (hindari frame hitam di detik 0)
            '-i', videoUrl,
            '-frames:v', '1',
            '-q:v', '4',
            outPath
        ]);

        let settled = false;
        const finish = (result) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };

        const timer = setTimeout(() => {
            try { proc.kill('SIGKILL'); } catch (_) {}
            finish(null);
        }, timeoutMs);

        proc.on('error', () => finish(null));
        proc.on('exit', (code) => {
            if (code === 0 && fs.existsSync(outPath) && fs.statSync(outPath).size > 0) {
                finish(outPath);
            } else {
                try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (_) {}
                finish(null);
            }
        });
    });
}

function detectContentType(url) {
    try {
        const u = new URL(url);
        const p = u.pathname;
        if (p.includes('/reel/')) return 'reel';
        if (p.includes('/p/')) return 'post';
        if (p.includes('/tv/')) return 'tv';
        return 'unknown';
    } catch {
        return 'unknown';
    }
}

async function formatInstagramResponse(videos, images, contentType = 'unknown') {
    const hasVideos = videos.length > 0;
    const hasImages = images.length > 0;

    if (!hasVideos && !hasImages) {
        return { status: false, error: 'No media found' };
    }

    let filteredVideos = videos;
    let filteredImages = images;

    if (contentType === 'post' && hasVideos) {
        if (videos.length > images.length) {
            const realVideos = videos.filter(v => v.match(/\.mp4/i) || v.includes('/video/'));
            filteredVideos = realVideos.length === 0 ? [] : realVideos;
        }
    }

    if (filteredImages.length === 1 && filteredVideos.length === 0) {
        return {
            status: true,
            result: {
                metadata: { type: 'single_image' },
                media: {
                    images: filteredImages.map(url => ({ url })),
                    videos: [],
                    audios: [],
                    thumbnail: filteredImages[0]
                }
            }
        };
    }

    if (filteredVideos.length === 1 && filteredImages.length === 0) {
        const thumbnail = await extractVideoThumbnail(filteredVideos[0]);
        return {
            status: true,
            result: {
                metadata: { type: 'reels' },
                media: {
                    videos: filteredVideos.map(url => ({ url })),
                    images: [],
                    audios: [],
                    thumbnail
                }
            }
        };
    }

    const items = [];

    for (const url of filteredVideos) {
        items.push({ index: items.length + 1, type: 'video', videos: [{ url }], images: [] });
    }

    for (const url of filteredImages) {
        items.push({ index: items.length + 1, type: 'image', images: [{ url }], videos: [] });
    }

    let type = 'single';
    if (items.length > 1) type = 'carousel';
    else if (items.length === 1 && items[0].type === 'video') type = 'reels';
    else if (items.length === 1 && items[0].type === 'image') type = 'single_image';

    // Thumbnail representatif buat carousel: pakai item pertama — kalau
    // video, extract frame; kalau image, pakai langsung.
    let thumbnail = null;
    const first = items[0];
    if (first) {
        if (first.type === 'video') {
            thumbnail = await extractVideoThumbnail(first.videos[0].url);
        } else {
            thumbnail = first.images[0].url;
        }
    }

    return {
        status: true,
        result: {
            metadata: {
                type,
                totalItems: items.length,
                totalImages: filteredImages.length,
                totalVideos: filteredVideos.length
            },
            media: { items, thumbnail }
        }
    };
}

export async function instagram(url) {
    const contentType = detectContentType(url);

    try {
        const instance = axios.create({ maxRedirects: 5, timeout: 30000 });

        const { data: res } = await instance.post(
            'https://savereels.io/api/ajaxSearch',
            new URLSearchParams({ q: url, v: 'v2' }).toString(),
            {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                    'X-Requested-With': 'XMLHttpRequest',
                    'Accept': 'application/json, text/plain, */*',
                    'Referer': 'https://savereels.io/',
                    'Origin': 'https://savereels.io'
                }
            }
        );

        if (res.status !== 'ok') {
            return { status: false, error: 'Savereels error: ' + res.status };
        }

        let html = res.data || res;

        if (typeof html === 'object' && html !== null) {
            if (html.html && typeof html.html === 'string') html = html.html;
            else if (html.content && typeof html.content === 'string') html = html.content;
            else if (html.body && typeof html.body === 'string') html = html.body;
            else if (html.data && typeof html.data === 'string') html = html.data;
            else html = JSON.stringify(html);
        }

        if (typeof html !== 'string') html = String(html);

        if (!html || html.length < 10) {
            return { status: false, error: 'Empty response from Savereels' };
        }

        const allLinks = [];
        const patterns = [
            /https:\/\/[a-zA-Z0-9.-]+\.snapcdn\.app\/get\?token=[^\s"']+/gi,
            /https:\/\/[a-zA-Z0-9.-]+\.snapcdn\.app\/video[^\s"']*/gi,
            /https:\/\/[^\s"']+\.(mp4|jpg|jpeg|png|gif|webp)[^\s"']*/gi,
            /https:\/\/i\.snapcdn\.app\/photo\?token=[^\s"']+/gi
        ];

        for (const pattern of patterns) {
            const matches = html.match(pattern);
            if (matches) {
                matches.forEach(m => {
                    const clean = m.replace(/["']/g, '').trim();
                    if (clean && clean.startsWith('http') && !allLinks.includes(clean)) {
                        allLinks.push(clean);
                    }
                });
            }
        }

        function getTokenData(link) {
            try {
                const token = link.match(/token=([^&]+)/)?.[1];
                if (!token) return null;
                const payload = Buffer.from(token.split('.')[1], 'base64').toString('utf8');
                return JSON.parse(payload);
            } catch { return null; }
        }

        const videoSet = new Set();
        const imageMap = new Map();

        for (const link of allLinks) {
            const data = getTokenData(link);

            if (data && data.filename) {
                const filename = data.filename;
                const ext = filename.split('.').pop()?.toLowerCase();

                if (['mp4', 'mov', 'avi', 'mkv', 'webm'].includes(ext)) {
                    videoSet.add(link);
                    continue;
                }

                if (['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(ext)) {
                    const originalUrl = data.url ? data.url.split('?')[0] : link;

                    let w = 0, h = 0;
                    const match1 = filename.match(/_(\d+)x(\d+)\./);
                    const match2 = filename.match(/_(\d+)\.(jpg|jpeg|png|gif|webp)$/i);

                    if (match1) { w = parseInt(match1[1]); h = parseInt(match1[2]); }
                    else if (match2) { w = parseInt(match2[1]); h = parseInt(match2[1]); }

                    if (w === 0) w = 1;
                    if (h === 0) h = 1;

                    if (!imageMap.has(originalUrl) || (w * h) > (imageMap.get(originalUrl).w * imageMap.get(originalUrl).h)) {
                        imageMap.set(originalUrl, { url: link, w, h });
                    }
                }
            }
        }

        const sorted = Array.from(imageMap.values()).sort((a, b) => (b.w * b.h) - (a.w * a.h));
        const imageLinks = sorted.map(item => item.url);
        const videos = Array.from(videoSet);

        let filteredVideos = videos;
        let filteredImages = imageLinks;

        if (contentType === 'reel') {
            filteredImages = [];
            if (filteredVideos.length === 0) {
                return { status: false, error: 'No video found for reel' };
            }
        }

        if (filteredVideos.length === 0 && filteredImages.length === 0) {
            return { status: false, error: 'No media found' };
        }

        return await formatInstagramResponse(filteredVideos, filteredImages, contentType);

    } catch (err) {
        console.error('[IG Savereels Error]', err.message);
        return { status: false, error: err.message };
    }
}
