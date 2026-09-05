// ytdl.js - Updated with SaveTube API
import { search as yts } from './ytsearch.js'
import crypto from 'crypto';

const AES_KEY_HEX = 'C5D58EF67A7584E4A29F6C35BBC4EB12';
const KEY_BUFFER = Buffer.from(AES_KEY_HEX, 'hex');

// Headers untuk SaveTube API
const SAVETUBE_HEADERS = {
    'Content-Type': 'application/json',
    'Origin': 'https://save-tube.com',
    'Referer': 'https://save-tube.com/',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.5'
};

// Fungsi dekripsi payload SaveTube
function decryptPayload(encryptedBase64) {
    const raw = Buffer.from(encryptedBase64, 'base64');
    if (raw.length < 16) throw new Error('Invalid cipher format');
    const iv = raw.subarray(0, 16);
    const ciphertext = raw.subarray(16);
    const decipher = crypto.createDecipheriv('aes-128-cbc', KEY_BUFFER, iv);
    const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
}

// Fungsi untuk mendapatkan CDN random
async function getRandomCdn() {
    const res = await fetch('https://media.savetube.vip/api/random-cdn');
    if (!res.ok) throw new Error(`HTTP ${res.status}: CDN network unavailable`);
    const json = await res.json();
    if (!json?.cdn) throw new Error('CDN response corrupted');
    return json.cdn;
}

// Fungsi untuk mendapatkan info video
async function getVideoInfo(cdn, youtubeUrl) {
    const res = await fetch(`https://${cdn}/v2/info`, {
        method: 'POST',
        headers: SAVETUBE_HEADERS,
        body: JSON.stringify({ url: youtubeUrl })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: Failed to fetch video info`);
    const json = await res.json();
    if (!json.status || !json.data) {
        throw new Error(json.message || 'Invalid or unsupported YouTube URL');
    }
    return decryptPayload(json.data);
}

// Fungsi untuk mendapatkan download URL
async function getDownloadUrl(cdn, key, quality, downloadType = 'video') {
    const payload = { downloadType, quality: String(quality), key };
    const res = await fetch(`https://${cdn}/download`, {
        method: 'POST',
        headers: SAVETUBE_HEADERS,
        body: JSON.stringify(payload)
    });
    if (!res.ok) return { url: null, error: `HTTP ${res.status}` };
    const json = await res.json();
    if (!json.status || !json.data?.downloadUrl) {
        return { url: null, error: json.message || 'Server render failed' };
    }
    return { url: json.data.downloadUrl, error: null };
}

// Fungsi extract YouTube ID (sama seperti sebelumnya)
function extractYoutubeId(url) {
    const re = /(?:youtu\.be\/|youtube\.com\/(?:embed\/|live\/|shorts\/)|[?&]v=)([a-zA-Z0-9-_]{11})/
    const match = url.match(re)
    return match ? match[1] : null
}

// Fungsi utama ytdl dengan interface yang sama
export async function ytdl(type = 'audio', url) {
    const format = type === 'audio' ? 'mp3' : 'mp4';
    const videoId = extractYoutubeId(url);

    if (!videoId) {
        throw new Error(`YouTube download error: could not extract a valid video ID from URL: ${url}`);
    }

    try {
        // 1. Get random CDN
        const cdn = await getRandomCdn();
        
        // 2. Get video info
        const videoData = await getVideoInfo(cdn, url);
        
        // 3. Pilih format berdasarkan tipe (audio/video)
        let selectedFormat = null;
        let quality = '';
        
        if (type === 'audio') {
            // Pilih audio format tertinggi (biasanya 128kbps atau 320kbps)
            const audioFormats = videoData.audio_formats || [];
            if (audioFormats.length === 0) {
                throw new Error('No audio formats available for this video');
            }
            // Coba ambil yang kualitas tertinggi, fallback ke pertama
            selectedFormat = audioFormats.find(f => f.quality >= 128) || audioFormats[0];
            quality = selectedFormat.quality;
        } else {
            // Pilih video format berdasarkan kualitas
            const videoFormats = videoData.video_formats || [];
            if (videoFormats.length === 0) {
                throw new Error('No video formats available for this video');
            }
            // Coba ambil 720p, fallback ke kualitas tertinggi tersedia
            selectedFormat = videoFormats.find(f => f.quality === 720) || 
                           videoFormats.find(f => f.quality >= 720) || 
                           videoFormats[videoFormats.length - 1];
            quality = selectedFormat.quality;
        }

        // 4. Dapatkan download URL
        let downloadUrl = selectedFormat?.url;
        let key = videoData.key;
        
        if (!downloadUrl) {
            const result = await getDownloadUrl(cdn, key, quality, type);
            if (result.error) {
                throw new Error(`Failed to get download URL: ${result.error}`);
            }
            downloadUrl = result.url;
        }

        if (!downloadUrl) {
            throw new Error('No download URL found');
        }

        // 5. Tambahkan title ke URL jika diperlukan
        const cleanTitle = (videoData.title || 'video').replaceAll('#', '');
        const finalUrl = downloadUrl.includes('?') 
            ? `${downloadUrl}&title=${encodeURIComponent(cleanTitle)}`
            : `${downloadUrl}?title=${encodeURIComponent(cleanTitle)}`;

        // 6. Download file
        const fileRes = await fetch(finalUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:152.0) Gecko/20100101 Firefox/152.0',
                'Accept': '*/*'
            },
            redirect: 'follow'
        });
        
        if (!fileRes.ok) {
            throw new Error(`File download failed with status ${fileRes.status}`);
        }
        
        const buffer = Buffer.from(await fileRes.arrayBuffer());

        // 7. Dapatkan metadata tambahan dari yts
        let views, duration, thumbnail, channel;
        try {
            const meta = await yts({ videoId });
            views = meta?.views;
            duration = meta?.duration?.timestamp || meta?.timestamp;
            thumbnail = meta?.thumbnail;
            channel = meta?.author?.name;
        } catch (metaErr) {
            console.warn('[ytdl] yts metadata fallback failed:', metaErr.message);
            // Gunakan data dari SaveTube sebagai fallback
            thumbnail = videoData.thumbnail || null;
            duration = videoData.durationLabel || videoData.duration || 'Unknown';
        }

        return {
            buffer,
            mime: type === 'audio' ? 'audio/mpeg' : 'video/mp4',
            title: videoData.title || videoId,
            views: views ?? videoData.views ?? 0,
            duration: duration || 'Unknown',
            thumbnail: thumbnail || null,
            channel: channel || videoData.author?.name || 'Unknown'
        };
        
    } catch (error) {
        throw new Error(`YouTube download error: ${error.message}`);
    }
}

export default ytdl;