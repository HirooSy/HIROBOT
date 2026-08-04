import axios from 'axios';
import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';

async function extractVideoThumbnail(videoUrl, timeoutMs = 15000) {
    const outPath = path.join(os.tmpdir(), `fb_thumb_${Date.now()}_${Math.random().toString(36).slice(2)}.jpg`);
    return new Promise((resolve) => {
        const proc = spawn('ffmpeg', [
            '-y',
            '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            '-headers', 'Referer: https://savereels.io/\r\n',
            '-ss', '0.5',
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

function isFbUrl(url) {
    try {
        const u = new URL(url);
        return /(^|\.)facebook\.com$|(^|\.)fb\.watch$|(^|\.)fb\.com$/i.test(u.hostname);
    } catch {
        return false;
    }
}

export async function facebook(url) {
    if (!isFbUrl(url)) {
        return { status: false, error: 'Invalid Facebook URL' };
    }

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

        // Ambil title/duration kalau ada (buat metadata)
        let title = null;
        const titleMatch = html.match(/<h3[^>]*>([^<]+)<\/h3>/i) || html.match(/class="[^"]*title[^"]*"[^>]*>([^<]+)</i);
        if (titleMatch) title = titleMatch[1].trim();

        // Cari semua anchor/link download beserta label kualitasnya.
        // Struktur khas: <a href="...">Download</a> di baris yang ada label kualitas (720p, 360p, dst)
        // dan flag "Render"/"No" (render = butuh proses, No = link langsung).
        const rows = [];
        const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rowMatch;
        while ((rowMatch = rowRegex.exec(html)) !== null) {
            const rowHtml = rowMatch[1];
            const qualityMatch = rowHtml.match(/(\d{3,4}p)\s*(\(HD\)|\(SD\))?/i);
            const hrefMatch = rowHtml.match(/href="([^"]+)"/i);
            const needsRender = /render/i.test(rowHtml) && !/no\s*<\/td>/i.test(rowHtml);

            if (qualityMatch && hrefMatch) {
                rows.push({
                    quality: qualityMatch[1],
                    label: qualityMatch[0].trim(),
                    url: hrefMatch[1].replace(/&amp;/g, '&'),
                    needsRender
                });
            }
        }

        if (rows.length === 0) {
            const directLinks = [];
            const patterns = [
                /https:\/\/[a-zA-Z0-9.-]+\.snapcdn\.app\/get\?token=[^\s"']+/gi,
                /https:\/\/[a-zA-Z0-9.-]+\.snapcdn\.app\/video[^\s"']*/gi,
                /https:\/\/[^\s"']+\.mp4[^\s"']*/gi
            ];
            for (const pattern of patterns) {
                const matches = html.match(pattern);
                if (matches) {
                    matches.forEach(m => {
                        const clean = m.replace(/["']/g, '').trim();
                        if (clean && clean.startsWith('http') && !directLinks.includes(clean)) {
                            directLinks.push(clean);
                        }
                    });
                }
            }

            if (directLinks.length === 0) {
                return { status: false, error: 'No downloadable video found' };
            }

            const videoUrl = directLinks[0];
            const thumbnail = await extractVideoThumbnail(videoUrl);

            return {
                status: true,
                result: {
                    metadata: { type: 'video', title },
                    media: {
                        videos: [{ url: videoUrl, quality: null }],
                        thumbnail
                    }
                }
            };
        }

        const instant = rows.filter(r => !r.needsRender)
            .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));
        const rendered = rows.filter(r => r.needsRender)
            .sort((a, b) => parseInt(b.quality) - parseInt(a.quality));

        const orderedVideos = [...instant, ...rendered].map(r => ({
            url: r.url,
            quality: r.quality,
            needsRender: r.needsRender
        }));

        const best = orderedVideos[0];
        const thumbnail = best ? await extractVideoThumbnail(best.url) : null;

        return {
            status: true,
            result: {
                metadata: { type: 'video', title },
                media: {
                    videos: orderedVideos,
                    thumbnail
                }
            }
        };

    } catch (err) {
        console.error('[FB Savereels Error]', err.message);
        return { status: false, error: err.message };
    }
}
