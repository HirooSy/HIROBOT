import axios from 'axios';
import { URLSearchParams } from 'url';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
const cheerio = await import('cheerio');

const execFileAsync = promisify(execFile);
const FFMPEG_PATH = '/usr/bin/ffmpeg';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';

const TMP_DIR = path.join(process.cwd(), 'data/tmp');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });

export function isLink(text) {
    return text?.match(/https?:\/\/\S+/gi) || null;
}

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
        throw new Error('Download failed, input file is empty');

    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    try {
        await execFileAsync(FFMPEG_PATH, [
            '-y',
            '-i', tmpInput,
            '-map_metadata', '-1',         
            '-metadata', `creation_time=${nowIso}`,
            '-metadata:s:v:0', `creation_time=${nowIso}`,
            '-metadata:s:a:0', `creation_time=${nowIso}`,
            '-movflags', 'faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-f', 'mp4',
            tmpOutput
        ]);
    } catch (err) {
        throw new Error(`ffmpeg error: ${err.message}\n${err.stderr || ''}`);
    }

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0)
        throw new Error('Conversion failed, output file is empty or not found');

    return tmpOutput;
}

export async function fixVideoMetadata(fileUrl) {
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
        throw new Error('Download failed, input file is empty');

    const nowIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

    try {
        await execFileAsync(FFMPEG_PATH, [
            '-y',
            '-i', tmpInput,
            '-map_metadata', '-1',
            '-metadata', `creation_time=${nowIso}`,
            '-metadata:s:v:0', `creation_time=${nowIso}`,
            '-metadata:s:a:0', `creation_time=${nowIso}`,
            '-c', 'copy',   
            '-movflags', 'faststart',
            '-f', 'mp4',
            tmpOutput
        ]);
    } catch (err) {
        if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);
        throw new Error(`ffmpeg error: ${err.message}\n${err.stderr || ''}`);
    }

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0)
        throw new Error('Conversion failed, output file is empty or not found');

    return tmpOutput;
}

function findScriptVar($, name) {
    let value = null;
    $('script').each((_, el) => {
        const body = $(el).html() || '';
        if (!body.includes(name)) return;
        const m = body.match(new RegExp(`${name}\\s*[:=]\\s*["']([^"']+)["']`));
        if (m) {
            value = m[1];
            return false;
        }
    });
    return value;
}

async function twitterViaSaveTwitter(url) {
    const res = await axios({
        method: 'POST',
        url: 'https://savetwitter.net/api/ajaxSearch',
        data: new URLSearchParams({ q: url, lang: 'id' }).toString(),
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'Accept': '*/*',
            'X-Requested-With': 'XMLHttpRequest',
            'User-Agent': BROWSER_UA,
        },
        timeout: 20000,
    });

    const html = res.data?.data;
    if (typeof html !== 'string' || !html.trim())
        throw new Error(`savetwitter.net returned no page${res.data?.mess ? ` (${res.data.mess})` : ''}`);

    const $ = cheerio.load(html);
    const twitterId   = $('#TwitterId').attr('value') || null;
    const mp3Link     = $('a[data-audiourl]').attr('data-audiourl') || null;
    const kexp        = findScriptVar($, 'k_exp');
    const ktoken      = findScriptVar($, 'k_token');
    const thumbnail   = $('.thumbnail .image-tw img').attr('src');
    const description = $('h3').text().trim();

    const usernameIndex    = url.indexOf('.com/') + 5;
    const usernameEndIndex = url.indexOf('/status/');
    const nickname = usernameEndIndex > usernameIndex ? url.substring(usernameIndex, usernameEndIndex) : '';

    // GIF tweet
    const gifUrl   = $('.dl-action a').filter((i, el) => $(el).text().includes('Unduh MP4 (gif)')).attr('href');
    const imageUrl = $('.dl-action a').filter((i, el) => $(el).text().toLowerCase().includes('unduh gambar')).attr('href');

    if (gifUrl) {
        return {
            username: nickname,
            description,
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
        if (text.includes('Unduh MP4') && href) {
            const quality = text.match(/\((\d+p)\)/);
            links.push({ type: 'MP4', quality: quality ? quality[1] : 'Unknown', link: [href] });
        }
    });

    // Image links
    const norm = s => (s.startsWith('//') ? 'https:' + s : s);
    const allImgs = [];
    $('img').each(function () {
        const src = norm($(this).attr('src') || '');
        if (/^https?:\/\//i.test(src)) allImgs.push(src);
    });
    const tweetImgs = allImgs.filter(s => /pbs\.twimg\.com/i.test(s));
    const hasVideo  = links.some(l => l.type === 'MP4');
    const thumb     = thumbnail ? norm(thumbnail) : null;
    const imgLinks  = [...new Set(tweetImgs.length ? tweetImgs : allImgs)]
        .filter(s => !(hasVideo && thumb && s === thumb));
    if (imgLinks.length) links.push({ type: 'JPG', quality: 'Image', link: imgLinks });

    // MP3
    if (mp3Link && twitterId && kexp && ktoken) {
        try {
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
                timeout: 20000,
            });
            if (mp3Res.data?.result && mp3Res.data.result !== 'Converting') {
                links.push({ type: 'MP3', quality: '320kbps', link: [mp3Res.data.result] });
            }
        } catch (_) {
        }
    }

    if (links.length === 0)
        throw new Error('savetwitter.net page had no downloadable media (its layout may have changed)');

    return {
        username: nickname,
        description,
        thumbnail: thumb || tweetImgs[0] || null,
        videoUrls: links,
    };
}

const TWEET_URL_RE = /(?:twitter|x|fxtwitter|vxtwitter|fixupx)\.com\/(?:([A-Za-z0-9_]+)\/(?:web\/)?)?status\/(\d+)/i;

function parseTweetUrl(url) {
    const m = url.match(TWEET_URL_RE);
    if (!m) throw new Error('no tweet id found in the URL');
    return { screenName: m[1] || 'i', tweetId: m[2] };
}

function tweetFromItems({ username, description, items }) {
    const usable = items.filter(it => it && it.url);
    if (usable.length === 1 && usable[0].kind === 'gif') {
        return {
            username,
            description,
            type: 'gif',
            thumbnail: usable[0].thumbnail || null,
            gif: usable[0].url,
            image: null,
            videoUrls: []
        };
    }

    const videoUrls = [];
    for (const it of usable) {
        if (it.kind === 'video' || it.kind === 'gif') {
            videoUrls.push({ type: 'MP4', quality: it.height ? `${it.height}p` : 'Unknown', link: [it.url] });
        }
    }
    const photos = usable.filter(it => it.kind === 'photo').map(it => it.url);
    if (photos.length) videoUrls.push({ type: 'JPG', quality: 'Image', link: photos });
    if (videoUrls.length === 0) return null;

    return {
        username,
        description,
        thumbnail: usable.find(it => it.thumbnail)?.thumbnail || null,
        videoUrls,
    };
}

async function twitterViaFxTwitter(url) {
    const { screenName, tweetId } = parseTweetUrl(url);

    const res = await axios.get(`https://api.fxtwitter.com/${screenName}/status/${tweetId}`, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        timeout: 20000,
    });

    const tweet = res.data?.tweet;
    if (!tweet) throw new Error(`FxTwitter returned no tweet${res.data?.message ? ` (${res.data.message})` : ''}`);

    const media = tweet.media || {};
    const raw = Array.isArray(media.all) ? media.all : [...(media.photos || []), ...(media.videos || [])];
    const items = raw.filter(it => it && it.url).map(it => ({
        kind: it.type === 'photo' || it.type === 'video' || it.type === 'gif'
            ? it.type
            : (/\.mp4(\?|$)/i.test(it.url) ? 'video' : 'photo'),
        url: it.url,
        thumbnail: it.thumbnail_url || null,
        height: it.height || 0
    }));

    const result = tweetFromItems({ username: tweet.author?.screen_name || '', description: tweet.text || '', items });
    if (!result) throw new Error('FxTwitter found no media in this tweet');
    return result;
}

async function twitterViaVxTwitter(url) {
    const { screenName, tweetId } = parseTweetUrl(url);

    const res = await axios.get(`https://api.vxtwitter.com/${screenName}/status/${tweetId}`, {
        headers: { 'User-Agent': BROWSER_UA, 'Accept': 'application/json' },
        timeout: 20000,
    });

    const tweet = res.data;
    if (!tweet || typeof tweet !== 'object' || (!tweet.media_extended && !tweet.mediaURLs)) {
        throw new Error(`VxTwitter returned no tweet${tweet?.error ? ` (${tweet.error})` : ''}`);
    }

    const raw = Array.isArray(tweet.media_extended) && tweet.media_extended.length
        ? tweet.media_extended
        : (tweet.mediaURLs || []).map(u => ({ url: u, type: /\.mp4(\?|$)/i.test(u) ? 'video' : 'image' }));
    const items = raw.filter(it => it && it.url).map(it => ({
        kind: it.type === 'image' ? 'photo' : (it.type === 'gif' ? 'gif' : 'video'),
        url: it.url,
        thumbnail: it.thumbnail_url || null,
        height: it.size?.height || 0
    }));

    const result = tweetFromItems({ username: tweet.user_screen_name || '', description: tweet.text || '', items });
    if (!result) throw new Error('VxTwitter found no media in this tweet');
    return result;
}

export async function twitter(url) {
    if (!url || typeof url !== 'string') throw new Error('Invalid URL provided.');
    const urls = url.match(/(https?:\/\/[^\s]+)/g);
    if (!urls) throw new Error('No URL found.');
    const tweetUrl = urls[0];

    const errors = [];
    for (const [name, fetchFn] of [['fxtwitter', twitterViaFxTwitter], ['vxtwitter', twitterViaVxTwitter], ['savetwitter', twitterViaSaveTwitter]]) {
        try {
            return await fetchFn(tweetUrl);
        } catch (err) {
            errors.push(`${name}: ${err.message}`);
        }
    }
    throw new Error(`Twitter/X download failed. ${errors.join('. ')}`);
}
