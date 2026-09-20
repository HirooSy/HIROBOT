const DEFAULT_LIMIT = 30
const DEFAULT_MAX_CHARS = 5000
const LINE_MAX = 300
const QUOTE_MAX = 40

const WRAPPERS = [
  'ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension',
  'documentWithCaptionMessage', 'editedMessage', 'groupMentionedMessage', 'botInvokeMessage',
]

const num = jid => String(jid || '').split(':')[0].split('@')[0]
const esc = s => String(s).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')

export function groupContextLimit() {
  const n = Number.parseInt(process.env.AI_GROUP_CONTEXT ?? '', 10)
  if (!Number.isFinite(n)) return DEFAULT_LIMIT
  return Math.max(0, Math.min(100, n))
}

async function getStore() {
  return (await import('../../utils/connection.js')).default?.store
}

function unwrap(message) {
  let cur = message || {}
  for (let i = 0; i < 5; i++) {
    const k = WRAPPERS.find(w => cur?.[w]?.message)
    if (!k) break
    cur = cur[k].message
  }
  return cur || {}
}

function describe(message) {
  const c = unwrap(message)
  const text = c.conversation || c.extendedTextMessage?.text
  if (text) return String(text)

  const tag = (label, caption) => caption ? `[${label}] ${caption}` : `[${label}]`
  if (c.imageMessage) return tag('foto', c.imageMessage.caption)
  if (c.videoMessage) return tag(c.videoMessage.gifPlayback ? 'gif' : 'video', c.videoMessage.caption)
  if (c.audioMessage) return c.audioMessage.ptt ? '[voice note]' : '[audio]'
  if (c.stickerMessage) return '[stiker]'
  if (c.documentMessage) {
    const name = c.documentMessage.fileName ? ` ${c.documentMessage.fileName}` : ''
    return tag(`dokumen${name}`, c.documentMessage.caption)
  }
  if (c.contactMessage || c.contactsArrayMessage) return '[kontak]'
  if (c.locationMessage || c.liveLocationMessage) return '[lokasi]'
  const poll = c.pollCreationMessage || c.pollCreationMessageV2 || c.pollCreationMessageV3
  if (poll) return `[polling] ${poll.name || ''}`.trim()
  return ''
}

function contextInfoOf(message) {
  const c = unwrap(message)
  for (const v of Object.values(c)) {
    if (v && typeof v === 'object' && v.contextInfo) return v.contextInfo
  }
  return null
}

const tsOf = msg => {
  const t = msg?.messageTimestamp
  const n = t && typeof t === 'object' ? Number(t.toString()) : Number(t)
  return Number.isFinite(n) ? n : 0
}

const fmtCache = new Map()
function fmt(tz, kind) {
  const k = tz + '|' + kind
  let f = fmtCache.get(k)
  if (!f) {
    const opts = kind === 'time' ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : kind === 'date' ? { day: '2-digit', month: '2-digit' }
        : { year: 'numeric', month: '2-digit', day: '2-digit' }
    try { f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: tz }) }
    catch { f = new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: 'Asia/Jakarta' }) }
    fmtCache.set(k, f)
  }
  return f
}

function stamp(sec, tz, todayKey) {
  const d = new Date(sec * 1000)
  const time = fmt(tz, 'time').format(d)
  return fmt(tz, 'day').format(d) === todayKey ? time : `${fmt(tz, 'date').format(d)} ${time}`
}

function isCommand(text) {
  const pref = global.prefix
  const list = Array.isArray(pref) ? pref : typeof pref === 'string' ? [pref] : []
  const t = String(text).trimStart()
  return list.some(p => typeof p === 'string' && p && new RegExp('^' + esc(p) + '[a-z]', 'i').test(t))
}

function cleanText(text, max, botIds) {
  let t = String(text)
    .replace(/<\/?(?:riwayat_grup|pesan_user)[^>]*>/gi, '[tag]')
    .replace(/\s*\n+\s*/g, ' ⏎ ')
    .replace(/\s+/g, ' ')
    .trim()
  if (botIds.length) t = t.replace(new RegExp('@(?:' + botIds.map(esc).join('|') + ')', 'g'), '@bot')
  return t.length > max ? t.slice(0, max - 1) + '…' : t
}

function makeWho(conn) {
  const cache = new Map()
  const users = () => global.db?.data?.users || {}
  return function who(msg) {
    const key = msg.key || {}
    if (key.fromMe) return { self: true, name: 'Bot', num: num(conn?.user?.id) }
    const raw = key.participant || msg.participant || key.remoteJid || ''
    if (cache.has(raw)) return cache.get(raw)

    let pn = key.participantPn || key.senderPn || null
    if (!pn && String(key.participantAlt || '').endsWith('@s.whatsapp.net')) pn = key.participantAlt
    if (!pn && raw.endsWith('@lid')) pn = users()[raw]?.number || null
    if (!pn && raw.endsWith('@s.whatsapp.net')) pn = raw

    const number = num(pn || raw)
    const dbName = users()[pn || raw]?.name
    const name = msg.pushName || (dbName && dbName !== number ? dbName : null)
    const out = { self: false, name: name || null, num: number }
    cache.set(raw, out)
    return out
  }
}

function collect(store, conn, chat, { tz, skipCommands }) {
  const arr = store?.messages?.[chat]
  if (!Array.isArray(arr) || !arr.length) return []

  const who = makeWho(conn)
  const byId = new Map()
  for (const m of arr) if (m?.key?.id) byId.set(m.key.id, m)
  const botIds = [num(conn?.user?.id), num(conn?.user?.lid)].filter(Boolean)

  const rows = []
  for (const msg of arr) {
    if (!msg?.message || msg.messageStubType) continue
    const raw = describe(msg.message)
    if (!raw) continue
    const w = who(msg)
    if (skipCommands && !w.self && isCommand(raw)) continue

    let reply = null
    const ci = contextInfoOf(msg.message)
    if (ci?.quotedMessage) {
      const snip = cleanText(describe(ci.quotedMessage), QUOTE_MAX, botIds)
      const target = ci.stanzaId && byId.get(ci.stanzaId)
      const qw = target ? who(target) : { self: botIds.includes(num(ci.participant)), name: null, num: num(ci.participant) }
      if (snip) reply = { who: qw, snip }
    }
    rows.push({ id: msg.key.id, ts: tsOf(msg), who: w, text: raw, reply, botIds })
  }
  return rows.sort((a, b) => a.ts - b.ts)
}

const label = (w, withNum) => {
  if (w.self) return 'Bot'
  if (!w.name) return w.num || '?'
  return withNum && w.num ? `${w.name} (${w.num})` : w.name
}

function line(r, tz, todayKey, { withNum = false, lineMax = LINE_MAX } = {}) {
  const head = `[${stamp(r.ts, tz, todayKey)}] ${label(r.who, withNum)}`
  const rep = r.reply ? ` (balas ${label(r.reply.who, false)}: "${r.reply.snip}")` : ''
  return `${head}${rep}: ${cleanText(r.text, lineMax, r.botIds)}`
}

export async function buildGroupContext(conn, m, { limit = groupContextLimit(), maxChars = DEFAULT_MAX_CHARS, tz = 'Asia/Jakarta', store: injected } = {}) {
  const chat = m?.chat || m?.key?.remoteJid
  if (!limit || !chat || !chat.endsWith('@g.us')) return ''

  const store = injected || await getStore()
  const rows = collect(store, conn, chat, { tz, skipCommands: true })
    .filter(r => r.id !== m.key?.id && r.id !== m.id)
  if (!rows.length) return ''

  const todayKey = fmt(tz, 'day').format(new Date())
  const picked = rows.slice(-limit)
  const lines = []
  let used = 0
  for (let i = picked.length - 1; i >= 0; i--) {
    const l = line(picked[i], tz, todayKey)
    if (used + l.length > maxChars && lines.length) break
    used += l.length + 1
    lines.unshift(l)
  }

  const older = rows.length - lines.length
  const subject = store?.chats?.[chat]?.subject
  const attrs = `${subject ? ` grup="${String(subject).replace(/"/g, "'")}"` : ''} pesan="${lines.length}" zona="${tz}"`
  const note = older > 0 ? `\n(+${older} pesan lebih lama tidak ditampilkan — pakai tool read_chat_history kalau perlu)` : ''
  return `<riwayat_grup${attrs}>\n${lines.join('\n')}${note}\n</riwayat_grup>`
}

export async function readChatHistory(conn, chat, { limit = 50, minutes, keyword, sender, tz = 'Asia/Jakarta', store: injected } = {}) {
  const store = injected || await getStore()
  let rows = collect(store, conn, chat, { tz, skipCommands: false })
  const total = rows.length
  if (!total) return { text: '', total: 0, shown: 0 }

  if (minutes > 0) {
    const min = Date.now() / 1000 - minutes * 60
    rows = rows.filter(r => r.ts >= min)
  }
  if (keyword) {
    const k = String(keyword).toLowerCase()
    rows = rows.filter(r => r.text.toLowerCase().includes(k))
  }
  if (sender) {
    const s = String(sender).toLowerCase()
    rows = rows.filter(r => (r.who.name || '').toLowerCase().includes(s) || (r.who.num || '').includes(s))
  }

  const cap = Math.max(1, Math.min(100, Number(limit) || 50))
  const picked = rows.slice(-cap)
  const todayKey = fmt(tz, 'day').format(new Date())
  return {
    text: picked.map(r => line(r, tz, todayKey, { withNum: true, lineMax: 600 })).join('\n'),
    total,
    shown: picked.length,
    matched: rows.length,
    subject: store?.chats?.[chat]?.subject || null,
  }
}
