import * as cheerio from 'hiro/cheerio'

async function mediafire(url) {
    const html = await (await fetch(url)).text()
    const $ = cheerio.load(html)
    const $intro = $('div.dl-info > div.intro')
    const $details = $('div.dl-info > ul.details > li')
    const extMatch = /\(\.(.*?)\)/.exec($intro.find('div.filetype > span').eq(1).text())
    return {
        url: ($('#downloadButton').attr('href') || '').trim(),
        filename: $intro.find('div.filename').text().trim(),
        filetype: $intro.find('div.filetype > span').eq(0).text().trim(),
        ext: extMatch?.[1]?.trim() || 'bin',
        size: $details.eq(0).find('span').text().trim(),
        upload: $details.eq(1).find('span').text().trim()
    }
}

export { mediafire }
