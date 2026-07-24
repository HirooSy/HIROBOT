import fetch from 'node-fetch';
import FormData from 'form-data';
import * as cheerio from 'cheerio';
/**
 * 
 * @param {Buffer|String} source 
 */
async function webp2mp4(source) {
  let form = new FormData
  let isUrl = typeof source === 'string' && /https?:\/\//.test(source)
  form.append('new-image-url', isUrl ? source : '')
  form.append('new-image', isUrl ? '' : source, 'image.webp')
  let res = await fetch('https://ezgif.com/webp-to-mp4', {
    method: 'POST',
    body: form
  })
  let html = await res.text()
  let $ = cheerio.load(html)
  let form2 = new FormData
  let obj = {}
  $('form input[name]').each((_, el) => {
    let input = $(el)
    let name = input.attr('name')
    let value = input.attr('value') || ''
    obj[name] = value
    form2.append(name, value)
  })
  let res2 = await fetch('https://ezgif.com/webp-to-mp4/' + obj.file, {
    method: 'POST',
    body: form2
  })
  let html2 = await res2.text()
  let $2 = cheerio.load(html2)
  let src = $2('div#output > p.outfile > video > source').attr('src')
  return new URL(src, res2.url).toString()
}
/**
 * Converts a WebP image to a PNG image.
 *
 * @param {Buffer|String} source
 * @returns {Promise<string>}
 */
async function webp2png(source) {
  let form = new FormData
  let isUrl = typeof source === 'string' && /https?:\/\//.test(source)
  form.append('new-image-url', isUrl ? source : '')
  form.append('new-image', isUrl ? '' : source, 'image.webp')
  let res = await fetch('https://ezgif.com/webp-to-png', {
    method: 'POST',
    body: form
  })
  let html = await res.text()
  let $ = cheerio.load(html)
  let form2 = new FormData
  let obj = {}
  $('form input[name]').each((_, el) => {
    let input = $(el)
    let name = input.attr('name')
    let value = input.attr('value') || ''
    obj[name] = value
    form2.append(name, value)
  })
  let res2 = await fetch('https://ezgif.com/webp-to-png/' + obj.file, {
    method: 'POST',
    body: form2
  })
  let html2 = await res2.text()
  let $2 = cheerio.load(html2)
  let src = $2('div#output > p.outfile > img').attr('src')
  return new URL(src, res2.url).toString()
}
export {
  webp2mp4, 
  webp2png
      }
