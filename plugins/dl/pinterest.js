import { webp2mp4 } from '../../lib/scraper/ezgif.js'
import upload from '../../lib/scraper/upload.js'
import { default as ffmpeg } from 'fluent-ffmpeg'
import axios from 'axios'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

// ─── Setup Temporary Directory ─────────────────────────────────────────────
const TMP_DIR = path.join(process.cwd(), process.env.TMP || 'data/tmp');
if (!fs.existsSync(TMP_DIR)) {
    fs.mkdirSync(TMP_DIR, { recursive: true });
}

// ─── GIF to MP4 Converter Function ──────────────────────────────────────
async function gifToMp4(fileUrl) {
    const tmpDir = TMP_DIR;

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
        throw new Error('Download gagal, file input kosong');
    }

    await new Promise((resolve, reject) => {
        ffmpeg(tmpInput)
            .outputOptions([
                '-movflags faststart',
                '-pix_fmt yuv420p',
                '-vf scale=trunc(iw/2)*2:trunc(ih/2)*2',
                '-c:v libx264',
                '-preset fast',
                '-crf 23'
            ])
            .toFormat('mp4')
            .output(tmpOutput)
            .on('end', () => {
                resolve();
            })
            .on('error', (err, stdout, stderr) => {
                reject(new Error(`ffmpeg error: ${err.message}`));
            })
            .run();
    });

    if (fs.existsSync(tmpInput)) fs.unlinkSync(tmpInput);

    if (!fs.existsSync(tmpOutput) || fs.statSync(tmpOutput).size === 0) {
        throw new Error('Konversi gagal, file output kosong atau tidak ditemukan');
    }

    return tmpOutput;
}

// ─── Pinterest API Configuration ───────────────────────────────────────────
const pinterest = {
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
      console.error(error);
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

// ─── Utility Functions ─────────────────────────────────────────────────────
const hlsHeaders = {
  'User-Agent': 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36',
  referer: 'https://id.pinterest.com/',
  origin: 'https://id.pinterest.com/'
}

async function getPinterestHLS(m3u8Url) {
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

function formatNumber(n) {
  if (!n) return '0'
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M'
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K'
  return String(n)
}

async function mergeVideoAudio(videoUrl, audioUrl, output = '/tmp/pin_output.mp4') {
  return new Promise((resolve, reject) => {
    const cmd = ffmpeg()
      .input(videoUrl)
      .inputOptions([
        '-user_agent', hlsHeaders['User-Agent'],
        '-headers', `referer: ${hlsHeaders.referer}\r\norigin: ${hlsHeaders.origin}\r\n`
      ])
    if (audioUrl) {
      cmd.input(audioUrl).inputOptions([
        '-user_agent', hlsHeaders['User-Agent'],
        '-headers', `referer: ${hlsHeaders.referer}\r\norigin: ${hlsHeaders.origin}\r\n`
      ])
    }
    cmd
      .outputOptions(['-c:v copy', '-c:a aac', '-shortest'])
      .on('error', reject)
      .on('end', () => resolve(output))
      .save(output)
  })
}

function isPinterestUrl(str) {
  return /pinterest\.(com|co\.\w+)\/pin\/|pin\.it\//i.test(str)
}

function detectMode(args) {
  const modeMap = {
    vid: 'video', video: 'video',
    gif: 'gif', gifs: 'gif',
    img: 'image', image: 'image', images: 'image'
  }
  const first = args[0]?.toLowerCase()
  return modeMap[first] || 'all'
}

function extractMediaFromPin(pin) {
  const mediaUrls = []

  // Check if it's a GIF from embed
  if (pin.embed?.type === 'gif') {
    mediaUrls.push({
      type: 'gif',
      url: pin.embed?.src || pin.embed?.url || null,
      thumbnailUrl: pin.media?.images?.orig?.url || null,
      isGif: true
    })
    return mediaUrls
  }

  // Check if image URL ends with .gif
  if (pin.media?.images?.orig?.url?.toLowerCase().endsWith('.gif')) {
    mediaUrls.push({
      type: 'gif',
      url: pin.media.images.orig.url,
      thumbnailUrl: pin.media.images.orig.url,
      isGif: true
    })
    return mediaUrls
  }

  // Check for GIF in image variants
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

  // Extract videos
  if (pin.media?.video?.video_list) {
    const videoFormats = Object.values(pin.media.video.video_list)
      .sort((a, b) => b.width - a.width)
    
    videoFormats.forEach(video => {
      mediaUrls.push({
        type: 'video',
        url: video.url,
        thumbnailUrl: pin.media.images?.orig?.url || null,
        isGif: false
      })
    })
    return mediaUrls
  }

  // Extract images (non-GIF)
  if (pin.media?.images?.orig) {
    const imageUrl = pin.media.images.orig.url || pin.media.images.large?.url || pin.media.images.medium?.url;
    if (imageUrl && !imageUrl.toLowerCase().endsWith('.gif')) {
      mediaUrls.push({
        type: 'image',
        url: imageUrl,
        thumbnailUrl: pin.media.images.orig.url,
        isGif: false
      })
    }
  }

  return mediaUrls.length > 0 ? mediaUrls : null
}

// ─── Main Handler ────────────────────────────────────────────────────────────
let handler = async (m, { conn, args }) => {
  if (!args[0]) throw `Usage:\n\n*Download by URL:*\n.pin https://pinterest.com/pin/xxx\n.pin https://pin.it/xxx\n\n*Search:*\n.pin <keyword>\n.pin video <keyword>\n.pin image <keyword>\n.pin gif <keyword>`

  const firstArg = args[0]

  // ─── MODE: Download by URL ───────────────────────────────────────────────
  if (isPinterestUrl(firstArg)) {
    await m.reply('Fetching pin info...')
    
    const downloadResult = await pinterest.download(firstArg)
    if (!downloadResult.status) {
      throw downloadResult.result.message
    }

    const result = downloadResult.result
    const media = result.media_urls[0]
    const title = result.title || ""
    const desc = result.description || ""
    const creator = result.uploader.full_name || result.uploader.username || ""
    const saves = formatNumber(result.statistics.saves || 0)

    const infoText = `Pinterest Pin\n${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}`

    if (media.type === 'gif' || media.url?.toLowerCase().includes('.gif')) {
      try {
        const videoPath = await gifToMp4(media.url)
        await conn.sendFile(m.chat, fs.readFileSync(videoPath), 'converted.mp4', infoText, m)
        fs.unlinkSync(videoPath)
        return
      } catch (error) {
        throw `Failed to convert GIF to video: ${error.message}`
      }
    }

    if (media.type === 'image') {
      await conn.sendFile(m.chat, media.url, 'pinterest.jpg', infoText, m)
      return
    }

    if (media.type === 'video') {
      const hls = await getPinterestHLS(media.url)
      if (!hls || !hls.qualities.length) throw 'Failed to get video quality.'

      const qualityList = hls.qualities.map((q, i) => `${i + 1}. ${q.resolution}`).join('\n')
      const caption = `Pinterest Video\n${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}\n\nChoose Resolution:\n${qualityList}`

      const sent = await conn.reply(m.chat, caption, m)

      if (!global.pinterestDlState) global.pinterestDlState = {}
      global.pinterestDlState[m.sender] = {
        hls,
        title,
        desc,
        creator,
        saves,
        messageId: sent.key.id,
        timestamp: Date.now()
      }
      return
    }
    return
  }

  // ─── MODE: Search ────────────────────────────────────────────────────────
  const modeKeys = ['vid', 'video', 'gif', 'gifs', 'img', 'image', 'images']
  const mode = detectMode(args)
  const queryArgs = modeKeys.includes(args[0]?.toLowerCase()) ? args.slice(1) : args
  const query = queryArgs.join(' ')
  if (!query) throw 'Please enter a search keyword!'

  const modeLabel = { all: 'All', video: 'Video', gif: 'GIF', image: 'Image' }

  const searchResult = await pinterest.search(query, 50)

  if (!searchResult.status) {
    throw `No results found for: *${query}*`
  }

  const pins = searchResult.result.pins

  const filteredPins = pins.filter(pin => {
    const medias = extractMediaFromPin(pin)
    if (!medias) return false
    if (mode === 'all') return true
    if (mode === 'gif') {
      return medias.some(m => m.type === 'gif' || m.isGif === true)
    }
    return medias.some(m => m.type === mode)
  })

  if (!filteredPins.length) throw `No ${mode} results found for: *${query}*`

  const totalResult = filteredPins.length

  // Hanya ambil 3 untuk GIF agar tidak terlalu berat
  const maxResults = mode === 'gif' ? 3 : 10
  
  const shuffled = filteredPins
    .sort(() => Math.random() - 0.5)
    .slice(0, maxResults)

  const imageUrls = []
  const videoUrls = []
  const allSources = []

  for (const pin of shuffled) {
    const medias = extractMediaFromPin(pin)
    if (!medias) continue

    for (const media of medias) {
      // ─── HANDLE GIF ──────────────────────────────────────────────────────
      if (media.type === 'gif' || media.isGif === true) {
        if (mode === 'all' || mode === 'gif') {
          try {
            // Convert GIF to MP4
            const videoPath = await gifToMp4(media.url)
            const videoBuffer = fs.readFileSync(videoPath)
            fs.unlinkSync(videoPath)
            
            // Upload via lib/scraper/upload.js (Discord webhook)
            const uploadedUrl = await upload(videoBuffer, `pinterest_gif_${Date.now()}.mp4`)
            
            if (uploadedUrl) {
              videoUrls.push(uploadedUrl)
            }
          } catch (err) {
            console.error('GIF error:', err)
          }
        }
      } 
      // ─── HANDLE IMAGE ────────────────────────────────────────────────────
      else if (media.type === 'image' && mode !== 'video') {
        imageUrls.push(media.url)
      }
      // ─── HANDLE VIDEO ────────────────────────────────────────────────────
      else if (media.type === 'video' && mode !== 'image') {
        try {
          const hls = await getPinterestHLS(media.url)
          const best = hls?.qualities?.at(-1)
          if (!best) continue
          const output = `/tmp/pin_${Date.now()}.mp4`
          await mergeVideoAudio(best.url, hls.audio, output)
          const videoBuffer = fs.readFileSync(output)
          fs.unlinkSync(output)
          
          const uploadedUrl = await upload(videoBuffer, `pinterest_video_${Date.now()}.mp4`)
          if (uploadedUrl) {
            videoUrls.push(uploadedUrl)
          }
        } catch (err) {
          console.error('Video error:', err)
        }
      }
    }

    allSources.push(['https://www.pinterest.com/favicon.ico', pin.pin_url, pin.title || 'Pinterest'])
  }

  // ─── Kirim dengan AiRich ──────────────────────────────────────────────
  try {
    const rich = conn.aiRich()
      .setTitle("Pinterest Search")
      .addSuggest([
        `Query: ${query}`,
        `Mode: ${modeLabel[mode] || 'All'}`,
        `Result: ${totalResult}`,
        `Showing: ${shuffled.length}`
      ])
      .addSource(allSources)
    
    if (imageUrls.length) rich.addImage(imageUrls)
    if (videoUrls.length) rich.addVideo(videoUrls)
    
    await rich.send(m.chat, { quoted:m })
  } catch (e) {
    console.error('AiRich error:', e)
    
    // Fallback: kirim satu per satu jika AiRich gagal
    if (videoUrls.length > 0) {
      for (const url of videoUrls) {
        try {
          const response = await axios.get(url, { responseType: 'arraybuffer' })
          await conn.sendFile(m.chat, Buffer.from(response.data), 'video.mp4', '🎬 Pinterest GIF', m)
        } catch (err) {
          console.error('Fallback send error:', err)
        }
      }
    }
    throw e.message
  }
}

// ─── Quality Selection Handler ────────────────────────────────────────────
handler.before = async (m, { conn }) => {
  // Fix: Aman dari quoted message yang undefined/null
  if (!m.quoted || !m.quoted.id) return
  const state = global.pinterestDlState?.[m.sender]
  if (!state || Date.now() - state.timestamp > 300000) return
  
  // Validasi ID pesan yang di-reply
  if (state.messageId !== m.quoted.id) return

  const choice = parseInt(m.text)
  if (isNaN(choice) || choice < 1 || choice > state.hls.qualities.length) return

  try {
    const { hls, title, desc, creator, saves } = state
    const selected = hls.qualities[choice - 1]

    const infoText = `Pinterest Video\n${title ? `- Title: ${title}\n` : ''}${desc ? `- Description: ${desc}\n` : ''}- Creator: ${creator}\n- Saves: ${saves}\n- Resolution: ${selected.resolution}`

    await m.reply(`Downloading resolution ${selected.resolution}...`)
    const output = `/tmp/pin_${Date.now()}.mp4`
    await mergeVideoAudio(selected.url, hls.audio, output)

    await conn.sendFile(m.chat, fs.readFileSync(output), 'pinterest.mp4', infoText, m)
    fs.unlinkSync(output)
    await m.reply('Video downloaded successfully!')
  } catch (err) {
    await m.reply(`Failed: ${err.message || err}`)
  }

  delete global.pinterestDlState[m.sender]
  return true
}

handler.help = ['pinterest'].map(v => v + ' <url|keyword>')
handler.tags = ['downloader']
handler.command = /^(pint(erest)?)$/i
handler.limit = true

export default handler
