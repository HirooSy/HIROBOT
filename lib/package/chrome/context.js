import { EventEmitter } from 'node:events'
import { expressionFor, noop } from './util.js'

const COOKIE_FIELDS = ['name', 'value', 'url', 'domain', 'path', 'expires', 'httpOnly', 'secure', 'sameSite']

const cookieMatches = (cookie, url) => {
    const domain = String(cookie.domain || '').replace(/^\./, '')
    const hostMatches = url.hostname === domain || url.hostname.endsWith(`.${domain}`)
    const pathMatches = url.pathname.startsWith(cookie.path || '/')
    const secureMatches = !cookie.secure || url.protocol === 'https:'
    return hostMatches && pathMatches && secureMatches
}

const toCdpCookie = (cookie) => {
    const result = {}
    for (const field of COOKIE_FIELDS) {
        if (cookie[field] !== undefined) result[field] = cookie[field]
    }
    return result
}

export const normalizeContextOptions = (options = {}) => ({
    viewport: options.viewport === undefined ? { width: 1280, height: 720 } : options.viewport,
    deviceScaleFactor: options.deviceScaleFactor ?? 1,
    isMobile: options.isMobile === true,
    hasTouch: options.hasTouch === true,
    userAgent: options.userAgent,
    locale: options.locale,
    timezoneId: options.timezoneId,
    colorScheme: options.colorScheme,
    extraHTTPHeaders: options.extraHTTPHeaders,
    ignoreHTTPSErrors: options.ignoreHTTPSErrors === true,
    javaScriptEnabled: options.javaScriptEnabled !== false,
    bypassCSP: options.bypassCSP === true,
    blockResources: Array.isArray(options.blockResources) ? options.blockResources.map((type) => String(type).toLowerCase()) : [],
    downloadsPath: options.downloadsPath,
    proxy: options.proxy,
    cookies: options.cookies
})

export class BrowserContext extends EventEmitter {
    constructor(browser, id, options) {
        super()
        this._browser = browser
        this._id = id
        this._options = options
        this._pages = new Set()
        this._routes = []
        this._initScripts = []
        this._pendingClose = null
        this._closed = false
        this._implicit = false
        this._timeout = undefined
        this._navigationTimeout = undefined
        if (options.blockResources.length > 0) {
            const blocked = new Set(options.blockResources)
            this._routes.push({
                matcher: () => true,
                handler: (route) => (blocked.has(route.request().resourceType()) ? route.abort() : route.continue())
            })
        }
    }

    browser() {
        return this._browser
    }

    pages() {
        return [...this._pages]
    }

    setDefaultTimeout(timeout) {
        this._timeout = timeout
    }

    setDefaultNavigationTimeout(timeout) {
        this._navigationTimeout = timeout
    }

    async newPage() {
        this._assertOpen()
        const { targetId } = await this._browser.connection.send('Target.createTarget', { url: 'about:blank', browserContextId: this._id })
        return this._browser.attachPage(targetId, this)
    }

    async route(matcher, handler) {
        this._routes.push({ matcher, handler })
        await Promise.all([...this._pages].map((page) => page._syncInterception()))
    }

    async unroute(matcher) {
        this._routes = this._routes.filter((entry) => entry.matcher !== matcher)
        await Promise.all([...this._pages].map((page) => page._syncInterception()))
    }

    async addInitScript(script, arg) {
        const source = expressionFor(script, arg)
        this._initScripts.push(source)
        await Promise.all([...this._pages].map((page) => page._addInitSource(source)))
    }

    async cookies(urls) {
        const { cookies } = await this._browser.connection.send('Storage.getCookies', { browserContextId: this._id })
        if (urls === undefined) return cookies
        const targets = (Array.isArray(urls) ? urls : [urls]).map((value) => new URL(value))
        return cookies.filter((cookie) => targets.some((url) => cookieMatches(cookie, url)))
    }

    async addCookies(cookies) {
        await this._browser.connection.send('Storage.setCookies', {
            browserContextId: this._id,
            cookies: cookies.map(toCdpCookie)
        })
    }

    async clearCookies() {
        await this._browser.connection.send('Storage.clearCookies', { browserContextId: this._id })
    }

    async close() {
        if (this._closed) return
        this._closed = true
        await Promise.all([...this._pages].map((page) => page.close().catch(noop)))
        await this._browser.connection.send('Target.disposeBrowserContext', { browserContextId: this._id }).catch(noop)
        this._browser._contexts.delete(this._id)
        this.emit('close')
    }

    async _setup() {
        const downloadsPath = this._options.downloadsPath
        await this._browser.connection
            .send('Browser.setDownloadBehavior', {
                behavior: downloadsPath ? 'allow' : 'deny',
                browserContextId: this._id,
                downloadPath: downloadsPath,
                eventsEnabled: false
            })
            .catch(noop)
        if (this._options.cookies && this._options.cookies.length > 0) await this.addCookies(this._options.cookies)
    }

    _assertOpen() {
        if (this._closed) throw new Error('Context has been closed')
    }

    _attachPage(page) {
        this._pages.add(page)
        this.emit('page', page)
    }

    _onPageClosed(page) {
        this._pages.delete(page)
        if (this._implicit && !this._closed && this._pages.size === 0) this._pendingClose = this.close().catch(noop)
    }

    _markClosed() {
        this._closed = true
        this.emit('close')
    }
}
