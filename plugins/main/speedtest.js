import fetch from 'node-fetch'
import { XMLParser } from 'fast-xml-parser'

// ─── helpers ──────────────────────────────────────────────────────────────────

function distance(lat1, lon1, lat2, lon2) {
    const R = 6371
    const dLat = (lat2 - lat1) * Math.PI / 180
    const dLon = (lon2 - lon1) * Math.PI / 180
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) ** 2
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
}

function cacheBust(url) {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}x=${Date.now()}.0`
}

const UA = 'Mozilla/5.0 (speedtest-cli/2.1.4)'

async function fetchXML(url) {
    const res = await fetch(cacheBust(url), {
        headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
        timeout: 15000,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
    const text = await res.text()
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '' })
    return parser.parse(text)
}

// ─── 1. get config ────────────────────────────────────────────────────────────

async function getConfig() {
    const xml = await fetchXML('https://www.speedtest.net/speedtest-config.php')
    const settings = xml.settings

    const client   = settings.client
    const dl       = settings.download
    const ul       = settings.upload
    const srvCfg   = settings['server-config']

    const ratio     = parseInt(ul.ratio)
    const upMax     = parseInt(ul.maxchunkcount)
    const upSizes   = [32768, 65536, 131072, 262144, 524288, 1048576, 7340032]
    const dlSizes   = [350, 500, 750, 1000, 1500, 2000, 2500, 3000, 3500, 4000]
    const uploadSizes = upSizes.slice(ratio - 1)
    const sizeCount  = uploadSizes.length
    const uploadCount = Math.ceil(upMax / sizeCount)

    const ignoreServers = (srvCfg.ignoreids || '')
        .split(',').filter(Boolean).map(Number)

    return {
        client: {
            ip: client.ip,
            isp: client.isp,
            lat: parseFloat(client.lat),
            lon: parseFloat(client.lon),
        },
        ignoreServers,
        sizes: { download: dlSizes, upload: uploadSizes },
        counts: {
            download: parseInt(dl.threadsperurl),
            upload: uploadCount,
        },
        threads: {
            download: parseInt(srvCfg.threadcount) * 2,
            upload: parseInt(ul.threads),
        },
        length: {
            download: parseInt(dl.testlength),
            upload: parseInt(ul.testlength),
        },
        uploadMax: uploadCount * sizeCount,
    }
}

// ─── 2. get servers ───────────────────────────────────────────────────────────

async function getServers(config) {
    const urls = [
        'https://www.speedtest.net/speedtest-servers-static.php',
        'http://c.speedtest.net/speedtest-servers-static.php',
        'https://www.speedtest.net/speedtest-servers.php',
        'http://c.speedtest.net/speedtest-servers.php',
    ]

    for (const baseUrl of urls) {
        try {
            const url = `${baseUrl}?threads=${config.threads.download}`
            const xml = await fetchXML(url)
            const elements = [].concat(
                xml?.settings?.servers?.server || []
            )
            if (!elements.length) continue

            const servers = []
            for (const s of elements) {
                if (config.ignoreServers.includes(parseInt(s.id))) continue
                const d = distance(
                    config.client.lat, config.client.lon,
                    parseFloat(s.lat), parseFloat(s.lon)
                )
                servers.push({ ...s, d })
            }

            servers.sort((a, b) => a.d - b.d)
            return servers
        } catch (e) {
            continue
        }
    }
    throw new Error('Cannot retrieve server list')
}

// ─── 3. ping / best server ────────────────────────────────────────────────────

async function pingServer(server) {
    const base = server.url.substring(0, server.url.lastIndexOf('/'))
    const times = []
    for (let i = 0; i < 3; i++) {
        try {
            const url = `${base}/latency.txt?x=${Date.now()}.${i}`
            const t0 = Date.now()
            const res = await fetch(url, {
                headers: { 'User-Agent': UA, 'Cache-Control': 'no-cache' },
                timeout: 5000,
            })
            const text = await res.text()
            if (res.ok && text.trim() === 'test=test') {
                times.push((Date.now() - t0))
            } else {
                times.push(3600000)
            }
        } catch {
            times.push(3600000)
        }
    }
    // average of 6 slots (same as Python: sum/6)
    return Math.round((times.reduce((a, b) => a + b, 0) / 6) * 10) / 10
}

async function getBestServer(servers) {
    const closest = servers.slice(0, 5)
    let best = null
    let bestLatency = Infinity
    for (const server of closest) {
        const latency = await pingServer(server)
        if (latency < bestLatency) {
            bestLatency = latency
            best = { ...server, latency }
        }
    }
    if (!best) throw new Error('Unable to determine best server')
    return best
}

// ─── 4. download test ─────────────────────────────────────────────────────────

async function testDownload(best, config) {
    const base = best.url.substring(0, best.url.lastIndexOf('/'))
    const urls = []
    for (const size of config.sizes.download) {
        for (let i = 0; i < config.counts.download; i++) {
            urls.push(`${base}/random${size}x${size}.jpg`)
        }
    }

    const timeout = config.length.download * 1000
    const start = Date.now()
    let bytesReceived = 0

    const workers = Array.from({ length: config.threads.download }, async () => {
        for (const url of urls) {
            if (Date.now() - start >= timeout) break
            try {
                const res = await fetch(cacheBust(url), {
                    headers: { 'User-Agent': UA },
                    timeout: timeout,
                })
                const buf = await res.arrayBuffer()
                bytesReceived += buf.byteLength
            } catch { /* ignore */ }
        }
    })

    await Promise.all(workers)
    const elapsed = (Date.now() - start) / 1000
    return (bytesReceived / elapsed) * 8  // bits per second
}

// ─── 5. upload test ───────────────────────────────────────────────────────────

function makeUploadData(size) {
    const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const multiplier = Math.round(size / 36)
    const body = 'content1=' + (chars.repeat(multiplier)).slice(0, size - 9)
    return body
}

async function testUpload(best, config) {
    const sizes = []
    for (const size of config.sizes.upload) {
        for (let i = 0; i < config.counts.upload; i++) {
            sizes.push(size)
        }
    }
    const requests = sizes.slice(0, config.uploadMax)

    const timeout = config.length.upload * 1000
    const start = Date.now()
    let bytesSent = 0

    const workers = Array.from({ length: config.threads.upload }, async () => {
        for (const size of requests) {
            if (Date.now() - start >= timeout) break
            try {
                const body = makeUploadData(size)
                await fetch(cacheBust(best.url), {
                    method: 'POST',
                    headers: {
                        'User-Agent': UA,
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'Content-Length': size,
                    },
                    body,
                    timeout: timeout,
                })
                bytesSent += size
            } catch { /* ignore */ }
        }
    })

    await Promise.all(workers)
    const elapsed = (Date.now() - start) / 1000
    return (bytesSent / elapsed) * 8  // bits per second
}

// ─── main speedtest function ──────────────────────────────────────────────────

async function runSpeedtest() {
    const config = await getConfig()
    const servers = await getServers(config)
    const best = await getBestServer(servers)
    const download = await testDownload(best, config)
    const upload = await testUpload(best, config)

    return {
        isp: config.client.isp,
        ip: config.client.ip,
        server: {
            sponsor: best.sponsor,
            name: best.name,
            country: best.country,
            d: best.d,
        },
        ping: best.latency,
        download,  // bps
        upload,    // bps
    }
}

// ─── WhatsApp bot handler ─────────────────────────────────────────────────────

let handler = async (m, { conn }) => {
    await m.react("🔴")

    try {
        const r = await runSpeedtest()

        const dl = (r.download / 1e6).toFixed(2)
        const ul = (r.upload / 1e6).toFixed(2)
        const ping = r.ping.toFixed(2)
        const dist = r.server.d.toFixed(2)

        const text =
`> \`\`\`Testing From ${r.isp}\`\`\`

────────────────
- *\`Hosted :\`* ${r.server.sponsor}
- *\`Location :\`* ${r.server.name}, ${r.server.country} [${dist} km]
- *\`Ping :\`* ${ping} ms
- ▾ *\`Inbound :\`* ${dl} Mb/s
- ▵ *\`Outbound :\`* ${ul} Mb/s

────────────────`

        await conn.reply(m.chat, text, {
            key: { remoteJid: "0@s.whatsapp.net" },
            message: {
                orderMessage: {
                    orderId: '780642630945098',
                    thumbnail: await conn.resize(img.profile.bot, 150, 150),
                    itemCount: 666,
                    status: 1,
                    surface: 1,
                    message: "𝗦𝗣𝗘𝗘𝗗𝗧𝗘𝗦𝗧 . Ookla",
                    orderTitle: 'Channel.',
                    sellerJid: '6283143393763@s.whatsapp.net',
                    token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==',
                    totalAmount1000: "0",
                    totalCurrencyCode: "IDR"
                }
            }
        })

        await m.react("🟢")

    } catch (e) {
        await m.reply(`❌ Speedtest gagal:\n${e.message}`)
        await m.react("🔴")
    }
}

handler.help = handler.dym = ["speedtest"]
handler.tags = ['info']
handler.command = /^(speedtest)$/i

export default handler
