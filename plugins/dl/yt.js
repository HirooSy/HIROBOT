import yts from 'yt-search'
import fetch from 'node-fetch';
import axios from 'axios'
import crypto from 'crypto'; 
import { ytdl } from "../../lib/scraper/ytdl.js"

let handler = async(m, { conn, usedPrefix, text, args, command }) => {
let chat = db.data.chats[m.chat]
let fkon = { key: { fromMe: false, participant: m.sender, ...(m.chat ? { remoteJid: '16504228206@s.whatsapp.net' } : {}) }, message: { contactMessage: { displayName: `${await conn.getName(m.sender)}`, vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;a,;;;\nFN:${await conn.getName(m.sender)}\nitem1.TEL;waid=6283143393763:6283143393763\nitem1.X-ABLabel:Ponsel\nEND:VCARD`}}}

/*Play*/
if (command == "play") {
       let txt = isLink(text), input = '';
       if (!text && txt === null) throw `- [PlayAudio] ${usedPrefix + command} music\n- [PlayVideo] ${usedPrefix + command} video_name --video`
       if (txt === null) {
           let getUrl = await yts(text);
               input = getUrl.videos[0].url;
             } else {
               input = txt[0];
         };
       let isVideo = /--video/.test(text)
            m.react('🎶') 
  
           try {
                  var data = await ytdl((isVideo ? "video" : "audio"), input);
                   var description = `\`${data.title}\`\n\n- *Duration:* ${data.duration}\n- *Views:* ${(data.views).toSimpleNumber ? data.views.toSimpleNumber() : data.views}\n- *Url:* ${(input).replace("https://", "")}`
                   var filename = !isVideo ? "YouTube.mp3" : "YouTube.mp4";
                       // data.thumbnail can be null (yts metadata lookup failed
                       // or this video simply has none) — guard it so a missing
                       // thumbnail doesn't crash a command whose actual download
                       // already succeeded.
                       var thumbBuffer = null
                       if (data.thumbnail) {
                           try { thumbBuffer = await conn.resize(await (await fetch(data.thumbnail)).buffer(), 150, 150) } catch (_) {}
                       }
                       conn.reply(m.chat, description, { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: thumbBuffer, itemCount: 666, status: 1, surface: 1,message: "YOUTUBE DOWNLOADER" , orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR"}}})
                       await conn.sendMessage(m.chat, { 
                                                       [(isVideo ? 'video': 'audio')]: data.buffer, 
						                               mimetype: data.mime, 
						                               asDocument: db.data.chats[m.chat].useDocument,
						                               fileName: filename }, {})
                 } catch(e) { throw e }
}


//--------------------- AUDIO AND VIDEO --------------
if (/^yt(a|v|audio|video)$/i.test(command)) {
       let links = isLink(text);
       if (!text || !links) return m.reply(`*How To Use:* \`${usedPrefix + command} <your_link>\`\n\nContoh: \`${usedPrefix + command} https://youtube.com/watch?v=xxxx\``)
       var isAudio = /yt(a|audio)/.test(command)
       try {
         var data = await ytdl((isAudio ? "audio" : "video"), links[0]);
         var filename = isAudio ? "YouTube.mp3" : "YouTube.mp4";
                        await conn.sendMessage(m.chat, { 
                                    [(!isAudio ? 'video': 'audio')]: data.buffer, 
						            mimetype: data.mime, 
						            asDocument: db.data.chats[m.chat].useDocument,
						            fileName: filename }, {})
       } catch(e) { console.log(e); return m.reply("Failed to download, Scrape trouble") }
  }
  
//--------------------- SEARCH --------------
if (/^yt(s|search)$/i.test(command)) {
	if (!text) throw "- *Example:* .yts <query>"
	var s = await yts(text)
    var data = s.all.filter(v => v.type == 'video').slice(0, 10)
    var res = data.map((v, i) => { 
        return `> [ ${i + 1} ] ${v.title}\n- *Author:* ${v.author.name}\n- *Publish:* ${v.ago}\n- *Duration:* ${v.timestamp}\n- *Views:* ${(parseInt(v.views)).toSimpleNumber()}\n- ${(v.url).replace("https://", '')}`}).join("\n\n")
        conn.reply(m.chat, res, { key: { fromMe: false, participant: m.sender, ...(m.chat ? { remoteJid: '16504228206@s.whatsapp.net' } : {}) }, message: { contactMessage: { displayName: `YOUTUBE SEARCH`, vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;a,;;;\nFN:${await conn.getName(m.sender)}\nitem1.TEL;waid=6283143393763:6283143393763\nitem1.X-ABLabel:Ponsel\nEND:VCARD`}}})
    }

}
handler.dym = ["yta", "ytv", "yts", "play"]
handler.help = ['ytv <link>', 'yta <link>', 'yts <query>', 'play <query>']
handler.tags = ['downloader']
handler.command = /^(play|yt(v|video|a|audio|s|search))$/i
handler.limit = true

export default handler

function isLink(text) {
    let pattern = /https?:\/\/\S+/gi;
    let links = text.match(pattern);
    return links;
};
