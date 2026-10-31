import { closest as selClosest, matches as selMatches, queryAll, queryOne } from './select.js'
import { parseHtmlFragment } from './html.js'
import { Layout, parseDeclarations, serializeDeclarations } from './layout.js'

let errorSink = () => {}
export const setErrorSink = (fn) => {
    errorSink = fn
}

const domError = (name, message) => {
    const error = new Error(message)
    error.name = name
    return error
}

const kebab = (key) => (key.startsWith('--') ? key : key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`))
const camel = (key) => key.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
const resolveUrl = (value, base) => {
    try {
        return new URL(value, base).href
    } catch {
        return value
    }
}

export class EventTarget {
    constructor() {
        this._listeners = new Map()
        this._handlers = new Map()
    }

    addEventListener(type, listener, options) {
        if (!listener) return
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        const once = typeof options === 'object' && options?.once === true
        const list = this._listeners.get(type) ?? []
        if (list.some((entry) => entry.listener === listener && entry.capture === capture)) return
        list.push({ listener, capture, once })
        this._listeners.set(type, list)
    }

    removeEventListener(type, listener, options) {
        const capture = typeof options === 'boolean' ? options : options?.capture === true
        const list = this._listeners.get(type)
        if (!list) return
        this._listeners.set(
            type,
            list.filter((entry) => !(entry.listener === listener && entry.capture === capture))
        )
    }

    dispatchEvent(event) {
        return dispatch(this, event)
    }

    _path() {
        return [this]
    }
}

const HANDLER_EVENTS = [
    'click', 'dblclick', 'mousedown', 'mouseup', 'mousemove', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave',
    'keydown', 'keyup', 'keypress', 'input', 'change', 'submit', 'reset', 'focus', 'blur', 'focusin', 'focusout',
    'load', 'error', 'scroll', 'resize', 'wheel', 'select', 'invalid', 'toggle', 'contextmenu', 'drag', 'drop',
    'dragover', 'dragstart', 'dragend', 'paste', 'copy', 'cut', 'pointerdown', 'pointerup', 'pointermove',
    'touchstart', 'touchend', 'touchmove', 'message', 'hashchange', 'popstate', 'beforeunload', 'unload',
    'readystatechange', 'animationend', 'transitionend', 'storage', 'online', 'offline'
]

for (const name of HANDLER_EVENTS) {
    Object.defineProperty(EventTarget.prototype, `on${name}`, {
        configurable: true,
        enumerable: true,
        get() {
            return this._handlers.get(name)?.fn ?? null
        },
        set(fn) {
            const previous = this._handlers.get(name)
            if (previous) this.removeEventListener(name, previous.wrapper)
            if (typeof fn !== 'function') {
                this._handlers.delete(name)
                return
            }
            const wrapper = function (event) {
                const result = fn.call(this, event)
                if (result === false) event.preventDefault()
            }
            this._handlers.set(name, { fn, wrapper })
            this.addEventListener(name, wrapper)
        }
    })
}

const inlineHandler = (node, type) => {
    if (node.nodeType !== 1) return null
    const code = node.getAttribute(`on${type}`)
    if (code === null) return null
    const doc = node._doc
    if (!node._inlineHandlers) node._inlineHandlers = new Map()
    const cached = node._inlineHandlers.get(type)
    if (cached && cached.code === code) return cached.fn
    const fn = doc?.hooks.compile ? doc.hooks.compile(code, node) : null
    node._inlineHandlers.set(type, { code, fn })
    return fn
}

const invoke = (node, event, phase) => {
    event.currentTarget = node
    const list = node._listeners?.get(event.type)
    if (list) {
        for (const entry of [...list]) {
            if (phase === 'capture' && !entry.capture) continue
            if (phase === 'bubble' && entry.capture) continue
            if (entry.once) node.removeEventListener(event.type, entry.listener, { capture: entry.capture })
            try {
                if (typeof entry.listener === 'function') entry.listener.call(node, event)
                else if (typeof entry.listener.handleEvent === 'function') entry.listener.handleEvent(event)
            } catch (error) {
                errorSink(error)
            }
            if (event._stopImmediate) return
        }
    }
    if (phase !== 'capture') {
        const fn = inlineHandler(node, event.type)
        if (fn) {
            try {
                fn.call(node, event)
            } catch (error) {
                errorSink(error)
            }
        }
    }
}

export const dispatch = (target, event) => {
    const chain = target._path()
    event._target = target
    event._chain = chain
    event._stop = false
    event._stopImmediate = false
    event.eventPhase = 1
    for (let i = chain.length - 1; i >= 1 && !event._stop; i--) invoke(chain[i], event, 'capture')
    if (!event._stop) {
        event.eventPhase = 2
        invoke(chain[0], event, 'target')
    }
    if (event.bubbles) {
        for (let i = 1; i < chain.length && !event._stop; i++) {
            event.eventPhase = 3
            invoke(chain[i], event, 'bubble')
        }
    }
    event.eventPhase = 0
    event.currentTarget = null
    return !event.defaultPrevented
}

const pick = (target, init, keys) => {
    for (const key of keys) if (init && init[key] !== undefined) target[key] = init[key]
}

export class Event {
    constructor(type, init = {}) {
        this.type = String(type)
        this.bubbles = init?.bubbles === true
        this.cancelable = init?.cancelable === true
        this.composed = init?.composed === true
        this.defaultPrevented = false
        this.eventPhase = 0
        this.currentTarget = null
        this.timeStamp = performance.now()
        this.isTrusted = false
        this._target = null
        this._chain = []
        this._stop = false
        this._stopImmediate = false
    }

    get target() {
        return this._target
    }

    get srcElement() {
        return this._target
    }

    get returnValue() {
        return !this.defaultPrevented
    }

    set returnValue(value) {
        if (value === false) this.preventDefault()
    }

    preventDefault() {
        if (this.cancelable) this.defaultPrevented = true
    }

    stopPropagation() {
        this._stop = true
    }

    stopImmediatePropagation() {
        this._stop = true
        this._stopImmediate = true
    }

    composedPath() {
        return this._chain.slice()
    }
}

export class CustomEvent extends Event {
    constructor(type, init = {}) {
        super(type, init)
        this.detail = init?.detail ?? null
    }

    initCustomEvent(type, bubbles = false, cancelable = false, detail = null) {
        this.type = String(type)
        this.bubbles = bubbles === true
        this.cancelable = cancelable === true
        this.detail = detail
    }
}

export class UIEvent extends Event {
    constructor(type, init = {}) {
        super(type, init)
        this.view = init?.view ?? null
        this.detail = init?.detail ?? 0
    }
}

const MOUSE_KEYS = ['screenX', 'screenY', 'clientX', 'clientY', 'button', 'buttons', 'ctrlKey', 'shiftKey', 'altKey', 'metaKey', 'relatedTarget']

export class MouseEvent extends UIEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.screenX = 0
        this.screenY = 0
        this.clientX = 0
        this.clientY = 0
        this.button = 0
        this.buttons = 0
        this.ctrlKey = false
        this.shiftKey = false
        this.altKey = false
        this.metaKey = false
        this.relatedTarget = null
        pick(this, init, MOUSE_KEYS)
    }

    get pageX() {
        return this.clientX
    }

    get pageY() {
        return this.clientY
    }

    getModifierState(name) {
        return name === 'Control' ? this.ctrlKey : name === 'Shift' ? this.shiftKey : name === 'Alt' ? this.altKey : name === 'Meta' ? this.metaKey : false
    }
}

export class WheelEvent extends MouseEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.deltaX = init?.deltaX ?? 0
        this.deltaY = init?.deltaY ?? 0
        this.deltaZ = 0
        this.deltaMode = 0
    }
}

export class KeyboardEvent extends UIEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.key = init?.key ?? ''
        this.code = init?.code ?? ''
        this.location = init?.location ?? 0
        this.ctrlKey = init?.ctrlKey === true
        this.shiftKey = init?.shiftKey === true
        this.altKey = init?.altKey === true
        this.metaKey = init?.metaKey === true
        this.repeat = init?.repeat === true
        this.isComposing = false
        this.keyCode = init?.keyCode ?? 0
        this.charCode = init?.charCode ?? 0
        this.which = this.keyCode
    }

    getModifierState(name) {
        return name === 'Control' ? this.ctrlKey : name === 'Shift' ? this.shiftKey : name === 'Alt' ? this.altKey : false
    }
}

export class FocusEvent extends UIEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.relatedTarget = init?.relatedTarget ?? null
    }
}

export class InputEvent extends UIEvent {
    constructor(type, init = {}) {
        super(type, init)
        this.data = init?.data ?? null
        this.inputType = init?.inputType ?? ''
        this.isComposing = false
    }
}

const ORDER_FOLLOWING = 4
const ORDER_PRECEDING = 2
const ORDER_CONTAINS = 8
const ORDER_CONTAINED_BY = 16
const ORDER_DISCONNECTED = 1
const ORDER_IMPLEMENTATION_SPECIFIC = 32

const removeFromParent = (child) => {
    const parent = child.parentNode
    if (!parent) return
    const index = parent.childNodes.indexOf(child)
    if (index >= 0) parent.childNodes.splice(index, 1)
    child.parentNode = null
    ownerOf(parent)?._touch()
}

const ownerOf = (node) => (node.nodeType === 9 ? node : node._doc)

const notifyInserted = (doc, node) => {
    const visit = (current) => {
        if (current.nodeType === 1 && current.localName === 'script') doc.hooks.onScript?.(current)
        for (const child of current.childNodes) visit(child)
    }
    visit(node)
}

const insertNode = (parent, child, ref) => {
    if (child.nodeType === 11) {
        for (const item of [...child.childNodes]) insertNode(parent, item, ref)
        return child
    }
    if (ref && ref.parentNode !== parent) {
        throw domError('NotFoundError', 'The node before which the new node is to be inserted is not a child of this node.')
    }
    if (child.contains(parent)) throw domError('HierarchyRequestError', 'The new child element contains the parent.')
    if (child.parentNode) removeFromParent(child)
    const index = ref ? parent.childNodes.indexOf(ref) : parent.childNodes.length
    parent.childNodes.splice(index, 0, child)
    child.parentNode = parent
    const doc = ownerOf(parent)
    if (doc) {
        doc._touch()
        if (doc.booted) notifyInserted(doc, child)
    }
    return child
}

const textOf = (node) => {
    if (node.nodeType === 3 || node.nodeType === 8) return node.data
    if (node.nodeType === 9 || node.nodeType === 10) return null
    let out = ''
    for (const child of node.childNodes) if (child.nodeType !== 8) out += textOf(child)
    return out
}

const cloneOf = (node, deep) => {
    let copy
    switch (node.nodeType) {
        case 1:
            copy = makeElement(node._doc, node.localName, [...node._attrs.entries()])
            break
        case 3:
            copy = new Text(node._doc, node.data)
            break
        case 8:
            copy = new Comment(node._doc, node.data)
            break
        case 11:
            copy = new DocumentFragment(node._doc)
            break
        default:
            throw domError('NotSupportedError', 'Cloning this node type is not supported.')
    }
    if (deep) for (const child of node.childNodes) copy.appendChild(cloneOf(child, true))
    return copy
}

const chainOf = (node) => {
    const chain = []
    for (let current = node; current; current = current.parentNode) chain.unshift(current)
    return chain
}

export class Node extends EventTarget {
    constructor(doc) {
        super()
        this._doc = doc
        this.childNodes = []
        this.parentNode = null
    }

    get ownerDocument() {
        return this._doc
    }

    get parentElement() {
        return this.parentNode?.nodeType === 1 ? this.parentNode : null
    }

    get firstChild() {
        return this.childNodes[0] ?? null
    }

    get lastChild() {
        return this.childNodes.at(-1) ?? null
    }

    get nextSibling() {
        if (!this.parentNode) return null
        const siblings = this.parentNode.childNodes
        return siblings[siblings.indexOf(this) + 1] ?? null
    }

    get previousSibling() {
        if (!this.parentNode) return null
        const siblings = this.parentNode.childNodes
        const index = siblings.indexOf(this)
        return index > 0 ? siblings[index - 1] : null
    }

    get isConnected() {
        let node = this
        while (node.parentNode) node = node.parentNode
        return node.nodeType === 9
    }

    get textContent() {
        return textOf(this)
    }

    set textContent(value) {
        for (const child of [...this.childNodes]) removeFromParent(child)
        const text = value === null || value === undefined ? '' : String(value)
        if (text !== '') insertNode(this, new Text(this._doc, text), null)
    }

    hasChildNodes() {
        return this.childNodes.length > 0
    }

    contains(other) {
        for (let node = other; node; node = node.parentNode) if (node === this) return true
        return false
    }

    getRootNode() {
        let node = this
        while (node.parentNode) node = node.parentNode
        return node
    }

    appendChild(child) {
        return insertNode(this, child, null)
    }

    insertBefore(child, ref) {
        return insertNode(this, child, ref ?? null)
    }

    removeChild(child) {
        if (child.parentNode !== this) throw domError('NotFoundError', 'The node to be removed is not a child of this node.')
        removeFromParent(child)
        return child
    }

    replaceChild(child, old) {
        insertNode(this, child, old)
        removeFromParent(old)
        return old
    }

    cloneNode(deep = false) {
        return cloneOf(this, deep)
    }

    normalize() {
        for (let i = this.childNodes.length - 1; i >= 0; i--) {
            const node = this.childNodes[i]
            if (node.nodeType === 3) {
                const prev = this.childNodes[i - 1]
                if (prev && prev.nodeType === 3) {
                    prev.data += node.data
                    removeFromParent(node)
                } else if (node.data === '') removeFromParent(node)
            } else node.normalize()
        }
    }

    isSameNode(other) {
        return other === this
    }

    compareDocumentPosition(other) {
        if (other === this) return 0
        const mine = chainOf(this)
        const theirs = chainOf(other)
        if (mine[0] !== theirs[0]) return ORDER_DISCONNECTED | ORDER_IMPLEMENTATION_SPECIFIC | (mine[0] < theirs[0] ? ORDER_FOLLOWING : ORDER_PRECEDING)
        let i = 0
        while (i < mine.length && i < theirs.length && mine[i] === theirs[i]) i++
        if (i === mine.length) return ORDER_CONTAINED_BY | ORDER_FOLLOWING
        if (i === theirs.length) return ORDER_CONTAINS | ORDER_PRECEDING
        const siblings = mine[i - 1].childNodes
        return siblings.indexOf(mine[i]) < siblings.indexOf(theirs[i]) ? ORDER_FOLLOWING : ORDER_PRECEDING
    }

    _path() {
        const out = []
        let node = this
        while (node) {
            if (node.nodeType === 9) return out.concat(node._path())
            out.push(node)
            node = node.parentNode
        }
        return out
    }
}

Node.ELEMENT_NODE = 1
Node.TEXT_NODE = 3
Node.COMMENT_NODE = 8
Node.DOCUMENT_NODE = 9
Node.DOCUMENT_TYPE_NODE = 10
Node.DOCUMENT_FRAGMENT_NODE = 11
Node.DOCUMENT_POSITION_DISCONNECTED = ORDER_DISCONNECTED
Node.DOCUMENT_POSITION_PRECEDING = ORDER_PRECEDING
Node.DOCUMENT_POSITION_FOLLOWING = ORDER_FOLLOWING
Node.DOCUMENT_POSITION_CONTAINS = ORDER_CONTAINS
Node.DOCUMENT_POSITION_CONTAINED_BY = ORDER_CONTAINED_BY
Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC = ORDER_IMPLEMENTATION_SPECIFIC

export class CharacterData extends Node {
    constructor(doc, data = '') {
        super(doc)
        this.data = String(data)
    }

    get nodeValue() {
        return this.data
    }

    set nodeValue(value) {
        this.data = String(value)
    }

    get length() {
        return this.data.length
    }

    get textContent() {
        return this.data
    }

    set textContent(value) {
        this.data = String(value ?? '')
    }
}

export class Text extends CharacterData {
    get nodeType() {
        return 3
    }

    get nodeName() {
        return '#text'
    }

    get wholeText() {
        return this.data
    }
}

export class Comment extends CharacterData {
    get nodeType() {
        return 8
    }

    get nodeName() {
        return '#comment'
    }
}

export class DocumentType extends Node {
    constructor(doc, name) {
        super(doc)
        this.name = name
        this.publicId = ''
        this.systemId = ''
    }

    get nodeType() {
        return 10
    }

    get nodeName() {
        return this.name
    }
}

const descendantElements = (root) => {
    const out = []
    const walk = (node) => {
        for (const child of node.childNodes) {
            if (child.nodeType === 1) {
                out.push(child)
                walk(child)
            }
        }
    }
    walk(root)
    return out
}

const elementChildren = (node) => node.childNodes.filter((child) => child.nodeType === 1)

const nodesFrom = (doc, items) =>
    items.flat().map((item) => (typeof item === 'object' && item !== null && item.nodeType ? item : new Text(doc, String(item))))

class ParentNodeMixin {
    get children() {
        return elementChildren(this)
    }

    get childElementCount() {
        return elementChildren(this).length
    }

    get firstElementChild() {
        return elementChildren(this)[0] ?? null
    }

    get lastElementChild() {
        return elementChildren(this).at(-1) ?? null
    }

    querySelector(selector) {
        return queryOne(this, selector)
    }

    querySelectorAll(selector) {
        return queryAll(this, selector)
    }

    getElementsByTagName(name) {
        const wanted = String(name).toLowerCase()
        return descendantElements(this).filter((el) => wanted === '*' || el.localName === wanted)
    }

    getElementsByClassName(names) {
        const wanted = String(names).split(/\s+/).filter(Boolean)
        return descendantElements(this).filter((el) => {
            const classes = (el.getAttribute('class') ?? '').split(/\s+/)
            return wanted.length > 0 && wanted.every((name) => classes.includes(name))
        })
    }

    getElementById(id) {
        return descendantElements(this).find((el) => el.getAttribute('id') === String(id)) ?? null
    }
}

const applyMixin = (target) => {
    for (const key of Object.getOwnPropertyNames(ParentNodeMixin.prototype)) {
        if (key === 'constructor') continue
        Object.defineProperty(target.prototype, key, Object.getOwnPropertyDescriptor(ParentNodeMixin.prototype, key))
    }
}

export class DocumentFragment extends Node {
    get nodeType() {
        return 11
    }

    get nodeName() {
        return '#document-fragment'
    }
}
applyMixin(DocumentFragment)

class ClassList {
    constructor(el) {
        this._el = el
    }

    _list() {
        return (this._el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean)
    }

    _write(list) {
        this._el.setAttribute('class', [...new Set(list)].join(' '))
    }

    get length() {
        return this._list().length
    }

    get value() {
        return this._list().join(' ')
    }

    item(index) {
        return this._list()[index] ?? null
    }

    contains(token) {
        return this._list().includes(String(token))
    }

    add(...tokens) {
        this._write([...this._list(), ...tokens.map(String)])
    }

    remove(...tokens) {
        const drop = new Set(tokens.map(String))
        this._write(this._list().filter((token) => !drop.has(token)))
    }

    toggle(token, force) {
        const name = String(token)
        const present = this.contains(name)
        const want = force === undefined ? !present : Boolean(force)
        if (want && !present) this.add(name)
        if (!want && present) this.remove(name)
        return want
    }

    replace(oldToken, newToken) {
        const list = this._list()
        const index = list.indexOf(String(oldToken))
        if (index < 0) return false
        list[index] = String(newToken)
        this._write(list)
        return true
    }

    forEach(fn, thisArg) {
        this._list().forEach((token, index) => fn.call(thisArg, token, index, this))
    }

    keys() {
        return this._list().keys()
    }

    values() {
        return this._list().values()
    }

    entries() {
        return this._list().entries()
    }

    [Symbol.iterator]() {
        return this._list()[Symbol.iterator]()
    }

    toString() {
        return this.value
    }
}

const styleProxy = (el) =>
    new Proxy(
        {},
        {
            get(_, key) {
                if (typeof key !== 'string') return undefined
                const map = parseDeclarations(el.getAttribute('style') ?? '')
                switch (key) {
                    case 'cssText':
                        return serializeDeclarations(map)
                    case 'length':
                        return map.size
                    case 'setProperty':
                        return (name, value) => writeDecl(el, map, String(name).toLowerCase(), value)
                    case 'getPropertyValue':
                        return (name) => map.get(String(name).toLowerCase()) ?? ''
                    case 'removeProperty': {
                        return (name) => {
                            const lower = String(name).toLowerCase()
                            const old = map.get(lower) ?? ''
                            map.delete(lower)
                            el.setAttribute('style', serializeDeclarations(map))
                            return old
                        }
                    }
                    case 'item':
                        return (index) => [...map.keys()][index] ?? ''
                    default:
                        return map.get(kebab(key)) ?? ''
                }
            },
            set(_, key, value) {
                if (key === 'cssText') {
                    el.setAttribute('style', String(value))
                    return true
                }
                writeDecl(el, parseDeclarations(el.getAttribute('style') ?? ''), kebab(String(key)), value)
                return true
            }
        }
    )

const writeDecl = (el, map, name, value) => {
    const text = String(value ?? '')
    if (text === '') map.delete(name)
    else map.set(name, text)
    el.setAttribute('style', serializeDeclarations(map))
}

const datasetProxy = (el) => {
    const keyOf = (prop) => `data-${kebab(prop)}`
    const names = () => [...el._attrs.keys()].filter((name) => name.startsWith('data-')).map((name) => camel(name.slice(5)))
    return new Proxy(
        {},
        {
            get: (_, prop) => (typeof prop === 'string' ? (el.getAttribute(keyOf(prop)) ?? undefined) : undefined),
            set(_, prop, value) {
                el.setAttribute(keyOf(String(prop)), String(value))
                return true
            },
            has: (_, prop) => typeof prop === 'string' && el.hasAttribute(keyOf(prop)),
            deleteProperty(_, prop) {
                el.removeAttribute(keyOf(String(prop)))
                return true
            },
            ownKeys: () => names(),
            getOwnPropertyDescriptor(_, prop) {
                if (typeof prop !== 'string' || !el.hasAttribute(keyOf(prop))) return undefined
                return { value: el.getAttribute(keyOf(prop)), enumerable: true, configurable: true, writable: true }
            }
        }
    )
}

export class Element extends Node {
    constructor(doc, localName, attrs = []) {
        super(doc)
        this.localName = localName
        this._attrs = new Map(attrs)
    }

    get nodeType() {
        return 1
    }

    get nodeName() {
        return this.tagName
    }

    get tagName() {
        return this.localName.toUpperCase()
    }

    get namespaceURI() {
        return 'http://www.w3.org/1999/xhtml'
    }

    get id() {
        return this.getAttribute('id') ?? ''
    }

    set id(value) {
        this.setAttribute('id', value)
    }

    get className() {
        return this.getAttribute('class') ?? ''
    }

    set className(value) {
        this.setAttribute('class', value)
    }

    get classList() {
        return new ClassList(this)
    }

    get title() {
        return this.getAttribute('title') ?? ''
    }

    set title(value) {
        this.setAttribute('title', value)
    }

    get lang() {
        return this.getAttribute('lang') ?? ''
    }

    set lang(value) {
        this.setAttribute('lang', value)
    }

    get dir() {
        return this.getAttribute('dir') ?? ''
    }

    set dir(value) {
        this.setAttribute('dir', value)
    }

    get hidden() {
        return this.hasAttribute('hidden')
    }

    set hidden(value) {
        this.toggleAttribute('hidden', Boolean(value))
    }

    get tabIndex() {
        if (this.hasAttribute('tabindex')) return Number.parseInt(this.getAttribute('tabindex'), 10) || 0
        return ['a', 'button', 'input', 'select', 'textarea', 'iframe'].includes(this.localName) ? 0 : -1
    }

    set tabIndex(value) {
        this.setAttribute('tabindex', String(value))
    }

    get contentEditable() {
        return this.getAttribute('contenteditable') ?? 'inherit'
    }

    set contentEditable(value) {
        this.setAttribute('contenteditable', String(value))
    }

    get isContentEditable() {
        for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
            const value = node.getAttribute('contenteditable')
            if (value !== null) return value !== 'false'
        }
        return false
    }

    get dataset() {
        return datasetProxy(this)
    }

    get style() {
        return styleProxy(this)
    }

    get attributes() {
        return [...this._attrs.entries()].map(([name, value]) => ({ name, value, nodeName: name, nodeValue: value, specified: true }))
    }

    getAttribute(name) {
        const value = this._attrs.get(String(name).toLowerCase())
        return value === undefined ? null : value
    }

    setAttribute(name, value) {
        this._attrs.set(String(name).toLowerCase(), String(value))
        this._doc?._touch()
    }

    setAttributeNS(_, name, value) {
        this.setAttribute(name, value)
    }

    getAttributeNS(_, name) {
        return this.getAttribute(name)
    }

    removeAttribute(name) {
        this._attrs.delete(String(name).toLowerCase())
        this._doc?._touch()
    }

    hasAttribute(name) {
        return this._attrs.has(String(name).toLowerCase())
    }

    hasAttributes() {
        return this._attrs.size > 0
    }

    getAttributeNames() {
        return [...this._attrs.keys()]
    }

    toggleAttribute(name, force) {
        const present = this.hasAttribute(name)
        const want = force === undefined ? !present : Boolean(force)
        if (want && !present) this.setAttribute(name, '')
        if (!want && present) this.removeAttribute(name)
        return want
    }

    get innerHTML() {
        return serializeChildren(this)
    }

    set innerHTML(html) {
        const holder = makeElement(this._doc, this.localName)
        parseHtmlFragment(String(html), holder)
        this.textContent = ''
        for (const child of [...holder.childNodes]) insertNode(this, child, null)
    }

    get outerHTML() {
        return serializeNode(this)
    }

    set outerHTML(html) {
        const holder = makeElement(this._doc, this.localName)
        parseHtmlFragment(String(html), holder)
        const parent = this.parentNode
        if (!parent) return
        for (const child of [...holder.childNodes]) insertNode(parent, child, this)
        removeFromParent(this)
    }

    get innerText() {
        return innerTextOf(this)
    }

    set innerText(value) {
        this.textContent = value
    }

    get nextElementSibling() {
        let node = this.nextSibling
        while (node && node.nodeType !== 1) node = node.nextSibling
        return node
    }

    get previousElementSibling() {
        let node = this.previousSibling
        while (node && node.nodeType !== 1) node = node.previousSibling
        return node
    }

    matches(selector) {
        return selMatches(this, selector)
    }

    closest(selector) {
        return selClosest(this, selector)
    }

    insertAdjacentHTML(position, html) {
        const holder = makeElement(this._doc, 'div')
        parseHtmlFragment(String(html), holder)
        const nodes = [...holder.childNodes]
        const where = String(position).toLowerCase()
        if (where === 'beforebegin') for (const node of nodes) insertNode(this.parentNode, node, this)
        else if (where === 'afterbegin') for (const node of nodes.reverse()) insertNode(this, node, this.firstChild)
        else if (where === 'beforeend') for (const node of nodes) insertNode(this, node, null)
        else if (where === 'afterend') {
            const next = this.nextSibling
            for (const node of nodes) insertNode(this.parentNode, node, next)
        }
    }

    insertAdjacentElement(position, element) {
        this.insertAdjacentHTML(position, '')
        const where = String(position).toLowerCase()
        if (where === 'beforebegin') this.parentNode.insertBefore(element, this)
        else if (where === 'afterbegin') this.insertBefore(element, this.firstChild)
        else if (where === 'beforeend') this.appendChild(element)
        else if (where === 'afterend') this.parentNode.insertBefore(element, this.nextSibling)
        return element
    }

    insertAdjacentText(position, text) {
        this.insertAdjacentElement(position, new Text(this._doc, text))
    }

    append(...items) {
        for (const node of nodesFrom(this._doc, items)) insertNode(this, node, null)
    }

    prepend(...items) {
        const first = this.firstChild
        for (const node of nodesFrom(this._doc, items)) insertNode(this, node, first)
    }

    before(...items) {
        for (const node of nodesFrom(this._doc, items)) insertNode(this.parentNode, node, this)
    }

    after(...items) {
        const next = this.nextSibling
        for (const node of nodesFrom(this._doc, items)) insertNode(this.parentNode, node, next)
    }

    replaceWith(...items) {
        const parent = this.parentNode
        const next = this.nextSibling
        removeFromParent(this)
        for (const node of nodesFrom(this._doc, items)) insertNode(parent, node, next)
    }

    remove() {
        removeFromParent(this)
    }

    getBoundingClientRect() {
        return this._doc.layout().clientRect(this)
    }

    getClientRects() {
        return [this.getBoundingClientRect()]
    }

    get offsetWidth() {
        return this._doc.layout().boxOf(this)?.width ?? 0
    }

    get offsetHeight() {
        return this._doc.layout().boxOf(this)?.height ?? 0
    }

    get offsetTop() {
        return this._doc.layout().boxOf(this)?.y ?? 0
    }

    get offsetLeft() {
        return this._doc.layout().boxOf(this)?.x ?? 0
    }

    get clientWidth() {
        return this.offsetWidth
    }

    get clientHeight() {
        return this.offsetHeight
    }

    get scrollWidth() {
        return this.offsetWidth
    }

    get scrollHeight() {
        return this.offsetHeight
    }

    get scrollTop() {
        return 0
    }

    get scrollLeft() {
        return 0
    }

    scrollIntoView(options) {
        this._doc._scrollIntoView(this, options)
    }

    scrollIntoViewIfNeeded() {
        this._doc._scrollIntoView(this, { block: 'nearest' })
    }

    checkVisibility(options = {}) {
        for (let node = this; node && node.nodeType === 1; node = node.parentElement) {
            const style = this._doc.layout().computed(node)
            if (style.display === 'none') return false
        }
        if (options.visibilityProperty || options.checkVisibilityCSS) {
            const style = this._doc.layout().computed(this)
            if (style.visibility === 'hidden' || style.visibility === 'collapse') return false
        }
        return true
    }

    focus() {
        this._doc._focus(this)
    }

    blur() {
        if (this._doc._focused === this) this._doc._focus(null)
    }

    click() {
        const hooks = this._doc.hooks
        if (hooks.click) hooks.click(this)
        else this.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    }

    getAnimations() {
        return []
    }

    get part() {
        return new ClassList(this)
    }

    querySelector(selector) {
        return queryOne(this, selector)
    }

    querySelectorAll(selector) {
        return queryAll(this, selector)
    }
}
applyMixin(Element)

export class HTMLElement extends Element {}

const reflectBoolean = (proto, name) => {
    Object.defineProperty(proto, name, {
        configurable: true,
        get() {
            return this.hasAttribute(name)
        },
        set(value) {
            this.toggleAttribute(name, Boolean(value))
        }
    })
}

const reflectString = (proto, prop, attr = prop) => {
    Object.defineProperty(proto, prop, {
        configurable: true,
        get() {
            return this.getAttribute(attr) ?? ''
        },
        set(value) {
            this.setAttribute(attr, value)
        }
    })
}

const isFocusable = (el) => {
    if (el.hasAttribute('disabled') && ['input', 'button', 'select', 'textarea'].includes(el.localName)) return false
    if (el.localName === 'input') return el.type !== 'hidden'
    if (['select', 'textarea', 'button'].includes(el.localName)) return true
    if (el.localName === 'a' || el.localName === 'area') return el.hasAttribute('href')
    if (el.hasAttribute('tabindex')) return true
    return el.isContentEditable
}

export class HTMLInputElement extends HTMLElement {
    get type() {
        const raw = (this.getAttribute('type') ?? 'text').toLowerCase()
        return ['text', 'password', 'email', 'number', 'search', 'tel', 'url', 'checkbox', 'radio', 'submit', 'reset', 'button', 'hidden', 'file', 'image', 'date', 'time', 'color', 'range'].includes(raw) ? raw : 'text'
    }

    set type(value) {
        this.setAttribute('type', value)
    }

    get value() {
        if (this._dirtyValue) return this._value
        const attr = this.getAttribute('value')
        if (attr !== null) return attr
        return this.type === 'checkbox' || this.type === 'radio' ? 'on' : ''
    }

    set value(value) {
        this._value = String(value ?? '')
        this._dirtyValue = true
        this._selectAll = false
    }

    get defaultValue() {
        return this.getAttribute('value') ?? ''
    }

    set defaultValue(value) {
        this.setAttribute('value', value)
    }

    get checked() {
        return this._dirtyChecked ? this._checked : this.hasAttribute('checked')
    }

    set checked(value) {
        this._checked = Boolean(value)
        this._dirtyChecked = true
        if (this._checked && this.type === 'radio') {
            const scope = this.form ?? this.getRootNode()
            for (const other of descendantElements(scope)) {
                if (other !== this && other.localName === 'input' && other.type === 'radio' && other.name === this.name && other.name !== '') {
                    other._checked = false
                    other._dirtyChecked = true
                }
            }
        }
    }

    get defaultChecked() {
        return this.hasAttribute('checked')
    }

    set defaultChecked(value) {
        this.toggleAttribute('checked', Boolean(value))
    }

    get indeterminate() {
        return this._indeterminate === true
    }

    set indeterminate(value) {
        this._indeterminate = Boolean(value)
    }

    get form() {
        return closest(this, 'form')
    }

    get labels() {
        return labelsOf(this)
    }

    get selectionStart() {
        return this._selectAll ? 0 : this.value.length
    }

    get selectionEnd() {
        return this.value.length
    }

    select() {
        this._selectAll = true
    }

    setSelectionRange(start) {
        this._selectAll = Number(start) === 0
    }

    checkValidity() {
        return true
    }

    reportValidity() {
        return true
    }

    get files() {
        return null
    }
}
reflectString(HTMLInputElement.prototype, 'name')
reflectString(HTMLInputElement.prototype, 'placeholder')
reflectString(HTMLInputElement.prototype, 'autocomplete')
reflectString(HTMLInputElement.prototype, 'accept')
reflectBoolean(HTMLInputElement.prototype, 'disabled')
reflectBoolean(HTMLInputElement.prototype, 'readOnly')
reflectBoolean(HTMLInputElement.prototype, 'required')
reflectBoolean(HTMLInputElement.prototype, 'multiple')
reflectBoolean(HTMLInputElement.prototype, 'autofocus')

const closest = (el, selector) => selClosest(el, selector)

const labelsOf = (el) => {
    const scope = el.getRootNode()
    return descendantElements(scope).filter((node) => node.localName === 'label' && node.control === el)
}

export class HTMLTextAreaElement extends HTMLElement {
    get value() {
        if (this._dirtyValue) return this._value
        return textOf(this)
    }

    set value(value) {
        this._value = String(value ?? '')
        this._dirtyValue = true
        this._selectAll = false
    }

    get defaultValue() {
        return textOf(this)
    }

    set defaultValue(value) {
        this.textContent = value
    }

    get type() {
        return 'textarea'
    }

    get form() {
        return closest(this, 'form')
    }

    get labels() {
        return labelsOf(this)
    }

    get selectionStart() {
        return this._selectAll ? 0 : this.value.length
    }

    get selectionEnd() {
        return this.value.length
    }

    select() {
        this._selectAll = true
    }

    setSelectionRange(start) {
        this._selectAll = Number(start) === 0
    }

    checkValidity() {
        return true
    }
}
reflectString(HTMLTextAreaElement.prototype, 'name')
reflectString(HTMLTextAreaElement.prototype, 'placeholder')
reflectBoolean(HTMLTextAreaElement.prototype, 'disabled')
reflectBoolean(HTMLTextAreaElement.prototype, 'readOnly')
reflectBoolean(HTMLTextAreaElement.prototype, 'required')

export class HTMLOptionElement extends HTMLElement {
    get value() {
        return this.getAttribute('value') ?? textOf(this).replace(/\s+/g, ' ').trim()
    }

    set value(value) {
        this.setAttribute('value', value)
    }

    get text() {
        return textOf(this).replace(/\s+/g, ' ').trim()
    }

    set text(value) {
        this.textContent = value
    }

    get label() {
        return this.getAttribute('label') ?? this.text
    }

    set label(value) {
        this.setAttribute('label', value)
    }

    get selected() {
        if (this._dirtySelected) return this._selected
        return this.hasAttribute('selected')
    }

    set selected(value) {
        this._selected = Boolean(value)
        this._dirtySelected = true
        const select = closest(this, 'select')
        if (select && this._selected && !select.multiple) {
            for (const option of select.options) if (option !== this) {
                option._selected = false
                option._dirtySelected = true
            }
        }
    }

    get index() {
        const select = closest(this, 'select')
        return select ? select.options.indexOf(this) : 0
    }

    get disabled() {
        return this.hasAttribute('disabled')
    }

    set disabled(value) {
        this.toggleAttribute('disabled', Boolean(value))
    }

    get form() {
        return null
    }
}

export class HTMLSelectElement extends HTMLElement {
    get options() {
        return descendantElements(this).filter((node) => node.localName === 'option')
    }

    get multiple() {
        return this.hasAttribute('multiple')
    }

    set multiple(value) {
        this.toggleAttribute('multiple', Boolean(value))
    }

    get type() {
        return this.multiple ? 'select-multiple' : 'select-one'
    }

    get selectedOptions() {
        const selected = this.options.filter((option) => option.selected)
        if (selected.length === 0 && !this.multiple && this.options.length > 0) return [this.options[0]]
        return selected
    }

    get selectedIndex() {
        return this.options.indexOf(this.selectedOptions[0] ?? null)
    }

    set selectedIndex(index) {
        this.options.forEach((option, i) => {
            option.selected = i === index
        })
    }

    get value() {
        return this.selectedOptions[0]?.value ?? ''
    }

    set value(value) {
        for (const option of this.options) option.selected = option.value === String(value)
    }

    get length() {
        return this.options.length
    }

    item(index) {
        return this.options[index] ?? null
    }

    get form() {
        return closest(this, 'form')
    }

    get labels() {
        return labelsOf(this)
    }

    checkValidity() {
        return true
    }
}
reflectString(HTMLSelectElement.prototype, 'name')
reflectBoolean(HTMLSelectElement.prototype, 'disabled')
reflectBoolean(HTMLSelectElement.prototype, 'required')

export class HTMLButtonElement extends HTMLElement {
    get type() {
        const raw = (this.getAttribute('type') ?? 'submit').toLowerCase()
        return ['submit', 'reset', 'button'].includes(raw) ? raw : 'submit'
    }

    set type(value) {
        this.setAttribute('type', value)
    }

    get value() {
        return this.getAttribute('value') ?? ''
    }

    set value(value) {
        this.setAttribute('value', value)
    }

    get form() {
        return closest(this, 'form')
    }

    get labels() {
        return labelsOf(this)
    }

    checkValidity() {
        return true
    }
}
reflectString(HTMLButtonElement.prototype, 'name')
reflectBoolean(HTMLButtonElement.prototype, 'disabled')

export class HTMLFormElement extends HTMLElement {
    get elements() {
        return descendantElements(this).filter((node) => ['input', 'select', 'textarea', 'button'].includes(node.localName))
    }

    get length() {
        return this.elements.length
    }

    submit() {
        this._doc.hooks.submitForm?.(this, null, false)
    }

    requestSubmit(submitter) {
        this._doc.hooks.submitForm?.(this, submitter ?? null, true)
    }

    reset() {
        for (const el of this.elements) {
            if (el.localName === 'input') {
                el._dirtyValue = false
                el._dirtyChecked = false
            } else if (el.localName === 'textarea') el._dirtyValue = false
            else if (el.localName === 'select') for (const option of el.options) option._dirtySelected = false
        }
        this.dispatchEvent(new Event('reset', { bubbles: true, cancelable: true }))
    }

    checkValidity() {
        return true
    }

    reportValidity() {
        return true
    }
}
reflectString(HTMLFormElement.prototype, 'action')
reflectString(HTMLFormElement.prototype, 'method')
reflectString(HTMLFormElement.prototype, 'enctype')
reflectString(HTMLFormElement.prototype, 'target')
reflectString(HTMLFormElement.prototype, 'name')

export class HTMLAnchorElement extends HTMLElement {
    get href() {
        const raw = this.getAttribute('href')
        return raw === null ? '' : resolveUrl(raw, this._doc.baseURI)
    }

    set href(value) {
        this.setAttribute('href', value)
    }

    get text() {
        return this.textContent
    }

    set text(value) {
        this.textContent = value
    }
}
reflectString(HTMLAnchorElement.prototype, 'target')
reflectString(HTMLAnchorElement.prototype, 'rel')
reflectString(HTMLAnchorElement.prototype, 'download')

export class HTMLImageElement extends HTMLElement {
    get src() {
        const raw = this.getAttribute('src')
        return raw === null ? '' : resolveUrl(raw, this._doc.baseURI)
    }

    set src(value) {
        this.setAttribute('src', value)
    }

    get complete() {
        return true
    }

    get naturalWidth() {
        return 0
    }

    get naturalHeight() {
        return 0
    }
}
reflectString(HTMLImageElement.prototype, 'alt')

export class HTMLScriptElement extends HTMLElement {
    get src() {
        const raw = this.getAttribute('src')
        return raw === null ? '' : resolveUrl(raw, this._doc.baseURI)
    }

    set src(value) {
        this.setAttribute('src', value)
    }

    get text() {
        return textOf(this)
    }

    set text(value) {
        this.textContent = value
    }
}
reflectString(HTMLScriptElement.prototype, 'type')
reflectString(HTMLScriptElement.prototype, 'nonce')
reflectString(HTMLScriptElement.prototype, 'integrity')
reflectBoolean(HTMLScriptElement.prototype, 'async')
reflectBoolean(HTMLScriptElement.prototype, 'defer')

export class HTMLLinkElement extends HTMLElement {
    get href() {
        const raw = this.getAttribute('href')
        return raw === null ? '' : resolveUrl(raw, this._doc.baseURI)
    }

    set href(value) {
        this.setAttribute('href', value)
    }
}
reflectString(HTMLLinkElement.prototype, 'rel')

export class HTMLLabelElement extends HTMLElement {
    get control() {
        const target = this.getAttribute('for')
        if (target !== null) {
            const found = this._doc.getElementById(target)
            return found && ['input', 'select', 'textarea', 'button'].includes(found.localName) ? found : null
        }
        return descendantElements(this).find((node) => ['input', 'select', 'textarea', 'button'].includes(node.localName)) ?? null
    }

    get htmlFor() {
        return this.getAttribute('for') ?? ''
    }

    set htmlFor(value) {
        this.setAttribute('for', value)
    }

    get form() {
        return closest(this, 'form')
    }
}

export class HTMLIFrameElement extends HTMLElement {
    get contentWindow() {
        return null
    }

    get contentDocument() {
        return null
    }
}
reflectString(HTMLIFrameElement.prototype, 'src')
reflectString(HTMLIFrameElement.prototype, 'name')

const CONTEXT2D_METHODS = [
    'addHitRegion', 'arc', 'arcTo', 'beginPath', 'bezierCurveTo', 'clearHitRegions', 'clearRect', 'clip', 'closePath',
    'drawFocusIfNeeded', 'drawImage', 'ellipse', 'fill', 'fillRect', 'fillText', 'lineTo', 'moveTo', 'putImageData',
    'quadraticCurveTo', 'rect', 'removeHitRegion', 'reset', 'resetTransform', 'restore', 'rotate', 'save', 'scale',
    'scrollPathIntoView', 'setLineDash', 'setTransform', 'stroke', 'strokeRect', 'strokeText', 'transform', 'translate'
]

const createContext2D = (canvas) => {
    const context = {
        canvas,
        fillStyle: '#000000',
        strokeStyle: '#000000',
        font: '10px sans-serif',
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        lineWidth: 1,
        lineCap: 'butt',
        lineJoin: 'miter',
        lineDashOffset: 0,
        miterLimit: 10,
        textAlign: 'start',
        textBaseline: 'alphabetic',
        direction: 'ltr',
        imageSmoothingEnabled: true,
        imageSmoothingQuality: 'low',
        shadowBlur: 0,
        shadowColor: 'rgba(0, 0, 0, 0)',
        shadowOffsetX: 0,
        shadowOffsetY: 0,
        filter: 'none',
        measureText: (text) => ({
            width: String(text).length * 6,
            actualBoundingBoxLeft: 0,
            actualBoundingBoxRight: 0,
            actualBoundingBoxAscent: 0,
            actualBoundingBoxDescent: 0,
            fontBoundingBoxAscent: 0,
            fontBoundingBoxDescent: 0
        }),
        getImageData: (x, y, w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        createImageData: (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
        createLinearGradient: () => ({ addColorStop() {} }),
        createRadialGradient: () => ({ addColorStop() {} }),
        createPattern: () => null,
        getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
        getLineDash: () => [],
        isPointInPath: () => false,
        isPointInStroke: () => false
    }
    for (const name of CONTEXT2D_METHODS) context[name] = () => {}
    return context
}

export class HTMLCanvasElement extends HTMLElement {
    get width() {
        return Number.parseInt(this.getAttribute('width'), 10) || 300
    }

    set width(value) {
        this.setAttribute('width', String(value))
    }

    get height() {
        return Number.parseInt(this.getAttribute('height'), 10) || 150
    }

    set height(value) {
        this.setAttribute('height', String(value))
    }

    getContext(kind) {
        if (String(kind) !== '2d') return null
        this._context2d ??= createContext2D(this)
        return this._context2d
    }
}

const SIMPLE_TAGS = ['html', 'head', 'body', 'title', 'meta', 'style', 'template', 'base', 'div', 'span', 'p', 'table', 'ul', 'ol', 'li', 'section', 'article', 'nav', 'header', 'footer', 'main', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
const SIMPLE_CLASSES = new Map(SIMPLE_TAGS.map((tag) => [tag, class extends HTMLElement {}]))

const TAG_CLASSES = new Map([
    ['a', HTMLAnchorElement],
    ['input', HTMLInputElement],
    ['textarea', HTMLTextAreaElement],
    ['select', HTMLSelectElement],
    ['option', HTMLOptionElement],
    ['form', HTMLFormElement],
    ['button', HTMLButtonElement],
    ['label', HTMLLabelElement],
    ['script', HTMLScriptElement],
    ['img', HTMLImageElement],
    ['iframe', HTMLIFrameElement],
    ['canvas', HTMLCanvasElement],
    ['link', HTMLLinkElement]
])
for (const [tag, cls] of SIMPLE_CLASSES) if (!TAG_CLASSES.has(tag)) TAG_CLASSES.set(tag, cls)

export const makeElement = (doc, localName, attrs = []) => {
    const Cls = TAG_CLASSES.get(localName) ?? HTMLElement
    return new Cls(doc, localName, attrs)
}

const innerTextOf = (node) => {
    if (node.nodeType === 3) return node.data
    if (node.nodeType !== 1) return ''
    if (['script', 'style', 'template'].includes(node.localName)) return ''
    if (node.localName === 'br') return '\n'
    const inner = node.childNodes.map(innerTextOf).join('')
    const block = ['p', 'div', 'li', 'ul', 'ol', 'section', 'article', 'header', 'footer', 'nav', 'main', 'table', 'tr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre']
    const text = block.includes(node.localName) ? `\n${inner}\n` : inner
    return text
}

const VOID_OUT = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const RAW_OUT = new Set(['script', 'style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext'])
const escapeText = (s) => s.replace(/&/g, '&amp;').replace(/\u00a0/g, '&nbsp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeAttr = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/\u00a0/g, '&nbsp;')

export const serializeNode = (node) => {
    switch (node.nodeType) {
        case 1: {
            const tag = node.localName
            let out = `<${tag}`
            for (const [name, value] of node._attrs) out += ` ${name}="${escapeAttr(value)}"`
            out += '>'
            if (VOID_OUT.has(tag)) return out
            return `${out}${serializeChildren(node)}</${tag}>`
        }
        case 3:
            return node.parentNode && RAW_OUT.has(node.parentNode.localName) ? node.data : escapeText(node.data)
        case 8:
            return `<!--${node.data}-->`
        case 10:
            return `<!DOCTYPE ${node.name}>`
        case 9:
        case 11:
            return serializeChildren(node)
        default:
            return ''
    }
}

export const serializeChildren = (node) => node.childNodes.map(serializeNode).join('')

export const NodeFilter = Object.freeze({
    FILTER_ACCEPT: 1,
    FILTER_REJECT: 2,
    FILTER_SKIP: 3,
    SHOW_ALL: 0xffffffff,
    SHOW_ELEMENT: 0x1,
    SHOW_ATTRIBUTE: 0x2,
    SHOW_TEXT: 0x4,
    SHOW_CDATA_SECTION: 0x8,
    SHOW_ENTITY_REFERENCE: 0x10,
    SHOW_ENTITY: 0x20,
    SHOW_PROCESSING_INSTRUCTION: 0x40,
    SHOW_COMMENT: 0x80,
    SHOW_DOCUMENT: 0x100,
    SHOW_DOCUMENT_TYPE: 0x200,
    SHOW_DOCUMENT_FRAGMENT: 0x400,
    SHOW_NOTATION: 0x800
})

export class TreeWalker {
    constructor(root, whatToShow = NodeFilter.SHOW_ALL, filter = null) {
        this.root = root
        this.whatToShow = whatToShow >>> 0
        this.filter = filter
        this.currentNode = root
    }

    _accept(node) {
        if (!(this.whatToShow & (1 << (node.nodeType - 1)))) return NodeFilter.FILTER_SKIP
        if (!this.filter) return NodeFilter.FILTER_ACCEPT
        const result = typeof this.filter === 'function' ? this.filter(node) : this.filter.acceptNode(node)
        return result === NodeFilter.FILTER_REJECT || result === NodeFilter.FILTER_SKIP ? result : NodeFilter.FILTER_ACCEPT
    }

    parentNode() {
        let node = this.currentNode
        while (node && node !== this.root) {
            node = node.parentNode
            if (node && this._accept(node) === NodeFilter.FILTER_ACCEPT) {
                this.currentNode = node
                return node
            }
        }
        return null
    }

    firstChild() {
        return this._descend(true)
    }

    lastChild() {
        return this._descend(false)
    }

    _descend(first) {
        let node = first ? this.currentNode.firstChild : this.currentNode.lastChild
        while (node) {
            const result = this._accept(node)
            if (result === NodeFilter.FILTER_ACCEPT) {
                this.currentNode = node
                return node
            }
            if (result === NodeFilter.FILTER_SKIP && node.childNodes.length) {
                node = first ? node.firstChild : node.lastChild
                continue
            }
            while (node) {
                const sibling = first ? node.nextSibling : node.previousSibling
                if (sibling) {
                    node = sibling
                    break
                }
                const parent = node.parentNode
                if (!parent || parent === this.root || parent === this.currentNode) return null
                node = parent
            }
        }
        return null
    }

    nextSibling() {
        return this._sibling(true)
    }

    previousSibling() {
        return this._sibling(false)
    }

    _sibling(next) {
        let node = this.currentNode
        if (node === this.root) return null
        for (;;) {
            let sibling = next ? node.nextSibling : node.previousSibling
            while (sibling) {
                node = sibling
                const result = this._accept(node)
                if (result === NodeFilter.FILTER_ACCEPT) {
                    this.currentNode = node
                    return node
                }
                sibling = result === NodeFilter.FILTER_SKIP && node.childNodes.length
                    ? (next ? node.firstChild : node.lastChild)
                    : (next ? node.nextSibling : node.previousSibling)
            }
            node = node.parentNode
            if (!node || node === this.root || this._accept(node) === NodeFilter.FILTER_ACCEPT) return null
        }
    }

    nextNode() {
        let node = this.currentNode
        let result = NodeFilter.FILTER_ACCEPT
        for (;;) {
            while (result !== NodeFilter.FILTER_REJECT && node.childNodes.length) {
                node = node.childNodes[0]
                result = this._accept(node)
                if (result === NodeFilter.FILTER_ACCEPT) {
                    this.currentNode = node
                    return node
                }
            }
            let sibling = null
            for (let temp = node; temp; temp = temp.parentNode) {
                if (temp === this.root) return null
                sibling = temp.nextSibling
                if (sibling) {
                    node = sibling
                    break
                }
            }
            if (!sibling) return null
            result = this._accept(node)
            if (result === NodeFilter.FILTER_ACCEPT) {
                this.currentNode = node
                return node
            }
        }
    }

    previousNode() {
        let node = this.currentNode
        while (node !== this.root) {
            let sibling = node.previousSibling
            while (sibling) {
                node = sibling
                let result = this._accept(node)
                while (result !== NodeFilter.FILTER_REJECT && node.childNodes.length) {
                    node = node.childNodes.at(-1)
                    result = this._accept(node)
                }
                if (result === NodeFilter.FILTER_ACCEPT) {
                    this.currentNode = node
                    return node
                }
                sibling = node.previousSibling
            }
            if (node === this.root || !node.parentNode) return null
            node = node.parentNode
            if (this._accept(node) === NodeFilter.FILTER_ACCEPT) {
                this.currentNode = node
                return node
            }
        }
        return null
    }
}

export class Document extends Node {
    constructor(url = 'about:blank') {
        super(null)
        this._doc = this
        this._url = url
        this.viewport = { width: 1280, height: 720 }
        this.scrollY = 0
        this.hooks = {}
        this.readyState = 'loading'
        this.booted = false
        this._version = 0
        this._focused = null
        this._layout = null
        this._created = new Date()
        this._currentScript = null
    }

    get referrer() {
        return ''
    }

    get domain() {
        try {
            return new URL(this._url).hostname
        } catch {
            return ''
        }
    }

    get lastModified() {
        const pad = (value) => String(value).padStart(2, '0')
        const d = this._created
        return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
    }

    get location() {
        return this.hooks.window?.location ?? null
    }

    get currentScript() {
        return this._currentScript
    }

    get nodeType() {
        return 9
    }

    get nodeName() {
        return '#document'
    }

    get ownerDocument() {
        return null
    }

    get URL() {
        return this._url
    }

    get documentURI() {
        return this._url
    }

    get baseURI() {
        const base = this.querySelector('base[href]')
        return base ? resolveUrl(base.getAttribute('href'), this._url) : this._url
    }

    get defaultView() {
        return this.hooks.window ?? null
    }

    get documentElement() {
        return this.childNodes.find((node) => node.nodeType === 1) ?? null
    }

    get head() {
        return this.documentElement?.childNodes.find((node) => node.nodeType === 1 && node.localName === 'head') ?? null
    }

    get body() {
        return this.documentElement?.childNodes.find((node) => node.nodeType === 1 && (node.localName === 'body' || node.localName === 'frameset')) ?? null
    }

    get doctype() {
        return this.childNodes.find((node) => node.nodeType === 10) ?? null
    }

    get title() {
        const title = this.querySelector('title')
        return title ? title.textContent.replace(/\s+/g, ' ').trim() : ''
    }

    set title(value) {
        let title = this.querySelector('title')
        if (!title) {
            title = makeElement(this, 'title')
            ;(this.head ?? this.documentElement ?? this).appendChild(title)
        }
        title.textContent = value
    }

    get characterSet() {
        return 'UTF-8'
    }

    get charset() {
        return 'UTF-8'
    }

    get contentType() {
        return 'text/html'
    }

    get compatMode() {
        return 'CSS1Compat'
    }

    get scrollingElement() {
        return this.documentElement
    }

    get visibilityState() {
        return 'visible'
    }

    get hidden() {
        return false
    }

    get activeElement() {
        return this._focused ?? this.body ?? this.documentElement
    }

    get cookie() {
        return this.hooks.getCookie ? this.hooks.getCookie() : ''
    }

    set cookie(value) {
        this.hooks.setCookie?.(String(value))
    }

    get forms() {
        return queryAll(this, 'form')
    }

    get images() {
        return queryAll(this, 'img')
    }

    get links() {
        return queryAll(this, 'a[href], area[href]')
    }

    get scripts() {
        return queryAll(this, 'script')
    }

    get embeds() {
        return queryAll(this, 'embed')
    }

    hasFocus() {
        return true
    }

    createElement(name) {
        return makeElement(this, String(name).toLowerCase())
    }

    createElementNS(_, name) {
        return makeElement(this, String(name))
    }

    createTextNode(data) {
        return new Text(this, String(data))
    }

    createComment(data) {
        return new Comment(this, String(data))
    }

    createDocumentFragment() {
        return new DocumentFragment(this)
    }

    createEvent(kind = 'Event') {
        const event = String(kind).toLowerCase() === 'customevent' ? new CustomEvent('') : new Event('')
        event.initEvent = (type, bubbles, cancelable) => {
            event.type = String(type)
            event.bubbles = bubbles === true
            event.cancelable = cancelable === true
        }
        return event
    }

    createTreeWalker(root, whatToShow, filter) {
        return new TreeWalker(root, whatToShow, filter)
    }

    importNode(node, deep = false) {
        return cloneOf(node, deep)
    }

    adoptNode(node) {
        removeFromParent(node)
        node._doc = this
        return node
    }

    evaluate() {
        throw new Error('XPath evaluation is not supported by this engine')
    }

    open() {
        return this
    }

    close() {}

    write(...chunks) {
        if (!this.booted || !this.body) return
        this.body.insertAdjacentHTML('beforeend', chunks.join(''))
    }

    writeln(...chunks) {
        this.write(...chunks, '\n')
    }

    getSelection() {
        return this.hooks.getSelection ? this.hooks.getSelection() : null
    }

    _path() {
        const window = this.hooks.window
        return window ? [this, window] : [this]
    }

    _touch() {
        this._version++
    }

    layout() {
        if (!this._layout) this._layout = new Layout(this)
        return this._layout
    }

    _focus(el) {
        const next = el && isFocusable(el) ? el : null
        if (this._focused === next) return
        const previous = this._focused
        this._focused = next
        if (previous) {
            previous.dispatchEvent(new FocusEvent('blur', { relatedTarget: next }))
            previous.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: next }))
        }
        if (next) {
            next.dispatchEvent(new FocusEvent('focus', { relatedTarget: previous }))
            next.dispatchEvent(new FocusEvent('focusin', { bubbles: true, relatedTarget: previous }))
        }
    }

    _scrollIntoView(el, options = {}) {
        const box = this.layout().boxOf(el)
        if (!box) return
        const height = this.viewport.height
        const max = Math.max(0, this.layout().contentHeight - height)
        const block = options.block ?? 'start'
        let target = box.y
        if (block === 'center') target = box.y + box.height / 2 - height / 2
        else if (block === 'end') target = box.y + box.height - height
        else if (block === 'nearest') {
            if (box.y >= this.scrollY && box.y + box.height <= this.scrollY + height) return
            target = box.y < this.scrollY ? box.y : box.y + box.height - height
        }
        this.scrollY = Math.min(max, Math.max(0, target))
    }

    getElementById(id) {
        return descendantElements(this).find((el) => el.getAttribute('id') === String(id)) ?? null
    }

    elementFromPoint(x, y) {
        return this.layout().hitTest(Number(x), Number(y)) ?? null
    }
}
applyMixin(Document)


export const nearestFocusable = (el) => {
    for (let node = el; node && node.nodeType === 1; node = node.parentElement) if (isFocusable(node)) return node
    return null
}

export const focusableList = (doc) => descendantElements(doc).filter((el) => isFocusable(el) && el.tabIndex >= 0)
