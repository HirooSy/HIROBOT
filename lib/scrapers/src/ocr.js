const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const onlineOcrPageUrl = 'https://www.onlineocr.net/'
const onlineOcrUploadUrl = 'https://www.onlineocr.net/FileHandler.ashx'
const ocrSpaceUrl = 'https://api.ocr.space/parse/image'
const ocrSpaceApiKey = 'helloworld'
const defaultLanguage = 'ENGLISH'
const defaultViewStateGenerator = 'CA0B0334'

const viewStatePattern = /id="__VIEWSTATE"\s+value="([^"]+)"/
const viewStateGeneratorPattern = /id="__VIEWSTATEGENERATOR"\s+value="([^"]+)"/
const eventValidationPattern = /id="__EVENTVALIDATION"\s+value="([^"]+)"/
const resultTextPattern = /txtOCRResultText[^>]*>([\s\S]*?)<\/textarea>/i

function getRandomIp() {
    return `${Math.floor(Math.random() * 200) + 20}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`
}

function firstGroup(text, pattern) {
    const match = text.match(pattern)
    return match ? match[1] : null
}

function buildHeaders() {
    const ip = getRandomIp()
    return {
        'User-Agent': userAgent,
        'X-Forwarded-For': ip,
        'X-Real-IP': ip,
        'Client-IP': ip
    }
}

function collectCookies(responseHeaders) {
    const setCookies = typeof responseHeaders.getSetCookie === 'function'
        ? responseHeaders.getSetCookie()
        : [responseHeaders.get('set-cookie') || '']
    return setCookies
        .map(cookie => cookie.split(';')[0].trim())
        .filter(pair => pair.includes('='))
        .reduce((cookies, pair) => (cookies ? `${cookies}; ${pair}` : pair), '')
}

function buildImageBlob(imageBuffer) {
    return new Blob([new Uint8Array(imageBuffer)], { type: 'image/png' })
}

async function convertWithOnlineOcr(imageBuffer, filename, language) {
    const headers = buildHeaders()
    const pageRes = await fetch(onlineOcrPageUrl, { headers, signal: AbortSignal.timeout(10000) })
    const cookies = collectCookies(pageRes.headers)
    const html = await pageRes.text()

    const viewState = firstGroup(html, viewStatePattern)
    const viewStateGenerator = firstGroup(html, viewStateGeneratorPattern)
    const eventValidation = firstGroup(html, eventValidationPattern)
    if (!viewState || !eventValidation) return null

    const form = new FormData()
    form.append('files[]', buildImageBlob(imageBuffer), filename)

    const uploadRes = await fetch(onlineOcrUploadUrl, {
        method: 'POST',
        headers: { ...headers, 'Cookie': cookies },
        body: form,
        signal: AbortSignal.timeout(12000)
    })
    const uploadJson = await uploadRes.json().catch(() => null)
    const fileInfo = uploadJson?.files?.[0]
    if (!fileInfo) return null

    const originalName = fileInfo.extra_info?.original_name || fileInfo.name
    const dateStamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14)

    const params = new URLSearchParams()
    params.set('ctl00$ScriptManager1', 'ctl00$MainContent$UpdatePanel1|ctl00$MainContent$btnOCRConvert')
    params.set('__EVENTTARGET', '')
    params.set('__EVENTARGUMENT', '')
    params.set('__VIEWSTATE', viewState)
    params.set('__VIEWSTATEGENERATOR', viewStateGenerator || defaultViewStateGenerator)
    params.set('__EVENTVALIDATION', eventValidation)
    params.set('ctl00$MainContent$comboLanguages', language.toUpperCase())
    params.set('ctl00$MainContent$comboOutput', 'Text Plain (txt)')
    params.set('ctl00$MainContent$hdnFullPath', originalName)
    params.set('ctl00$MainContent$hdnFileName', fileInfo.name)
    params.set('ctl00$MainContent$hdnFileNameEx', dateStamp)
    params.set('__ASYNCPOST', 'true')
    params.set('ctl00$MainContent$btnOCRConvert', 'Convert File')

    const convertRes = await fetch(onlineOcrPageUrl, {
        method: 'POST',
        headers: {
            ...headers,
            'Cookie': cookies,
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-MicrosoftAjax': 'Delta=true',
            'X-Requested-With': 'XMLHttpRequest',
            'Referer': onlineOcrPageUrl,
            'Origin': 'https://www.onlineocr.net'
        },
        body: params.toString(),
        signal: AbortSignal.timeout(15000)
    })

    const deltaText = await convertRes.text()
    const resultText = firstGroup(deltaText, resultTextPattern)
    if (!resultText || !resultText.trim()) return null

    return { text: resultText.trim(), source: 'onlineocr.net', language }
}

async function convertWithOcrSpace(imageBuffer, filename, language) {
    const form = new FormData()
    form.append('file', buildImageBlob(imageBuffer), filename)
    form.append('language', language.toLowerCase().slice(0, 3) === 'ind' ? 'ind' : 'eng')
    form.append('isOverlayRequired', 'false')

    const ocrRes = await fetch(ocrSpaceUrl, {
        method: 'POST',
        headers: { 'apikey': ocrSpaceApiKey },
        body: form,
        signal: AbortSignal.timeout(15000)
    })
    const ocrJson = await ocrRes.json().catch(() => null)
    const parsedText = ocrJson?.ParsedResults?.[0]?.ParsedText
    if (!parsedText || !parsedText.trim()) return null

    return { text: parsedText.trim(), source: 'ocr.space', language }
}

async function attempt(task) {
    try {
        return await task()
    } catch {
        return null
    }
}

export async function onlineOcr(imageBuffer, filename = 'image.png', language = defaultLanguage) {
    if (!imageBuffer) throw new Error('Image buffer is required')

    const resolvedLanguage = typeof language === 'string' && language.trim() ? language.trim() : defaultLanguage

    const onlineResult = await attempt(() => convertWithOnlineOcr(imageBuffer, filename, resolvedLanguage))
    if (onlineResult) return onlineResult

    const spaceResult = await attempt(() => convertWithOcrSpace(imageBuffer, filename, resolvedLanguage))
    if (spaceResult) return spaceResult

    throw new Error('Failed to extract text from image')
}

export default onlineOcr
