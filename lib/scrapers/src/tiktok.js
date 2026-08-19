/**
 * lib/scraper/tiktok.js
 */

import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import axios from 'axios';

const execAsync = promisify(exec);

export function isLink(text) {
    return text?.match(/https?:\/\/\S+/gi) || null;
}

/**
 * Ambil data TikTok dari tikwm.com
 * @param {string} url
 * @returns {{ author: { nickname, unique_id }, title: string, play: string, music: string, images: string[]|null }}
 */
export async function tiktok(url) {
    const link = isLink(url);
    if (!link) throw new Error('URL tidak valid');
    
    // Menggunakan axios agar lebih stabil dibanding fetch bawaan
    const { data: res } = await axios.post('https://www.tikwm.com/api/', {
        url: link[0],
        count: 12,
        cursor: 0,
        web: 1,
        hd: 1
    }, {
        headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    });

    if (!res?.data) throw new Error('Gagal mengambil data TikTok');
    return res.data;
}

/**
 * Pastikan URL video absolut. tikwm kadang mengembalikan path relatif
 * (mis. "/video/media/play/xxx.mp4") yang bikin `new URL()` di axios error.
 * @param {string} url
 * @returns {string}
 */
function normalizeVideoUrl(url) {
    if (!url) throw new Error('URL video kosong/tidak tersedia dari tikwm');
    if (/^https?:\/\//i.test(url)) return url;
    return `https://www.tikwm.com${url.startsWith('/') ? '' : '/'}${url}`;
}

/**
 * Download video TikTok lalu naikkan volume 4x, return Buffer hasil
 * @param {string} videoUrl
 * @returns {Buffer}
 */
export async function tiktokBoostVolume(videoUrl) {
    const fixedUrl = normalizeVideoUrl(videoUrl);
    const { data: videoBuffer } = await axios.get(fixedUrl, {
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            Referer: 'https://www.tikwm.com/'
        }
    });
    const tmpIn  = join(tmpdir(), `tt_in_${Date.now()}.mp4`);
    const tmpOut = join(tmpdir(), `tt_out_${Date.now()}.mp4`);
    await writeFile(tmpIn, videoBuffer);
    await execAsync(`ffmpeg -i "${tmpIn}" -filter:a "volume=4.0" -c:v copy "${tmpOut}" -y`);
    const boostedBuffer = await readFile(tmpOut);
    await Promise.allSettled([unlink(tmpIn), unlink(tmpOut)]);
    return boostedBuffer;
}
