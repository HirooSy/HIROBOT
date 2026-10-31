import { Comment, DocumentType, Text, makeElement } from './dom.js'

const VOID = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript'])
const ESCAPABLE = new Set(['textarea', 'title'])
const HEAD_TAGS = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'title', 'noscript', 'script', 'style', 'template'])
const CLOSE_P = new Set(['address', 'article', 'aside', 'blockquote', 'center', 'details', 'dialog', 'dir', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'ul', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'listing', 'plaintext', 'table', 'xmp'])
const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6'])
const SCOPE = new Set(['applet', 'caption', 'html', 'table', 'td', 'th', 'marquee', 'object', 'template', 'button'])
const TAG_OPEN = /<([A-Za-z][^\s/>]*)/y
const TAG_CLOSE = /<\/([A-Za-z][^\s/>]*)[^>]*>/y
const ATTR_NAME = /[^\s/>][^\s/>=]*/y
const UNQUOTED = /[^\s>]*/y

const NAMED = new Map([
    ['amp', '&'], ['lt', '<'], ['gt', '>'], ['quot', '"'], ['apos', "'"], ['nbsp', '\u00a0'], ['copy', '\u00a9'],
    ['reg', '\u00ae'], ['trade', '\u2122'], ['hellip', '\u2026'], ['mdash', '\u2014'], ['ndash', '\u2013'],
    ['lsquo', '\u2018'], ['rsquo', '\u2019'], ['ldquo', '\u201c'], ['rdquo', '\u201d'], ['bull', '\u2022'],
    ['middot', '\u00b7'], ['euro', '\u20ac'], ['pound', '\u00a3'], ['yen', '\u00a5'], ['cent', '\u00a2'],
    ['times', '\u00d7'], ['laquo', '\u00ab'], ['raquo', '\u00bb'], ['deg', '\u00b0'], ['plusmn', '\u00b1'],
    ['frac12', '\u00bd'], ['para', '\u00b6'], ['sect', '\u00a7'], ['larr', '\u2190'], ['rarr', '\u2192'],
    ['uarr', '\u2191'], ['darr', '\u2193'], ['hearts', '\u2665'], ['check', '\u2713'], ['shy', '\u00ad']
])

export const decodeEntities = (text) => {
    if (!text.includes('&')) return text
    return text.replace(/&(#[xX][0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);?/g, (match, body) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10)
            if (!(code > 0 && code <= 0x10ffff) || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
            return String.fromCodePoint(code)
        }
        return NAMED.get(body) ?? match
    })
}

const readAttributes = (src, start) => {
    const attrs = []
    let pos = start
    let selfClosing = false
    const len = src.length
    for (;;) {
        while (pos < len && (/\s/.test(src[pos]) || src[pos] === '/')) {
            if (src[pos] === '/' && src[pos + 1] === '>') selfClosing = true
            pos++
        }
        if (pos >= len) return { attrs, selfClosing, end: len }
        if (src[pos] === '>') return { attrs, selfClosing, end: pos + 1 }
        selfClosing = false
        ATTR_NAME.lastIndex = pos
        const nameMatch = ATTR_NAME.exec(src)
        if (!nameMatch) {
            pos++
            continue
        }
        pos += nameMatch[0].length
        const name = nameMatch[0].toLowerCase()
        while (pos < len && /\s/.test(src[pos])) pos++
        let value = ''
        if (src[pos] === '=') {
            pos++
            while (pos < len && /\s/.test(src[pos])) pos++
            const quote = src[pos]
            if (quote === '"' || quote === "'") {
                const close = src.indexOf(quote, pos + 1)
                const stop = close === -1 ? len : close
                value = decodeEntities(src.slice(pos + 1, stop))
                pos = close === -1 ? len : close + 1
            } else {
                UNQUOTED.lastIndex = pos
                const raw = UNQUOTED.exec(src)[0]
                value = decodeEntities(raw)
                pos += raw.length
            }
        }
        if (!attrs.some(([key]) => key === name)) attrs.push([name, value])
    }
}

class Builder {
    constructor(root, fragment, src) {
        this.root = root
        this.fragment = fragment
        this.doc = fragment ? root._doc : root
        this.stack = [root]
        this.html = null
        this.head = null
        this.body = null
        this.src = src
        this.pos = 0
    }

    top() {
        return this.stack.at(-1)
    }

    ensureHtml(attrs = []) {
        if (!this.html) {
            this.html = makeElement(this.doc, 'html', attrs)
            this.doc.appendChild(this.html)
            this.stack.push(this.html)
        }
        return this.html
    }

    ensureHead() {
        if (!this.head) {
            this.ensureHtml()
            this.head = makeElement(this.doc, 'head')
            this.html.appendChild(this.head)
        }
        return this.head
    }

    ensureBody() {
        if (!this.body) {
            this.ensureHtml()
            this.ensureHead()
            this.body = makeElement(this.doc, 'body')
            this.html.appendChild(this.body)
        }
        return this.body
    }

    resolveParent(node) {
        if (this.fragment) return this.top()
        if (this.stack.length === 1) this.ensureHtml()
        const isHeadTag = node !== null && node.nodeType === 1 && HEAD_TAGS.has(node.localName)
        let top = this.top()
        if (top === this.head && !isHeadTag) {
            this.stack.pop()
            top = this.top()
        }
        if (top === this.html) return isHeadTag && !this.body ? this.ensureHead() : this.ensureBody()
        return top
    }

    place(node) {
        this.resolveParent(node).appendChild(node)
    }

    popTo(names, stop) {
        for (let i = this.stack.length - 1; i >= 1; i--) {
            const name = this.stack[i].localName
            if (names.has(name)) {
                this.stack.length = i
                return true
            }
            if (stop.has(name)) return false
        }
        return false
    }

    implicitClose(name) {
        if (CLOSE_P.has(name)) this.popTo(new Set(['p']), SCOPE)
        else if (name === 'li') this.popTo(new Set(['li']), new Set(['ul', 'ol', 'menu', 'table', 'html']))
        else if (name === 'dd' || name === 'dt') this.popTo(new Set(['dd', 'dt']), new Set(['dl', 'table', 'html']))
        else if (name === 'option') {
            if (this.top().localName === 'option') this.stack.pop()
        } else if (name === 'optgroup') {
            if (this.top().localName === 'option') this.stack.pop()
            if (this.top().localName === 'optgroup') this.stack.pop()
        } else if (name === 'tr') {
            this.popTo(new Set(['tr']), new Set(['tbody', 'thead', 'tfoot', 'table', 'html']))
            if (this.top().localName === 'table') this.pushImplicit('tbody')
        } else if (name === 'td' || name === 'th') {
            this.popTo(new Set(['td', 'th']), new Set(['tr', 'table', 'html']))
            if (['table', 'tbody', 'thead', 'tfoot'].includes(this.top().localName)) this.pushImplicit('tr')
        } else if (name === 'thead' || name === 'tbody' || name === 'tfoot') {
            this.popTo(new Set(['thead', 'tbody', 'tfoot']), new Set(['table', 'html']))
        } else if (HEADINGS.has(name)) {
            if (HEADINGS.has(this.top().localName)) this.stack.pop()
        } else if (name === 'a') this.popTo(new Set(['a']), SCOPE)
        else if (name === 'button') this.popTo(new Set(['button']), SCOPE)
    }

    pushImplicit(name) {
        const el = makeElement(this.doc, name)
        this.place(el)
        this.stack.push(el)
    }

    text(raw) {
        if (!raw) return
        const top = this.top()
        if (!this.fragment && /^\s*$/.test(raw) && (top === this.root || top === this.html || top === this.head)) return
        const parent = this.resolveParent(null)
        const data = decodeEntities(raw)
        const last = parent.childNodes.at(-1)
        if (last && last.nodeType === 3) last.data += data
        else parent.appendChild(new Text(this.doc, data))
    }

    comment(data) {
        this.top().appendChild(new Comment(this.doc, data))
    }

    doctype(body) {
        if (this.fragment || this.stack.length !== 1) return
        const name = body.split(/\s+/)[0]?.toLowerCase() ?? 'html'
        this.doc.appendChild(new DocumentType(this.doc, name))
    }

    startTag(name, attrs, selfClosing) {
        if (this.fragment && (name === 'html' || name === 'head' || name === 'body')) return null
        if (!this.fragment && name === 'html') {
            if (this.html) for (const [key, value] of attrs) if (!this.html.hasAttribute(key)) this.html.setAttribute(key, value)
            else this.ensureHtml(attrs)
            return null
        }
        if (!this.fragment && name === 'head') {
            if (!this.head && !this.body) {
                this.ensureHtml()
                this.head = makeElement(this.doc, 'head', attrs)
                this.html.appendChild(this.head)
                this.stack.push(this.head)
            }
            return null
        }
        if (!this.fragment && name === 'body') {
            if (!this.body) {
                this.ensureHtml()
                this.ensureHead()
                this.body = makeElement(this.doc, 'body', attrs)
                this.html.appendChild(this.body)
                this.stack.push(this.body)
            } else for (const [key, value] of attrs) if (!this.body.hasAttribute(key)) this.body.setAttribute(key, value)
            return null
        }
        if (name === 'form' && this.stack.some((node) => node.localName === 'form')) return null
        this.implicitClose(name)
        const el = makeElement(this.doc, name, attrs)
        if (name === 'script' && this.fragment) el._alreadyStarted = true
        this.place(el)
        if (VOID.has(name) || selfClosing) return null
        this.stack.push(el)
        if (RAW.has(name) || ESCAPABLE.has(name)) this.rawText(el, name)
        return el
    }

    rawText(el, name) {
        const pattern = new RegExp(`</${name}[\\s/>]`, 'ig')
        pattern.lastIndex = this.pos
        const match = pattern.exec(this.src)
        const end = match ? match.index : this.src.length
        let content = this.src.slice(this.pos, end)
        if (ESCAPABLE.has(name)) content = decodeEntities(content)
        if (content) el.appendChild(new Text(this.doc, content))
        const close = match ? this.src.indexOf('>', end) : -1
        this.pos = close === -1 ? this.src.length : close + 1
        if (this.top() === el) this.stack.pop()
    }

    endTag(name) {
        if (VOID.has(name) || name === 'html' || name === 'body') return
        for (let i = this.stack.length - 1; i >= 1; i--) {
            if (this.stack[i].localName === name) {
                this.stack.length = i
                return
            }
        }
    }

    run() {
        const src = this.src
        const len = src.length
        while (this.pos < len) {
            const lt = src.indexOf('<', this.pos)
            if (lt === -1) {
                this.text(src.slice(this.pos))
                this.pos = len
                break
            }
            if (lt > this.pos) this.text(src.slice(this.pos, lt))
            this.pos = lt
            if (src.startsWith('<!--', this.pos)) {
                const end = src.indexOf('-->', this.pos + 4)
                this.comment(src.slice(this.pos + 4, end === -1 ? len : end))
                this.pos = end === -1 ? len : end + 3
                continue
            }
            if (src[this.pos + 1] === '!') {
                const end = src.indexOf('>', this.pos)
                const body = src.slice(this.pos + 2, end === -1 ? len : end)
                if (/^doctype/i.test(body)) this.doctype(body.slice(7).trim())
                this.pos = end === -1 ? len : end + 1
                continue
            }
            if (src[this.pos + 1] === '?') {
                const end = src.indexOf('>', this.pos)
                this.pos = end === -1 ? len : end + 1
                continue
            }
            TAG_OPEN.lastIndex = this.pos
            const open = TAG_OPEN.exec(src)
            if (open) {
                this.pos += open[0].length
                const { attrs, selfClosing, end } = readAttributes(src, this.pos)
                this.pos = end
                this.startTag(open[1].toLowerCase(), attrs, selfClosing)
                continue
            }
            TAG_CLOSE.lastIndex = this.pos
            const close = TAG_CLOSE.exec(src)
            if (close) {
                this.pos += close[0].length
                this.endTag(close[1].toLowerCase())
                continue
            }
            this.text('<')
            this.pos++
        }
        if (!this.fragment) {
            this.ensureBody()
        }
    }
}

export const parseDocumentHtml = (doc, source) => {
    new Builder(doc, false, source).run()
    return doc
}

export const parseHtmlFragment = (source, container) => {
    new Builder(container, true, source).run()
    return container
}
