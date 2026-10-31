import fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { TimeoutError } from './errors.js'
import { CHALLENGE_EXPRESSION, waitForChallengeClear } from './challenge.js'
import { DOM_SOURCE, QUERY_SOURCE } from './dom.js'
import { Keyboard, Mouse } from './input.js'
import { Locator } from './locator.js'
import { ConsoleMessage, exceptionToError } from './messages.js'
import { Dialog, Request, Response, Route } from './network.js'
import { DEFAULT_TIMEOUT, engine, expressionFor, functionSource, matchUrl, noop, parseLength, poll, remainingTime, serialize, sleep } from './util.js'

const LIFECYCLE = { commit: 'init', domcontentloaded: 'DOMContentLoaded', load: 'load', networkidle: 'networkIdle' }
const PAPER_SIZES = {
    letter: [8.5, 11],
    legal: [8.5, 14],
    tabloid: [11, 17],
    ledger: [17, 11],
    a0: [33.1, 46.8],
    a1: [23.4, 33.1],
    a2: [16.54, 23.4],
    a3: [11.7, 16.54],
    a4: [8.27, 11.7],
    a5: [5.83, 8.27],
    a6: [4.13, 5.83]
}
const NETWORK_ENABLE = { maxTotalBufferSize: 64 * 1024 * 1024, maxResourceBufferSize: 16 * 1024 * 1024, maxPostDataSize: 1024 * 1024 }
const NETWORK_IDLE_MS = 500
const STALE_CONTEXT = /Execution context was destroyed|Cannot find context with specified id|Inspected target navigated or closed/
const RETENTION = 4

const exceptionMessage = (details) => String(details.exception?.description || details.text || 'Evaluation failed').split('\n')[0]

const trim = (map) => {
    while (map.size > RETENTION) map.delete(map.keys().next().value)
}

export class Page extends EventEmitter {
    constructor(browser, context, targetId, session) {
        super()
        this._browser = browser
        this._context = context
        this._targetId = targetId
        this._session = session
        this._signals = new EventEmitter()
        this._signals.setMaxListeners(0)
        this._routes = []
        this._intercepting = false
        this._closed = false
        this._timeout = undefined
        this._navigationTimeout = undefined
        this._viewport = null
        this._url = 'about:blank'
        this._mainFrameId = null
        this._loaderId = null
        this._lifecycle = new Map()
        this._documents = new Map()
        this._requests = new Map()
        this.keyboard = new Keyboard(session)
        this.mouse = new Mouse(session, this.keyboard)
        session.on('event', (method, params) => this._onEvent(method, params))
    }

    context() {
        return this._context
    }

    browser() {
        return this._browser
    }

    url() {
        return this._url
    }

    isClosed() {
        return this._closed
    }

    viewportSize() {
        return this._viewport ? { ...this._viewport } : null
    }

    setDefaultTimeout(timeout) {
        this._timeout = timeout
    }

    setDefaultNavigationTimeout(timeout) {
        this._navigationTimeout = timeout
    }

    async goto(url, options = {}) {
        const timeout = this._navigationTimeoutFor(options.timeout)
        const waitUntil = options.waitUntil ?? 'load'
        const lifecycle = LIFECYCLE[waitUntil]
        if (!lifecycle) throw new Error(`Unsupported waitUntil value: ${waitUntil}`)
        const started = Date.now()
        const navigation = await this._withTimeout(
            this._session.send('Page.navigate', { url, referrer: options.referer ?? '' }),
            timeout,
            `navigating to "${url}"`,
            () => this._session.send('Page.stopLoading')
        )
        if (navigation.isDownload) return null
        if (navigation.errorText) throw new Error(`${navigation.errorText} at ${url}`)
        if (!navigation.loaderId) return null
        await this._waitFor(() => this._hasLifecycle(navigation.loaderId, lifecycle), remainingTime(timeout, started), `navigating to "${url}"`)
        return this._documentResponse(navigation.loaderId)
    }

    async reload(options = {}) {
        const timeout = this._navigationTimeoutFor(options.timeout)
        const started = Date.now()
        const previous = this._loaderId
        await this._withTimeout(this._session.send('Page.reload'), timeout, 'reloading the page', () => this._session.send('Page.stopLoading'))
        await this._waitForNewLoader(previous, remainingTime(timeout, started), 'reloading the page')
        return this._documentResponse(this._loaderId)
    }

    goBack(options) {
        return this._navigateHistory(-1, options)
    }

    goForward(options) {
        return this._navigateHistory(1, options)
    }

    async setContent(html, options = {}) {
        await this._session.send('Page.setDocumentContent', { frameId: this._mainFrameId, html })
        const waitUntil = options.waitUntil ?? 'load'
        if (waitUntil === 'commit') return
        if (waitUntil === 'networkidle') {
            await this.waitForLoadState('load', { timeout: options.timeout })
            await this._waitForNetworkIdle(this._timeoutFor(options.timeout), 'waiting for network idle')
            return
        }
        await this.waitForLoadState(waitUntil, { timeout: options.timeout })
    }

    async waitForLoadState(state = 'load', options = {}) {
        const timeout = this._timeoutFor(options.timeout)
        if (state === 'networkidle') {
            await this._waitFor(() => this._loaderId !== null && this._hasLifecycle(this._loaderId, 'networkIdle'), timeout, 'waiting for network idle')
            return
        }
        if (state !== 'load' && state !== 'domcontentloaded') throw new Error(`Unsupported load state: ${state}`)
        await poll(
            async () => {
                const readyState = await this._evaluate('document.readyState')
                return state === 'load' ? readyState === 'complete' : readyState !== 'loading'
            },
            { timeout, interval: 30, label: `waiting for load state "${state}"` }
        )
    }

    async waitForURL(matcher, options = {}) {
        const timeout = this._navigationTimeoutFor(options.timeout)
        await poll(async () => matchUrl(matcher, await this._evaluate('location.href')), { timeout, interval: 100, label: 'waiting for URL' })
        const waitUntil = options.waitUntil ?? 'load'
        if (waitUntil !== 'commit') await this.waitForLoadState(waitUntil, { timeout })
    }

    waitForEvent(event, options = {}) {
        const predicate = typeof options === 'function' ? options : options.predicate
        const timeout = typeof options === 'function' ? undefined : options.timeout
        return this._waitForEvent(event, predicate, this._timeoutFor(timeout))
    }

    waitForRequest(matcher, options = {}) {
        return this.waitForEvent('request', { predicate: (request) => matchUrl(matcher, request.url()), timeout: options.timeout })
    }

    waitForResponse(matcher, options = {}) {
        return this.waitForEvent('response', { predicate: (response) => matchUrl(matcher, response.url()), timeout: options.timeout })
    }

    waitForTimeout(ms) {
        return sleep(ms)
    }

    detectChallenges() {
        return this._evaluate(CHALLENGE_EXPRESSION)
    }

    waitForChallenge(options = {}) {
        return waitForChallengeClear(() => this._evaluate(CHALLENGE_EXPRESSION), { ...options, timeout: this._timeoutFor(options.timeout) })
    }

    async title() {
        return this._evaluate('document.title')
    }

    async content() {
        return this._evaluate(
            "(() => { const doctype = document.doctype; const prefix = doctype ? '<!DOCTYPE ' + doctype.name + '>' : ''; return prefix + document.documentElement.outerHTML })()"
        )
    }

    async evaluate(pageFunction, arg) {
        return this._evaluate(expressionFor(pageFunction, arg))
    }

    async $eval(selector, pageFunction, arg) {
        return this._evaluate(
            `((query, selector, fn, arg) => { const node = query(selector)[0]; if (!node) throw new Error('failed to find element matching selector "' + selector + '"'); return fn(node, arg) })(${QUERY_SOURCE}, ${JSON.stringify(selector)}, ${functionSource(pageFunction)}, ${serialize(arg)})`
        )
    }

    async $$eval(selector, pageFunction, arg) {
        return this._evaluate(
            `((query, selector, fn, arg) => fn(query(selector), arg))(${QUERY_SOURCE}, ${JSON.stringify(selector)}, ${functionSource(pageFunction)}, ${serialize(arg)})`
        )
    }

    async waitForFunction(pageFunction, arg, options = {}) {
        const timeout = this._timeoutFor(options.timeout)
        const interval = typeof options.polling === 'number' ? options.polling : 100
        return poll(() => this.evaluate(pageFunction, arg).then((value) => value || null), { timeout, interval, label: 'waiting for function' })
    }

    locator(selector) {
        return new Locator(this, selector)
    }

    getByRole(role, options = {}) {
        return this.locator(engine('role', { role, ...options }))
    }

    getByText(text, options = {}) {
        return this.locator(engine('text', { text, exact: options.exact === true }))
    }

    getByLabel(text, options = {}) {
        return this.locator(engine('label', { text, exact: options.exact === true }))
    }

    getByPlaceholder(text, options = {}) {
        return this.locator(engine('placeholder', { text, exact: options.exact === true }))
    }

    getByAltText(text, options = {}) {
        return this.locator(engine('alt', { text, exact: options.exact === true }))
    }

    getByTitle(text, options = {}) {
        return this.locator(engine('title', { text, exact: options.exact === true }))
    }

    getByTestId(testId) {
        return this.locator(engine('testid', { text: testId, attribute: 'data-testid' }))
    }

    click(selector, options) {
        return this.locator(selector).click(options)
    }

    dblclick(selector, options) {
        return this.locator(selector).dblclick(options)
    }

    hover(selector, options) {
        return this.locator(selector).hover(options)
    }

    fill(selector, value, options) {
        return this.locator(selector).fill(value, options)
    }

    type(selector, text, options) {
        return this.locator(selector).type(text, options)
    }

    press(selector, key, options) {
        return this.locator(selector).press(key, options)
    }

    focus(selector, options) {
        return this.locator(selector).focus(options)
    }

    check(selector, options) {
        return this.locator(selector).check(options)
    }

    uncheck(selector, options) {
        return this.locator(selector).uncheck(options)
    }

    selectOption(selector, values, options) {
        return this.locator(selector).selectOption(values, options)
    }

    textContent(selector, options) {
        return this.locator(selector).textContent(options)
    }

    innerText(selector, options) {
        return this.locator(selector).innerText(options)
    }

    innerHTML(selector, options) {
        return this.locator(selector).innerHTML(options)
    }

    inputValue(selector, options) {
        return this.locator(selector).inputValue(options)
    }

    getAttribute(selector, name, options) {
        return this.locator(selector).getAttribute(name, options)
    }

    isVisible(selector) {
        return this.locator(selector).isVisible()
    }

    isHidden(selector) {
        return this.locator(selector).isHidden()
    }

    isEnabled(selector) {
        return this.locator(selector).isEnabled()
    }

    isDisabled(selector) {
        return this.locator(selector).isDisabled()
    }

    isChecked(selector) {
        return this.locator(selector).isChecked()
    }

    isEditable(selector) {
        return this.locator(selector).isEditable()
    }

    async waitForSelector(selector, options = {}) {
        const locator = this.locator(selector)
        const state = options.state ?? 'visible'
        await locator.waitFor({ state, timeout: options.timeout })
        return state === 'attached' || state === 'visible' ? locator : null
    }

    async route(matcher, handler) {
        this._routes.push({ matcher, handler })
        await this._syncInterception()
    }

    async unroute(matcher) {
        this._routes = this._routes.filter((entry) => entry.matcher !== matcher)
        await this._syncInterception()
    }

    async screenshot(options = {}) {
        const type = options.type === 'jpeg' ? 'jpeg' : 'png'
        const params = { format: type, fromSurface: true }
        if (type === 'jpeg') params.quality = options.quality ?? 80
        if (options.clip) {
            params.clip = { ...options.clip, scale: 1 }
        } else if (options.fullPage) {
            const metrics = await this._session.send('Page.getLayoutMetrics')
            const size = metrics.cssContentSize || metrics.contentSize
            params.clip = { x: 0, y: 0, width: Math.ceil(size.width), height: Math.ceil(size.height), scale: 1 }
            params.captureBeyondViewport = true
        }
        if (options.omitBackground) {
            await this._session.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } })
        }
        let data
        try {
            data = (await this._session.send('Page.captureScreenshot', params)).data
        } finally {
            if (options.omitBackground) await this._session.send('Emulation.setDefaultBackgroundColorOverride', {}).catch(noop)
        }
        const buffer = Buffer.from(data, 'base64')
        if (options.path) await fsp.writeFile(options.path, buffer)
        return buffer
    }

    async pdf(options = {}) {
        const paper = PAPER_SIZES[String(options.format ?? 'letter').toLowerCase()] ?? PAPER_SIZES.letter
        const margin = options.margin ?? {}
        const { data } = await this._session.send('Page.printToPDF', {
            landscape: options.landscape === true,
            displayHeaderFooter: options.displayHeaderFooter === true,
            headerTemplate: options.headerTemplate ?? '',
            footerTemplate: options.footerTemplate ?? '',
            printBackground: options.printBackground === true,
            scale: options.scale ?? 1,
            paperWidth: options.width !== undefined ? parseLength(options.width) : paper[0],
            paperHeight: options.height !== undefined ? parseLength(options.height) : paper[1],
            marginTop: parseLength(margin.top ?? 0),
            marginBottom: parseLength(margin.bottom ?? 0),
            marginLeft: parseLength(margin.left ?? 0),
            marginRight: parseLength(margin.right ?? 0),
            preferCSSPageSize: options.preferCSSPageSize === true,
            pageRanges: options.pageRanges ?? ''
        })
        const buffer = Buffer.from(data, 'base64')
        if (options.path) await fsp.writeFile(options.path, buffer)
        return buffer
    }

    async setViewportSize({ width, height }) {
        await this._applyViewport({ width, height })
    }

    async setExtraHTTPHeaders(headers) {
        await this._session.send('Network.setExtraHTTPHeaders', { headers })
    }

    async emulateMedia(options = {}) {
        const features = []
        if (options.colorScheme) features.push({ name: 'prefers-color-scheme', value: options.colorScheme })
        if (options.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: options.reducedMotion })
        const params = { features }
        if (options.media) params.media = options.media
        await this._session.send('Emulation.setEmulatedMedia', params)
    }

    async addInitScript(script, arg) {
        await this._addInitSource(expressionFor(script, arg))
    }

    async bringToFront() {
        await this._session.send('Page.bringToFront')
    }

    async close() {
        if (this._closed) return
        const closed = this._waitFor(() => this._closed, 5000, 'closing the page').catch(noop)
        await this._browser.connection.send('Target.closeTarget', { targetId: this._targetId }).catch(noop)
        await closed
        this._markClosed()
        await this._context._pendingClose
    }

    _withTimeout(promise, timeout, label, onTimeout) {
        if (!(timeout > 0 && Number.isFinite(timeout))) return promise
        let timer = null
        const expired = new Promise((_, reject) => {
            timer = setTimeout(() => {
                if (onTimeout) onTimeout().catch(noop)
                reject(new TimeoutError(`Timeout ${timeout}ms exceeded while ${label}`))
            }, timeout)
        })
        return Promise.race([promise, expired]).finally(() => clearTimeout(timer))
    }

    _timeoutFor(timeout) {
        if (timeout !== undefined && timeout !== null) return timeout
        return this._timeout ?? this._context._timeout ?? DEFAULT_TIMEOUT
    }

    _navigationTimeoutFor(timeout) {
        if (timeout !== undefined && timeout !== null) return timeout
        return this._navigationTimeout ?? this._context._navigationTimeout ?? this._timeoutFor()
    }

    async _init() {
        const session = this._session
        const options = this._context._options
        const tasks = [
            session.send('Page.enable'),
            session.send('Inspector.enable'),
            session.send('Runtime.enable'),
            session.send('Page.setLifecycleEventsEnabled', { enabled: true }),
            session.send('Network.enable', NETWORK_ENABLE),
            session.send('Page.setBypassCSP', { enabled: options.bypassCSP }),
            session.send('Security.setIgnoreCertificateErrors', { ignore: options.ignoreHTTPSErrors })
        ]
        if (options.hasTouch) tasks.push(session.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 1 }))
        if (options.viewport) tasks.push(this._applyViewport(options.viewport))
        if (options.userAgent) tasks.push(session.send('Emulation.setUserAgentOverride', { userAgent: options.userAgent, acceptLanguage: options.locale }))
        if (options.locale) tasks.push(session.send('Emulation.setLocaleOverride', { locale: options.locale }))
        if (options.timezoneId) tasks.push(session.send('Emulation.setTimezoneOverride', { timezoneId: options.timezoneId }))
        if (!options.javaScriptEnabled) tasks.push(session.send('Emulation.setScriptExecutionDisabled', { value: true }))
        if (options.extraHTTPHeaders) tasks.push(session.send('Network.setExtraHTTPHeaders', { headers: options.extraHTTPHeaders }))
        if (options.colorScheme) {
            tasks.push(session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: options.colorScheme }] }))
        }
        for (const source of this._context._initScripts) tasks.push(this._addInitSource(source))
        await Promise.all(tasks)
        const { frameTree } = await session.send('Page.getFrameTree')
        this._mainFrameId = frameTree.frame.id
        this._url = frameTree.frame.url
        await this._syncInterception()
    }

    _addInitSource(source) {
        return this._session.send('Page.addScriptToEvaluateOnNewDocument', { source })
    }

    _applyViewport(viewport) {
        this._viewport = { width: viewport.width, height: viewport.height }
        const options = this._context._options
        return this._session.send('Emulation.setDeviceMetricsOverride', {
            width: viewport.width,
            height: viewport.height,
            deviceScaleFactor: options.deviceScaleFactor,
            mobile: options.isMobile
        })
    }

    _markClosed() {
        if (this._closed) return
        this._closed = true
        this._requests.clear()
        this._browser._removePage(this)
        this._context._onPageClosed(this)
        this._signals.emit('tick')
        this.emit('close')
    }

    _dom(op, selector, arg = null) {
        return this._evaluate(`(${DOM_SOURCE})(${QUERY_SOURCE}, ${JSON.stringify(op)}, ${JSON.stringify(selector)}, ${JSON.stringify(arg)})`)
    }

    async _evaluate(expression) {
        for (let attempt = 0; ; attempt++) {
            let result
            try {
                result = await this._session.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
            } catch (error) {
                if (attempt < 3 && STALE_CONTEXT.test(error.message)) {
                    await sleep(100)
                    continue
                }
                throw error
            }
            if (!result.exceptionDetails) return result.result.value
            const message = exceptionMessage(result.exceptionDetails)
            if (attempt < 3 && STALE_CONTEXT.test(message)) {
                await sleep(100)
                continue
            }
            throw new Error(message)
        }
    }

    _waitFor(predicate, timeout, label) {
        if (predicate()) return Promise.resolve()
        return new Promise((resolve, reject) => {
            let timer = null
            const finish = (error) => {
                clearTimeout(timer)
                this._signals.off('tick', onTick)
                this.off('close', onClose)
                if (error) reject(error)
                else resolve()
            }
            const onTick = () => {
                if (predicate()) finish(null)
            }
            const onClose = () => finish(new Error(`Target closed while ${label}`))
            if (timeout > 0 && Number.isFinite(timeout)) {
                timer = setTimeout(() => finish(new TimeoutError(`Timeout ${timeout}ms exceeded while ${label}`)), timeout)
            }
            this._signals.on('tick', onTick)
            this.once('close', onClose)
        })
    }

    _waitForEvent(event, predicate, timeout) {
        return new Promise((resolve, reject) => {
            let timer = null
            const cleanup = () => {
                clearTimeout(timer)
                this.off(event, onEvent)
                this.off('close', onClose)
            }
            const onEvent = (value) => {
                let accepted = true
                try {
                    accepted = !predicate || predicate(value)
                } catch (error) {
                    cleanup()
                    reject(error)
                    return
                }
                if (!accepted) return
                cleanup()
                resolve(value)
            }
            const onClose = () => {
                cleanup()
                reject(new Error(`Target closed while waiting for "${event}"`))
            }
            if (this._closed) {
                reject(new Error(`Target closed while waiting for "${event}"`))
                return
            }
            if (timeout > 0 && Number.isFinite(timeout)) {
                timer = setTimeout(() => {
                    cleanup()
                    reject(new TimeoutError(`Timeout ${timeout}ms exceeded while waiting for "${event}"`))
                }, timeout)
            }
            this.on(event, onEvent)
            this.on('close', onClose)
        })
    }

    async _waitForNetworkIdle(timeout, label) {
        const deadline = timeout > 0 && Number.isFinite(timeout) ? Date.now() + timeout : Infinity
        let quietSince = Date.now()
        for (;;) {
            if (this._closed) throw new Error(`Target closed while ${label}`)
            if (this._requests.size > 0) quietSince = Date.now()
            else if (Date.now() - quietSince >= NETWORK_IDLE_MS) return
            if (Date.now() >= deadline) throw new TimeoutError(`Timeout ${timeout}ms exceeded while ${label}`)
            await sleep(25)
        }
    }

    _hasLifecycle(loaderId, name) {
        return this._lifecycle.get(loaderId)?.has(name) === true
    }

    _waitForNewLoader(previous, timeout, label) {
        return this._waitFor(() => this._loaderId !== null && this._loaderId !== previous && this._hasLifecycle(this._loaderId, 'load'), timeout, label)
    }

    _documentResponse(loaderId) {
        return this._documents.get(loaderId) ?? null
    }

    async _navigateHistory(delta, options = {}) {
        const { currentIndex, entries } = await this._session.send('Page.getNavigationHistory')
        const entry = entries[currentIndex + delta]
        if (!entry) return null
        const timeout = this._navigationTimeoutFor(options.timeout)
        const started = Date.now()
        const previous = this._loaderId
        await this._withTimeout(this._session.send('Page.navigateToHistoryEntry', { entryId: entry.id }), timeout, 'navigating through history', () =>
            this._session.send('Page.stopLoading')
        )
        await this._waitForNewLoader(previous, remainingTime(timeout, started), 'navigating through history')
        return this._documentResponse(this._loaderId)
    }

    async _syncInterception() {
        if (this._closed) return
        const wanted = this._routes.length > 0 || this._context._routes.length > 0
        if (wanted === this._intercepting) return
        this._intercepting = wanted
        if (wanted) await this._session.send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] })
        else await this._session.send('Fetch.disable')
    }

    async _onRequestPaused(params) {
        const route = new Route(this._session, params)
        const url = route.request().url()
        const handlers = [...this._routes].reverse().concat([...this._context._routes].reverse())
        const entry = handlers.find((candidate) => matchUrl(candidate.matcher, url))
        if (!entry) {
            await route.continue().catch(noop)
            return
        }
        try {
            await entry.handler(route, route.request())
        } finally {
            if (!route._handled) await route.continue().catch(noop)
        }
    }

    _onDialog(params) {
        const dialog = new Dialog(this._session, params)
        if (this.listenerCount('dialog') > 0) this.emit('dialog', dialog)
        else dialog.dismiss().catch(noop)
    }

    _onLifecycle({ frameId, loaderId, name }) {
        if (frameId !== this._mainFrameId) return
        if (name === 'init') this._loaderId = loaderId
        let names = this._lifecycle.get(loaderId)
        if (!names) {
            names = new Set()
            this._lifecycle.set(loaderId, names)
            trim(this._lifecycle)
        }
        names.add(name)
        this._signals.emit('tick')
    }

    _onRequestWillBeSent(params) {
        const previous = this._requests.get(params.requestId)
        const redirected = previous !== undefined && params.redirectResponse !== undefined
        if (redirected) {
            previous._response = new Response(params.redirectResponse, previous, this._session, params.requestId)
            previous._response._settleFinished()
            this.emit('response', previous._response)
        }
        const request = new Request({
            requestId: params.requestId,
            request: params.request,
            resourceType: params.type,
            redirectedFrom: redirected ? previous : null
        })
        this._requests.set(params.requestId, request)
        this.emit('request', request)
    }

    _onResponseReceived(params) {
        const request = this._requests.get(params.requestId) ?? null
        const response = new Response(params.response, request, this._session, params.requestId)
        if (request) request._response = response
        else response._settleFinished()
        this.emit('response', response)
        if (params.type === 'Document' && params.loaderId && params.frameId === this._mainFrameId) {
            this._documents.set(params.loaderId, response)
            trim(this._documents)
            this._signals.emit('tick')
        }
    }

    _onLoadingFinished({ requestId }) {
        const request = this._requests.get(requestId)
        if (!request) return
        this._requests.delete(requestId)
        if (request._response) request._response._settleFinished()
        this.emit('requestfinished', request)
        this._signals.emit('tick')
    }

    _onLoadingFailed({ requestId, errorText }) {
        const request = this._requests.get(requestId)
        if (!request) return
        this._requests.delete(requestId)
        request._failure = { errorText }
        if (request._response) request._response._settleFinished(errorText)
        this.emit('requestfailed', request)
        this._signals.emit('tick')
    }

    _onEvent(method, params) {
        switch (method) {
            case 'Page.frameNavigated':
                if (!params.frame.parentId) {
                    this._mainFrameId = params.frame.id
                    this._url = params.frame.url
                }
                break
            case 'Page.navigatedWithinDocument':
                if (params.frameId === this._mainFrameId) this._url = params.url
                break
            case 'Page.lifecycleEvent':
                this._onLifecycle(params)
                break
            case 'Page.loadEventFired':
                this.emit('load')
                break
            case 'Page.domContentEventFired':
                this.emit('domcontentloaded')
                break
            case 'Page.javascriptDialogOpening':
                this._onDialog(params)
                break
            case 'Runtime.consoleAPICalled':
                this.emit('console', new ConsoleMessage(params))
                break
            case 'Runtime.exceptionThrown':
                this.emit('pageerror', exceptionToError(params.exceptionDetails))
                break
            case 'Network.requestWillBeSent':
                this._onRequestWillBeSent(params)
                break
            case 'Network.responseReceived':
                this._onResponseReceived(params)
                break
            case 'Network.loadingFinished':
                this._onLoadingFinished(params)
                break
            case 'Network.loadingFailed':
                this._onLoadingFailed(params)
                break
            case 'Fetch.requestPaused':
                this._onRequestPaused(params).catch(noop)
                break
            case 'Inspector.targetCrashed':
                this.emit('crash')
                break
            default:
                break
        }
    }
}
