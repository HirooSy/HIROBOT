import axios from 'hiro/axios'
import * as cheerio from 'hiro/cheerio'

function toThreadsUrl(input) {
  const value = String(input || '').trim()
  let parsed
  try {
    parsed = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error('Invalid URL')
  }
  if (!/(^|\.)threads\.(net|com)$/i.test(parsed.hostname)) throw new Error('Not a Threads URL')
  parsed.hostname = 'www.threads.net'
  parsed.search = ''
  parsed.hash = ''
  return parsed.href
}

function getThreadId(url) {
  return new URL(url).pathname.split('/').filter(Boolean).pop()
}

function findPostObject(obj, code) {
  if (!obj || typeof obj !== 'object') return null
  if (obj.code === code) return obj
  for (const value of Object.values(obj)) {
    const found = findPostObject(value, code)
    if (found) return found
  }
  return null
}

function durationFromUrl(videoUrl) {
  try {
    const efg = new URL(videoUrl).searchParams.get('efg')
    const data = efg ? JSON.parse(Buffer.from(efg, 'base64').toString('utf-8')) : null
    return data?.duration_s ? `${Math.round(data.duration_s)}s` : null
  } catch {
    return null
  }
}

function cleanUrl(url) {
  return url.replace(/\\/g, '').replace(/&amp;/g, '&')
}

function parseMedia(obj, list = [], seen = new Set()) {
  if (!obj || typeof obj !== 'object') return list
  if (Array.isArray(obj)) {
    for (const item of obj) parseMedia(item, list, seen)
    return list
  }

  const candidates = obj.image_versions2?.candidates
  if (Array.isArray(obj.video_versions)) {
    const best = obj.video_versions[0]
    if (best?.url) {
      const url = cleanUrl(best.url)
      if (!seen.has(url)) {
        seen.add(url)
        const seconds = obj.video_duration || obj.duration
        list.push({
          type: 'video',
          width: obj.original_width || null,
          height: obj.original_height || null,
          resolution: obj.original_width && obj.original_height ? `${obj.original_width}x${obj.original_height}` : 'Best Quality',
          duration: seconds ? `${Math.round(seconds)}s` : durationFromUrl(url),
          url
        })
      }
    }
  } else if (!obj.video_versions && Array.isArray(candidates)) {
    const best = candidates[0]
    if (best?.url) {
      const url = cleanUrl(best.url)
      if (!seen.has(url)) {
        seen.add(url)
        list.push({
          type: 'image',
          width: obj.original_width || best.width || null,
          height: obj.original_height || best.height || null,
          resolution: obj.original_width && obj.original_height ? `${obj.original_width}x${obj.original_height}` : (best.width && best.height ? `${best.width}x${best.height}` : 'Best Quality'),
          url
        })
      }
    }
  }

  for (const key of Object.keys(obj)) {
    if (!['video_versions', 'image_versions2', 'image_versions'].includes(key)) parseMedia(obj[key], list, seen)
  }
  return list
}

function jsonScripts(html) {
  const $ = cheerio.load(html)
  const list = []
  $('script[type="application/json"]').each((i, el) => {
    try {
      const text = $(el).text().trim()
      if (text) list.push(JSON.parse(text))
    } catch {}
  })
  return list
}

export async function get(input) {
  const url = toThreadsUrl(input)
  const code = getThreadId(url)

  const res = await axios.get(url, {
    headers: {
      'User-Agent': 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_voiced.html)',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.5'
    }
  })

  const scripts = jsonScripts(res.data)
  let post = null
  for (const json of scripts) {
    post = findPostObject(json, code)
    if (post) break
  }

  const medias = []
  const seen = new Set()
  if (post) {
    parseMedia(post, medias, seen)
  } else {
    for (const json of scripts) parseMedia(json, medias, seen)
  }

  if (!medias.length) throw new Error('No video or image URLs found for this post.')
  return { code, url, medias }
}
