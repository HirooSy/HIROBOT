import axios from 'axios'

const BASE = 'https://www.bing.com'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const POLL_INTERVAL = 3000
const POLL_LIMIT = 40
const DEFAULT_RATIO = '1:1'

const MDL = '10'
const RATIOS = { '1:1': 1, '3:2': 2, '2:3': 3 }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function createSession() {
    const jar = new Map()

    const take = (res) => {
        for (const c of res.headers['set-cookie'] || []) {
            const pair = c.split(';')[0]
            const i = pair.indexOf('=')
            if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1))
        }
    }

    const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ')

    const headers = (extra = {}) => ({
        'User-Agent': UA,
        'Accept-Language': 'en-US,en;q=0.9',
        'Sec-Ch-Ua': '"Chromium";v="137", "Not/A)Brand";v="24"',
        'Sec-Ch-Ua-Mobile': '?1',
        'Sec-Ch-Ua-Platform': '"Android"',
        Cookie: cookie(),
        ...extra
    })

    const request = async (config) => {
        const res = await axios({ timeout: 60000, validateStatus: () => true, maxRedirects: 0, ...config })
        take(res)
        return res
    }

    return { headers, request }
}

function extractImages(data) {
    const ids = new Set(data.match(/OIG\d*\.[A-Za-z0-9_.-]+/g) || [])
    const urls = [...ids].map(x => `https://tse2.mm.bing.net/th/id/${x}?pid=ImgGn`)
    if (urls.length) return urls

    const direct = new Set()
    for (const m of data.matchAll(/https?:\/\/[a-z0-9.-]*\.mm\.bing\.net\/th\/id\/[A-Za-z0-9_.-]+/gi)) direct.add(m[0] + '?pid=ImgGn')
    for (const m of data.matchAll(/https?:\/\/(?:www\.)?bing\.com\/th\/id\/[A-Za-z0-9_.-]+/gi)) direct.add(m[0] + '?pid=ImgGn')
    return [...direct]
}

const textOf = (html) => String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)

export const ASPECT_RATIOS = Object.keys(RATIOS)

export async function generateImage(prompt, { aspectRatio = DEFAULT_RATIO } = {}) {
    if (!prompt || !String(prompt).trim()) throw new Error('Prompt must not be empty.')

    const ratio = RATIOS[aspectRatio] ? aspectRatio : DEFAULT_RATIO
    const ar = RATIOS[ratio]

    const text = String(prompt).trim()
    const q = encodeURIComponent(text)
    const { headers, request } = createSession()

    const warmUrl = `${BASE}/images/create/ai-image-generator?FORM=IRPGEN`
    await request({ method: 'get', url: warmUrl, headers: headers({ Accept: 'text/html,*/*' }) })

    const createUrl = `${BASE}/images/create/ai-image-generator?q=${q}&rt=4&mdl=${MDL}&ar=${ar}&ctype=image&FORM=GENCRE&sm=1`
    const body = new URLSearchParams({ q: text, qs: 'ds', model: 'maiimage26e', aspectRatio: ratio }).toString()
    const created = await request({
        method: 'post',
        url: createUrl,
        data: body,
        headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: warmUrl, Accept: 'text/html,*/*' })
    })

    const location = created.headers.location || ''
    const id = (location.match(/[?&]id=(1-[a-f0-9]+)/) || String(created.data).match(/[?&;]id=(1-[a-f0-9]+)/) || [])[1]
    if (!id) {
        if (created.status === 429) throw new Error('Bing rate limit (429), try again later.')
        if (/captcha|challenge/i.test(`${location} ${String(created.data).slice(0, 2000)}`)) throw new Error('Bing requested a captcha/challenge, change IP or try again later.')
        throw new Error(`Bing did not return a creation id (status ${created.status}).`)
    }

    const pageUrl = `${createUrl}&id=${id}`
    const page = await request({ method: 'get', url: pageUrl, headers: headers({ Accept: 'text/html,*/*', Referer: createUrl }) })
    const html = String(page.data)
    const IG = (html.match(/IG:\s*"([A-F0-9]{32})"/) || html.match(/[?&;]IG=([A-F0-9]{32})/) || [])[1]
    if (!IG) throw new Error(`Bing session token not found (status ${page.status}).`)

    const resultUrl = `${BASE}/images/create/ai-image-generator/async/results/${id}?q=${q}&IG=${IG}&IID=images.as&mmasync=1&sm=1&mdl=${MDL}&ar=${ar}&girftp=1`
    let lastStatus = 0
    let lastBody = ''
    for (let i = 0; i < POLL_LIMIT; i++) {
        await sleep(POLL_INTERVAL)
        const res = await request({ method: 'get', url: resultUrl, headers: headers({ Accept: '*/*', Referer: pageUrl }) })

        if (res.status === 429) throw new Error('Bing rate limit (429), try again later.')
        if (res.status >= 300 && res.status < 400) throw new Error(`Bing redirect while polling (${res.status}) to ${res.headers.location || '?'} — session/cookie rejected.`)
        if (res.status >= 400) throw new Error(`Bing error ${res.status} while polling.`)

        const isJson = typeof res.data === 'object' && res.data !== null
        const data = isJson ? JSON.stringify(res.data) : String(res.data)
        lastStatus = res.status
        lastBody = data.slice(0, 300)
        const urls = extractImages(data)
        if (urls.length) return urls

        if (!isJson && data.length > 100 && /error|blocked|unsafe|warning|dismiss|policy|not allowed|rejected/i.test(data)) {
            throw new Error(`Bing rejected the request: ${textOf(data)}`)
        }
    }

    throw new Error(`Bing image generation timed out (last status ${lastStatus}, last response: ${lastBody}).`)
}
