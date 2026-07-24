/**
 * lib/scraper/x.js — Twitter / X scraper
 */

import axios from 'axios';
import { URLSearchParams } from 'url';
import { default as ffmpeg } from 'fluent-ffmpeg';
import * as fs from 'fs';
import * as path from 'path';
const cheerio = await import('cheerio');

const TMP_DIR = path.join(process.cwd(), process.env.TMP || 'data/tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

export function isLink(text) {
    return text?.match(/https?:\/\/\S+/gi) || null;
}

/**
 * Convert GIF tweet ke MP4 gifPlayback-compatible.
 * Caller WAJIB hapus file output setelah pakai.
 * @param {string} fileUrl
 * @returns {string} path file MP4 sementara
 */
export async function gifToMp4(fileUrl) {
    try {
        const old = fs.readdirSync(TMP_DIR).filter(f => f.startsWith('tmp_'));
        for (const f of old) {
            try { fs.unlinkSync(path.join(TMP_DIR, f)); } catch {}
        }
    } catch {}

    const ts        = Date.now();
    const tmpInput  = path.join(TMP_DIR, `tmp_in_${ts}.mp4`);
    const tmpOutput = path.join(TMP_DIR, `tmp_out_${ts}.mp4`);

    const dlRes = await axios.get(fileUrl, {
        responseType: 'stream',
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36' }
    });

    await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tmpInput);
        dlRes.data.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
    });

    if (!fs.existsSync(tmpInput) || fs.statSync(tmpInput).size === 0)
        throw new Error('Download gagal, file input kosong');

    await new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
            .outputOptions(['-movflags faststart', '-pix_fmt yuv420p', '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2'])
            .toFormat('mp4')
            .output(tmpOutput)
            .on('end', resolve)
            .on('error', (err, _stdout, stderr) => reject(new Error(`ffmpeg error: ${err.message}\n${stderr}`)))
            .run();
    });

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0)
        throw new Error('Konversi gagal, file output kosong atau tidak ditemukan');

    return tmpOutput;
}

/**
 * Ambil data Twitter/X dari savetwitter.net
 * @param {string} url - URL tweet
 * @returns {{ username, description, thumbnail, type?, gif?, image?, videoUrls: Array<{type, quality, link}> }}
 */
export async function twitter(url) {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL provided.');
    const urls = url.match(/(https?:\/\/[^\s]+)/g);
    if (!urls) throw new Error('No URL found.');

    const res = await axios({
        method: 'POST',
        url: 'https://savetwitter.net/api/ajaxSearch',
        data: new URLSearchParams({ q: urls[0], lang: 'id' }).toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': '*/*',
            'X-Requested-With': 'XMLHttpRequest',
        },
    });

    const $ = cheerio.load(res.data.data);
    const twitterId = $('#TwitterId').attr('value');
    const mp3Link   = $('a[data-audiourl]').attr('data-audiourl');

    const usernameIndex    = url.indexOf('.com/') + 5;
    const usernameEndIndex = url.indexOf('/status/');
    const nickname = url.substring(usernameIndex, usernameEndIndex);

    const kexp = $('script').filter(function () {
        return $(this).html().includes('k_exp');
    }).html().match(/k_exp\s*=\s*"([^"]*)"/)[1];

    const ktoken = $('script').filter(function () {
        return $(this).html().includes('k_token');
    }).html().match(/k_token\s*=\s*"([^"]*)"/)[1];

    const thumbnail = $('.thumbnail .image-tw img').attr('src');

    // GIF tweet
    const gifUrl   = $('.dl-action a').filter((i, el) => $(el).text().includes('Unduh MP4 (gif)')).attr('href');
    const imageUrl = $('.dl-action a').filter((i, el) => $(el).text().toLowerCase().includes('unduh gambar')).attr('href');

    if (gifUrl) {
        return {
            username: nickname,
            description: $('h3').text().trim(),
            type: 'gif',
            thumbnail,
            gif: gifUrl,
            image: imageUrl || null,
            videoUrls: []
        };
    }

    // Video links
    const links = [];
    $('a').each(function () {
        const text = $(this).text();
        const href = $(this).attr('href');
        if (text.includes('Unduh MP4')) {
            const quality = text.match(/\((\d+p)\)/);
            links.push({ type: 'MP4', quality: quality ? quality[1] : 'Unknown', link: [href] });
        }
    });

    // Image links
    const imgLinks = [];
    $('img').each(function () {
        const src = $(this).attr('src');
        if (src) imgLinks.push(src);
    });
    if (imgLinks.length) links.push({ type: 'JPG', quality: 'Image', link: imgLinks });

    // MP3
    if (mp3Link) {
        const mp3Res = await axios({
            method: 'POST',
            url: 'https://s1.twcdn.net/api/json/convert',
            data: new URLSearchParams({
                ftype: 'mp3',
                v_id: twitterId,
                audioUrl: mp3Link,
                audioType: 'audio/mp4',
                fquality: '320',
                fname: 'SaveTwitter.Net',
                exp: kexp,
                token: ktoken,
            }).toString(),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Accept': '*/*',
            },
        });
        if (mp3Res.data.result !== 'Converting') {
            links.push({ type: 'MP3', quality: '320kbps', link: [mp3Res.data.result] });
        }
    }

    return {
        username: nickname,
        description: $('h3').text().trim(),
        thumbnail: $('a[onclick="showAd()"]').attr('href'),
        videoUrls: links,
    };
}
