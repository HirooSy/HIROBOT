const PSEUDO_FLAGS = new Set(['first-child', 'last-child', 'only-child', 'first-of-type', 'last-of-type', 'only-of-type', 'empty', 'root', 'checked', 'disabled', 'enabled', 'required', 'optional', 'read-only', 'read-write', 'link', 'any-link', 'visited', 'hover', 'active', 'focus', 'focus-visible', 'focus-within', 'target', 'scope', 'default', 'indeterminate', 'placeholder-shown', 'in-range', 'out-of-range', 'defined'])
const LIST_PSEUDO = new Set(['not', 'is', 'where', 'matches', 'any', '-webkit-any', '-moz-any', 'has'])
const NTH_PSEUDO = new Set(['nth-child', 'nth-last-child', 'nth-of-type', 'nth-last-of-type'])
const NTH_RE = /^\s*(?:([+-]?\d*)n\s*(?:([+-])\s*(\d+))?|([+-]?\d+)|(odd|even))/i
const IDENT_RE = /(?:-?[A-Za-z_\u0080-\uffff]|\\.)(?:[\w\u0080-\uffff-]|\\.)*/y
const cache = new Map()

const parseNth = (m) => {
    if (m[5]) return /odd/i.test(m[5]) ? { a: 2, b: 1 } : { a: 2, b: 0 }
    if (m[4] !== undefined) return { a: 0, b: Number(m[4]) }
    const av = m[1]
    const a = av === '' || av === '+' ? 1 : av === '-' ? -1 : Number(av)
    const b = m[3] === undefined ? 0 : m[2] === '-' ? -Number(m[3]) : Number(m[3])
    return { a, b }
}

const parseSelector = (src) => {
    let pos = 0
    const fail = () => new SyntaxError(`'${src}' is not a valid selector`)
    const ws = () => {
        while (pos < src.length && /\s/.test(src[pos])) pos++
    }
    const ident = () => {
        IDENT_RE.lastIndex = pos
        const m = IDENT_RE.exec(src)
        if (!m) throw fail()
        pos += m[0].length
        return m[0].replace(/\\(.)/g, '$1')
    }
    const attr = () => {
        ws()
        const name = ident().toLowerCase()
        ws()
        if (src[pos] === ']') {
            pos++
            return { type: 'attr', name, op: null }
        }
        const m = /^([~|^$*]?=)/.exec(src.slice(pos))
        if (!m) throw fail()
        pos += m[1].length
        ws()
        let value
        if (src[pos] === '"' || src[pos] === "'") {
            const quote = src[pos++]
            value = ''
            while (pos < src.length && src[pos] !== quote) {
                if (src[pos] === '\\') pos++
                value += src[pos++] ?? ''
            }
            if (src[pos] !== quote) throw fail()
            pos++
        } else {
            const raw = /[^\s\]]+/y
            raw.lastIndex = pos
            const r = raw.exec(src)
            if (!r) throw fail()
            value = r[0]
            pos += r[0].length
        }
        ws()
        let flag = null
        if (/^[iIsS]$/.test(src[pos] ?? '') && /[\s\]]/.test(src[pos + 1] ?? ']')) {
            flag = src[pos].toLowerCase()
            pos++
            ws()
        }
        if (src[pos] !== ']') throw fail()
        pos++
        return { type: 'attr', name, op: m[1], value, flag }
    }
    const pseudo = () => {
        const name = ident().toLowerCase()
        if (src[pos] !== '(') {
            if (!PSEUDO_FLAGS.has(name)) throw fail()
            return { type: 'pseudo', name }
        }
        pos++
        if (LIST_PSEUDO.has(name)) return { type: 'pseudo', name, args: list(true, name === 'has') }
        if (NTH_PSEUDO.has(name)) {
            ws()
            const m = NTH_RE.exec(src.slice(pos))
            if (!m) throw fail()
            pos += m[0].length
            const { a, b } = parseNth(m)
            let of = null
            ws()
            if ((name === 'nth-child' || name === 'nth-last-child') && /^of\s/i.test(src.slice(pos))) {
                pos += 2
                of = list(true, false)
            } else {
                ws()
                if (src[pos] !== ')') throw fail()
                pos++
            }
            return { type: 'pseudo', name, a, b, of }
        }
        throw fail()
    }
    const compound = () => {
        const out = []
        const ch = src[pos]
        if (ch === '*') {
            pos++
            out.push({ type: 'universal' })
        } else if (ch !== undefined && /[A-Za-z_\\\-\u0080-\uffff]/.test(ch)) {
            out.push({ type: 'tag', name: ident().toLowerCase() })
        }
        for (;;) {
            const c = src[pos]
            if (c === '#') {
                pos++
                out.push({ type: 'id', value: ident() })
            } else if (c === '.') {
                pos++
                out.push({ type: 'class', value: ident() })
            } else if (c === '[') {
                pos++
                out.push(attr())
            } else if (c === ':') {
                pos++
                if (src[pos] === ':') {
                    pos++
                    ident()
                    out.push({ type: 'never' })
                } else out.push(pseudo())
            } else break
        }
        return out.length ? out : null
    }
    const complex = (relative) => {
        const parts = []
        let comb = null
        if (relative) {
            ws()
            if ('>+~'.includes(src[pos])) comb = src[pos++]
            else comb = ' '
            parts.push({ combinator: null, compound: [{ type: 'scope' }] })
        }
        for (;;) {
            ws()
            if (pos >= src.length || src[pos] === ',' || src[pos] === ')') break
            if ('>+~'.includes(src[pos])) {
                comb = src[pos++]
                continue
            }
            const simples = compound()
            if (!simples) throw fail()
            const first = parts.length === (relative ? 1 : 0)
            parts.push({ combinator: first ? (relative ? comb : null) : (comb ?? ' '), compound: simples })
            comb = null
        }
        if (parts.length === (relative ? 1 : 0)) throw fail()
        return parts
    }
    const list = (closing, relative) => {
        const out = []
        for (;;) {
            ws()
            out.push(complex(relative))
            ws()
            if (src[pos] === ',') {
                pos++
                continue
            }
            break
        }
        if (closing) {
            if (src[pos] !== ')') throw fail()
            pos++
        } else if (pos < src.length) throw fail()
        return out
    }
    return list(false, false)
}

export const compile = (text) => {
    const key = String(text)
    let compiled = cache.get(key)
    if (compiled) return compiled
    compiled = parseSelector(key)
    if (cache.size > 500) cache.clear()
    cache.set(key, compiled)
    return compiled
}

const siblingsOf = (el) => (el.parentNode ? el.parentNode.childNodes.filter((n) => n.nodeType === 1) : [el])
const sameTypeSiblings = (el) => siblingsOf(el).filter((n) => n.localName === el.localName)
const prevElement = (el) => {
    const sibs = el.parentNode ? el.parentNode.childNodes : []
    for (let i = sibs.indexOf(el) - 1; i >= 0; i--) if (sibs[i].nodeType === 1) return sibs[i]
    return null
}
const descendants = (el) => {
    const out = []
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 1) {
                out.push(child)
                walk(child)
            }
        }
    }
    walk(el)
    return out
}

const attrMatch = (value, op, expected, flag) => {
    let v = value
    let e = expected
    if (flag === 'i') {
        v = v.toLowerCase()
        e = e.toLowerCase()
    }
    switch (op) {
        case '=':
            return v === e
        case '~=':
            return e !== '' && !/\s/.test(e) && v.split(/\s+/).includes(e)
        case '|=':
            return v === e || v.startsWith(`${e}-`)
        case '^=':
            return e !== '' && v.startsWith(e)
        case '$=':
            return e !== '' && v.endsWith(e)
        case '*=':
            return e !== '' && v.includes(e)
        default:
            return false
    }
}

const matchNth = (index, a, b) => {
    if (a === 0) return index === b
    const n = (index - b) / a
    return Number.isInteger(n) && n >= 0
}

const matchPseudo = (el, s, ctx) => {
    switch (s.name) {
        case 'first-child':
            return siblingsOf(el)[0] === el
        case 'last-child':
            return siblingsOf(el).at(-1) === el
        case 'only-child':
            return siblingsOf(el).length === 1
        case 'first-of-type':
            return sameTypeSiblings(el)[0] === el
        case 'last-of-type':
            return sameTypeSiblings(el).at(-1) === el
        case 'only-of-type':
            return sameTypeSiblings(el).length === 1
        case 'nth-child':
        case 'nth-last-child':
        case 'nth-of-type':
        case 'nth-last-of-type': {
            if (s.of && !s.of.some((c) => matchComplex(el, c, ctx))) return false
            let sibs = s.name.endsWith('of-type') ? sameTypeSiblings(el) : siblingsOf(el)
            if (s.of) sibs = sibs.filter((n) => s.of.some((c) => matchComplex(n, c, ctx)))
            let index = sibs.indexOf(el)
            if (index < 0) return false
            index += 1
            if (s.name.includes('last')) index = sibs.length - index + 1
            return matchNth(index, s.a, s.b)
        }
        case 'not':
            return !s.args.some((c) => matchComplex(el, c, ctx))
        case 'is':
        case 'where':
        case 'matches':
        case 'any':
        case '-webkit-any':
        case '-moz-any':
            return s.args.some((c) => matchComplex(el, c, ctx))
        case 'has': {
            return s.args.some((c) => {
                const lead = c[1]?.combinator
                const candidates = lead === '+' || lead === '~' ? allElements(el.ownerDocument) : descendants(el)
                const sub = { scope: el }
                return candidates.some((d) => matchComplex(d, c, sub))
            })
        }
        case 'empty':
            return el.childNodes.every((n) => n.nodeType === 8 || (n.nodeType === 3 && n.data === ''))
        case 'root':
            return el.parentNode !== null && el.parentNode.nodeType === 9
        case 'checked':
            return el.checked === true || el.selected === true
        case 'disabled':
            return el.disabled === true
        case 'enabled':
            return el.disabled !== true && ['input', 'button', 'select', 'textarea', 'option', 'fieldset'].includes(el.localName)
        case 'required':
            return el.hasAttribute('required')
        case 'optional':
            return ['input', 'select', 'textarea'].includes(el.localName) && !el.hasAttribute('required')
        case 'read-only':
            return el.readOnly === true || el.disabled === true
        case 'read-write':
            return !(el.readOnly === true || el.disabled === true) && (el.isContentEditable === true || ['input', 'textarea'].includes(el.localName))
        case 'link':
        case 'any-link':
            return (el.localName === 'a' || el.localName === 'area') && el.hasAttribute('href')
        case 'focus':
        case 'focus-visible':
            return el.ownerDocument?.activeElement === el
        case 'focus-within':
            return el.ownerDocument?.activeElement ? el.contains(el.ownerDocument.activeElement) : false
        case 'placeholder-shown':
            return el.hasAttribute('placeholder') && (el.value ?? '') === ''
        case 'scope':
            return el === ctx.scope
        case 'defined':
            return true
        default:
            return false
    }
}

const allElements = (doc) => (doc ? descendants(doc) : [])

const matchSimple = (el, s, ctx) => {
    switch (s.type) {
        case 'universal':
            return true
        case 'tag':
            return el.localName === s.name
        case 'id':
            return el.getAttribute('id') === s.value
        case 'class':
            return (el.getAttribute('class') ?? '').split(/\s+/).includes(s.value)
        case 'attr':
            if (s.op === null) return el.hasAttribute(s.name)
            return attrMatch(el.getAttribute(s.name) ?? '', s.op, s.value, s.flag) && el.hasAttribute(s.name)
        case 'scope':
            return el === ctx.scope
        case 'pseudo':
            return matchPseudo(el, s, ctx)
        case 'never':
            return false
        default:
            return false
    }
}

const matchCompound = (el, compound, ctx) => compound.every((s) => matchSimple(el, s, ctx))

const matchFrom = (el, parts, idx, ctx) => {
    if (!el || el.nodeType !== 1) return false
    const part = parts[idx]
    if (!matchCompound(el, part.compound, ctx)) return false
    if (idx === 0) return true
    switch (part.combinator) {
        case '>':
            return matchFrom(el.parentElement, parts, idx - 1, ctx)
        case ' ':
            for (let p = el.parentElement; p; p = p.parentElement) if (matchFrom(p, parts, idx - 1, ctx)) return true
            return false
        case '+':
            return matchFrom(prevElement(el), parts, idx - 1, ctx)
        case '~':
            for (let s = prevElement(el); s; s = prevElement(s)) if (matchFrom(s, parts, idx - 1, ctx)) return true
            return false
        default:
            return false
    }
}

export const matchComplex = (el, complex, ctx) => matchFrom(el, complex, complex.length - 1, ctx)

export const matches = (el, text) => {
    const ctx = { scope: el }
    return compile(text).some((c) => matchComplex(el, c, ctx))
}

export const queryAll = (root, text, limit = Infinity) => {
    const compiled = compile(text)
    const ctx = { scope: root.nodeType === 1 ? root : (root.documentElement ?? null) }
    const out = []
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (out.length >= limit) return
            if (child.nodeType !== 1) continue
            if (compiled.some((c) => matchComplex(child, c, ctx))) out.push(child)
            walk(child)
        }
    }
    walk(root)
    return out
}

export const queryOne = (root, text) => queryAll(root, text, 1)[0] ?? null

export const closest = (el, text) => {
    const compiled = compile(text)
    const ctx = { scope: el }
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) {
        if (compiled.some((c) => matchComplex(node, c, ctx))) return node
    }
    return null
}
