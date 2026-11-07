import { join } from 'path'
import http2 from 'http2'
import { execFile } from 'child_process'
import { promisify } from 'util'
import axios from 'hiro/axios'
import fs from 'fs'
import path from 'path'
import { getTmpDir } from '../../utils/helper.js'

const execFileAsync = promisify(execFile)
const ffmpegPath = '/usr/bin/ffmpeg'

const pinterestTmpDir = getTmpDir();

export async function gifToMp4(fileUrl) {
    const tmpDir = pinterestTmpDir;

    try {
        const oldFiles = fs.readdirSync(tmpDir).filter(f => f.startsWith('tmp_'));
        for (const f of oldFiles) {
            try { fs.unlinkSync(path.join(tmpDir, f)); } catch {}
        }
    } catch {}

    const ts = Date.now();
    const tmpInput = path.join(tmpDir, `tmp_in_${ts}.gif`);
    const tmpOutput = path.join(tmpDir, `tmp_out_${ts}.mp4`);

    const response = await axios.get(fileUrl, {
        responseType: 'arraybuffer',
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/136.0.0.0',
        }
    });

    fs.writeFileSync(tmpInput, response.data);

    if (!fs.existsSync(tmpInput) || fs.statSync(tmpInput).size === 0) {
        throw new Error('Download failed, input file is empty');
    }

    try {
        await execFileAsync(ffmpegPath, [
            '-y',
            '-i', tmpInput,
            '-movflags', 'faststart',
            '-pix_fmt', 'yuv420p',
            '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-f', 'mp4',
            tmpOutput
        ]);
    } catch (err) {
        throw new Error(`ffmpeg error: ${err.message}`);
    }

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
        throw new Error('Conversion failed, output file is empty or not found');
    }

    return tmpOutput;
}

export const pinterest = {
  api: {
    base: "https://www.pinterest.com",
    endpoints: {
      search: "/resource/BaseSearchResource/get/",
      pin: "/resource/PinResource/get/",
      user: "/resource/UserResource/get/"
    }
  },

  headers: {
    'accept': 'application/json, text/javascript, */*, q=0.01',
    'referer': 'https://id.pinterest.com/',
    'user-agent': 'Postify/1.0.0',
    'x-app-version': 'a9522f',
    'x-pinterest-appstate': 'active',
    'x-pinterest-pws-handler': 'www/[username]/[slug].js',
    'x-pinterest-source-url': '/search/pins/?rs=typed&q=search/',
    'x-requested-with': 'XMLHttpRequest'
  },

  isUrl: (str) => {
    try {
      new URL(str);
      return true;
    } catch (_) {
      return false;
    }
  },

  isPin: (url) => {
    if (!url) return false;
    const patterns = [
      /^https?:\/\/(?:www\.)?pinterest\.com\/pin\/[\w.-]+/,
      /^https?:\/\/(?:www\.)?pinterest\.[\w.]+\/pin\/[\w.-]+/,
      /^https?:\/\/pin\.it\/[\w.-]+/,
      /^https?:\/\/(?:www\.)?pinterest\.com\/amp\/pin\/[\w.-]+/
    ];

    const clean = url.trim().toLowerCase();
    return patterns.some(pattern => pattern.test(clean));
  },

  getCookies: async () => {
    try {
      const response = await axios.get('https://id.pinterest.com');
      const setHeaders = response.headers['set-cookie'];
      if (setHeaders) {
        const cookies = setHeaders.map(cookieString => {
          const cp = cookieString.split(';');
          const cv = cp[0].trim();
          return cv;
        });
        return cookies.join('; ');
      }
      return null;
    } catch (error) {
      return null;
    }
  },

  search: async (query, limit = 10) => {
    if (!query) {
      return {
        status: false,
        code: 400,
        result: {
          message: "Please provide a search query."
        }
      };
    }

    try {
      const cookies = await pinterest.getCookies();
      if (!cookies) {
        return {
          status: false,
          code: 400,
          result: {
            message: "Failed to retrieve cookies. Please try again later."
          }
        };
      }

      const params = {
        source_url: `/search/pins/?q=${query}`,
        data: JSON.stringify({
          options: {
            isPrefetch: false,
            query: query,
            scope: "pins",
            bookmarks: [""],
            no_fetch_context_on_resource: false,
            page_size: limit
          },
          context: {}
        }),
        _: Date.now()
      };

      const { data } = await axios.get(`${pinterest.api.base}${pinterest.api.endpoints.search}`, {
        headers: { ...pinterest.headers, 'cookie': cookies },
        params: params
      });

      const container = [];
      const results = data.resource_response.data.results.filter((v) => v.images?.orig);

      results.forEach((result) => {
        container.push({
          id: result.id,
          title: result.title || "",
          description: result.description || "",
          pin_url: `https://pinterest.com/pin/${result.id}`,
          media: {
            images: {
              orig: result.images.orig,
              small: result.images['236x'],
              medium: result.images['474x'],
              large: result.images['736x']
            },
            video: result.videos ? {
              video_list: result.videos.video_list,
              duration: result.videos.duration
            } : null
          },
          uploader: {
            username: result.pinner.username,
            full_name: result.pinner.full_name,
            profile_url: `https://pinterest.com/${result.pinner.username}`
          }
        });
      });

      if (container.length === 0) {
        return {
          status: false,
          code: 404,
          result: {
            message: `No results found for "${query}". Try another search term.`
          }
        };
      }

      return {
        status: true,
        code: 200,
        result: {
          query: query,
          total: container.length,
          pins: container
        }
      };

    } catch (error) {
      return {
        status: false,
        code: error.response?.status || 500,
        result: {
          message: "Server error. Please try again later."
        }
      };
    }
  },

  download: async (pinUrl) => {
    if (!pinUrl) {
      return {
        status: false,
        code: 400,
        result: {
          message: "Please provide a Pinterest URL."
        }
      };
    }

    if (!pinterest.isUrl(pinUrl)) {
      return {
        status: false,
        code: 400,
        result: {
          message: "Invalid URL format."
        }
      };
    }

    if (!pinterest.isPin(pinUrl)) {
      return {
        status: false,
        code: 400,
        result: {
          message: "This is not a valid Pinterest link."
        }
      };
    }

    try {
      const pinId = pinUrl.split('/pin/')[1].replace('/', '');
      const cookies = await pinterest.getCookies();

      if (!cookies) {
        return {
          status: false,
          code: 400,
          result: {
            message: "Failed to retrieve cookies. Please try again later."
          }
        };
      }

      const params = {
        source_url: `/pin/${pinId}/`,
        data: JSON.stringify({
          options: {
            field_set_key: "detailed",
            id: pinId,
          },
          context: {}
        }),
        _: Date.now()
      };

      const { data } = await axios.get(`${pinterest.api.base}${pinterest.api.endpoints.pin}`, {
        headers: { ...pinterest.headers, 'cookie': cookies },
        params: params
      });

      if (!data.resource_response.data) {
        return {
          status: false,
          code: 404,
          result: {
            message: "Pin not found. It may have been deleted or is no longer available."
          }
        };
      }

      const pd = data.resource_response.data;
      const mediaUrls = [];

      if (pd.videos) {
        const videoFormats = Object.values(pd.videos.video_list)
          .sort((a, b) => b.width - a.width);

        videoFormats.forEach(video => {
          mediaUrls.push({
            type: 'video',
            quality: `${video.width}x${video.height}`,
            width: video.width,
            height: video.height,
            duration: pd.videos.duration || null,
            url: video.url,
            file_size: video.file_size || null,
            thumbnail: pd.images.orig.url
          });
        });
      }

      if (pd.images) {
        const imge = {
          'original': pd.images.orig,
          'large': pd.images['736x'],
          'medium': pd.images['474x'],
          'small': pd.images['236x']
        };

        Object.entries(imge).forEach(([quality, image]) => {
          if (image) {
            mediaUrls.push({
              type: 'image',
              quality: quality,
              width: image.width,
              height: image.height,
              url: image.url,
              size: `${image.width}x${image.height}`
            });
          }
        });
      }

      if (mediaUrls.length === 0) {
        return {
          status: false,
          code: 404,
          result: {
            message: "No media found in this pin."
          }
        };
      }

      return {
        status: true,
        code: 200,
        result: {
          id: pd.id,
          title: pd.title || pd.grid_title || "",
          description: pd.description || "",
          media_urls: mediaUrls,
          uploader: {
            id: pd.pinner?.id || null,
            username: pd.pinner?.username || null,
            full_name: pd.pinner?.full_name || null
          },
          statistics: {
            saves: pd.repin_count || 0,
            comments: pd.comment_count || 0
          }
        }
      };

    } catch (error) {
      if (error.response?.status === 404) {
        return {
          status: false,
          code: 404,
          result: {
            message: "Pin not found."
          }
        };
      }

      return {
        status: false,
        code: error.response?.status || 500,
        result: {
          message: "Server error. Please try again later."
        }
      };
    }
  }
}

export const hlsHeaders = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  referer: 'https://id.pinterest.com/',
  origin: 'https://id.pinterest.com/'
}

export async function getPinterestHLS(m3u8Url) {
  try {
    const { data } = await axios.get(m3u8Url, {
      headers: { 'User-Agent': 'Mozilla/5.0', referer: 'https://id.pinterest.com/' }
    })
    const base = m3u8Url.substring(0, m3u8Url.lastIndexOf('/') + 1)
    const audioMatch = data.match(/URI="([^"]+)"/)
    const audio = audioMatch
      ? audioMatch[1].startsWith('http') ? audioMatch[1] : base + audioMatch[1]
      : null
    const regex = /RESOLUTION=(\d+x\d+).*?\n(.*?\.m3u8)/g
    let match
    const qualities = []
    while ((match = regex.exec(data)) !== null) {
      qualities.push({
        resolution: match[1],
        url: match[2].startsWith('http') ? match[2] : base + match[2]
      })
    }
    qualities.sort((a, b) => parseInt(a.resolution) - parseInt(b.resolution))
    return { audio, qualities }
  } catch (e) {
    return null
  }
}

export function formatNumber(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

export async function mergeVideoAudio(videoUrl, audioUrl, output = '/tmp/pin_output.mp4') {
  const headerArg = `referer: ${hlsHeaders.referer}\r\norigin: ${hlsHeaders.origin}\r\n`

  const args = ['-y']

  args.push('-user_agent', hlsHeaders['User-Agent'], '-headers', headerArg, '-i', videoUrl)

  if (audioUrl) {
    args.push('-user_agent', hlsHeaders['User-Agent'], '-headers', headerArg, '-i', audioUrl)
  }

  args.push('-c:v', 'copy', '-c:a', 'aac', '-shortest', output)

  await execFileAsync(ffmpegPath, args)
  return output
}

export function isPinterestUrl(str) {
  return /pinterest\.(com|co\.\w+)\/pin\/|pin\.it\//i.test(str)
}

export function detectMode(args) {
  const modeMap = {
    vid: 'video', video: 'video',
    gif: 'gif', gifs: 'gif',
    img: 'image', image: 'image', images: 'image'
  }
  const first = args[0]?.toLowerCase()
  return modeMap[first] || 'all'
}

function pickPreviewUrl(pin) {
  const imgs = pin.media?.images || {}
  const order = ['medium', 'large', 'small', 'orig']
  for (const k of order) {
    const u = imgs[k]?.url
    if (u && !u.toLowerCase().endsWith('.gif')) return u
  }
  return imgs.orig?.url || null
}

export function extractMediaFromPin(pin) {
  const mediaUrls = []

  if (pin.embed?.type === 'gif') {
    mediaUrls.push({
      type: 'gif',
      url: pin.embed?.src || pin.embed?.url || null,
      thumbnailUrl: pickPreviewUrl(pin),
      isGif: true
    })
    return mediaUrls
  }

  if (pin.media?.images?.orig?.url?.toLowerCase().endsWith('.gif')) {
    mediaUrls.push({
      type: 'gif',
      url: pin.media.images.orig.url,
      thumbnailUrl: pin.media.images.orig.url,
      isGif: true
    })
    return mediaUrls
  }

  const imageVariants = ['orig', '736x', '474x', '236x'];
  for (const variant of imageVariants) {
    if (pin.media?.images?.[variant]?.url?.toLowerCase().endsWith('.gif')) {
      mediaUrls.push({
        type: 'gif',
        url: pin.media.images[variant].url,
        thumbnailUrl: pin.media.images[variant].url,
        isGif: true
      })
      return mediaUrls
    }
  }

  if (pin.media?.video?.video_list) {
    const videoFormats = Object.values(pin.media.video.video_list)
      .sort((a, b) => b.width - a.width)

    videoFormats.forEach(video => {
      mediaUrls.push({
        type: 'video',
        url: video.url,
        thumbnailUrl: pickPreviewUrl(pin),
        isGif: false
      })
    })
    return mediaUrls
  }

  if (pin.media?.images?.orig) {
    const imageUrl = pin.media.images.orig.url || pin.media.images.large?.url || pin.media.images.medium?.url;
    if (imageUrl && !imageUrl.toLowerCase().endsWith('.gif')) {
      mediaUrls.push({
        type: 'image',
        url: imageUrl,
        thumbnailUrl: pickPreviewUrl(pin) || pin.media.images.orig.url,
        isGif: false
      })
    }
  }

  return mediaUrls.length > 0 ? mediaUrls : null
}

const previewUa = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const previewConcurrency = 30

const isGifUrl = (u) => /\.gif(\?|$)/i.test(u || '')

function createFetcher() {
  const sessions = new Map()
  let h2Broken = false

  const getSession = (origin) => {
    let session = sessions.get(origin)
    if (session && !session.closed && !session.destroyed) return session
    session = http2.connect(origin)
    session.on('error', () => sessions.delete(origin))
    session.on('close', () => sessions.delete(origin))
    sessions.set(origin, session)
    return session
  }

  const headers = { 'user-agent': previewUa, 'accept': 'image/*,*/*', 'referer': 'https://id.pinterest.com/' }

  const viaHttp2 = (url) => new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = getSession(u.origin).request({ ':path': u.pathname + u.search, ...headers })
    const chunks = []
    let status = 0
    let type = ''
    const timer = setTimeout(() => {
      req.close(http2.constants.NGHTTP2_CANCEL)
      reject(new Error('timeout'))
    }, 10000)
    req.on('response', (h) => {
      status = h[':status']
      type = h['content-type'] || ''
    })
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      clearTimeout(timer)
      if (status === 200) return resolve({ data: Buffer.concat(chunks), type })
      reject(Object.assign(new Error(`HTTP ${status}`), { response: { status } }))
    })
    req.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    req.end()
  })

  const viaAxios = async (url) => {
    const res = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': previewUa, referer: 'https://id.pinterest.com/' }
    })
    return { data: res.data, type: res.headers?.['content-type'] || '' }
  }

  return {
    async get(url) {
      if (!h2Broken) {
        try {
          return await viaHttp2(url)
        } catch (e) {
          if (e.response?.status >= 400) throw e
          h2Broken = true
        }
      }
      return viaAxios(url)
    },
    close() {
      for (const session of sessions.values()) session.close()
      sessions.clear()
    }
  }
}

async function fetchToFile(url, file, fetcher) {
  const res = await fetcher.get(url)
  if (!res.data?.length) throw new Error('empty response')
  fs.writeFileSync(file, res.data)
  return String(res.type || '').split(';')[0].trim()
}

async function firstFrame(input, output) {
  const args = ['-y']
  if (/^https?:\/\//i.test(input)) {
    args.push('-user_agent', previewUa, '-headers', 'referer: https://id.pinterest.com/\r\norigin: https://id.pinterest.com/\r\n')
  }
  args.push('-i', input, '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '5', output)
  await execFileAsync(ffmpegPath, args, { timeout: 30000 })
  if (!fs.existsSync(output) || fs.statSync(output).size === 0) throw new Error('empty frame')
}

const smallThumb = (u) => /i\.pinimg\.com\/(474x|736x|originals|orig)\//i.test(u)
  ? u.replace(/i\.pinimg\.com\/(474x|736x|originals|orig)\//i, 'i.pinimg.com/236x/')
  : u

async function savePreview(item, dir, idx, fetcher) {
  const out = join(dir, `pin_${idx}.jpg`)

  const still = item.thumbUrl && !isGifUrl(item.thumbUrl) ? item.thumbUrl
    : (item.type === 'image' && !isGifUrl(item.rawUrl) ? item.rawUrl : null)

  if (still) {
    const small = smallThumb(still)
    try {
      await fetchToFile(small, out, fetcher)
    } catch (e) {
      if (small === still) throw e
      await fetchToFile(still, out, fetcher)
    }
    return out
  }

  if (item.type === 'gif') {
    const guess = smallThumb(item.thumbUrl || item.rawUrl).replace(/\.gif(\?.*)?$/i, '.jpg')
    try {
      const type = await fetchToFile(guess, out, fetcher)
      if (/^image\/jpe?g$/i.test(type)) return out
    } catch {}
  }

  if (item.type === 'gif' || item.type === 'video') {
    await firstFrame(item.rawUrl, out)
    return out
  }

  throw new Error('no preview source')
}

async function downloadPreviews(items, dir) {
  const fetcher = createFetcher()
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const i = cursor++
      try {
        items[i].localPath = await savePreview(items[i], dir, i, fetcher)
      } catch {
        items[i].localPath = null
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.min(previewConcurrency, items.length) }, worker))
  } finally {
    fetcher.close()
  }
}

export { downloadPreviews }
