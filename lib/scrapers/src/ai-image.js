import axios from 'axios'

const BASE = 'https://www.bing.com'
const UA = 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36'
const POLL_INTERVAL = 3000
const POLL_LIMIT = 40
const DEFAULT_RATIO = '1:1'
const RATIOS = { '1:1': 1, '3:2': 2, '2:3': 3 }

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

function createSession() {
    const jar = new Map()

    const take = (res) => {
        for (const c of res.headers['set-cookie'] || []) {
            const pair = c.split(';')[0]
            const i = pair.indexOf('=')
            if (i > 0) jar.set(pair.slice(0, i), pair.slice(i + 1))
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

    const createUrl = `${BASE}/images/create/ai-image-generator?q=${q}&rt=4&mdl=12&ar=${ar}&FORM=GENCRE&sm=1`
    const body = new URLSearchParams({ q: text, qs: 'ds', model: 'maiimage26e', aspectRatio: ratio }).toString()
    const created = await request({
        method: 'post',
        url: createUrl,
        data: body,
        headers: headers({ 'Content-Type': 'application/x-www-form-urlencoded', Origin: BASE, Referer: warmUrl, Accept: 'text/html,*/*' })
    })

    const location = created.headers.location || ''
    const id = (location.match(/[?&]id=(1-[a-f0-9]+)/) || String(created.data).match(/[?&;]id=(1-[a-f0-9]+)/) || [])[1]
    if (!id) throw new Error(`Bing did not return a creation id (status ${created.status}).`)

    const pageUrl = `${createUrl}&id=${id}`
    const page = await request({ method: 'get', url: pageUrl, headers: headers({ Accept: 'text/html,*/*', Referer: createUrl }) })
    const html = String(page.data)
    const IG = (html.match(/IG:"([A-F0-9]{32})"/) || html.match(/[?&]IG=([A-F0-9]{32})/) || [])[1]
    if (!IG) throw new Error(`Bing session token not found (status ${page.status}).`)

    for (let i = 0; i < POLL_LIMIT; i++) {
        await sleep(POLL_INTERVAL)
        const res = await request({
            method: 'get',
            url: `${BASE}/images/create/ai-image-generator/async/results/${id}?q=${q}&IG=${IG}&IID=images.as&mmasync=1&sm=1&mdl=12&ar=${ar}&girftp=1`,
            headers: headers({ Accept: '*/*', Referer: pageUrl })
        })
        const data = String(res.data)
        const ids = [...new Set(data.match(/OIG\d*\.[A-Za-z0-9_.-]+/g) || [])]
        if (ids.length) return ids.map(x => `https://tse2.mm.bing.net/th/id/${x}?pid=ImgGn`)
        if (data.length > 100) {
            const message = data.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 150)
            throw new Error(`Bing rejected the request: ${message}`)
        }
    }

    throw new Error('Bing image generation timed out.')
}