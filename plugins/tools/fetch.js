import axios from 'axios';
import { format } from 'util';

let handler = async (m, { conn, text }) => {
    if (!/^https?:\/\//.test(text)) throw 'Prefix *URL* with http:// or https://';
    
    let url = new URL(text).toString();
    
    try {
        // Fetch dengan axios
        let response = await axios({
            method: 'GET',
            url: url,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Referer': 'https://www.google.com/',
            },
            timeout: 30000,
            maxRedirects: 5,
            responseType: 'arraybuffer'
        });
        
        let contentLength = response.headers['content-length'];
        if (contentLength > 100 * 1024 * 1024 * 1024) {
            throw `Content-Length: ${contentLength}`;
        }
        
        let contentType = response.headers['content-type'] || '';
        if (!/text|json/.test(contentType)) {
            return conn.sendFile(m.chat, url, 'file', text, m);
        }
        
        let txt = response.data.toString('utf-8');
        try {
            txt = format(JSON.parse(txt));
        } catch (e) {
        }
        
        m.reply(txt.slice(0, 65536));
    } catch (e) {
        throw `${e.message}`;
    }
};

handler.help = ['fetch', 'get'].map(v => v + ' <url>');
handler.tags = ['tools'];
handler.command = /^(fetch|get)$/i;

handler.ai = {
    risk: 'low',
    summarize: false,
    description: 'Retrieving data or content from a URL.'
};

export default handler;
