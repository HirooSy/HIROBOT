const cheerio = (await import("cheerio"));

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });


let handler = async(m, { conn, args, text, usedPrefix, command}) => {
const link = args[0] || text
if (!link) throw `- *Example:* ${usedPrefix + command} <url>`
	var _a, _b;
	    const data = await (await fetch(link)).text(),
	      $ = cheerio.load(data),
	      Url = ($("#downloadButton").attr("href") || "").trim(),
	      url2 = ($("#download_link > a.retry").attr("href") || "").trim(),
	      $intro = $("div.dl-info > div.intro"),
	      filename = $intro.find("div.filename").text().trim(),
	      filetype = $intro.find("div.filetype > span").eq(0).text().trim(),
	      ext =
	        (null ===
	          (_b =
	            null ===
	              (_a = /\(\.(.*?)\)/.exec(
	                $intro.find("div.filetype > span").eq(1).text(),
	              )) || void 0 === _a
	              ? void 0
	              : _a[1]) || void 0 === _b
	          ? void 0
	          : _b.trim()) || "bin",
	      $li = $("div.dl-info > ul.details > li"),
	      upload = $li.eq(1).find("span").text().trim(),
	      filesizeH = $li.eq(0).find("span").text().trim();
	    sendOut(conn, m, { document: { url: Url },
	        fileName: filename,
	        mimetype: "application/" + ext.toLowerCase(),
	        caption: `- *File Name :* ${filename}\n- *Type :* ${filetype}\n- *Size :* ${filesizeH}\n- *Uploaded :* ${upload}` });
}
handler.help = [
    ...(['mediafire', 'mf'].map(v => v + ' <url>')),
    { command: 'mediafire', name: 'text', description: 'MediaFire file URL', type: 'string', required: true }
]
handler.tags = ['downloader']
handler.command = ['mediafire', 'mf']
handler.description = 'Download a file from MediaFire'

handler.platform = { whatsapp: true, discord: true }

export default handler
