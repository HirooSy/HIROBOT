let jimp = (await import("jimp")).Jimp
import FormData from "form-data";
import axios from 'axios';
const { fileTypeFromBuffer } = (await import("file-type"));

let handler = async (m, { conn, args, usedPrefix, command }) => {
  var towidth = args[0]
  var toheight = args[1]
  if (!towidth || !toheight) throw `- *Example:* ${usedPrefix + command} <width> <height>`
  var q = m.quoted ? m.quoted : m
  var mime = (q.msg || q).mimetype || ''
  if (!mime) throw "- Please Reply/caption the image you want to resize."
  var media = await q.download()
  var isMedia = /image\/(png|jpe?g)/.test(mime)
  if (!isMedia) throw `- Mime ${mime} not Supported`
  var link = await upload(media)
  var source = await jimp.read(await link)
  var size = { before:{ height: await source.bitmap.height, width: await source.bitmap.width }, 
               after:{ height: toheight, width: towidth } }
  var compres = await conn.resize(link, towidth - 0, toheight - 0)
  conn.sendFile(m.chat, compres, null, `                 *\`Resize Image\`*\n- *Width  :* ${size.before.width} > ${size.after.width}\n- *Height:* ${size.before.height} > ${size.after.height}`, m)
}
handler.help = ['resize [ width ] [ height]']
handler.tags = ['tools']
handler.command = /^(resize)$/i

export default handler

async function upload(buffer) {
  const { ext, mime } = (await fileTypeFromBuffer(buffer)) || {};
  const form = new FormData();
  form.append("file", buffer, { filename: `tmp.${ext}`, contentType: mime });
  try {
    const { data } = await axios.post("https://tmpfiles.org/api/v1/upload", form, { headers: form.getHeaders() });
    const match = /https?:\/\/tmpfiles.org\/(.*)/.exec(data.data.url);
    return `https://tmpfiles.org/dl/${match[1]}`;
  } catch (error) { throw error; }
};
