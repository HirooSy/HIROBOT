import { ghostFetch } from 'ghostfetch'
import { format } from 'util'

let handler = async (m, { conn, text }) => {
    if (!/^https?:\/\//.test(text)) throw 'Awali *URL* dengan http:// atau https://'
    
    let _url = new URL(text)
    let url = _url.toString()
    
    // Use ghostFetch instead of node-fetch, with browser impersonation
    let res = await ghostFetch(url, {
        browser: 'Chrome_131',  // Spoof as Chrome to bypass Cloudflare
        timeout: 30000,          // 30 second timeout
        followRedirects: true    // Follow redirects automatically
    })
    
    if (res.headers.get('content-length') > 100 * 1024 * 1024 * 1024) {
        throw `Content-Length: ${res.headers.get('content-length')}`
    }
    
    if (!/text|json/.test(res.headers.get('content-type'))) {
        return conn.sendFile(m.chat, url, 'file', text, m)
    }
    
    let txt = await res.buffer()  // Still works with ghostFetch
    try {
        txt = format(JSON.parse(txt + ''))
    } catch (e) {
        txt = txt + ''
    } finally {
        m.reply(txt.slice(0, 65536) + '')
    }
}

handler.dym = ['fetch', 'get']
handler.help = ['fetch', 'get'].map(v => v + ' <url>')
handler.tags = ['internet']
handler.command = /^(fetch|get)$/i

export default handler