import { waToDiscord, chunkText } from '../discord/text.js'
import { resolveMedia, flowToDiscord } from '../discord/payload.js'

const adapters = new Map()
const DISCORD_TEXT_FILE_THRESHOLD = 7600
const CODE_EXT = {
  javascript: 'js', typescript: 'ts', python: 'py', markdown: 'md', bash: 'sh', yaml: 'yml',
  json: 'json', html: 'html', css: 'css', sql: 'sql', xml: 'xml', text: 'txt'
}

const keyOf = (res, chat) => {
  if (res?.key) return res
  return { key: { id: res?.id, remoteJid: chat, fromMe: true }, id: res?.id, message: res }
}

function discordControls(content) {
  const flow = content.nativeFlow || content.interactiveButtons || []
  const legacy = (content.buttons || []).map(b => ({
    text: b.buttonText?.displayText || b.displayText || b.text,
    id: b.buttonId || b.id
  }))
  return flowToDiscord([...flow, ...legacy])
}

export async function toDiscordPayload(content) {
  if (typeof content === 'string') return { text: waToDiscord(content) }
  const source = content || {}
  let text = waToDiscord(source.text ?? source.caption ?? source.body ?? '')
  if (!text && source.title) text = waToDiscord(source.title)
  if (source.footer) text = [text, `-# ${source.footer}`].filter(Boolean).join('\n')
  const media = await resolveMedia({ ...source, text })
  const out = {}
  if (media.files?.length) out.file = media.files[0]
  if (media.files?.length > 1) out.files = media.files
  const { button, select } = discordControls(source)
  if (button.length) out.button = button
  if (select.length) out.select = select
  if (source.embed) out.embed = source.embed
  if (source.embeds) out.embeds = source.embeds
  if (media.text) out.text = media.text
  return out
}

async function sendDiscord(conn, chat, content) {
  const payload = await toDiscordPayload(content)
  if (typeof conn?.discord !== 'function') {
    if (typeof conn?.sendMessage === 'function') return conn.sendMessage(chat, content)
    throw new Error('Discord sending is not available on this connection')
  }
  const text = payload.text || ''
  if (!text && !payload.file && !payload.files && !payload.embed && !payload.embeds && !payload.button && !payload.select) return null
  if (text.length > DISCORD_TEXT_FILE_THRESHOLD && !payload.file) {
    const rest = { ...payload }
    delete rest.text
    return keyOf(await conn.discord(chat, { ...rest, file: { attachment: Buffer.from(text, 'utf8'), name: 'result.txt' } }), chat)
  }
  const parts = chunkText(text)
  if (parts.length <= 1) return keyOf(await conn.discord(chat, payload), chat)
  let last = null
  for (let i = 0; i < parts.length; i++) {
    const final = i === parts.length - 1
    last = await conn.discord(chat, final ? { ...payload, text: parts[i] } : { text: parts[i] })
  }
  return keyOf(last, chat)
}

function fenced(language, code) {
  let fence = '```'
  while (String(code).includes(fence)) fence += '`'
  return `${fence}${language || ''}\n${code}\n${fence}`
}

function codeText({ title, description, language, code }) {
  return [title ? `**${title}**` : '', description || '', fenced(language, code || '')].filter(Boolean).join('\n\n')
}

function whatsappFallbackCode({ title, description, language, code }) {
  return (title ? `*${title}*\n\n` : '') + (description ? `${description}\n\n` : '') + '```' + (language || 'text') + '\n' + (code || '') + '\n```'
}

const whatsapp = {
  name: 'whatsapp',
  features: ['groups', 'history', 'rich', 'plugins', 'reminders', 'relay', 'forward'],
  note: '',
  resolveTarget(target) {
    const raw = String(target || '').trim()
    if (!raw) return ''
    return raw.includes('@') ? raw : raw.replace(/\D/g, '') + '@s.whatsapp.net'
  },
  async send(conn, chat, content, { quoted } = {}) {
    return conn.sendMessage(chat, content, quoted ? { quoted } : undefined)
  },
  async button(conn, chat, content, { quoted } = {}) {
    return conn.sendButton(chat, content, quoted)
  },
  async edit(conn, chat, key, text) {
    return conn.sendMessage(chat, { edit: key, text })
  },
  async remove(conn, chat, key) {
    return conn.sendMessage(chat, { delete: key })
  },
  async code(conn, chat, data, { quoted } = {}) {
    try {
      const rich = conn.aiRich()
      if (data.title) rich.setTitle(data.title)
      if (data.description) rich.addText(`${data.description}\n`, { hyperlink: true })
      rich.addCode(data.language || 'text', data.code || '')
      return await rich.send(chat, { quoted })
    } catch {
      return conn.sendMessage(chat, { text: whatsappFallbackCode(data) }, quoted ? { quoted } : undefined)
    }
  },
  async html(conn, chat, { html, title }, { quoted } = {}) {
    const rich = conn.aiRich()
    if (title) rich.setTitle(String(title).slice(0, 80))
    rich.addHtml(html)
    return rich.send(chat, { quoted })
  },
  async images(conn, chat, { text, urls }, { quoted } = {}) {
    try {
      const rich = conn.aiRich()
      if (text) rich.addText(text)
      rich.addImage(urls, { resolveUrl: true })
      return await rich.send(chat, { quoted })
    } catch {
      return conn.sendMessage(chat, { image: { url: urls[0] }, caption: text || '' }, quoted ? { quoted } : undefined)
    }
  }
}

const discord = {
  name: 'discord',
  features: ['plugins', 'reminders', 'relay', 'forward'],
  note: 'Write Discord markdown (**bold**, *italic*, inline code and fenced code blocks) and keep each message under 2000 characters. WhatsApp-only features (group management, chat history reading) are not available here.',
  resolveTarget(target) {
    const match = /\d{15,22}/.exec(String(target || ''))
    return match ? match[0] : ''
  },
  async send(conn, chat, content) {
    return sendDiscord(conn, chat, content)
  },
  async button(conn, chat, content) {
    return sendDiscord(conn, chat, content)
  },
  async edit(conn, chat, key, text) {
    return conn.sendMessage(chat, { edit: key, text })
  },
  async remove(conn, chat, key) {
    return conn.sendMessage(chat, { delete: key })
  },
  async code(conn, chat, data, opts) {
    const body = codeText(data)
    if (body.length <= 1900) return sendDiscord(conn, chat, { text: body })
    const ext = CODE_EXT[String(data.language || 'text').toLowerCase()] || 'txt'
    const base = String(data.title || 'code').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'code'
    const fileName = /\.[a-z0-9]{1,5}$/i.test(base) ? base : `${base}.${ext}`
    return sendDiscord(conn, chat, {
      document: Buffer.from(data.code || '', 'utf8'),
      fileName,
      caption: [data.title, data.description].filter(Boolean).join('\n')
    })
  },
  async images(conn, chat, { text, urls }) {
    return sendDiscord(conn, chat, { text: text || '', embeds: urls.slice(0, 4).map(url => ({ image: { url } })) })
  },
  async html(conn, chat, { html, title }) {
    const base = String(title || 'design').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'design'
    return sendDiscord(conn, chat, {
      document: Buffer.from(html, 'utf8'),
      fileName: `${base.replace(/\.html?$/i, '')}.html`,
      caption: title ? String(title).slice(0, 80) : ''
    })
  }
}

const generic = {
  name: 'generic',
  features: ['plugins'],
  note: 'Keep replies concise and use plain text formatting. Platform-specific features are not available here.',
  resolveTarget(target) {
    return String(target || '').trim()
  },
  async send(conn, chat, content, { quoted } = {}) {
    if (typeof conn.sendMessage === 'function') return conn.sendMessage(chat, content, quoted ? { quoted } : undefined)
    const text = typeof content === 'string' ? content : content?.text || content?.caption || ''
    if (typeof conn.reply === 'function') return conn.reply(chat, text, quoted)
    throw new Error('This platform connection cannot send messages')
  },
  async edit(conn, chat, key, text) {
    return conn.sendMessage(chat, { edit: key, text })
  },
  async remove(conn, chat, key) {
    return conn.sendMessage(chat, { delete: key })
  },
  async code(conn, chat, data, opts) {
    return generic.send(conn, chat, { text: whatsappFallbackCode(data) }, opts)
  },
  async button(conn, chat, content, opts) {
    return generic.send(conn, chat, content, opts)
  },
  async images(conn, chat, { text, urls }, opts) {
    return generic.send(conn, chat, { image: { url: urls[0] }, caption: text || '' }, opts)
  },
  async html(conn, chat, { html, title }, opts) {
    return generic.send(conn, chat, {
      document: Buffer.from(html, 'utf8'),
      mimetype: 'text/html',
      fileName: `${String(title || 'design').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 40) || 'design'}.html`
    }, opts)
  }
}

export function registerPlatform(name, adapter) {
  adapters.set(String(name).toLowerCase(), { ...generic, ...adapter, name: String(name).toLowerCase() })
}

export function platformOf(m, fallback = 'whatsapp') {
  return String(m?.platform || fallback).toLowerCase()
}

export function adapterOf(name) {
  return adapters.get(String(name || 'whatsapp').toLowerCase()) || generic
}

export function platformHas(name, features = []) {
  const have = adapterOf(name).features
  return [].concat(features).every(feature => have.includes(feature))
}

export function listPlatforms() {
  return [...adapters.keys()]
}

adapters.set('whatsapp', whatsapp)
adapters.set('discord', discord)
