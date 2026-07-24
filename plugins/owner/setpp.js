import { webp2png } from '../../lib/scraper/ezgif.js'
import { S_WHATSAPP_NET, downloadMediaMessage, areJidsSameUser } from 'baileys'
import Connection from '../../lib/connection.js'

let handler = async (m, { conn, args }) => {
  if (areJidsSameUser((await Connection.conn).user.id, conn.user.id)) {
      throw "You cannot change the profile picture of the main bot as a sub-bot."
  }
  let q = m.quoted || m;
  let mime = q.mimetype || q.mediaType || '';

  const setProfilePicture = async (imageBuffer) => {
    return conn.query({
      tag: 'iq',
      attrs: { to: S_WHATSAPP_NET, type: 'set', xmlns: 'w:profile:picture' },
      content: [{ tag: 'picture', attrs: { type: 'image' }, content: imageBuffer }]
    }).then(m.reply('Success')) 
};

  if (/image/.test(mime)) {
    let rawBuffer;
    try {
      rawBuffer = await q.download();
    } catch {
      rawBuffer = await downloadMediaMessage(
        { key: m.key, message: m.message },
        'buffer',
        {},
        { reuploadRequest: conn.updateMediaMessage }
      );
    }
    let url = /webp/.test(mime) ? await webp2png(rawBuffer) : rawBuffer;
    let image = await generateProfilePicture(url)
    await setProfilePicture(image);
  } else {
    throw 'Where\'s the media?';
  }
};

handler.help = ['setbotpp'];
handler.command = /^setbotpp$/i;
handler.owner = true;
handler.ai = { risk: 'low', isTool: false, description: "change bot's profile picture" }

export default handler;

async function generateProfilePicture(mediaUpload) {
  const bufferOrFilePath = Buffer.isBuffer(mediaUpload)
    ? mediaUpload
    : typeof mediaUpload === 'object' && 'url' in mediaUpload
    ? mediaUpload.url.toString()
    : typeof mediaUpload === 'string'
    ? mediaUpload
    : Buffer.from(mediaUpload.stream);

  const { Jimp, JimpMime } = await import('jimp');
  const jimp = await Jimp.read(bufferOrFilePath);
  const min = jimp.width;
  const max = jimp.height;

  jimp.crop({ x: 0, y: 0, w: min, h: max });
  jimp.scaleToFit({ w: 720, h: 720 });
  return jimp.getBuffer(JimpMime.jpeg);
}
