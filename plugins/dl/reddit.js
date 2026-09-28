import axios from 'axios';
import * as cheerio from 'cheerio';
import * as fs from 'fs';

const { gifToMp4, fixVideoMetadata } = global.scraper.x;

const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const BASE = 'https://rapidsave.com'

let handler = async (m, { conn, text }) => {
  if (!text) return m.reply(`Where's the URL?`)
  if (!/reddit\.com|redd\.it/i.test(text)) return m.reply(`Invalid Reddit Url!`)

  await m.react('⬇️')

  try {
    const data = await scrapeRapidSave(text.trim())

    if (!data || !data.download) {
      return m.reply('Failed to fetch data. Link may be private or incorrect.')
    }

    const getBuf = async (u) =>
      (await axios.get(u, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': UA, Referer: BASE + '/' },
        timeout: 60000
      })).data

    if (data.type === 'image') {
      return conn.sendMessage(m.chat, {
        image: await getBuf(data.download.image),
        caption: data.title || ''
      }, { quoted: m })
    }

    if (data.type === 'gif') {
      const tmpPath = await gifToMp4(data.download.gif)
      try {
        return await conn.sendMessage(m.chat, {
          video: fs.readFileSync(tmpPath),
          gifPlayback: true,
          caption: data.title || ''
        }, { quoted: m })
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      }
    }

    if (data.type === 'video') {
      const tmpPath = await fixVideoMetadata(data.download.video)
      try {
        await conn.sendMessage(m.chat, {
          video: fs.readFileSync(tmpPath),
          caption: data.title || ''
        }, { quoted: m })
      } finally {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath)
      }

      if (data.download.audio) {
        await conn.sendMessage(m.chat, {
          audio: await getBuf(data.download.audio),
          mimetype: 'audio/mp4',
          fileName: 'audio.mp4'
        }, { quoted: m })
      }
    }
  } catch (e) {
    console.error(e)
    return m.reply('Error: ' + (e.message || 'Unknown error'))
  }
}

handler.help = ['reddit', 'redditdl']
handler.command = /^(reddit|redditdl)$/i
handler.tags = ['downloader']
handler.limit = true
handler.ai = { risk: 'low', description: 'download reddit post' }

export default handler

function abs(href) {
  if (!href) return null
  if (href.startsWith('http')) return href
  return BASE + (href.startsWith('/') ? '' : '/') + href
}

function decodeDLink(href) {
  try {
    const m = href.match(/\/d\/([^?#]+)/)
    if (!m) return null
    const url = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('utf8')
    return /^https?:\/\//.test(url) ? url : null
  } catch {
    return null
  }
}

function realUrl(href) {
  if (!href) return null
  if (/^https?:\/\//i.test(href)) return href
  const d = decodeDLink(href)
  return d || abs(href)
}

async function resolveUrl(redditUrl) {
  if (/i\.redd\.it/i.test(redditUrl)) return redditUrl
  if (!/redd\.it|\/s\/[A-Za-z0-9]+/i.test(redditUrl)) return redditUrl
  try {
    const res = await axios.get(redditUrl, {
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400,
      headers: { 'User-Agent': UA },
      timeout: 15000
    })
    const final = res.request?.res?.responseUrl || res.request?.responseURL
    return final && /comments\//.test(final) ? final : redditUrl
  } catch (e) {
    const loc = e.response?.headers?.location
    return loc || redditUrl
  }
}

async function primeCache(postId, cookieJar) {
  try {
    const { data } = await axios.get(`https://api.reddit.com/api/info.json?id=t3_${postId}`, {
      headers: { 'User-Agent': UA },
      timeout: 15000
    })
    await axios.post(`${BASE}/save-cache.php`,
      { postId, jsonData: data },
      {
        headers: {
          'User-Agent': UA,
          'Content-Type': 'application/json',
          Referer: BASE + '/',
          Origin: BASE,
          ...(cookieJar ? { Cookie: cookieJar } : {})
        },
        timeout: 15000
      })
    return true
  } catch {
    return false
  }
}

async function fetchPage(url) {
  const res = await axios.get(url, {
    headers: {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: BASE + '/'
    },
    timeout: 20000
  })
  const cookie = (res.headers['set-cookie'] || []).map(c => c.split(';')[0]).join('; ')
  return { html: res.data, cookie }
}

function parse(html) {
  const $ = cheerio.load(html)

  const title = $('h2.text-center').first().text().trim()
  const noAudio = /no audio\/sound/i.test($('center').text())

  let videoHD = null, audioOnly = null, gif = null, image = null

  $('a.downloadbutton').each((_, el) => {
    const href = $(el).attr('href') || ''
    const label = $(el).text().trim().toLowerCase()
    const real = realUrl(href)
    if (!real) return

    if (/video_url/.test(href) || /\.mp4(\?|$)/i.test(real) || label.includes('video') || label.includes('hd')) {
      if (!videoHD) videoHD = abs(href)
    } else if (label.includes('audio') || /audio/i.test(href)) {
      if (!audioOnly) audioOnly = abs(href)
    } else if (/\.gif(\?|$)/i.test(real) || label.includes('gif')) {
      if (!gif) gif = real
    } else if (/\.(jpe?g|png|webp)(\?|$)/i.test(real) || label.includes('image')) {
      if (!image) image = real
    } else if (!image) {
      image = real
    }
  })

  return { title, noAudio, videoHD, audioOnly, gif, image }
}

async function scrapeRapidSave(redditUrl) {
  redditUrl = await resolveUrl(redditUrl)

  const idMatch = redditUrl.match(/comments\/([a-z0-9]+)/i)
  const postId = idMatch ? idMatch[1] : null

  const pageUrl = `${BASE}/info?url=${encodeURIComponent(redditUrl)}`

  let { html, cookie } = await fetchPage(pageUrl)
  let r = parse(html)

  if (!r.videoHD && !r.gif && !r.image && postId) {
    await primeCache(postId, cookie)
    ;({ html } = await fetchPage(pageUrl))
    r = parse(html)
  }

  if (r.videoHD) {
    return { type: 'video', title: r.title, download: { video: r.videoHD, audio: r.noAudio ? null : r.audioOnly } }
  }
  if (r.gif) return { type: 'gif', title: r.title, download: { gif: r.gif } }
  if (r.image) return { type: 'image', title: r.title, download: { image: r.image } }

  throw new Error('No download link found. Post might be removed or private.')
}