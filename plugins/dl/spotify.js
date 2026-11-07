import { URL_REGEX } from 'baileys';

let handler = async(m, { conn, usedPrefix, command, text, platform }) => {
    let chat = db.data.chats[m.chat]
    if (!text) return m.reply(`> *SEARCH -* [ ${usedPrefix + command} <Music_name> ]\n> *DOWNLOAD -* [ ${usedPrefix + command} <Spotify_link> ]`)

    const pickMatch = text.match(/^--pick\s+(\S+)$/i)
    if (pickMatch) {
        let track
        try {
            track = JSON.parse(Buffer.from(pickMatch[1], 'base64').toString('utf8'))
        } catch (err) {
            return m.reply("- Failed to get song data.\n- Debug: invalid payload")
        }

        let result
        try {
            result = await global.scraper.spotify.spotifyDownloadByTrack(track.t, track.a, track.al, track.c)
        } catch (err) {
            return m.reply(`- Failed to get song data.\n- Debug: ${err.message}`)
        }

        return sendTrackResult(m, conn, chat, result)
    }

    if (!text.match(URL_REGEX)) {
        const res = await global.scraper.spotify.searchSpotify(text)
        if (!res?.success || !res?.results?.length) return m.reply("- *Error:* " + res.message)

        if (platform === 'discord') {
            const options = res.results.slice(0, 25).map(v => ({
                label: v.title.slice(0, 100),
                description: `${v.artists.join(', ')} · ${v.duration}`.slice(0, 100),
                action: `spotify --pick ${Buffer.from(JSON.stringify({
                    t: v.title,
                    a: v.artists.join(', '),
                    al: v.album?.name || null,
                    c: v.album?.cover || null
                }), 'utf8').toString('base64')}`
            }))
            const first = res.results[0].album?.cover
            return conn.discord(m.chat, {
                embed: {
                    title: `Spotify: ${text}`.slice(0, 256),
                    description: res.results.map((v, i) => `**${i + 1}.** ${v.title} · ${v.artists.join(', ')} · ${v.duration}`).join('\n').slice(0, 4000),
                    ...(first ? { thumbnail: { url: first } } : {})
                },
                select: { placeholder: 'Select a song', options }
            })
        }

        const rows = res.results.map((v, i) => {
            const payload = Buffer.from(JSON.stringify({
                t : v.title,
                a : v.artists.join(', '),
                al: v.album?.name || null,
                c : v.album?.cover || null
            }), 'utf8').toString('base64')

            return {
                header     : `${v.title}`,
                title      : `Artist: ${v.artists.join(', ')}  •  Duration: ${v.duration}`,
                description: `📁 ${v.album?.name || 'Unknown Album'}`,
                id         : `${usedPrefix}spotify --pick ${payload}`
            }
        })

        const coverUrl = res.results[0].album?.cover || 'https://i.scdn.co/image/ab67616d0000b273';

        let thumb
        try {
            const thumbResp = await global.scraper.spotify.downloadCover(coverUrl);
            thumb = await conn.resize(Buffer.from(thumbResp.data), 100, 100);
        } catch {
            thumb = undefined
        }

        const payload = {
            document   : { url: coverUrl },
            mimetype   : 'image/webp',
            caption    : " ",
            fileName   : 'SPOTIFY SEARCH',
            fileLength : '665666646645000',
            nativeFlow : [
                { text: 'Select', sections: [{ title: 'Result', rows }] }
            ],
        }
        if (thumb) payload.jpegThumbnail = thumb

        return conn.sendButton(m.chat, payload, m)

    } else {
        if (!/open\.spotify\.com/i.test(text)) {
            return m.reply("- Only support Spotify link.")
        }

        let result
        try {
            result = await global.scraper.spotify.spotifyDownloadByUrl(text)
        } catch (err) {
            return m.reply(`- Failed to get song data.\n- Debug: ${err.message}`)
        }

        if (!result) {
            return m.reply("- Failed to get song data.\n- Debug: track not found on spotsaver.net")
        }

        return sendTrackResult(m, conn, chat, result)
    }
}

async function sendTrackResult(m, conn, chat, result) {
    const { metadata, links } = result

    const trackName = metadata.name || 'Unknown Title'
    const coverUrl  = links.cover || metadata.cover || null
    const audioUrl  = links.mp3

    if (!audioUrl) {
        return m.reply("- Failed to get song data.\n- Debug: mp3 link is empty, check the console log.")
    }

    if (m.platform === 'discord') {
        return conn.discord(m.chat, {
            audio: { url: audioUrl },
            fileName: `${trackName}.mp3`,
            text: `**${trackName}**`
        })
    }

    let thumbBuffer
    if (coverUrl) {
        try {
            const coverResp = await global.scraper.spotify.downloadCover(coverUrl);
            thumbBuffer = await conn.resize(Buffer.from(coverResp.data), 150, 150);
        } catch {
            thumbBuffer = undefined
        }
    }

    return conn.sendFile(m.chat, audioUrl, `${trackName}.mp3`, '', m, false, {
        mimetype: 'audio/mpeg',
        asDocument: chat.useDocument,
        quoted: { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: thumbBuffer, itemCount: 666, status: 1, surface: 1, message: trackName, orderTitle: trackName, sellerJid: '0@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } }
    })
}

handler.tags    = ["downloader"]
handler.help    = [
    "spotify <name/link>",
    { command: "spotify", name: "text", description: "Song name or Spotify link", type: "string", required: true }
]
handler.command = ["spotify"]
handler.description = "Search or download a song from Spotify"
handler.ai      = { risk:"low", description:"search/download spotify music" }

handler.platform = { whatsapp: true, discord: true }

export default handler
