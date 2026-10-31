import { compile, matchComplex } from './select.js'

const LINE_HEIGHT = 18
const CHAR_WIDTH = 8

const NONE_TAGS = new Set(['area', 'base', 'basefont', 'datalist', 'head', 'link', 'meta', 'noembed', 'noframes', 'param', 'rp', 'script', 'style', 'template', 'title', 'noscript'])
const INLINE_TAGS = new Set(['a', 'abbr', 'acronym', 'b', 'bdi', 'bdo', 'big', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'font', 'i', 'ins', 'kbd', 'label', 'mark', 'q', 's', 'samp', 'small', 'span', 'strike', 'strong', 'sub', 'sup', 'time', 'tt', 'u', 'var', 'br', 'nobr', 'output', 'wbr'])
const ATOMIC_TAGS = new Set(['img', 'input', 'button', 'select', 'textarea', 'iframe', 'canvas', 'svg', 'video', 'audio', 'object', 'embed', 'meter', 'progress'])
const BLOCK_DISPLAY = new Set(['block', 'list-item', 'flex', 'grid', 'flow-root', 'table', 'table-row', 'table-cell', 'table-caption', 'table-row-group', 'table-header-group', 'table-footer-group'])
const TABLE_DISPLAY = { table: 'table', tr: 'table-row', td: 'table-cell', th: 'table-cell', thead: 'table-row-group', tbody: 'table-row-group', tfoot: 'table-row-group', caption: 'table-caption' }

const defaultDisplay = (el) => {
    const tag = el.localName
    if (el.hasAttribute('hidden')) return 'none'
    if (tag === 'input' && (el.getAttribute('type') ?? '').toLowerCase() === 'hidden') return 'none'
    if (tag === 'dialog' && !el.hasAttribute('open')) return 'none'
    if (NONE_TAGS.has(tag)) return 'none'
    if (tag === 'li') return 'list-item'
    if (TABLE_DISPLAY[tag]) return TABLE_DISPLAY[tag]
    if (ATOMIC_TAGS.has(tag)) return 'inline-block'
    if (INLINE_TAGS.has(tag)) return 'inline'
    return 'block'
}

const splitTopLevel = (text, separator) => {
    const out = []
    let depth = 0
    let quote = null
    let start = 0
    for (let i = 0; i < text.length; i++) {
        const c = text[i]
        if (quote) {
            if (c === '\\') i++
            else if (c === quote) quote = null
            continue
        }
        if (c === '"' || c === "'") quote = c
        else if (c === '(') depth++
        else if (c === ')') depth = Math.max(0, depth - 1)
        else if (c === separator && depth === 0) {
            out.push(text.slice(start, i))
            start = i + 1
        }
    }
    out.push(text.slice(start))
    return out
}

export const parseDeclarationList = (text) =>
    splitTopLevel(String(text ?? ''), ';')
        .map((part) => {
            const colon = part.indexOf(':')
            if (colon < 0) return null
            const name = part.slice(0, colon).trim().toLowerCase()
            let value = part.slice(colon + 1).trim()
            let important = false
            const flag = /!\s*important\s*$/i.exec(value)
            if (flag) {
                important = true
                value = value.slice(0, flag.index).trim()
            }
            if (!name || value === '') return null
            return { name, value, important }
        })
        .filter(Boolean)

export const parseDeclarations = (text) => new Map(parseDeclarationList(text).map((decl) => [decl.name, decl.value]))

export const serializeDeclarations = (map) => [...map].map(([name, value]) => `${name}: ${value}`).join('; ')

const skipBlock = (text, open) => {
    let depth = 0
    for (let j = open; j < text.length; j++) {
        if (text[j] === '{') depth++
        else if (text[j] === '}') {
            depth--
            if (depth === 0) return j + 1
        }
    }
    return text.length
}

const parseStylesheet = (css) => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
    const rules = []
    let i = 0
    while (i < text.length) {
        while (i < text.length && /\s/.test(text[i])) i++
        if (i >= text.length) break
        if (text[i] === '@') {
            const brace = text.indexOf('{', i)
            const semi = text.indexOf(';', i)
            if (semi !== -1 && (brace === -1 || semi < brace)) {
                i = semi + 1
                continue
            }
            if (brace === -1) break
            i = skipBlock(text, brace)
            continue
        }
        const brace = text.indexOf('{', i)
        if (brace === -1) break
        const end = skipBlock(text, brace)
        const selectorText = text.slice(i, brace).trim()
        const body = text.slice(brace + 1, Math.max(brace + 1, end - 1))
        i = end
        let selectors
        try {
            selectors = compile(selectorText)
        } catch {
            continue
        }
        rules.push({ selectors, decls: parseDeclarationList(body) })
    }
    return rules
}

const collectRules = (doc) => {
    const rules = []
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType !== 1) continue
            if (child.localName === 'style') rules.push(...parseStylesheet(child.textContent))
            else if (child.localName === 'link' && (child.getAttribute('rel') ?? '').toLowerCase().includes('stylesheet') && child._cssText) {
                rules.push(...parseStylesheet(child._cssText))
            }
            walk(child)
        }
    }
    walk(doc)
    return rules
}

const parseLength = (value) => {
    if (value === null || value === undefined) return null
    const text = String(value).trim().toLowerCase()
    const match = /^(-?\d*\.?\d+)(px|em|rem|pt|%)?$/.exec(text)
    if (!match) return null
    const amount = Number(match[1])
    switch (match[2]) {
        case '%':
            return { pct: amount }
        case 'em':
        case 'rem':
            return amount * 16
        case 'pt':
            return (amount * 4) / 3
        default:
            return amount
    }
}

const expandBox = (value) => {
    const parts = String(value).trim().split(/\s+/).map((part) => parseLength(part) ?? 0)
    const [top, right = top, bottom = top, left = right] = parts
    return { top, right, bottom, left }
}

const applyDecl = (style, name, value) => {
    switch (name) {
        case 'display':
            style.display = value.toLowerCase().split(/\s+/)[0]
            break
        case 'visibility':
            style.visibility = value.toLowerCase()
            break
        case 'width':
            style.width = parseLength(value)
            break
        case 'height':
            style.height = parseLength(value)
            break
        case 'margin':
            style.margin = expandBox(value)
            break
        case 'padding':
            style.padding = expandBox(value)
            break
        default: {
            const match = /^(margin|padding)-(top|right|bottom|left)$/.exec(name)
            if (match) style[match[1]][match[2]] = parseLength(value) ?? 0
        }
    }
}

const resolve = (value, base) => {
    if (typeof value === 'number') return value
    if (value && typeof value === 'object' && value.pct !== undefined) return (value.pct * base) / 100
    return 0
}

const depthOf = (el) => {
    let depth = 0
    for (let node = el.parentNode; node; node = node.parentNode) depth++
    return depth
}

const EMPTY_RECT = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }

export class Layout {
    constructor(doc) {
        this.doc = doc
        this.styleVersion = -1
        this.layoutVersion = -1
        this.styles = new Map()
        this.rules = []
        this.blockMemo = new Map()
        this.boxes = new Map()
        this.contentHeightValue = 0
    }

    ensureStyles() {
        if (this.styleVersion === this.doc._version) return
        this.styleVersion = this.doc._version
        this.styles = new Map()
        this.rules = collectRules(this.doc)
        this.blockMemo = new Map()
    }

    computed(el) {
        this.ensureStyles()
        const cached = this.styles.get(el)
        if (cached) return cached
        const parent = el.parentElement
        const style = {
            display: defaultDisplay(el),
            visibility: parent ? this.computed(parent).visibility : 'visible',
            width: null,
            height: null,
            margin: { top: 0, right: 0, bottom: 0, left: 0 },
            padding: { top: 0, right: 0, bottom: 0, left: 0 }
        }
        this.styles.set(el, style)
        const normal = []
        const important = []
        for (const rule of this.rules) {
            if (!rule.selectors.some((complex) => matchComplex(el, complex, { scope: el }))) continue
            for (const decl of rule.decls) (decl.important ? important : normal).push(decl)
        }
        for (const decl of parseDeclarationList(el.getAttribute('style') ?? '')) (decl.important ? important : normal).push(decl)
        for (const decl of [...normal, ...important]) applyDecl(style, decl.name, decl.value)
        if (style.display === 'none') style.visibility = style.visibility
        return style
    }

    isBlockLevel(el, style) {
        const display = style.display
        if (display === 'none') return false
        if (BLOCK_DISPLAY.has(display)) return true
        if (display.startsWith('inline')) return this.containsBlock(el)
        return true
    }

    containsBlock(el) {
        if (this.blockMemo.has(el)) return this.blockMemo.get(el)
        this.blockMemo.set(el, false)
        let result = false
        for (const child of el.childNodes) {
            if (child.nodeType !== 1) continue
            const style = this.computed(child)
            if (style.display !== 'none' && this.isBlockLevel(child, style)) {
                result = true
                break
            }
        }
        this.blockMemo.set(el, result)
        return result
    }

    atomSize(el, style, width) {
        const tag = el.localName
        const attrW = Number.parseFloat(el.getAttribute('width'))
        const attrH = Number.parseFloat(el.getAttribute('height'))
        let w = null
        let h = null
        if (style.width !== null) w = resolve(style.width, width)
        if (style.height !== null) h = resolve(style.height, 0)
        let dw = 0
        let dh = 0
        if (tag === 'input') {
            const type = el.type
            if (type === 'checkbox' || type === 'radio') {
                dw = 13
                dh = 13
            } else {
                dw = 150
                dh = 21
            }
        } else if (tag === 'button') {
            dw = el.textContent.length * CHAR_WIDTH + 16
            dh = 21
        } else if (tag === 'select') {
            dw = 150
            dh = 21
        } else if (tag === 'textarea') {
            dw = 200
            dh = 60
        } else if (tag === 'img') {
            dw = Number.isFinite(attrW) ? attrW : 0
            dh = Number.isFinite(attrH) ? attrH : 0
        } else if (tag === 'iframe' || tag === 'video' || tag === 'canvas' || tag === 'svg' || tag === 'object' || tag === 'embed') {
            dw = Number.isFinite(attrW) ? attrW : 300
            dh = Number.isFinite(attrH) ? attrH : 150
        } else if (tag === 'meter' || tag === 'progress') {
            dw = 160
            dh = 16
        }
        return { w: w ?? dw, h: h ?? dh }
    }

    isAtomic(el, style) {
        return ATOMIC_TAGS.has(el.localName) || style.display === 'inline-block'
    }

    layoutBlock(el, x, y, width, depth) {
        const style = this.computed(el)
        if (style.display === 'none') return 0
        const mt = resolve(style.margin.top, width)
        const mb = resolve(style.margin.bottom, width)
        const ml = resolve(style.margin.left, width)
        const mr = resolve(style.margin.right, width)
        const pt = resolve(style.padding.top, width)
        const pb = resolve(style.padding.bottom, width)
        const pl = resolve(style.padding.left, width)
        const pr = resolve(style.padding.right, width)
        const boxW = Math.max(0, style.width !== null ? resolve(style.width, width) : width - ml - mr)
        const boxX = x + ml
        const boxY = y + mt
        const contentX = boxX + pl
        const contentW = Math.max(0, boxW - pl - pr)
        const contentY = boxY + pt
        let cursor = contentY
        let run = []
        const flush = () => {
            if (run.length === 0) return
            cursor += this.inlineRun(run, contentX, cursor, contentW, depth + 1)
            run = []
        }
        for (const child of el.childNodes) {
            if (child.nodeType === 3) {
                run.push(child)
                continue
            }
            if (child.nodeType !== 1) continue
            const childStyle = this.computed(child)
            if (childStyle.display === 'none') continue
            if (this.isBlockLevel(child, childStyle)) {
                flush()
                cursor += this.layoutBlock(child, contentX, cursor, contentW, depth + 1)
            } else run.push(child)
        }
        flush()
        const contentH = cursor - contentY
        const boxH = style.height !== null ? resolve(style.height, 0) : pt + contentH + pb
        this.boxes.set(el, { x: boxX, y: boxY, width: boxW, height: boxH })
        return mt + boxH + mb
    }

    inlineRun(nodes, x, y, width, depth) {
        const segments = []
        const collect = (node, owners) => {
            if (node.nodeType === 3) {
                segments.push({ kind: 'text', text: node.data, owners })
                return
            }
            if (node.nodeType !== 1) return
            const style = this.computed(node)
            if (style.display === 'none') return
            if (node.localName === 'br') {
                segments.push({ kind: 'br' })
                return
            }
            if (this.isAtomic(node, style)) {
                const size = this.atomSize(node, style, width)
                segments.push({ kind: 'atom', el: node, w: size.w, h: size.h, owners })
                return
            }
            const next = [...owners, node]
            for (const child of node.childNodes) collect(child, next)
        }
        for (const node of nodes) collect(node, [])

        const fragments = new Map()
        const extend = (owners, x0, x1, y0, y1) => {
            for (const owner of owners) {
                const fragment = fragments.get(owner)
                if (!fragment) fragments.set(owner, { x0, x1, y0, y1 })
                else {
                    fragment.x0 = Math.min(fragment.x0, x0)
                    fragment.x1 = Math.max(fragment.x1, x1)
                    fragment.y0 = Math.min(fragment.y0, y0)
                    fragment.y1 = Math.max(fragment.y1, y1)
                }
            }
        }
        let lineX = 0
        let lineY = y
        let used = false
        const newline = () => {
            lineY += LINE_HEIGHT
            lineX = 0
        }
        for (const seg of segments) {
            if (seg.kind === 'br') {
                newline()
                continue
            }
            if (seg.kind === 'atom') {
                if (lineX > 0 && lineX + seg.w > width) newline()
                this.boxes.set(seg.el, { x: x + lineX, y: lineY, width: seg.w, height: seg.h })
                extend(seg.owners, x + lineX, x + lineX + seg.w, lineY, lineY + Math.max(seg.h, 1))
                lineX += seg.w
                used = true
                continue
            }
            for (const part of seg.text.split(/(\s+)/)) {
                if (part === '') continue
                if (/^\s+$/.test(part)) {
                    if (lineX > 0) lineX += CHAR_WIDTH
                    continue
                }
                const w = part.length * CHAR_WIDTH
                if (lineX > 0 && lineX + w > width) newline()
                extend(seg.owners, x + lineX, x + lineX + w, lineY, lineY + LINE_HEIGHT)
                lineX += w
                used = true
            }
        }
        for (const [owner, f] of fragments) {
            this.boxes.set(owner, { x: f.x0, y: f.y0, width: f.x1 - f.x0, height: f.y1 - f.y0 })
        }
        if (!used) return 0
        return lineX > 0 ? lineY - y + LINE_HEIGHT : lineY - y
    }

    refresh() {
        this.ensureStyles()
        if (this.layoutVersion === this.doc._version) return
        this.layoutVersion = this.doc._version
        this.boxes = new Map()
        const root = this.doc.documentElement
        this.contentHeightValue = root ? this.layoutBlock(root, 0, 0, this.doc.viewport.width, 0) : 0
    }

    get contentHeight() {
        this.refresh()
        return this.contentHeightValue
    }

    boxOf(el) {
        this.refresh()
        return this.boxes.get(el) ?? null
    }

    clientRect(el) {
        const box = this.boxOf(el)
        if (!box) return { ...EMPTY_RECT }
        const y = box.y - this.doc.scrollY
        return {
            x: box.x,
            y,
            width: box.width,
            height: box.height,
            top: y,
            left: box.x,
            right: box.x + box.width,
            bottom: y + box.height,
            toJSON() {
                return { x: this.x, y: this.y, width: this.width, height: this.height, top: this.top, left: this.left, right: this.right, bottom: this.bottom }
            }
        }
    }

    hitTest(clientX, clientY) {
        this.refresh()
        const x = clientX
        const y = clientY + this.doc.scrollY
        let best = null
        let bestDepth = -1
        for (const [el, box] of this.boxes) {
            if (box.width <= 0 || box.height <= 0) continue
            if (x < box.x || x >= box.x + box.width || y < box.y || y >= box.y + box.height) continue
            const style = this.computed(el)
            if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') continue
            const depth = depthOf(el)
            if (depth >= bestDepth) {
                best = el
                bestDepth = depth
            }
        }
        return best
    }
}
