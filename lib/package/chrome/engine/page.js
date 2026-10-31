import * as dom from './dom.js'
import { parseDocumentHtml } from './html.js'
import { createRealm } from './runtime.js'
import { fetchResource, NetError } from './http.js'

export const DEFAULT_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36'
const NETWORK_IDLE_MS = 500
const SCRIPT_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript', 'module', 'text/jscript', 'text/livescript', 'application/x-javascript'])
const BUTTON_INDEX = { none: 0, left: 0, middle: 1, right: 2, back: 3, forward: 4 }
const TEXT_INPUT_TYPES = new Set(['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range'])
const ERROR_REASONS = { aborted: 'net::ERR_ABORTED', accessdenied: 'net::ERR_ACCESS_DENIED', blockedbyclient: 'net::ERR_BLOCKED_BY_CLIENT', failed: 'net::ERR_FAILED', timedout: 'net::ERR_TIMED_OUT', connectionrefused: 'net::ERR_CONNECTION_REFUSED', internetdisconnected: 'net::ERR_INTERNET_DISCONNECTED', addressunreachable: 'net::ERR_ADDRESS_UNREACHABLE', namenotresolved: 'net::ERR_NAME_NOT_RESOLVED' }

const modifierFlags = (bits = 0) => ({ altKey: (bits & 1) !== 0, ctrlKey: (bits & 2) !== 0, metaKey: (bits & 4) !== 0, shiftKey: (bits & 8) !== 0 })

const isScriptType = (type) => SCRIPT_TYPES.has(String(type ?? '').trim().toLowerCase())

const isEditable = (el) => {
    if (!el || el.nodeType !== 1) return false
    if (el.localName === 'textarea') return !el.readOnly && !el.disabled
    if (el.localName === 'input') return TEXT_INPUT_TYPES.has(el.type) && !el.readOnly && !el.disabled
    return el.isContentEditable === true
}

const headerObject = (pairs) => {
    const out = {}
    for (const [name, value] of pairs) out[name] = out[name] === undefined ? value : `${out[name]}, ${value}`
    return out
}

const describeError = (error) => {
    if (!error || typeof error !== 'object') return String(error)
    const head = `${error.name ?? 'Error'}: ${error.message ?? ''}`.replace(/: $/, '')
    const frames = String(error.stack ?? '')
        .split('\n')
        .filter((line) => /^\s+at /.test(line))
    return frames.length ? `${head}\n${frames.join('\n')}` : head
}

const escapeHtml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const decodeBody = (buffer, contentType) => {
    const charset = /charset=([^;]+)/i.exec(contentType ?? '')?.[1]?.trim().replace(/['"]/g, '') ?? 'utf-8'
    try {
        return new TextDecoder(charset).decode(buffer)
    } catch {
        return buffer.toString('utf8')
    }
}

const documentSourceFor = (buffer, contentType) => {
    const mime = (contentType ?? '').split(';')[0].trim().toLowerCase() || 'text/html'
    if (mime.includes('html') || mime.includes('xml')) return decodeBody(buffer, contentType)
    if (mime.startsWith('text/') || mime.includes('json') || mime.includes('javascript')) {
        return `<html><head></head><body><pre>${escapeHtml(decodeBody(buffer, contentType))}</pre></body></html>`
    }
    return '<html><head></head><body></body></html>'
}

const normalizeBody = (body) => {
    if (body === null || body === undefined) return null
    if (typeof body === 'string') return Buffer.from(body, 'utf8')
    if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
    if (body instanceof ArrayBuffer) return Buffer.from(body)
    if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
    return Buffer.from(String(body), 'utf8')
}

export class EnginePage {
    constructor({ id, context, notify }) {
        this.id = id
        this.context = context
        this.notify = notify
        this.frameId = `frame-${id}`
        this.url = 'about:blank'
        this.doc = null
        this.realm = null
        this.loaderId = null
        this.loaderSeq = 0
        this.requestSeq = 0
        this.exceptionSeq = 0
        this.navToken = 0
        this.entries = [{ id: 1, url: 'about:blank', state: null }]
        this.index = 0
        this.entrySeq = 1
        this.lifecycle = new Map()
        this.fetchEnabled = false
        this.pendingDecisions = new Map()
        this.bodies = new Map()
        this.initScripts = []
        this.initSeq = 0
        this.pendingNetwork = 0
        this.idleTimer = null
        this.pressTarget = null
        this.lastHover = null
        this.activating = false
        this.closed = false
        this.defaultUserAgent = DEFAULT_USER_AGENT
        this.emulation = { viewport: { width: 1280, height: 720 }, userAgent: null, locale: null, timezoneId: null, colorScheme: null, reducedMotion: null, hasTouch: false, javaScriptEnabled: true, bypassCSP: false, extraHeaders: {} }
        this.doc = new dom.Document('about:blank')
        this.doc.viewport = { ...this.emulation.viewport }
        this.doc.booted = true
        parseDocumentHtml(this.doc, '')
        this.realm = createRealm({ page: this, doc: this.doc, jar: this.context.jar, storage: this.context.storageHost })
    }

    get origin() {
        try {
            return new URL(this.url).origin
        } catch {
            return ''
        }
    }

    get win() {
        return this.realm.window
    }

    nextRequestId() {
        return `${this.id}.${++this.requestSeq}`
    }

    setViewport(size) {
        this.emulation.viewport = { width: size.width, height: size.height }
        this.doc.viewport = { ...this.emulation.viewport }
        this.doc._touch()
    }

    reportError(error) {
        const description = describeError(error)
        const url = this.url
        this.notify('Runtime.exceptionThrown', {
            timestamp: Date.now(),
            exceptionDetails: {
                exceptionId: ++this.exceptionSeq,
                text: 'Uncaught',
                lineNumber: 0,
                columnNumber: 0,
                url,
                exception: { type: 'object', subtype: 'error', className: error?.name ?? 'Error', description }
            }
        })
    }

    emitConsole(type, args) {
        this.notify('Runtime.consoleAPICalled', { type, args, executionContextId: 1, timestamp: Date.now(), stackTrace: { callFrames: [] } })
    }

    emitDialog(type, message, defaultPrompt) {
        this.notify('Page.javascriptDialogOpening', { url: this.url, message, type, defaultPrompt, hasBrowserHandler: false })
    }

    emitLifecycle(name, loaderId = this.loaderId) {
        this.lifecycle.get(loaderId)?.add(name)
        this.notify('Page.lifecycleEvent', { frameId: this.frameId, loaderId, name, timestamp: Date.now() })
    }

    baseHeaders(type) {
        const headers = {
            'user-agent': this.emulation.userAgent ?? this.defaultUserAgent,
            'accept-language': `${this.emulation.locale ?? 'en-US'},en;q=0.9`,
            accept: type === 'Document' ? 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' : '*/*'
        }
        return { ...headers, ...this.emulation.extraHeaders }
    }

    async performRequest({ url, method = 'GET', headers = {}, body = null, type }) {
        const requestId = this.nextRequestId()
        const loaderId = this.loaderId
        let finalUrl = url
        let finalMethod = method
        let finalHeaders = { ...this.baseHeaders(type), ...headers }
        let finalBody = body
        this.notify('Network.requestWillBeSent', this.requestEvent(requestId, loaderId, finalUrl, finalMethod, finalHeaders, finalBody, type))
        let fulfilled = null
        if (this.fetchEnabled) {
            const decision = await this.pauseRequest(requestId, finalUrl, finalMethod, finalHeaders, finalBody, type)
            if (decision.kind === 'fail') {
                this.notify('Network.loadingFailed', { requestId, timestamp: Date.now(), type, errorText: decision.errorText, canceled: false })
                throw new NetError(decision.errorText)
            }
            if (decision.kind === 'fulfill') fulfilled = { ...decision.response, url: finalUrl }
            else {
                finalUrl = decision.url ?? finalUrl
                finalMethod = decision.method ?? finalMethod
                finalHeaders = decision.headers ?? finalHeaders
                finalBody = decision.body !== undefined ? decision.body : finalBody
            }
        }
        this.pendingNetwork++
        let result
        try {
            result = fulfilled ?? (await fetchResource({ url: finalUrl, method: finalMethod, headers: finalHeaders, body: normalizeBody(finalBody), jar: this.context.jar }))
        } catch (error) {
            this.pendingNetwork--
            const errorText = error instanceof NetError ? error.errorText : 'net::ERR_FAILED'
            this.notify('Network.loadingFailed', { requestId, timestamp: Date.now(), type, errorText, canceled: false })
            this.scheduleIdle()
            throw error instanceof NetError ? error : new NetError(errorText)
        }
        this.emitResponse(requestId, loaderId, type, result)
        this.pendingNetwork--
        this.scheduleIdle()
        return { ...result, requestId }
    }

    requestEvent(requestId, loaderId, url, method, headers, body, type) {
        const request = { url, method, headers }
        if (body !== null && body !== undefined) {
            request.postData = normalizeBody(body).toString('utf8')
            request.hasPostData = true
        }
        return { requestId, loaderId, documentURL: this.url, request, timestamp: Date.now() / 1000, wallTime: Date.now() / 1000, initiator: { type: 'other' }, type, frameId: this.frameId, hasUserGesture: false }
    }

    emitResponse(requestId, loaderId, type, result) {
        const hops = result.hops ?? []
        for (let index = 1; index < hops.length; index++) {
            const previous = hops[index - 1]
            const current = hops[index]
            this.notify('Network.requestWillBeSent', {
                requestId,
                loaderId,
                documentURL: this.url,
                request: { url: current.url, method: current.method, headers: current.requestHeaders },
                timestamp: Date.now() / 1000,
                wallTime: Date.now() / 1000,
                initiator: { type: 'other' },
                type,
                frameId: this.frameId,
                redirectResponse: { url: previous.url, status: previous.status, statusText: previous.statusText, headers: headerObject(previous.headers), mimeType: '', protocol: 'http/1.1' }
            })
        }
        const contentType = result.headers.find(([name]) => name === 'content-type')?.[1] ?? ''
        this.bodies.set(requestId, result.body ?? Buffer.alloc(0))
        if (this.bodies.size > 200) this.bodies.delete(this.bodies.keys().next().value)
        this.notify('Network.responseReceived', {
            requestId,
            loaderId,
            timestamp: Date.now() / 1000,
            type,
            frameId: this.frameId,
            response: {
                url: result.url,
                status: result.status,
                statusText: result.statusText,
                headers: headerObject(result.headers),
                mimeType: contentType.split(';')[0].trim(),
                charset: '',
                connectionReused: false,
                encodedDataLength: result.body?.length ?? 0,
                protocol: 'http/1.1',
                securityState: 'neutral'
            }
        })
        this.notify('Network.loadingFinished', { requestId, timestamp: Date.now() / 1000, encodedDataLength: result.body?.length ?? 0 })
    }

    pauseRequest(requestId, url, method, headers, body, type) {
        return new Promise((resolve) => {
            this.pendingDecisions.set(requestId, resolve)
            const request = { url, method, headers }
            if (body !== null && body !== undefined) {
                request.postData = normalizeBody(body).toString('base64')
                request.hasPostData = true
            }
            this.notify('Fetch.requestPaused', { requestId, request, frameId: this.frameId, resourceType: type, timestamp: Date.now() / 1000 })
        })
    }

    decide(requestId, decision) {
        const resolve = this.pendingDecisions.get(requestId)
        if (!resolve) throw new Error(`Unknown request id: ${requestId}`)
        this.pendingDecisions.delete(requestId)
        resolve(decision)
    }

    scheduleIdle() {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
        if (this.pendingNetwork > 0 || this.closed) return
        const token = this.navToken
        this.idleTimer = setTimeout(() => {
            this.idleTimer = null
            if (token === this.navToken && this.pendingNetwork === 0 && this.loaderId) this.emitLifecycle('networkIdle')
        }, NETWORK_IDLE_MS)
    }

    async navigate(target, options = {}) {
        const mode = options.history ?? 'push'
        const url = new URL(String(target), this.url || 'about:blank').href
        const loaderId = `${this.id}-L${++this.loaderSeq}`
        const token = ++this.navToken
        let result
        try {
            result = await this.fetchDocument(url, options, loaderId)
        } catch (error) {
            if (token !== this.navToken) return { loaderId, frameId: this.frameId, errorText: 'net::ERR_ABORTED' }
            if (error instanceof NetError) return { loaderId, frameId: this.frameId, errorText: error.errorText }
            return { loaderId, frameId: this.frameId, errorText: 'net::ERR_FAILED' }
        }
        if (token !== this.navToken) return { loaderId, frameId: this.frameId, errorText: 'net::ERR_ABORTED' }
        if (result.isDownload) return { loaderId, frameId: this.frameId, isDownload: true }
        this.commit(result.url, loaderId, mode, documentSourceFor(result.body, result.contentType), token)
        return { loaderId, frameId: this.frameId }
    }

    async fetchDocument(url, options, loaderId) {
        if (url.startsWith('about:')) return { url, body: Buffer.alloc(0), contentType: 'text/html', isDownload: false }
        const requestId = this.nextRequestId()
        const headers = { ...this.baseHeaders('Document'), ...(options.headers ?? {}) }
        const method = options.method ?? 'GET'
        const body = options.body ?? null
        this.notify('Network.requestWillBeSent', this.requestEvent(requestId, loaderId, url, method, headers, body, 'Document'))
        let fulfilled = null
        let finalUrl = url
        let finalMethod = method
        let finalHeaders = headers
        let finalBody = body
        if (this.fetchEnabled) {
            const decision = await this.pauseRequest(requestId, url, method, headers, body, 'Document')
            if (decision.kind === 'fail') {
                this.notify('Network.loadingFailed', { requestId, timestamp: Date.now() / 1000, type: 'Document', errorText: decision.errorText, canceled: false })
                throw new NetError(decision.errorText)
            }
            if (decision.kind === 'fulfill') fulfilled = { ...decision.response, url: finalUrl }
            else {
                finalUrl = decision.url ?? url
                finalMethod = decision.method ?? method
                finalHeaders = decision.headers ?? headers
                finalBody = decision.body !== undefined ? decision.body : body
            }
        }
        this.pendingNetwork++
        let result
        try {
            result = fulfilled ?? (await fetchResource({ url: finalUrl, method: finalMethod, headers: finalHeaders, body: normalizeBody(finalBody), jar: this.context.jar }))
        } catch (error) {
            this.pendingNetwork--
            const errorText = error instanceof NetError ? error.errorText : 'net::ERR_FAILED'
            this.notify('Network.loadingFailed', { requestId, timestamp: Date.now() / 1000, type: 'Document', errorText, canceled: false })
            throw error instanceof NetError ? error : new NetError(errorText)
        }
        this.pendingNetwork--
        const disposition = result.headers.find(([name]) => name === 'content-disposition')?.[1] ?? ''
        const contentType = result.headers.find(([name]) => name === 'content-type')?.[1] ?? ''
        if (/attachment/i.test(disposition)) {
            this.notify('Network.loadingFinished', { requestId, timestamp: Date.now() / 1000, encodedDataLength: 0 })
            return { isDownload: true }
        }
        this.emitResponse(requestId, loaderId, 'Document', result)
        return { url: result.url, body: result.body, contentType, isDownload: false }
    }

    commit(url, loaderId, mode, source, token) {
        this.disposeRealm()
        this.url = url
        if (mode === 'push') this.pushEntry(url, null)
        else if (mode === 'replace') this.entries[this.index].url = url
        this.loaderId = loaderId
        this.lifecycle.set(loaderId, new Set())
        this.doc = new dom.Document(url)
        this.doc.viewport = { ...this.emulation.viewport }
        parseDocumentHtml(this.doc, source)
        this.notify('Page.frameNavigated', { frame: { id: this.frameId, loaderId, url, domainAndRegistry: '', securityOrigin: this.origin, mimeType: 'text/html', secureContextType: 'Secure', crossOriginIsolatedContextType: 'NotIsolated', gatedAPIFeatures: [] } })
        this.emitLifecycle('init', loaderId)
        this.realm = createRealm({ page: this, doc: this.doc, jar: this.context.jar, storage: this.context.storageHost })
        this.runInitScripts()
        this.runDocument(token, loaderId).catch((error) => this.reportError(error))
    }

    runInitScripts() {
        for (const script of this.initScripts) {
            try {
                this.realm.evaluate(script.source, 'init-script')
            } catch (error) {
                this.reportError(error)
            }
        }
    }

    disposeRealm() {
        clearTimeout(this.idleTimer)
        this.idleTimer = null
        this.realm?.dispose()
    }

    async runDocument(token, loaderId) {
        const doc = this.doc
        doc.booted = true
        const scripts = doc.querySelectorAll('script')
        for (const script of scripts) script._alreadyStarted = true
        doc.hooks.onScript = (script) => this.onDynamicScript(script, token)
        const stylesheets = doc.querySelectorAll('link[href]').filter((link) => (link.getAttribute('rel') ?? '').toLowerCase().includes('stylesheet'))
        for (const link of stylesheets) {
            if (token !== this.navToken) return
            try {
                const result = await this.performRequest({ url: link.href, type: 'Stylesheet' })
                link._cssText = decodeBody(result.body, result.headers.find(([name]) => name === 'content-type')?.[1])
            } catch {}
        }
        for (const script of scripts) {
            if (token !== this.navToken) return
            if (!isScriptType(script.getAttribute('type'))) continue
            if (script.hasAttribute('src')) {
                const code = await this.loadScript(script.src, token)
                if (code !== null) this.runScript(code, script.src, script)
            } else this.runScript(script.textContent, this.url, script)
        }
        if (token !== this.navToken) return
        doc.readyState = 'interactive'
        this.emitLifecycle('DOMContentLoaded', loaderId)
        doc.dispatchEvent(new dom.Event('readystatechange'))
        doc.dispatchEvent(new dom.Event('DOMContentLoaded', { bubbles: true }))
        this.notify('Page.domContentEventFired', { timestamp: Date.now() / 1000 })
        await this.waitForQuiet(token)
        if (token !== this.navToken) return
        doc.readyState = 'complete'
        doc.dispatchEvent(new dom.Event('readystatechange'))
        this.win.dispatchEvent(new dom.Event('load'))
        this.emitLifecycle('load', loaderId)
        this.notify('Page.loadEventFired', { timestamp: Date.now() / 1000 })
        this.scheduleIdle()
        this.scheduleMetaRefresh(token)
    }

    scheduleMetaRefresh(token) {
        const meta = this.doc.querySelectorAll('meta[http-equiv]').find((node) => (node.getAttribute('http-equiv') ?? '').toLowerCase() === 'refresh')
        if (!meta) return
        const match = /^\s*(\d+(?:\.\d+)?)\s*(?:[;,]\s*(?:url\s*=\s*)?['"]?(.*?)['"]?\s*)?$/i.exec(meta.getAttribute('content') ?? '')
        if (!match) return
        const target = match[2] ? new URL(match[2], this.url).href : this.url
        setTimeout(() => {
            if (token === this.navToken) this.navigate(target, { history: 'replace' }).catch(() => {})
        }, Number(match[1]) * 1000)
    }

    async waitForQuiet(token) {
        const deadline = Date.now() + 30000
        while (this.pendingNetwork > 0 && token === this.navToken && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 10))
        }
    }

    async loadScript(url, token) {
        try {
            const result = await this.performRequest({ url, type: 'Script' })
            if (token !== this.navToken) return null
            return decodeBody(result.body, result.headers.find(([name]) => name === 'content-type')?.[1])
        } catch {
            return null
        }
    }

    runScript(code, url, element = null) {
        const doc = this.doc
        const previous = doc._currentScript
        doc._currentScript = element
        try {
            this.realm.evaluate(code, url || 'inline')
        } catch (error) {
            this.reportError(error)
        } finally {
            doc._currentScript = previous
        }
    }

    onDynamicScript(script, token) {
        if (script._alreadyStarted || !isScriptType(script.getAttribute('type'))) return
        script._alreadyStarted = true
        Promise.resolve().then(async () => {
            if (token !== this.navToken) return
            if (script.hasAttribute('src')) {
                const code = await this.loadScript(script.src, token)
                if (code !== null && token === this.navToken) this.runScript(code, script.src, script)
            } else this.runScript(script.textContent, this.url, script)
        })
    }

    async setContent(html) {
        const token = ++this.navToken
        this.disposeRealm()
        this.doc = new dom.Document(this.url)
        this.doc.viewport = { ...this.emulation.viewport }
        parseDocumentHtml(this.doc, String(html))
        this.realm = createRealm({ page: this, doc: this.doc, jar: this.context.jar, storage: this.context.storageHost })
        this.runInitScripts()
        await this.runDocument(token, this.loaderId).catch((error) => this.reportError(error))
    }

    pushEntry(url, state) {
        this.entries.splice(this.index + 1)
        this.entries.push({ id: ++this.entrySeq, url, state })
        this.index = this.entries.length - 1
    }

    pushHistory(state, url, mode) {
        const next = url === undefined || url === null ? this.url : new URL(String(url), this.url).href
        if (mode === 'replace') {
            this.entries[this.index] = { ...this.entries[this.index], url: next, state: state ?? null }
        } else this.pushEntry(next, state ?? null)
        this.url = next
        if (this.doc) this.doc._url = next
        this.notify('Page.navigatedWithinDocument', { frameId: this.frameId, url: next })
    }

    scheduleNavigation(url, options = {}) {
        const target = new URL(url, this.url || 'about:blank')
        const current = new URL(this.url || 'about:blank')
        if (target.href.split('#')[0] === current.href.split('#')[0] && target.hash !== current.hash) {
            this.pushHistory(null, target.href, options.history === 'replace' ? 'replace' : 'push')
            return
        }
        setImmediate(() => {
            this.navigate(target.href, { history: options.history ?? 'push' }).catch(() => {})
        })
    }

    traverse(delta) {
        const next = this.index + delta
        const entry = this.entries[next]
        if (!entry) return
        this.index = next
        this.navigate(entry.url, { history: 'none' }).catch(() => {})
    }

    async fetchFromScript(input, init = {}) {
        const source = typeof input === 'object' && input !== null && 'url' in input ? input.url : String(input)
        const url = new URL(source, this.url || 'about:blank').href
        const method = String(init.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase()
        const headers = {}
        const pairs = init.headers ? new Headers(init.headers) : null
        if (pairs) for (const [name, value] of pairs) headers[name] = value
        let body = init.body ?? null
        if (body instanceof FormData) body = new URLSearchParams([...body.entries()].map(([k, v]) => [k, String(v)])).toString()
        const result = await this.performRequest({ url, method, headers: { ...headers }, body, type: 'Fetch' })
        const status = result.status >= 200 && result.status <= 599 ? result.status : 200
        const nullBody = status === 204 || status === 205 || status === 304
        const response = new Response(nullBody ? null : result.body, { status, statusText: result.statusText, headers: result.headers })
        Object.defineProperty(response, 'url', { value: result.url, enumerable: true })
        Object.defineProperty(response, 'redirected', { value: (result.hops?.length ?? 1) > 1, enumerable: true })
        return response
    }

    async xhrFromScript(method, url, headers, body) {
        const absolute = new URL(String(url), this.url || 'about:blank').href
        const result = await this.performRequest({ url: absolute, method, headers, body: body ?? null, type: 'XHR' })
        return { status: result.status, statusText: result.statusText, url: result.url, headers: result.headers, text: decodeBody(result.body, result.headers.find(([name]) => name === 'content-type')?.[1]) }
    }

    clickElement(el, options = {}) {
        if (!el || el.nodeType !== 1) return false
        const init = { bubbles: true, cancelable: true, composed: true, clientX: options.x ?? 0, clientY: options.y ?? 0, screenX: options.x ?? 0, screenY: options.y ?? 0, button: options.button ?? 0, buttons: 0, detail: options.clickCount ?? 1, view: this.win, ...modifierFlags(options.modifiers) }
        const event = new dom.MouseEvent('click', init)
        event.isTrusted = options.trusted !== false
        const checkable = el.localName === 'input' && (el.type === 'checkbox' || el.type === 'radio')
        const previous = checkable ? el.checked : null
        if (checkable) {
            if (el.type === 'checkbox') el.checked = !previous
            else el.checked = true
        }
        const proceed = el.dispatchEvent(event)
        if (!proceed) {
            if (checkable) el.checked = previous
            return false
        }
        if (checkable) {
            el.dispatchEvent(new dom.Event('input', { bubbles: true, composed: true }))
            el.dispatchEvent(new dom.Event('change', { bubbles: true }))
            return true
        }
        if (this.activating) return true
        this.activating = true
        try {
            const anchor = el.closest('a[href]')
            const label = el.closest('label')
            const interactive = ['input', 'select', 'textarea', 'button', 'a'].includes(el.localName)
            if (label && label.control && label.control !== el && !interactive) this.clickElement(label.control, { trusted: true })
            else if (anchor && (el === anchor || anchor.contains(el))) this.followLink(anchor)
            else if (this.isSubmitter(el)) {
                const form = el.form
                if (form) this.submitForm(form, el, true)
            } else if (el.localName === 'button' && el.type === 'reset' && el.form) el.form.reset()
        } finally {
            this.activating = false
        }
        return true
    }

    isSubmitter(el) {
        if (el.localName === 'button') return el.type === 'submit'
        return el.localName === 'input' && (el.type === 'submit' || el.type === 'image')
    }

    followLink(anchor) {
        const href = anchor.getAttribute('href')
        if (href === null) return
        if (/^(javascript|mailto|tel):/i.test(href.trim())) return
        const target = (anchor.getAttribute('target') ?? '').toLowerCase()
        if (target === '_blank') return
        this.scheduleNavigation(new URL(href, this.doc.baseURI).href, { history: 'push' })
    }

    submitForm(form, submitter, dispatchSubmit) {
        if (dispatchSubmit) {
            const event = new dom.Event('submit', { bubbles: true, cancelable: true })
            event.isTrusted = true
            if (!form.dispatchEvent(event)) return
        }
        const entries = []
        for (const el of form.elements) {
            const name = el.getAttribute('name')
            if (!name || el.disabled) continue
            if (el.localName === 'input') {
                const type = el.type
                if (type === 'checkbox' || type === 'radio') {
                    if (el.checked) entries.push([name, el.getAttribute('value') ?? 'on'])
                } else if (type === 'submit' || type === 'image') {
                    if (el === submitter) entries.push([name, el.value])
                } else if (type !== 'button' && type !== 'reset' && type !== 'file') entries.push([name, el.value])
            } else if (el.localName === 'select') {
                for (const option of el.selectedOptions) entries.push([name, option.value])
            } else if (el.localName === 'textarea') entries.push([name, el.value])
            else if (el.localName === 'button' && el === submitter && el.type === 'submit') entries.push([name, el.value])
        }
        const action = form.getAttribute('action') ? new URL(form.getAttribute('action'), this.doc.baseURI).href : this.url
        const method = (form.getAttribute('method') ?? 'get').toLowerCase()
        if (method === 'post') {
            const body = new URLSearchParams(entries).toString()
            this.navigate(action, { method: 'POST', body, headers: { 'content-type': 'application/x-www-form-urlencoded' }, history: 'push' }).catch(() => {})
        } else {
            const url = new URL(action)
            url.search = new URLSearchParams(entries).toString()
            this.scheduleNavigation(url.href, { history: 'push' })
        }
    }

    hitTarget(x, y) {
        return this.doc.layout().hitTest(x, y) ?? this.doc.body ?? this.doc.documentElement
    }

    dispatchMouse(params) {
        const { type, x, y, button = 'none', buttons = 0, clickCount = 1, modifiers = 0, deltaX = 0, deltaY = 0 } = params
        const target = this.hitTarget(x, y)
        if (!target) return
        const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: BUTTON_INDEX[button] ?? 0, buttons, detail: clickCount, view: this.win, ...modifierFlags(modifiers) }
        const fire = (name, init = {}, el = target) => {
            const ev = new dom.MouseEvent(name, { ...base, ...init })
            ev.isTrusted = true
            return el.dispatchEvent(ev)
        }
        if (type === 'mouseMoved') {
            if (this.lastHover !== target) {
                if (this.lastHover) fire('mouseout', { relatedTarget: target }, this.lastHover)
                fire('mouseover', { relatedTarget: this.lastHover })
                this.lastHover = target
            }
            fire('mousemove')
        } else if (type === 'mousePressed') {
            this.pressTarget = target
            fire('mousedown')
            const focusable = dom.nearestFocusable(target)
            this.doc._focus(focusable)
        } else if (type === 'mouseReleased') {
            fire('mouseup')
            const pressed = this.pressTarget
            this.pressTarget = null
            if (pressed && (pressed === target || pressed.contains(target) || target.contains(pressed))) {
                if (button === 'right') fire('contextmenu')
                else {
                    this.clickElement(target, { x, y, button: BUTTON_INDEX[button] ?? 0, clickCount, modifiers, trusted: true })
                    if (clickCount === 2) fire('dblclick')
                }
            }
        } else if (type === 'mouseWheel') {
            const wheel = new dom.WheelEvent('wheel', { ...base, deltaX, deltaY, cancelable: true })
            wheel.isTrusted = true
            if (target.dispatchEvent(wheel)) {
                const max = Math.max(0, this.doc.layout().contentHeight - this.doc.viewport.height)
                this.doc.scrollY = Math.min(max, Math.max(0, this.doc.scrollY + deltaY))
                this.win.dispatchEvent(new dom.Event('scroll'))
            }
        }
    }

    dispatchKey(params) {
        const { type, key = '', code = '', text, windowsVirtualKeyCode = 0, modifiers = 0 } = params
        const target = this.doc.activeElement ?? this.doc.body
        if (!target) return
        const init = { key, code, keyCode: windowsVirtualKeyCode, bubbles: true, cancelable: true, composed: true, ...modifierFlags(modifiers) }
        const fire = (name) => {
            const ev = new dom.KeyboardEvent(name, init)
            ev.isTrusted = true
            return target.dispatchEvent(ev)
        }
        if (type === 'keyUp') {
            fire('keyup')
            return
        }
        if (type === 'char') {
            this.insertText(target, text ?? key)
            return
        }
        const proceed = fire('keydown')
        if (!proceed) return
        if (key === 'Enter') {
            if (target.localName === 'textarea') this.insertText(target, '\n')
            else if (target.localName === 'input') this.implicitSubmit(target)
            else if (target.localName === 'button' || (target.localName === 'a' && target.hasAttribute('href'))) this.clickElement(target, { trusted: true })
            else if (target.isContentEditable) this.insertText(target, '\n')
            return
        }
        if (key === 'Tab') {
            this.moveFocus(modifierFlags(modifiers).shiftKey ? -1 : 1)
            return
        }
        if (key === 'Backspace') {
            this.deleteBackward(target)
            return
        }
        if (key === ' ' && target.localName === 'input' && (target.type === 'checkbox' || target.type === 'radio')) {
            this.clickElement(target, { trusted: true })
            return
        }
        if (key === ' ' && target.localName === 'button') {
            this.clickElement(target, { trusted: true })
            return
        }
        if (text && text !== '\r') this.insertText(target, text)
    }

    implicitSubmit(input) {
        const form = input.form
        if (!form) return
        const submit = form.elements.find((el) => this.isSubmitter(el) && !el.disabled)
        if (submit) this.clickElement(submit, { trusted: true })
        else this.submitForm(form, null, true)
    }

    insertText(target, text) {
        if (!isEditable(target)) return
        const data = String(text)
        if (target.isContentEditable && target.localName !== 'input' && target.localName !== 'textarea') {
            target.appendChild(new dom.Text(target.ownerDocument, data))
        } else {
            const replace = target._selectAll === true
            target.value = replace ? data : `${target.value}${data}`
        }
        const ev = new dom.InputEvent('input', { bubbles: true, composed: true, data, inputType: 'insertText' })
        ev.isTrusted = true
        target.dispatchEvent(ev)
    }

    deleteBackward(target) {
        if (!isEditable(target)) return
        const value = target.value ?? ''
        if (value === '') return
        target.value = target._selectAll === true ? '' : value.slice(0, -1)
        const ev = new dom.InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' })
        ev.isTrusted = true
        target.dispatchEvent(ev)
    }

    moveFocus(direction) {
        const list = dom.focusableList(this.doc)
        if (list.length === 0) return
        const current = list.indexOf(this.doc.activeElement)
        const next = current < 0 ? (direction > 0 ? 0 : list.length - 1) : (current + direction + list.length) % list.length
        this.doc._focus(list[next])
    }

    insertIntoFocused(text) {
        const target = this.doc.activeElement ?? this.doc.body
        this.insertText(target, text)
    }

    describe(value) {
        return this.realm.describeValue(value)
    }

    evaluate(expression, options = {}) {
        if (this.closed) throw new Error('Target closed')
        let value
        try {
            value = this.realm.evaluate(String(expression), 'expression')
        } catch (error) {
            return { exceptionDetails: this.exceptionDetailsOf(error) }
        }
        if (options.awaitPromise && value && typeof value.then === 'function') {
            return Promise.resolve(value).then(
                (resolved) => ({ result: this.describe(resolved) }),
                (error) => ({ exceptionDetails: this.exceptionDetailsOf(error) })
            )
        }
        return { result: this.describe(value) }
    }

    exceptionDetailsOf(error) {
        const description = describeError(error)
        return {
            exceptionId: ++this.exceptionSeq,
            text: 'Uncaught',
            lineNumber: 0,
            columnNumber: 0,
            exception: { type: 'object', subtype: 'error', className: error?.name ?? 'Error', description }
        }
    }

    addInitScript(source) {
        const identifier = String(++this.initSeq)
        this.initScripts.push({ identifier, source })
        return identifier
    }

    removeInitScript(identifier) {
        this.initScripts = this.initScripts.filter((script) => script.identifier !== identifier)
    }

    async stopLoading() {
        this.navToken++
    }

    close() {
        if (this.closed) return
        this.closed = true
        this.navToken++
        clearTimeout(this.idleTimer)
        for (const resolve of this.pendingDecisions.values()) resolve({ kind: 'fail', errorText: 'net::ERR_ABORTED' })
        this.pendingDecisions.clear()
        this.disposeRealm()
    }

    errorReasonText(reason) {
        return ERROR_REASONS[String(reason ?? 'failed').toLowerCase()] ?? 'net::ERR_FAILED'
    }
}

export { headerObject, modifierFlags }
