import axios from 'axios'

const ENDPOINT = 'https://trw.lat/api/bypass'
const API_KEY = 'TRW_FREE-GAY-15a92945-9b04-4c75-8337-f2a6007281e9'
const FALLBACK_PROXY = 'https://proxy.corsfix.com/?'

function parseResult(result) {
  if (typeof result !== 'string') return String(result)
  const tuple = result.match(/^\(['"](.+?)['"],\s*(True|False)\)$/)
  if (tuple) return tuple[1]
  const quoted = result.match(/^["'](.+?)["']$/)
  if (quoted) return quoted[1]
  return result
}

function isValidUrl(s) {
  try {
    new URL(s)
    return true
  } catch {
    return false
  }
}

async function callBypassApi(url, useProxy) {
  const target = `${ENDPOINT}?apikey=${encodeURIComponent(API_KEY)}&url=${encodeURIComponent(url)}`
  const requestUrl = useProxy ? `${FALLBACK_PROXY}${target}` : target

  return axios.get(requestUrl, {
    timeout: 30000,
    validateStatus: () => true,
    headers: {
      Accept: 'application/json',
      Origin: 'https://bypassunlock.com',
      Referer: 'https://bypassunlock.com/',
    },
  })
}

export async function bypassUnlock(input) {
  try {
    const url = typeof input?.url === 'string' ? input.url.trim() : ''
    if (!url) {
      return {
        Status: false,
        Code: 400,
        Input: input,
        Result: null,
        Error: 'Missing required field: url',
      }
    }

    let res
    try {
      res = await callBypassApi(url, false)
      if (res.status === 0 || res.status >= 500) {
        throw new Error(`upstream returned ${res.status}`)
      }
    } catch (directErr) {
      res = await callBypassApi(url, true)
    }

    const body = res.data
    if (!body || typeof body !== 'object') {
      return {
        Status: false,
        Code: res.status,
        Input: { url },
        Result: null,
        Error: `Unexpected response: ${String(body).slice(0, 200)}`,
      }
    }

    if (!body.success) {
      return {
        Status: false,
        Code: res.status,
        Input: { url },
        Result: null,
        Error: body.message || body.result || 'Bypass failed (unsupported URL or backend error)',
      }
    }

    const clean = parseResult(body.result)
    return {
      Status: true,
      Code: res.status,
      Input: { url },
      Result: {
        OriginalUrl: url,
        BypassedUrl: clean,
        IsValidUrl: isValidUrl(clean),
        Raw: body.result,
      },
    }
  } catch (e) {
    return {
      Status: false,
      Code: e.response?.status ?? 500,
      Input: input,
      Result: null,
      Error: e.message ?? String(e),
    }
  }
}

let handler = async (m, { conn, text, usedPrefix, command }) => {
  const url = (text || '').trim().split(/\s+/)[0] || ''

  if (!url || !isValidUrl(url)) {
    return conn.reply(
      m.chat,
      `*Link Bypass*\n\nRemove ads/wait screens from shortlinks and ad-link services (Linkvertise, LootLabs, Work.ink, Sub2unlock, and 40+ more).\n\n▸ ${usedPrefix + command} <url>`,
      m
    )
  }

  await m.react('⏳')

  try {
    const result = await bypassUnlock({ url })

    if (!result.Status) {
      await m.react('❌')
      throw result.Error
    }

    await conn.reply(
      m.chat,
      `✅ Result: ${result.Result.BypassedUrl}`,
      m
    )
    await m.react('✅')

  } catch (error) {
    await m.react('❌')
    throw `Error: ${error.message || error}`
  }
}

handler.help = ['bypass'].map(v => v + ' <url>')
handler.tags = ['tools']
handler.command = /^(bypass)$/i
handler.limit = true

export default handler