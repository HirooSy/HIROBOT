const VOID_ELEMENTS = new Set(['area', 'base', 'basefont', 'bgsound', 'br', 'col', 'embed', 'frame', 'hr', 'image', 'img', 'input', 'keygen', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_TEXT = new Set(['script', 'style', 'noscript'])
const ESCAPABLE_RAW = new Set(['textarea', 'title'])
const CLOSES_P = new Set(['address', 'article', 'aside', 'blockquote', 'details', 'dialog', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul'])
const P_BARRIERS = ['table', 'td', 'th', 'caption', 'button', 'object', 'applet', 'marquee', 'template', 'html']
const HEADING = /^h[1-6]$/
const SVG_CAMEL_CASE = [
    'attributeName', 'attributeType', 'baseFrequency', 'baseProfile', 'calcMode', 'clipPathUnits', 'diffuseConstant', 'edgeMode',
    'filterUnits', 'glyphRef', 'gradientTransform', 'gradientUnits', 'kernelMatrix', 'kernelUnitLength', 'keyPoints', 'keySplines',
    'keyTimes', 'lengthAdjust', 'limitingConeAngle', 'markerHeight', 'markerUnits', 'markerWidth', 'maskContentUnits', 'maskUnits',
    'numOctaves', 'pathLength', 'patternContentUnits', 'patternTransform', 'patternUnits', 'pointsAtX', 'pointsAtY', 'pointsAtZ',
    'preserveAlpha', 'preserveAspectRatio', 'primitiveUnits', 'refX', 'refY', 'repeatCount', 'repeatDur', 'requiredExtensions',
    'requiredFeatures', 'specularConstant', 'specularExponent', 'spreadMethod', 'startOffset', 'stdDeviation', 'stitchTiles',
    'surfaceScale', 'systemLanguage', 'tableValues', 'targetX', 'targetY', 'textLength', 'viewBox', 'viewTarget',
    'xChannelSelector', 'yChannelSelector', 'zoomAndPan'
]
const SVG_ATTRIBUTE_NAMES = new Map(SVG_CAMEL_CASE.map(name => [name.toLowerCase(), name]))
const SVG_TAG_NAMES = new Map([
    'altGlyph', 'altGlyphDef', 'altGlyphItem', 'animateColor', 'animateMotion', 'animateTransform', 'clipPath', 'feBlend',
    'feColorMatrix', 'feComponentTransfer', 'feComposite', 'feConvolveMatrix', 'feDiffuseLighting', 'feDisplacementMap',
    'feDistantLight', 'feDropShadow', 'feFlood', 'feFuncA', 'feFuncB', 'feFuncG', 'feFuncR', 'feGaussianBlur', 'feImage',
    'feMerge', 'feMergeNode', 'feMorphology', 'feOffset', 'fePointLight', 'feSpecularLighting', 'feSpotLight', 'feTile',
    'feTurbulence', 'foreignObject', 'glyphRef', 'linearGradient', 'radialGradient', 'textPath'
].map(name => [name.toLowerCase(), name]))
const HEAD_TAGS = new Set(['base', 'basefont', 'bgsound', 'link', 'meta', 'noframes', 'noscript', 'script', 'style', 'template', 'title'])
const RAW_CLOSERS = new Map([...RAW_TEXT, ...ESCAPABLE_RAW].map(name => [name, new RegExp(`</${name}[\\s/>]`, 'gi')]))
const NO_CHILDREN = Object.freeze([])
const NO_ATTRIBS = Object.freeze({})

const ENTITIES = {
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', copy: '\u00a9', reg: '\u00ae', trade: '\u2122',
    hellip: '\u2026', mdash: '\u2014', ndash: '\u2013', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201c', rdquo: '\u201d',
    sbquo: '\u201a', bdquo: '\u201e', bull: '\u2022', middot: '\u00b7', laquo: '\u00ab', raquo: '\u00bb', euro: '\u20ac',
    pound: '\u00a3', yen: '\u00a5', cent: '\u00a2', times: '\u00d7', divide: '\u00f7', deg: '\u00b0', plusmn: '\u00b1',
    para: '\u00b6', sect: '\u00a7', shy: '\u00ad', frac12: '\u00bd', frac14: '\u00bc', frac34: '\u00be', sup2: '\u00b2',
    sup3: '\u00b3', micro: '\u00b5', iexcl: '\u00a1', iquest: '\u00bf', larr: '\u2190', rarr: '\u2192', uarr: '\u2191',
    darr: '\u2193', harr: '\u2194', hearts: '\u2665', dagger: '\u2020', Dagger: '\u2021', permil: '\u2030', prime: '\u2032',
    Prime: '\u2033', oline: '\u203e', ensp: '\u2002', emsp: '\u2003', thinsp: '\u2009', zwj: '\u200d', zwnj: '\u200c',
    lrm: '\u200e', rlm: '\u200f', eacute: '\u00e9', egrave: '\u00e8', agrave: '\u00e0', aacute: '\u00e1', ccedil: '\u00e7',
    ntilde: '\u00f1', ouml: '\u00f6', uuml: '\u00fc', auml: '\u00e4', szlig: '\u00df', oacute: '\u00f3', iacute: '\u00ed',
    uacute: '\u00fa', Eacute: '\u00c9', Auml: '\u00c4', Ouml: '\u00d6', Uuml: '\u00dc', ecirc: '\u00ea', acirc: '\u00e2',
    ocirc: '\u00f4', ucirc: '\u00fb', icirc: '\u00ee', ograve: '\u00f2', ugrave: '\u00f9', igrave: '\u00ec'
}

const decodeEntities = (text) => text.indexOf('&') === -1 ? text : text.replace(/&(#[xX][\da-fA-F]+|#\d+|[a-zA-Z][a-zA-Z\d]*);?/g, (match, body) => {
    if (body[0] === '#') {
        const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
        if (!code || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd'
        return String.fromCodePoint(code)
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, body) ? ENTITIES[body] : match
})

const encodeText = (text) => text.replace(/[&<>\u00a0]/g, (ch) => ch === '&' ? '&amp;' : ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : '&nbsp;')
const encodeAttribute = (text) => text.replace(/[&"\u00a0]/g, (ch) => ch === '&' ? '&amp;' : ch === '"' ? '&quot;' : '&nbsp;')

const isSpace = (code) => code === 32 || code === 9 || code === 10 || code === 12 || code === 13
const isAlpha = (code) => (code >= 65 && code <= 90) || (code >= 97 && code <= 122)
const isTagNameEnd = (code) => isSpace(code) || code === 47 || code === 62 || Number.isNaN(code)

function createNode(type, name, data) {
    return { type, name, data, attribs: NO_ATTRIBS, children: NO_CHILDREN, parent: null, prev: null, next: null }
}

function createElement(name, attribs) {
    const type = name === 'script' ? 'script' : name === 'style' ? 'style' : 'tag'
    return { type, name, data: null, attribs, children: [], parent: null, prev: null, next: null }
}

function appendChild(parent, node) {
    node.parent = parent
    const last = parent.children[parent.children.length - 1]
    if (last) {
        last.next = node
        node.prev = last
    }
    parent.children.push(node)
}

function appendText(parent, data) {
    if (!data) return
    const last = parent.children[parent.children.length - 1]
    if (last && last.type === 'text') {
        last.data += data
        return
    }
    appendChild(parent, createNode('text', '', data))
}

function readStartTag(html, start) {
    const length = html.length
    let pos = start
    while (pos < length && !isTagNameEnd(html.charCodeAt(pos))) pos++
    const name = html.slice(start, pos).toLowerCase()
    const attribs = {}
    let selfClosing = false
    while (pos < length) {
        const code = html.charCodeAt(pos)
        if (isSpace(code)) {
            pos++
            continue
        }
        if (code === 62) {
            pos++
            break
        }
        if (code === 47) {
            if (html.charCodeAt(pos + 1) === 62) {
                selfClosing = true
                pos += 2
                break
            }
            pos++
            continue
        }
        let nameEnd = pos + 1
        while (nameEnd < length) {
            const c = html.charCodeAt(nameEnd)
            if (isSpace(c) || c === 61 || c === 62 || c === 47) break
            nameEnd++
        }
        const attrName = html.slice(pos, nameEnd).toLowerCase()
        pos = nameEnd
        while (pos < length && isSpace(html.charCodeAt(pos))) pos++
        let value = ''
        if (html.charCodeAt(pos) === 61) {
            pos++
            while (pos < length && isSpace(html.charCodeAt(pos))) pos++
            const quote = html.charCodeAt(pos)
            if (quote === 34 || quote === 39) {
                const close = html.indexOf(quote === 34 ? '"' : "'", pos + 1)
                const end = close === -1 ? length : close
                value = decodeEntities(html.slice(pos + 1, end))
                pos = end + 1
            } else {
                let end = pos
                while (end < length) {
                    const c = html.charCodeAt(end)
                    if (isSpace(c) || c === 62) break
                    end++
                }
                value = decodeEntities(html.slice(pos, end))
                pos = end
            }
        }
        if (attrName !== '__proto__' && !Object.prototype.hasOwnProperty.call(attribs, attrName)) attribs[attrName] = value
    }
    return { name, attribs, selfClosing, end: pos }
}

function parseDocument(html, fragment = false) {
    const root = createNode('root', '', null)
    root.children = []
    const stack = [root]
    const length = html.length
    const top = () => stack[stack.length - 1]

    let htmlEl = null
    let bodyEl = null
    let headSeen = false
    if (!fragment) {
        htmlEl = createElement('html', {})
        appendChild(root, htmlEl)
        const headEl = createElement('head', {})
        appendChild(htmlEl, headEl)
        stack.push(htmlEl, headEl)
    }

    const enterBody = (attribs = {}) => {
        if (fragment || bodyEl) return
        const headIndex = stack.findIndex(node => node.name === 'head')
        if (headIndex !== -1) stack.length = headIndex
        bodyEl = createElement('body', attribs)
        appendChild(htmlEl, bodyEl)
        stack.push(bodyEl)
    }

    const closeUntil = (targets, barriers) => {
        for (let i = stack.length - 1; i > 0; i--) {
            const name = stack[i].name
            if (targets.includes(name)) {
                stack.length = i
                return
            }
            if (barriers.includes(name)) return
        }
    }

    const autoClose = (name) => {
        if (CLOSES_P.has(name)) closeUntil(['p'], P_BARRIERS)
        switch (name) {
            case 'li':
                closeUntil(['li'], ['ul', 'ol', 'menu'])
                return
            case 'dd':
            case 'dt':
                closeUntil(['dd', 'dt'], ['dl'])
                return
            case 'option':
                if (top().name === 'option') stack.pop()
                return
            case 'optgroup':
                if (top().name === 'option') stack.pop()
                if (top().name === 'optgroup') stack.pop()
                return
            case 'tr':
                closeUntil(['tr'], ['table', 'thead', 'tbody', 'tfoot'])
                return
            case 'td':
            case 'th':
                closeUntil(['td', 'th'], ['tr', 'table'])
                return
            case 'thead':
            case 'tbody':
            case 'tfoot':
                closeUntil(['thead', 'tbody', 'tfoot'], ['table'])
                return
            default:
                if (HEADING.test(name) && HEADING.test(top().name)) stack.pop()
        }
    }

    let pos = 0
    let textFrom = 0
    const flushText = (end) => {
        if (end <= textFrom) return
        const data = decodeEntities(html.slice(textFrom, end))
        if (!fragment) {
            if (/\S/.test(data)) {
                if (!bodyEl) enterBody()
            } else if (top() === root || (!headSeen && !bodyEl)) {
                return
            }
        }
        appendText(top(), data)
    }

    for (;;) {
        const lt = html.indexOf('<', pos)
        if (lt === -1) break
        const next = html.charCodeAt(lt + 1)

        if (next === 33 || next === 63) {
            flushText(lt)
            if (html.startsWith('<!--', lt)) {
                let end = html.indexOf('-->', lt + 4)
                if (end === -1) end = length
                appendChild(top(), createNode('comment', '', html.slice(lt + 4, end)))
                pos = end + 3
            } else {
                let end = html.indexOf('>', lt)
                if (end === -1) end = length
                appendChild(root, createNode('directive', '', html.slice(lt + 1, end)))
                pos = end + 1
            }
            textFrom = pos
            continue
        }

        if (next === 47) {
            if (!isAlpha(html.charCodeAt(lt + 2))) {
                pos = lt + 1
                continue
            }
            flushText(lt)
            let nameEnd = lt + 2
            while (nameEnd < length && !isTagNameEnd(html.charCodeAt(nameEnd))) nameEnd++
            const name = html.slice(lt + 2, nameEnd).toLowerCase()
            let end = html.indexOf('>', nameEnd)
            if (end === -1) end = length
            let found = false
            if (name === 'body' || name === 'html') {
                pos = end + 1
                textFrom = pos
                continue
            }
            for (let i = stack.length - 1; i > 0; i--) {
                if (stack[i].name.toLowerCase() === name) {
                    stack.length = i
                    found = true
                    break
                }
            }
            if (!found && name === 'p') appendChild(top(), createElement('p', {}))
            pos = end + 1
            textFrom = pos
            continue
        }

        if (!isAlpha(next)) {
            pos = lt + 1
            continue
        }

        flushText(lt)
        const tag = readStartTag(html, lt + 1)
        pos = tag.end
        textFrom = pos

        if (tag.name === 'html' && htmlEl) {
            htmlEl.attribs = { ...htmlEl.attribs, ...tag.attribs }
            continue
        }
        if (!fragment && !bodyEl && !HEAD_TAGS.has(tag.name)) {
            if (tag.name === 'head') {
                headSeen = true
                continue
            }
            if (tag.name === 'body') {
                enterBody(tag.attribs)
                continue
            }
            enterBody()
        }

        autoClose(tag.name)

        if (tag.name === 'tr' && top().name === 'table') {
            const tbody = createElement('tbody', {})
            appendChild(top(), tbody)
            stack.push(tbody)
        }

        let attribs = tag.attribs
        let elementName = tag.name
        if (tag.name === 'svg' || stack.some(node => node.name === 'svg')) {
            const adjusted = {}
            for (const key of Object.keys(attribs)) adjusted[SVG_ATTRIBUTE_NAMES.get(key) || key] = attribs[key]
            attribs = adjusted
            elementName = SVG_TAG_NAMES.get(tag.name) || tag.name
        }

        const element = createElement(elementName, attribs)
        appendChild(top(), element)

        if (RAW_TEXT.has(tag.name) || ESCAPABLE_RAW.has(tag.name)) {
            const closer = RAW_CLOSERS.get(tag.name)
            closer.lastIndex = pos
            const match = closer.exec(html)
            const contentEnd = match ? match.index : length
            const raw = html.slice(pos, contentEnd)
            if (RAW_TEXT.has(tag.name)) appendText(element, raw)
            else appendText(element, decodeEntities(raw))
            if (match) {
                const close = html.indexOf('>', contentEnd)
                pos = close === -1 ? length : close + 1
            } else {
                pos = length
            }
            textFrom = pos
            continue
        }

        if (!VOID_ELEMENTS.has(tag.name) && !tag.selfClosing) stack.push(element)
    }

    flushText(length)
    return root
}

const isElement = (node) => node !== null && node !== undefined && (node.type === 'tag' || node.type === 'script' || node.type === 'style')
const isNode = (value) => value !== null && typeof value === 'object' && typeof value.type === 'string' && Array.isArray(value.children)

function previousElement(node) {
    let sibling = node.prev
    while (sibling && !isElement(sibling)) sibling = sibling.prev
    return sibling
}

function nextElement(node) {
    let sibling = node.next
    while (sibling && !isElement(sibling)) sibling = sibling.next
    return sibling
}

function textOf(node) {
    if (node.type === 'text') return node.data
    if (node.type === 'comment' || node.type === 'directive') return ''
    let out = ''
    for (const child of node.children) out += textOf(child)
    return out
}

function innerHTML(node) {
    let out = ''
    for (const child of node.children) out += outerHTML(child)
    return out
}

function outerHTML(node) {
    switch (node.type) {
        case 'text':
            return node.parent && RAW_TEXT.has(node.parent.name) ? node.data : encodeText(node.data)
        case 'comment':
            return `<!--${node.data}-->`
        case 'directive':
            return `<${node.data}>`
        default: {
            let out = `<${node.name}`
            for (const [key, value] of Object.entries(node.attribs)) out += ` ${key}="${encodeAttribute(value)}"`
            out += '>'
            if (VOID_ELEMENTS.has(node.name)) return out
            return `${out}${innerHTML(node)}</${node.name}>`
        }
    }
}

function collectDescendants(roots) {
    const out = []
    const seen = new Set()
    const walk = (node) => {
        for (const child of node.children) {
            if (!isElement(child)) continue
            if (!seen.has(child)) {
                seen.add(child)
                out.push(child)
            }
            if (child.children.length) walk(child)
        }
    }
    for (const root of roots) if (root.children) walk(root)
    return out
}

function skipSpaces(state) {
    const start = state.i
    while (state.i < state.s.length && isSpace(state.s.charCodeAt(state.i))) state.i++
    return state.i > start
}

function readIdent(state) {
    const re = /(?:-?[a-zA-Z_\u00a0-\uffff]|\\.)(?:[\w\-\u00a0-\uffff]|\\.)*/y
    re.lastIndex = state.i
    const match = re.exec(state.s)
    if (!match) return null
    state.i = re.lastIndex
    return match[0].replace(/\\(.)/g, '$1')
}

function readQuoted(state) {
    const quote = state.s[state.i]
    const end = state.s.indexOf(quote, state.i + 1)
    if (end === -1) throw new SyntaxError(`Unterminated string in selector: ${state.s}`)
    const value = state.s.slice(state.i + 1, end)
    state.i = end + 1
    return value
}

function parseSelector(source) {
    const state = { s: source, i: 0 }
    const groups = parseList(state, false)
    if (state.i < source.length) throw new SyntaxError(`Unexpected token in selector: ${source}`)
    return groups
}

function parseList(state, inParens) {
    const groups = []
    for (;;) {
        skipSpaces(state)
        groups.push(parseComplex(state))
        skipSpaces(state)
        if (state.s[state.i] === ',') {
            state.i++
            continue
        }
        break
    }
    if (inParens) {
        if (state.s[state.i] !== ')') throw new SyntaxError(`Missing ) in selector: ${state.s}`)
        state.i++
    }
    return groups
}

function parseComplex(state) {
    const steps = []
    const positional = []
    let combinator = null
    for (;;) {
        const compound = parseCompound(state)
        if (!compound) throw new SyntaxError(`Invalid selector: ${state.s}`)
        steps.push({ combinator, compound })
        positional.push(...compound.positional)
        const spaced = skipSpaces(state)
        const ch = state.s[state.i]
        if (ch === undefined || ch === ',' || ch === ')') break
        if (ch === '>' || ch === '+' || ch === '~') {
            combinator = ch
            state.i++
            skipSpaces(state)
        } else if (spaced) {
            combinator = ' '
        } else {
            throw new SyntaxError(`Invalid selector: ${state.s}`)
        }
    }
    return { steps, positional }
}

function parseCompound(state) {
    const compound = { tag: null, id: null, classes: [], attrs: [], pseudos: [], positional: [] }
    let matched = false
    if (state.s[state.i] === '*') {
        state.i++
        compound.tag = '*'
        matched = true
    } else {
        const tag = readIdent(state)
        if (tag !== null) {
            compound.tag = tag.toLowerCase()
            matched = true
        }
    }
    for (;;) {
        const ch = state.s[state.i]
        if (ch === '#') {
            state.i++
            const id = readIdent(state)
            if (id === null) throw new SyntaxError(`Invalid id in selector: ${state.s}`)
            compound.id = id
        } else if (ch === '.') {
            state.i++
            const cls = readIdent(state)
            if (cls === null) throw new SyntaxError(`Invalid class in selector: ${state.s}`)
            compound.classes.push(cls)
        } else if (ch === '[') {
            state.i++
            compound.attrs.push(parseAttr(state))
        } else if (ch === ':') {
            state.i++
            parsePseudo(state, compound)
        } else {
            break
        }
        matched = true
    }
    return matched ? compound : null
}

function parseAttr(state) {
    skipSpaces(state)
    const name = readIdent(state)
    if (name === null) throw new SyntaxError(`Invalid attribute in selector: ${state.s}`)
    skipSpaces(state)
    let op = null
    let value = null
    let ci = false
    if (state.s[state.i] !== ']') {
        const two = state.s.slice(state.i, state.i + 2)
        if (['~=', '|=', '^=', '$=', '*=', '!='].includes(two)) {
            op = two
            state.i += 2
        } else if (state.s[state.i] === '=') {
            op = '='
            state.i++
        } else {
            throw new SyntaxError(`Invalid attribute operator in selector: ${state.s}`)
        }
        skipSpaces(state)
        const q = state.s[state.i]
        if (q === '"' || q === "'") {
            value = readQuoted(state)
        } else {
            value = readIdent(state)
            if (value === null) throw new SyntaxError(`Invalid attribute value in selector: ${state.s}`)
        }
        skipSpaces(state)
        if (state.s[state.i] === 'i' || state.s[state.i] === 'I') {
            ci = true
            state.i++
            skipSpaces(state)
        }
    }
    if (state.s[state.i] !== ']') throw new SyntaxError(`Missing ] in selector: ${state.s}`)
    state.i++
    return { name: name.toLowerCase(), op, value, ci }
}

const POSITIONAL = new Set(['first', 'last', 'eq', 'lt', 'gt', 'even', 'odd'])
const GROUP_PSEUDOS = new Set(['not', 'is', 'where', 'matches', 'has'])
const ARG_PSEUDOS = new Set(['contains', 'nth-child', 'nth-of-type'])
const SIMPLE_PSEUDOS = new Set(['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'empty', 'checked', 'selected', 'disabled', 'enabled'])

function parsePseudo(state, compound) {
    const name = readIdent(state)
    if (name === null) throw new SyntaxError(`Invalid pseudo in selector: ${state.s}`)
    const lower = name.toLowerCase()
    const hasArgs = state.s[state.i] === '('

    if (POSITIONAL.has(lower)) {
        if (!hasArgs) {
            compound.positional.push({ type: lower })
            return
        }
        state.i++
        skipSpaces(state)
        const re = /-?\d+/y
        re.lastIndex = state.i
        const match = re.exec(state.s)
        if (!match) throw new SyntaxError(`Invalid argument for :${lower}: ${state.s}`)
        state.i = re.lastIndex
        skipSpaces(state)
        if (state.s[state.i] !== ')') throw new SyntaxError(`Missing ) in selector: ${state.s}`)
        state.i++
        compound.positional.push({ type: lower, n: Number(match[0]) })
        return
    }

    if (GROUP_PSEUDOS.has(lower)) {
        if (!hasArgs) throw new SyntaxError(`Missing arguments for :${lower}`)
        state.i++
        compound.pseudos.push({ type: lower, groups: parseList(state, true) })
        return
    }

    if (ARG_PSEUDOS.has(lower)) {
        if (!hasArgs) throw new SyntaxError(`Missing arguments for :${lower}`)
        state.i++
        skipSpaces(state)
        const q = state.s[state.i]
        let arg
        if (q === '"' || q === "'") {
            arg = readQuoted(state)
        } else {
            const close = state.s.indexOf(')', state.i)
            if (close === -1) throw new SyntaxError(`Missing ) in selector: ${state.s}`)
            arg = state.s.slice(state.i, close).trim()
            state.i = close
        }
        skipSpaces(state)
        if (state.s[state.i] !== ')') throw new SyntaxError(`Missing ) in selector: ${state.s}`)
        state.i++
        compound.pseudos.push({ type: lower, arg: lower === 'contains' ? arg : parseNth(arg) })
        return
    }

    if (SIMPLE_PSEUDOS.has(lower)) {
        compound.pseudos.push({ type: lower })
        return
    }

    throw new SyntaxError(`Unsupported pseudo-class :${name}`)
}

function parseNth(arg) {
    const text = arg.toLowerCase().replace(/\s+/g, '')
    if (text === 'odd') return { a: 2, b: 1 }
    if (text === 'even') return { a: 2, b: 0 }
    const match = /^([+-]?\d*)n([+-]\d+)?$|^([+-]?\d+)$/.exec(text)
    if (!match) throw new SyntaxError(`Unsupported nth expression: ${arg}`)
    if (match[3] !== undefined) return { a: 0, b: Number(match[3]) }
    const coefficient = match[1]
    const a = coefficient === '' || coefficient === '+' ? 1 : coefficient === '-' ? -1 : Number(coefficient)
    const b = match[2] ? Number(match[2]) : 0
    return { a, b }
}

function matchesNth(index, { a, b }) {
    if (a === 0) return index === b
    const n = (index - b) / a
    return Number.isInteger(n) && n >= 0
}

function siblingIndex(node, sameName) {
    let index = 1
    for (let s = previousElement(node); s; s = previousElement(s)) {
        if (!sameName || s.name === node.name) index++
    }
    return index
}

function isLastSibling(node, sameName) {
    for (let s = nextElement(node); s; s = nextElement(s)) {
        if (!sameName || s.name === node.name) return false
    }
    return true
}

function hasDescendantMatching(el, groups) {
    for (const child of el.children) {
        if (!isElement(child)) continue
        if (groups.some(group => matchGroup(child, group))) return true
        if (child.children.length && hasDescendantMatching(child, groups)) return true
    }
    return false
}

function matchPseudo(el, pseudo) {
    switch (pseudo.type) {
        case 'first-child': return !previousElement(el)
        case 'last-child': return isLastSibling(el, false)
        case 'only-child': return !previousElement(el) && isLastSibling(el, false)
        case 'first-of-type': return siblingIndex(el, true) === 1
        case 'last-of-type': return isLastSibling(el, true)
        case 'only-of-type': return siblingIndex(el, true) === 1 && isLastSibling(el, true)
        case 'nth-child': return matchesNth(siblingIndex(el, false), pseudo.arg)
        case 'nth-of-type': return matchesNth(siblingIndex(el, true), pseudo.arg)
        case 'empty': return el.children.length === 0
        case 'checked': return el.attribs.checked !== undefined
        case 'selected': return el.attribs.selected !== undefined
        case 'disabled': return el.attribs.disabled !== undefined
        case 'enabled': return el.attribs.disabled === undefined
        case 'contains': return textOf(el).includes(pseudo.arg)
        case 'not': return !pseudo.groups.some(group => matchGroup(el, group))
        case 'has': return hasDescendantMatching(el, pseudo.groups)
        default: return pseudo.groups.some(group => matchGroup(el, group))
    }
}

function matchAttr(el, attr) {
    const actual = el.attribs[attr.name]
    if (attr.op === null) return actual !== undefined
    if (actual === undefined) return attr.op === '!='
    const value = attr.ci ? actual.toLowerCase() : actual
    const expected = attr.ci ? attr.value.toLowerCase() : attr.value
    switch (attr.op) {
        case '=': return value === expected
        case '!=': return value !== expected
        case '~=': return expected !== '' && value.split(/\s+/).includes(expected)
        case '|=': return value === expected || value.startsWith(`${expected}-`)
        case '^=': return expected !== '' && value.startsWith(expected)
        case '$=': return expected !== '' && value.endsWith(expected)
        case '*=': return expected !== '' && value.includes(expected)
        default: return false
    }
}

function matchCompound(el, compound) {
    if (compound.tag !== null && compound.tag !== '*' && el.name.toLowerCase() !== compound.tag) return false
    if (compound.id !== null && el.attribs.id !== compound.id) return false
    if (compound.classes.length) {
        const classes = (el.attribs.class || '').split(/\s+/)
        for (const cls of compound.classes) if (!classes.includes(cls)) return false
    }
    for (const attr of compound.attrs) if (!matchAttr(el, attr)) return false
    for (const pseudo of compound.pseudos) if (!matchPseudo(el, pseudo)) return false
    return true
}

function matchSteps(el, steps, index) {
    if (!matchCompound(el, steps[index].compound)) return false
    if (index === 0) return true
    const combinator = steps[index].combinator
    if (combinator === ' ') {
        for (let p = el.parent; isElement(p); p = p.parent) {
            if (matchSteps(p, steps, index - 1)) return true
        }
        return false
    }
    if (combinator === '>') {
        const p = el.parent
        return isElement(p) && matchSteps(p, steps, index - 1)
    }
    if (combinator === '+') {
        const s = previousElement(el)
        return !!s && matchSteps(s, steps, index - 1)
    }
    for (let s = previousElement(el); s; s = previousElement(s)) {
        if (matchSteps(s, steps, index - 1)) return true
    }
    return false
}

function matchGroup(el, group) {
    return isElement(el) && matchSteps(el, group.steps, group.steps.length - 1)
}

function applyPositional(list, positional) {
    let out = list
    for (const p of positional) {
        switch (p.type) {
            case 'first': out = out.slice(0, 1); break
            case 'last': out = out.slice(-1); break
            case 'eq': {
                const index = p.n < 0 ? out.length + p.n : p.n
                out = out[index] ? [out[index]] : []
                break
            }
            case 'lt': out = out.slice(0, p.n); break
            case 'gt': out = out.slice(p.n + 1); break
            case 'even': out = out.filter((_, i) => i % 2 === 0); break
            case 'odd': out = out.filter((_, i) => i % 2 === 1); break
        }
    }
    return out
}

const selectorCache = new Map()

function compileSelector(source) {
    let groups = selectorCache.get(source)
    if (!groups) {
        groups = parseSelector(source)
        if (selectorCache.size > 256) selectorCache.clear()
        selectorCache.set(source, groups)
    }
    return groups
}

function selectWithin(roots, source) {
    const groups = compileSelector(source)
    const candidates = collectDescendants(roots)
    if (groups.length === 1 && !groups[0].positional.length) {
        return candidates.filter(el => matchGroup(el, groups[0]))
    }
    const order = new Map(candidates.map((el, i) => [el, i]))
    const seen = new Set()
    const out = []
    for (const group of groups) {
        const matched = applyPositional(candidates.filter(el => matchGroup(el, group)), group.positional)
        for (const el of matched) {
            if (!seen.has(el)) {
                seen.add(el)
                out.push(el)
            }
        }
    }
    return out.sort((a, b) => order.get(a) - order.get(b))
}

function matchesSelector(node, source) {
    return isElement(node) && compileSelector(source).some(group => matchGroup(node, group))
}

const uniqueNodes = (list) => [...new Set(list)]

const filterBy = (nodes, selector) => selector ? nodes.filter(node => matchesSelector(node, selector)) : nodes

class Selection {
    constructor(nodes) {
        Object.defineProperty(this, 'nodes', { value: nodes, enumerable: false })
        this.length = nodes.length
        for (let i = 0; i < nodes.length; i++) this[i] = nodes[i]
    }

    [Symbol.iterator]() {
        return this.nodes[Symbol.iterator]()
    }

    each(fn) {
        for (let i = 0; i < this.nodes.length; i++) {
            if (fn.call(this.nodes[i], i, this.nodes[i]) === false) break
        }
        return this
    }

    map(fn) {
        const values = []
        for (let i = 0; i < this.nodes.length; i++) {
            const value = fn.call(this.nodes[i], i, this.nodes[i])
            if (value === null || value === undefined) continue
            if (Array.isArray(value)) values.push(...value)
            else values.push(value)
        }
        return new Selection(values)
    }

    get(index) {
        if (index === undefined) return this.nodes.slice()
        return this.nodes[index < 0 ? this.nodes.length + index : index]
    }

    toArray() {
        return this.nodes.slice()
    }

    first() {
        return new Selection(this.nodes.slice(0, 1))
    }

    last() {
        return new Selection(this.nodes.slice(-1))
    }

    eq(index) {
        const at = index < 0 ? this.nodes.length + index : index
        return new Selection(this.nodes[at] ? [this.nodes[at]] : [])
    }

    slice(start, end) {
        return new Selection(this.nodes.slice(start, end))
    }

    text() {
        let out = ''
        for (const node of this.nodes) out += textOf(node)
        return out
    }

    html() {
        if (!this.nodes.length) return null
        return innerHTML(this.nodes[0])
    }

    attr(name, value) {
        const key = name.toLowerCase()
        if (value === undefined) {
            const node = this.nodes[0]
            return isElement(node) ? node.attribs[key] : undefined
        }
        for (const node of this.nodes) {
            if (isElement(node)) node.attribs = { ...node.attribs, [key]: String(value) }
        }
        return this
    }

    val() {
        return this.attr('value')
    }

    hasClass(name) {
        return this.nodes.some(node => isElement(node) && (node.attribs.class || '').split(/\s+/).includes(name))
    }

    find(selector) {
        return new Selection(selectWithin(this.nodes, selector))
    }

    filter(selector) {
        if (typeof selector === 'function') return new Selection(this.nodes.filter((node, i) => selector.call(node, i, node)))
        return new Selection(this.nodes.filter(node => matchesSelector(node, selector)))
    }

    not(selector) {
        if (typeof selector === 'function') return new Selection(this.nodes.filter((node, i) => !selector.call(node, i, node)))
        return new Selection(this.nodes.filter(node => !matchesSelector(node, selector)))
    }

    is(selector) {
        if (typeof selector === 'function') return this.nodes.some((node, i) => selector.call(node, i, node))
        return this.nodes.some(node => matchesSelector(node, selector))
    }

    children(selector) {
        const out = []
        for (const node of this.nodes) for (const child of node.children) if (isElement(child)) out.push(child)
        return new Selection(filterBy(uniqueNodes(out), selector))
    }

    contents() {
        const out = []
        for (const node of this.nodes) out.push(...node.children)
        return new Selection(out)
    }

    parent(selector) {
        const out = []
        for (const node of this.nodes) if (isElement(node.parent)) out.push(node.parent)
        return new Selection(filterBy(uniqueNodes(out), selector))
    }

    closest(selector) {
        const out = []
        for (const node of this.nodes) {
            for (let current = node; isElement(current); current = current.parent) {
                if (matchesSelector(current, selector)) {
                    out.push(current)
                    break
                }
            }
        }
        return new Selection(uniqueNodes(out))
    }

    next(selector) {
        const out = []
        for (const node of this.nodes) {
            const sibling = nextElement(node)
            if (sibling) out.push(sibling)
        }
        return new Selection(filterBy(uniqueNodes(out), selector))
    }

    prev(selector) {
        const out = []
        for (const node of this.nodes) {
            const sibling = previousElement(node)
            if (sibling) out.push(sibling)
        }
        return new Selection(filterBy(uniqueNodes(out), selector))
    }

    siblings(selector) {
        const out = []
        for (const node of this.nodes) {
            if (!node.parent) continue
            for (const sibling of node.parent.children) if (sibling !== node && isElement(sibling)) out.push(sibling)
        }
        return new Selection(filterBy(uniqueNodes(out), selector))
    }
}

const isSelection = (value) => value instanceof Selection

export function load(content) {
    const root = parseDocument(String(content ?? ''))

    const $ = (selector, context) => {
        if (selector === null || selector === undefined) return new Selection([])
        if (isSelection(selector)) return selector
        if (typeof selector === 'string') {
            if (selector.trimStart().startsWith('<')) return new Selection(parseDocument(selector, true).children)
            const roots = context === undefined ? [root] : $(context).nodes
            return new Selection(selectWithin(roots, selector))
        }
        if (isNode(selector)) return new Selection([selector])
        if (Array.isArray(selector)) return new Selection(selector.filter(isNode))
        return new Selection([])
    }

    $.root = () => new Selection([root])
    $.html = () => innerHTML(root)
    $.text = () => textOf(root)
    return $
}

export default { load }
