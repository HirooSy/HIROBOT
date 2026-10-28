const { generateBratImage, generateBratVideo, buildFailureWarning } = global.scraper.brat;

const handler = async (m, { conn, text, command, usedPrefix, platform }) => {
    if (!text) throw `*• Example :* ${usedPrefix + command} [text]`;

    const isVideo = /^bratvid$/i.test(command);
    const generate = () => (isVideo ? generateBratVideo(text) : generateBratImage(text));

    const maxAttempts = 3;
    let lastError;

    try {
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
                const { buffer, failures } = await generate();

                if (platform === 'discord') await conn.discord(m.chat, { image: buffer, fileName: isVideo ? 'brat.webp' : 'brat.png' });
                else await conn.sendSticker(m.chat, buffer, {}, m);

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

handler.help = [
    ...(['brat <text>', 'bratvid <text>']),
    { command: 'brat', name: 'text', description: 'Text for the brat image', type: 'string', required: true },
    { command: 'bratvid', name: 'text', description: 'Text for the animated brat image', type: 'string', required: true }
]
handler.tags = ['canvas', 'sticker'];
handler.command = ['brat', 'bratvid']
handler.description = {
    brat: 'Make a brat image from text',
    bratvid: 'Make an animated brat image from text'
}
handler.limit = 1;
handler.ai = { risk: "low", description: "create a sticker. \"/brat <text>\" for image, \"/bratvid <text>\" for video" }

handler.platform = { whatsapp: true, discord: true }

export default handler;