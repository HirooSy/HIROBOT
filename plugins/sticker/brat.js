import { generateBratImage, generateBratVideo, buildFailureWarning } from '../../lib/scraper/brat.js';

const handler = async (m, { conn, text, command, usedPrefix }) => {
    if (!text) throw `*• Example :* ${usedPrefix + command} [text]`;

    const isVideo = /^bratvid$/i.test(command);
    const generate = () => (isVideo ? generateBratVideo(text) : generateBratImage(text));

    const maxAttempts = 3;
    let lastError;

    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const { buffer, failures } = await generate();

                await conn.sendSticker(m.chat, buffer, {}, m);

                if (failures.length > 0) {
                    m.reply(buildFailureWarning(failures));
                }
                return;
            } catch (e) {
                lastError = e;
                if (attempt < maxAttempts) await new Promise(r => setTimeout(r, 1000 * attempt));
            }
        }
        throw lastError;
    } catch (e) {
        m.reply(`❌ Failed: ${e.message}`);
        m.error = e;
    }
};

handler.help = ['brat <text>', 'bratvid <text>'];
handler.tags = ['sticker'];
handler.command = /^brat(vid)?$/i;
handler.limit = 1;
handler.ai = { risk: "low", description: "create a sticker. \"/brat <text>\" for image, \"/bratvid <text>\" for video" }

export default handler;