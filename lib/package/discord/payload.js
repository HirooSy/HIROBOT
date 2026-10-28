import fs from 'fs'
import path from 'path'

const FILE_LIMIT = 24 * 1024 * 1024
const KINDS = ['image', 'video', 'audio', 'document', 'sticker']
const NAMES = { image: 'image.png', video: 'video.mp4', audio: 'audio.mp3', document: 'file', sticker: 'sticker.webp' }

function nameFromRef(ref, fallback) {
  try {
    const base = path.basename(new URL(ref).pathname)
    return /\.[a-z0-9]{1,5}$/i.test(base) ? base : fallback
  } catch {
    return fallback
  }
}

export async function fileOf(source, fallbackName) {
  if (!source) return {}
  if (Buffer.isBuffer(source)) return { buffer: source, name: fallbackName }
  if (source instanceof Uint8Array) return { buffer: Buffer.from(source), name: fallbackName }
  if (typeof source === 'object') {
    const named = source.name || source.fileName || fallbackName
    const raw = source.buffer ?? source.attachment ?? source.data
    if (Buffer.isBuffer(raw)) return { buffer: raw, name: named }
    const inner = await fileOf(source.url || source.path, named)
    return inner.name === named || !source.name ? inner : { ...inner, name: named }
  }
  const ref = String(source)
  if (/^https?:\/\//i.test(ref)) {
    try {
      const res = await fetch(ref)
      if (!res.ok) return { url: ref }
      const buffer = Buffer.from(await res.arrayBuffer())
      if (buffer.length > FILE_LIMIT) return { url: ref }
      return { buffer, name: nameFromRef(ref, fallbackName) }
    } catch {
      return { url: ref }
    }
  }
  if (/^data:/i.test(ref)) return { buffer: Buffer.from(ref.split(',')[1] || '', 'base64'), name: fallbackName }
  if (fs.existsSync(ref)) {
    if (fs.statSync(ref).size > FILE_LIMIT) throw new Error('The file is too large to upload on Discord')
    return { buffer: fs.readFileSync(ref), name: path.basename(ref) }
  }
  return {}
}

export async function resolveMedia(payload) {
  const input = typeof payload === 'string' ? { text: payload } : { ...(payload || {}) }
  const files = [].concat(input.files || [], input.file || [])
  let text = input.text ?? input.content ?? ''
  if (!text && input.caption) text = input.caption
  for (const kind of KINDS) {
    if (input[kind] === undefined || input[kind] === null) continue
    for (const source of [].concat(input[kind])) {
      const file = await fileOf(source, (!files.length && input.fileName) || NAMES[kind])
      if (file.buffer) files.push({ attachment: file.buffer, name: file.name })
      else if (file.url) text = [text, file.url].filter(Boolean).join('\n')
    }
    delete input[kind]
  }
  for (const key of ['caption', 'fileName', 'mimetype', 'file', 'content', 'gifPlayback', 'ptt']) delete input[key]
  delete input.text
  if (files.length) input.files = files.slice(0, 10)
  if (text) input.text = text
  return input
}

const BLANK = '\u0000'
const actionOf = value => String(value).replace(/^[.\/!#]/, '')
const labelOf = value => (value && value !== BLANK ? String(value) : '')

export function flowToDiscord(flow = []) {
  const button = []
  const select = []
  for (const item of flow || []) {
    if (!item || typeof item !== 'object') continue
    const label = labelOf(item.text || item.displayText)
    if (Array.isArray(item.sections) && item.sections.length) {
      const options = []
      for (const section of item.sections) {
        for (const row of section.rows || []) {
          const action = row.id || row.rowId
          if (!action) continue
          const header = labelOf(row.header)
          const title = labelOf(row.title)
          const description = [header ? title : '', labelOf(row.description)].filter(Boolean).join(' · ')
          options.push({
            label: (header || title || '-').slice(0, 100),
            ...(description ? { description: description.slice(0, 100) } : {}),
            action: actionOf(action)
          })
        }
      }
      if (options.length) select.push({ placeholder: label || 'Select', options: options.slice(0, 25) })
      continue
    }
    if (!label) continue
    if (item.url && /^https?:\/\//i.test(item.url)) button.push({ label, url: item.url })
    else if (item.id) button.push({ label, action: actionOf(item.id) })
  }
  return { button, select }
}
