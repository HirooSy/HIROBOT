/**
 * lib/scraper/tiktok.js
 */

import fetch from 'node-fetch';
import { writeFile, unlink, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

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
    const res = await fetch(`https://tikwm.com/api/?url=${link[0]}`);
    const json = await res.json();
    if (!json?.data) throw new Error('Gagal mengambil data TikTok');
    return json.data;
}

/**
 * Download video TikTok lalu naikkan volume 4x, return Buffer hasil
 * @param {string} videoUrl
 * @returns {Buffer}
 */
export async function tiktokBoostVolume(videoUrl) {
    const videoBuffer = await (await fetch(videoUrl)).buffer();
    const tmpIn  = join(tmpdir(), `tt_in_${Date.now()}.mp4`);
    const tmpOut = join(tmpdir(), `tt_out_${Date.now()}.mp4`);
    await writeFile(tmpIn, videoBuffer);
    await execAsync(`ffmpeg -i "${tmpIn}" -filter:a "volume=4.0" -c:v copy "${tmpOut}" -y`);
    const boostedBuffer = await readFile(tmpOut);
    await Promise.allSettled([unlink(tmpIn), unlink(tmpOut)]);
    return boostedBuffer;
}
