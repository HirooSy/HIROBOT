import axios from 'hiro/axios'
import * as cheerio from 'hiro/cheerio'

const phHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': 'https://www.pornhub.com',
    'Cookie': 'accessAgeDisclaimerPH=2; accessPH=1; cookieConsent=1; platform=pc'
}

function extractViewkey(url) {
    return (url.match(/[?&]viewkey=([a-zA-Z0-9]+)/) || url.match(/\/video\/([a-zA-Z0-9]+)/))?.[1] ?? null
}

async function scrapePornhub(url) {
    const viewkey = extractViewkey(url)
    if (!viewkey) throw new Error('Could not extract viewkey from URL.')

    const res = await axios.get(`https://www.pornhub.com/view_video.php?viewkey=${viewkey}`, {
        headers: phHeaders, timeout: 20000
    })
    const $ = cheerio.load(res.data)

    const title = $('title').text().replace(/\s*[-–]\s*Pornhub\.com\s*$/i, '').trim()
        || $('meta[property="og:title"]').attr('content')?.trim()
        || 'Unknown Title'
    const thumbnail = $('meta[property="og:image"]').attr('content') || null
    const uploader = $('.usernameBadgesWrapper a').first().text().trim()
        || $('a.bolded').first().text().trim()
        || 'Unknown'

    let flashvars = null
    $('script').each(function () {
        if (flashvars) return
        const raw = $(this).html() || ''
        if (!raw.includes('mediaDefinitions')) return
        const m = raw.match(/var\s+flashvars_\d+\s*=\s*(\{[\s\S]*?\})\s*;/)
        if (!m) return
        try { flashvars = JSON.parse(m[1]) } catch {
            try {
                const start = raw.indexOf('{', raw.indexOf('flashvars_'))
                const end = raw.lastIndexOf('}', raw.indexOf(';\n', start)) + 1
                flashvars = JSON.parse(raw.slice(start, end))
            } catch {}
        }
    })

    if (!flashvars) throw new Error('Could not locate flashvars. Video may be age-gated or premium-only.')

    const videoUrls = []
    for (const def of (flashvars.mediaDefinitions || [])) {
        if (!def.videoUrl) continue
        const q = String(def.quality ?? '').trim()
        if (def.format === 'mp4' && /\d/.test(q)) videoUrls.push({ type: 'MP4', quality: `${q}p`, link: [def.videoUrl] })
        else if (def.format === 'hls') videoUrls.push({ type: 'HLS', quality: q ? `${q}p` : 'Auto', link: [def.videoUrl] })
    }

    videoUrls.sort((a, b) => {
        if (a.type === 'JPG') return 1
        if (b.type === 'JPG') return -1
        if (a.type === 'HLS' && b.type !== 'HLS') return 1
        if (b.type === 'HLS' && a.type !== 'HLS') return -1
        return (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0)
    })

    if (!videoUrls.length) throw new Error('No downloadable media found — video may be premium-only.')
    if (thumbnail) videoUrls.push({ type: 'JPG', quality: 'Thumbnail', link: [thumbnail] })

    return { title, uploader, thumbnail, videoUrls }
}

async function searchPornhub(query, page = 1) {
    const res = await axios.get('https://www.pornhub.com/video/search', {
        params: { search: query, page },
        headers: phHeaders,
        timeout: 20000
    })
    const $ = cheerio.load(res.data)
    const results = []

    $('li.pcVideoListItem').each(function () {
        const $item = $(this)
        const $link = $item.find('a.linkVideoThumb').first()
        const href = $link.attr('href')
        if (!href) return
        const videoUrl = href.startsWith('http') ? href : `https://www.pornhub.com${href}`
        const viewkey = extractViewkey(videoUrl)
        if (!viewkey) return

        results.push({
            viewkey,
            url: `https://www.pornhub.com/view_video.php?viewkey=${viewkey}`,
            title: ($item.find('span.title').text() || $item.find('.videoTitle').text() || $link.attr('title') || 'Unknown').trim(),
            duration: ($item.find('var.duration').text() || $item.find('.videoDuration').text()).trim(),
            views: $item.find('.views var').text().trim()
        })
    })

    const hasNext = results.length >= 32 || $('a.page_next').length > 0 || $('[aria-label="next"]').length > 0
    return { results, hasNext }
}

export { phHeaders, scrapePornhub, searchPornhub }
