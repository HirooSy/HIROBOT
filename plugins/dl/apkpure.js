import fs from 'fs'
import os from 'os'
import path from 'path'

const { apkSearch, apkDetail, apkDownload, apkFetchFile, formatSize } = global.scraper.apkpure

const sendOut = (conn, m, payload) => m.platform === 'discord'
    ? conn.discord(m.chat, payload)
    : conn.sendMessage(m.chat, payload, { quoted: m });


const MAX_SIZE = 1.9 * 1024 * 1024 * 1024

let handler = async (m, { conn, text, usedPrefix, command, platform }) => {
    if (!text) throw `- *Example:*\n> ${usedPrefix + command} whatsapp\n> ${usedPrefix + command} com.whatsapp\n> ${usedPrefix + command} https://apkpure.com/whatsapp-android/com.whatsapp`

    await m.react('🔎')
    let tmp
    try {
        const isTarget = /apkpure\.(com|net)\//i.test(text) || /^[a-z0-9_]+(\.[a-z0-9_]+)+$/i.test(text.trim())

        if (!isTarget) {
            const list = await apkSearch(text, 10)
            if (!list.length) throw '> App not found'

            const rows = list.map((a, i) => ({
                header: `${i + 1}. ${a.title}`.slice(0, 60),
                title: a.pkg,
                description: [a.developer, a.rating && `⭐ ${a.rating}`].filter(Boolean).join(' · ') || 'Tap to download',
                id: `${usedPrefix}apkpure ${a.pkg}`
            }))

            const searchText = `- *APKPure Search*\n- *Query:* ${text}\n- *Results:* ${list.length}\n\nSelect the app you want to download.`
            if (platform === 'discord') {
                await conn.discord(m.chat, {
                    text: searchText,
                    select: {
                        placeholder: 'Select App',
                        options: list.map(a => ({
                            label: `${a.title}`.slice(0, 100),
                            description: [a.developer, a.rating && `${a.rating}`].filter(Boolean).join(' · ') || a.pkg,
                            action: `apkpure ${a.pkg}`
                        }))
                    }
                })
            } else {
                await conn.sendButton(m.chat, {
                    text: searchText,
                    footer: 'APKPure',
                    nativeFlow: [{ text: 'Select App', sections: [{ title: 'Result', rows }] }]
                }, m)
            }
            return m.react('✅')
        }

        const detail = await apkDetail(text.trim()).catch(() => null)
        const dl = await apkDownload(text.trim(), /xapk/i.test(command) ? 'XAPK' : 'auto')

        if (dl.size && dl.size > MAX_SIZE) throw `> File too large (${formatSize(dl.size)})`

        await m.react('⬇️')
        tmp = path.join(os.tmpdir(), `apk_${Date.now()}_${dl.fileName.replace(/[^\w.\-]/g, '_')}`)
        const size = await apkFetchFile(dl, tmp, MAX_SIZE)
        if (platform === 'discord' && size > 24 * 1024 * 1024) throw `> File too large to upload on Discord (${formatSize(size)})`

        const caption = `- \`Name:\` ${detail?.title || dl.pkg}\n- \`Package:\` ${dl.pkg}${detail?.version ? `\n- \`Version:\` ${detail.version}` : ''}\n- \`Size:\` ${formatSize(size)}\n- \`Type:\` ${dl.type}`

        await sendOut(conn, m, {
            document: { url: tmp },
            fileName: dl.fileName,
            mimetype: dl.type === 'APK' ? 'application/vnd.android.package-archive' : 'application/octet-stream',
            caption
        })
        m.react('✅')
    } catch (e) {
        m.error = e
        throw e
    } finally {
        if (tmp) fs.promises.unlink(tmp).catch(() => {})
    }
}

handler.help = [
    ...(['apkpure'].map(v => v + ' <query>')),
    { command: 'apkpure', name: 'text', description: 'App name, package name or APKPure URL', type: 'string', required: true }
]
handler.tags = ['downloader', 'internet']
handler.command = ['apkpure', 'apk', 'apkpurexapk']
handler.description = 'Search or download an app from APKPure'
handler.limit = true

handler.platform = { whatsapp: true, discord: true }

export default handler