import fetch from 'node-fetch';
const cheerio = (await import("cheerio"));

let handler = async(m, { conn, args, usedPrefix, command}) => {
if (!args[0]) throw `- *Example:* ${usedPrefix + command} <url>`
	var _a, _b;
	    const data = await (await fetch(args[0])).text(),
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
	    conn.sendMessage( m.chat,
	      { document: { url: Url },
	        fileName: filename,
	        mimetype: "application/" + ext.toLowerCase(),
	        caption: `- *File Name :* ${filename}\n- *Type :* ${filetype}\n- *Size :* ${filesizeH}\n- *Uploaded :* ${upload}` }, { quoted: m } );
}
handler.dym = ["mediafire"]
handler.help = ['mediafire', 'mf'].map(v => v + ' <url>')
handler.tags = ['downloader']
handler.command = /^(mediafire|mf)$/i

export default handler