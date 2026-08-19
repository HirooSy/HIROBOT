import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';

// ============== RANDOM USER-AGENT ==============
export function getRandomUserAgent() {
    const agents = [
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1.1 Safari/605.1.15',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
    ];
    return agents[Math.floor(Math.random() * agents.length)];
}

export function getHeaders() {
    return {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'video/mp4,video/webm,video/ogg,*/*;q=0.9',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer': 'https://animeinweb.com/',
        'Origin': 'https://animeinweb.com',
        'Sec-Ch-Ua': '"Chromium";v="136", "Google Chrome";v="136", "Not-A.Brand";v="99"',
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Platform': '"Windows"',
        'Sec-Fetch-Dest': 'video',
        'Sec-Fetch-Mode': 'cors',
        'Sec-Fetch-Site': 'cross-site',
        'Connection': 'keep-alive',
        'Cache-Control': 'no-cache'
    };
}

// ============== API CLIENT ==============
export const apiClient = axios.create({
    baseURL: 'https://animeinweb.com/api/proxy',
    timeout: 15000,
    headers: {
        'x-proxy-secret': 'animein-secure-proxy-key-123',
        'User-Agent': getRandomUserAgent(),
        'Accept': 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        'Referer': 'https://animeinweb.com/',
        'Origin': 'https://animeinweb.com'
    }
});

// Update headers setiap request
apiClient.interceptors.request.use(config => {
    config.headers['User-Agent'] = getRandomUserAgent();
    return config;
});

// ============== FUNCTIONS ==============
export async function searchAnime(keyword, page = 0) {
    try {
        const { data } = await apiClient.get('/3/2/explore/movie', {
            params: { keyword, page: String(page), sort: 'views' }
        });
        return data?.data?.movie || data?.movie || [];
    } catch (error) {
        console.error('Search error:', error.message);
        return [];
    }
}

export async function getDetail(animeId) {
    try {
        const { data } = await apiClient.get(`/3/2/movie/detail/${animeId}`);
        return data?.data;
    } catch (error) {
        console.error('Get detail error:', error.message);
        return null;
    }
}

export async function getEpisodes(animeId) {
    let allEpisodes = [];
    try {
        // Ambil page pertama dulu untuk tahu apakah perlu lanjut
        const { data } = await apiClient.get(`/3/2/movie/episode/${animeId}`, { params: { page: 0 } });
        const firstPage = data?.data?.episode || [];
        allEpisodes.push(...firstPage);

        if (firstPage.length >= 30) {
            // Fetch beberapa page berikutnya sekaligus secara paralel (batch),
            // bukan satu-satu dengan delay. Batch 5 page per gelombang.
            const BATCH_SIZE = 5;
            let page = 1;
            let keepGoing = true;

            while (keepGoing) {
                const pagesToFetch = Array.from({ length: BATCH_SIZE }, (_, i) => page + i);
                const results = await Promise.all(
                    pagesToFetch.map(p =>
                        apiClient.get(`/3/2/movie/episode/${animeId}`, { params: { page: p } })
                            .then(res => res.data?.data?.episode || [])
                            .catch(() => [])
                    )
                );

                for (const episodes of results) {
                    allEpisodes.push(...episodes);
                    if (episodes.length < 30) keepGoing = false;
                }

                page += BATCH_SIZE;
                // Safety cap agar tidak infinite loop kalau API selalu return 30
                if (page > 500) break;
            }
        }
    } catch (error) {
        console.error('Get episodes error:', error.message);
    }

    // Urutkan dari episode paling lama ke terbaru (episode 1 dulu),
    // karena API mengembalikan urutan terbaru → terlama per page.
    allEpisodes = allEpisodes
        .filter((ep, idx, arr) => arr.findIndex(e => e.id === ep.id) === idx) // dedupe kalau ada overlap antar page
        .sort((a, b) => {
            const numA = parseEpisodeNumber(a);
            const numB = parseEpisodeNumber(b);
            return numA - numB;
        });

    return allEpisodes;
}

// Ekstrak nomor episode dari title (format "Episode 1131") untuk pengurutan yang benar.
// key_time TIDAK dipakai karena isinya tanggal rilis, bukan nomor episode.
function parseEpisodeNumber(ep) {
    const source = ep.title || '';
    // Cari angka yang muncul setelah kata "Episode"/"Ep" jika ada, fallback ke angka pertama
    const withLabel = String(source).match(/(?:episode|ep)\s*(\d+(\.\d+)?)/i);
    if (withLabel) return parseFloat(withLabel[1]);

    const anyNumber = String(source).match(/(\d+(\.\d+)?)/);
    if (anyNumber) return parseFloat(anyNumber[1]);

    return 0;
}

export async function getStream(episodeId) {
    try {
        const { data } = await apiClient.get(`/3/2/episode/streamnew/${episodeId}`);
        return data?.data || data;
    } catch (error) {
        console.error('Get stream error:', error.message);
        return null;
    }
}

export async function getFileSize(url) {
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            // NOTE: animein's CDN returns 403 on HEAD requests. It only accepts
            // GET with a Range header (same as the old ghostfetch client did).
            const response = await axios.get(url, {
                headers: {
                    ...getHeaders(),
                    'Range': 'bytes=0-1'
                },
                responseType: 'arraybuffer',
                timeout: 10000,
                validateStatus: status => status === 206 || status === 200
            });

            const contentRange = response.headers['content-range'];
            if (contentRange) {
                return parseInt(contentRange.split('/')[1]);
            }

            const contentLength = response.headers['content-length'];
            if (contentLength) {
                return parseInt(contentLength);
            }
            return null;

        } catch (error) {
            console.error(`Attempt ${attempt + 1} getFileSize error:`, error.message);
            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
            }
        }
    }
    return null;
}

// Checks free space on the partition holding `dirPath` and throws a clear
// error instead of letting the write stream die mid-download with ENOSPC.
async function assertEnoughDiskSpace(dirPath, neededBytes) {
    if (!neededBytes) return; // size unknown, can't pre-check, let it try
    try {
        const stats = await fs.promises.statfs(dirPath);
        const freeBytes = stats.bavail * stats.bsize;
        const MARGIN = 100 * 1024 * 1024; // keep 100MB headroom
        if (freeBytes < neededBytes + MARGIN) {
            throw new Error(
                `Not enough disk space: need ~${formatSize(neededBytes)}, only ${formatSize(freeBytes)} free`
            );
        }
    } catch (error) {
        if (error.message.startsWith('Not enough disk space')) throw error;
        // statfs unsupported on this platform/fs — skip the pre-check silently
    }
}

export function formatSize(bytes) {
    if (!bytes) return '?';
    if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export async function downloadEpisode(url, outputPath) {
    // Pre-check free space so a huge file doesn't fill the disk mid-write.
    const expectedSize = await getFileSize(url);
    await assertEnoughDiskSpace(path.dirname(outputPath), expectedSize);

    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            // Await the actual download result HERE (inside the try), so that
            // errors happening during the write (e.g. ENOSPC) are caught by
            // this loop instead of escaping past it as an unhandled/uncaught
            // rejection from an already-returned Promise.
            const size = await new Promise((resolve, reject) => {
                axios({
                    method: 'GET',
                    url: url,
                    headers: getHeaders(),
                    responseType: 'stream',
                    timeout: 120000
                }).then(response => {
                    const writer = fs.createWriteStream(outputPath);

                    const cleanup = (err) => {
                        writer.destroy();
                        response.data.destroy();
                        reject(err);
                    };

                    writer.on('finish', () => {
                        const stats = fs.statSync(outputPath);
                        resolve(stats.size);
                    });
                    writer.on('error', cleanup);
                    response.data.on('error', cleanup);
                    response.data.pipe(writer);
                }).catch(reject);
            });

            return size;

        } catch (error) {
            lastError = error;
            console.error(`Attempt ${attempt + 1} download error:`, error.message);

            // Always remove the partial file, on every attempt including the last.
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (e) {}
            }

            // Disk being full won't fix itself on retry — bail out immediately
            // instead of burning two more attempts.
            if (error.code === 'ENOSPC') break;

            if (attempt < 2) {
                await new Promise(resolve => setTimeout(resolve, 2000 * (attempt + 1)));
            }
        }
    }
    throw lastError;
}