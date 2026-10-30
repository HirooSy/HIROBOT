import fs from 'fs'
import path from 'path'
import { canvas } from 'hiro/canvas'

const FILE_LIMIT = 24 * 1024 * 1024

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
  for (const kind of ['image', 'video', 'audio', 'document', 'sticker']) {
    if (input[kind] === undefined || input[kind] === null) continue
    for (const source of [].concat(input[kind])) {
      const file = await fileOf(source, (!files.length && input.fileName) || { image: 'image.png', video: 'video.mp4', audio: 'audio.mp3', document: 'file', sticker: 'sticker.webp' }[kind])
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

const actionOf = value => String(value).replace(/^[.\/!#]/, '')
const labelOf = value => (value && value !== '\u0000' ? String(value) : '')

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

export async function buildGallery(images, files = []) {
  const items = []
  for (const source of [].concat(images || []).slice(0, 10)) {
    if (typeof source === 'string' && /^https?:\/\//i.test(source)) {
      items.push({ media: { url: source } })
      continue
    }
    const file = await fileOf(source, 'image.png')
    if (!file.buffer) continue
    const name = `${files.length}_${file.name}`
    files.push({ attachment: file.buffer, name })
    items.push({ media: { url: `attachment://${name}` } })
  }
  return { items, files }
}

const RATING_COLORS = { s: '#34c759', q: '#ffcc00', e: '#ff3b30' }

const gridEscape = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')

function formatCount(value) {
  const number = Number(value) || 0
  return number >= 1000 ? `${(number / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(number)
}

export function buildGridHtml(cells, { columns = 5, cell = 200, gap = 8, pad = 8 } = {}) {
  const width = columns * cell + (columns - 1) * gap + pad * 2
  const body = cells.map((item, index) => {
    const number = item.number ?? index + 1
    const image = item.src
      ? `<img src="${item.src}" style="width:${cell}px;height:${cell}px;object-fit:cover;display:block">`
      : `<div style="width:${cell}px;height:${cell}px;background:#3a3a3c;color:#ffffff;font-size:14px;text-align:center;line-height:${cell}px">${gridEscape(item.empty || '?')}</div>`
    const tag = item.tag
      ? `<div style="position:absolute;top:6px;right:6px;padding:2px 7px;border-radius:7px;background:rgba(0,0,0,0.65);color:#ffffff;font-size:13px">${gridEscape(item.tag)}</div>`
      : ''
    const footer = item.footer
      ? `<div style="width:${cell}px;height:26px;background:#1c1c1e;color:#ffffff;font-size:14px;text-align:center;line-height:26px;white-space:nowrap">${item.footer}</div>`
      : ''
    return `<div style="position:relative;width:${cell}px;border-radius:12px;overflow:hidden;background:#1c1c1e">
      <div style="position:relative;width:${cell}px;height:${cell}px">
        ${image}
        <div style="position:absolute;top:6px;left:6px;min-width:26px;padding:2px 8px;border-radius:12px;background:rgba(0,0,0,0.65);color:#ffffff;font-size:14px;text-align:center">${number}</div>
        ${tag}
      </div>
      ${footer}
    </div>`
  }).join('')
  return {
    width,
    html: `<!DOCTYPE html><html><head><meta charset="utf-8"><style>*{box-sizing:border-box;margin:0;padding:0}body{width:${width}px;padding:${pad}px;background:#2b2d31;font-family:sans-serif}.grid{display:grid;grid-template-columns:repeat(${columns},${cell}px);gap:${gap}px}</style></head><body><div class="grid">${body}</div></body></html>`
  }
}

export function ratingFooter(rating, favorites) {
  const key = String(rating || '?').toLowerCase()
  const color = RATING_COLORS[key] || '#8e8e93'
  return `<span style="color:#ff3b30">&#9829;</span> ${formatCount(favorites)} - <span style="color:${color}">${gridEscape(key.toUpperCase())}</span>`
}

export async function renderGrid(cells, options = {}) {
  const { html, width } = buildGridHtml(cells, options)
  const rendered = await canvas.html(html, { width, scale: 1, transparent: false, background: '#2b2d31', allowNetwork: false })
  return rendered.toBuffer('image/jpeg', { quality: 85 })
}
