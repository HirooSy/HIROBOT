import axios from 'hiro/axios';
import * as cheerio from 'hiro/cheerio';

const ua = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const base = 'https://rapidsave.com'

function abs(href) {
  if (!href) return null
  if (href.startsWith('http')) return href
  return base + (href.startsWith('/') ? '' : '/') + href
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
      headers: { 'User-Agent': ua },
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
      headers: { 'User-Agent': ua },
      timeout: 15000
    })
    await axios.post(`${base}/save-cache.php`,
      { postId, jsonData: data },
      {
        headers: {
          'User-Agent': ua,
          'Content-Type': 'application/json',
          Referer: base + '/',
          Origin: base,
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
      'User-Agent': ua,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      Referer: base + '/'
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

  const pageUrl = `${base}/info?url=${encodeURIComponent(redditUrl)}`

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

export { ua, base, scrapeRapidSave, downloadMedia }
async function downloadMedia(url) {
    return (await axios.get(url, {
        responseType: 'arraybuffer',
        headers: { 'User-Agent': ua, Referer: base + '/' },
        timeout: 60000
    })).data
}
