const sendOut = (conn, m, payload) =>
    m.platform === 'discord'
        ? conn.discord(m.chat, payload)
        : conn.sendMessage(m.chat, payload, { quoted: m });

const formatDuration = s => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
};

const formatSynced = text => {
    if (!text) return null;
    const lines = text
        .split('\n')
        .map(l => l.replace(/^\[\d{2}:\d{2}(?:\.\d{2,3})?\]\s*/, '').trim())
        .filter(Boolean);
    const seen = new Set();
    const out = [];
    for (const l of lines) {
        if (!seen.has(l)) {
            seen.add(l);
            out.push(l);
        }
    }
    return out.join('\n');
};

let handler = async (m, { conn, text, usedPrefix, command, platform }) => {
    if (!text) {
        throw `- *Example:*\n> ${usedPrefix + command} shape of you\n> ${usedPrefix + command} get 3`;
    }

    if (!conn.lyrics) conn.lyrics = {};

    const trimmed = text.trim();

    const getMatch = trimmed.match(/^get\s+(\d+)$/i);
    if (getMatch) {
        const state = conn.lyrics[m.sender];
        if (!state || Date.now() - state.at > 10 * 60 * 1000) {
            delete conn.lyrics[m.sender];
            throw '> No active search. Run a new search first.';
        }

        const index = Number(getMatch[1]);
        const item = state.results[index - 1];
        if (!item) throw `> Invalid number. Choose 1–${state.results.length}.`;

        await m.react('🕜');

        const header = `*${item.trackName}*\n${item.artistName || 'Unknown Artist'}${item.albumName ? ` — ${item.albumName}` : ''}${item.duration ? `\nDuration: ${formatDuration(item.duration)}` : ''}`;

        let body;
        if (item.instrumental) {
            body = '(Instrumental track — no lyrics available)';
        } else if (item.syncedLyrics) {
            body = formatSynced(item.syncedLyrics);
        } else if (item.plainLyrics) {
            body = item.plainLyrics.trim();
        } else {
            body = '(No lyrics available)';
        }

        const message = `${header}\n\n${body}`;

        if (message.length > 4000) {
            const chunks = message.match(/[\s\S]{1,4000}/g) || [];
            for (const c of chunks) await m.reply(c);
        } else {
            await m.reply(message);
        }

        return m.react('✅');
    }

    await m.react('🔎');

    try {
        const results = await global.scraper.lyrics.searchLyrics(trimmed);
        if (!results.length) throw '> Lyrics not found';

        const filtered = results.filter(r => r.trackName).slice(0, 10);
        if (!filtered.length) throw '> Lyrics not found';

        conn.lyrics[m.sender] = { results: filtered, at: Date.now() };

        const searchText = `- *Lyrics Search*\n- *Query:* ${trimmed}\n- *Results:* ${filtered.length}\n\nSelect the song you want.`;

        if (platform === 'discord') {
            await conn.discord(m.chat, {
                text: searchText,
                select: {
                    placeholder: 'Select Song',
                    options: filtered.map((r, i) => ({
                        label: `${r.trackName}`.slice(0, 100),
                        description: `${r.artistName || 'Unknown'}${r.duration ? ` · ${formatDuration(r.duration)}` : ''}`.slice(0, 100),
                        action: `${command} get ${i + 1}`
                    }))
                }
            });
        } else {
            const rows = filtered.map((r, i) => ({
                header: `${i + 1}. ${r.trackName}`.slice(0, 60),
                title: `${r.artistName || 'Unknown Artist'}`.slice(0, 60),
                description: `${r.albumName || 'Unknown Album'}${r.duration ? ` · ${formatDuration(r.duration)}` : ''}`.slice(0, 100),
                id: `${usedPrefix}${command} get ${i + 1}`
            }));

            await conn.sendButton(m.chat, {
                text: searchText,
                nativeFlow: [{ text: 'Select Song', sections: [{ title: 'Result', rows }] }]
            }, m);
        }

        return m.react('✅');
    } catch (e) {
        m.error = e;
        throw e;
    }
};

handler.help = [
    ...['lyrics'].map(v => v + ' <query>'),
    ...['lyrics'].map(v => v + ' get <number>'),
    { command: 'lyrics', name: 'text', description: 'Song title or "get <number>"', type: 'string', required: true }
];
handler.tags = ['internet', 'tools'];
handler.command = ['lyrics'];
handler.description = 'Search and fetch synced lyrics';
handler.limit = true;
handler.platform = { whatsapp: true, discord: true };

export default handler;