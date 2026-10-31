import { DEFAULT_USER_AGENT, EnginePage } from './page.js'
import { CookieJar } from './http.js'
import { headerObject } from './page.js'

const NOOP_METHODS = new Set([
    'Page.setBypassCSP', 'Page.bringToFront', 'Page.handleJavaScriptDialog', 'Page.setInterceptFileChooserDialog',
    'Emulation.setDefaultBackgroundColorOverride', 'Emulation.setIdleOverride', 'Emulation.clearDeviceMetricsOverride',
    'Network.setCacheDisabled', 'Network.setBypassServiceWorker', 'Input.setIgnoreInputEvents', 'Security.setIgnoreCertificateErrors',
    'Runtime.runIfWaitingForDebugger', 'Target.setAutoAttach', 'Page.setWebLifecycleState'
])

const headerPairs = (headers) => (Array.isArray(headers) ? headers : Object.entries(headers ?? {})).map((item) => (Array.isArray(item) ? item : [item.name, item.value]))

const protocolError = (message) => {
    const error = new Error(message)
    error.protocolCode = -32000
    return error
}

export class EngineBrowser {
    constructor({ send, onClose }) {
        this.send = send
        this.onClose = onClose
        this.contexts = new Map()
        this.targets = new Map()
        this.sessions = new Map()
        this.seq = 0
        this.contexts.set('default', this.createContextState('default'))
    }

    createContextState(id) {
        const buckets = new Map()
        return {
            id,
            jar: new CookieJar(),
            storageHost: {
                bucket: (kind, origin) => {
                    const key = `${kind}|${origin}`
                    if (!buckets.has(key)) buckets.set(key, new Map())
                    return buckets.get(key)
                }
            }
        }
    }

    emitBrowserEvent(method, params) {
        this.send({ method, params })
    }

    pageEvent(targetId, method, params) {
        const target = this.targets.get(targetId)
        if (!target) return
        for (const sessionId of target.sessionIds) this.send({ method, params, sessionId })
    }

    async handle(message) {
        const { id, method, params = {}, sessionId } = message
        try {
            const result = await this.dispatch(method, params, sessionId)
            this.send({ id, result: result ?? {}, sessionId })
        } catch (error) {
            this.send({ id, error: { code: error?.protocolCode ?? -32000, message: error?.message ?? String(error) }, sessionId })
        }
    }

    dispatch(method, params, sessionId) {
        if (sessionId !== undefined) {
            const target = this.targets.get(this.sessions.get(sessionId))
            if (!target) throw protocolError('Session with given id not found.')
            return this.pageCommand(target.page, method, params)
        }
        return this.browserCommand(method, params)
    }

    contextOf(id) {
        const context = this.contexts.get(id ?? 'default')
        if (!context) throw protocolError('Failed to find browser context with id')
        return context
    }

    targetOf(id) {
        const target = this.targets.get(id)
        if (!target) throw protocolError('No target with given id found')
        return target
    }

    createPage(context) {
        const targetId = `T${++this.seq}`
        const page = new EnginePage({ id: targetId, context, notify: (method, params) => this.pageEvent(targetId, method, params) })
        this.targets.set(targetId, { targetId, page, context, sessionIds: new Set() })
        this.emitBrowserEvent('Target.targetCreated', {
            targetInfo: { targetId, type: 'page', title: '', url: 'about:blank', attached: false, canAccessOpener: false, browserContextId: context.id }
        })
        return targetId
    }

    closeTarget(targetId) {
        const target = this.targets.get(targetId)
        if (!target) return
        target.page.close()
        for (const sessionId of target.sessionIds) this.sessions.delete(sessionId)
        this.targets.delete(targetId)
        this.emitBrowserEvent('Target.targetDestroyed', { targetId })
    }

    disposeContext(id) {
        for (const target of [...this.targets.values()]) if (target.context.id === id) this.closeTarget(target.targetId)
        this.contexts.delete(id)
    }

    async browserCommand(method, params) {
        switch (method) {
            case 'Browser.getVersion':
                return { protocolVersion: '1.3', product: 'HiroEngine/1.0', revision: '0', userAgent: DEFAULT_USER_AGENT, jsVersion: process.versions.v8 }
            case 'Browser.close':
                setImmediate(() => this.onClose())
                return {}
            case 'Browser.setDownloadBehavior':
            case 'Target.setDiscoverTargets':
                return {}
            case 'Target.createBrowserContext': {
                const id = `C${++this.seq}`
                this.contexts.set(id, this.createContextState(id))
                return { browserContextId: id }
            }
            case 'Target.disposeBrowserContext':
                this.disposeContext(params.browserContextId)
                return {}
            case 'Target.createTarget': {
                const targetId = this.createPage(this.contextOf(params.browserContextId))
                return { targetId }
            }
            case 'Target.attachToTarget': {
                const target = this.targetOf(params.targetId)
                const sessionId = `S${++this.seq}`
                this.sessions.set(sessionId, target.targetId)
                target.sessionIds.add(sessionId)
                return { sessionId }
            }
            case 'Target.closeTarget':
                this.closeTarget(params.targetId)
                return { success: true }
            case 'Storage.getCookies':
                return { cookies: this.contextOf(params.browserContextId).jar.list() }
            case 'Storage.setCookies':
                this.contextOf(params.browserContextId).jar.add(params.cookies ?? [])
                return {}
            case 'Storage.clearCookies':
                this.contextOf(params.browserContextId).jar.clear()
                return {}
            default:
                if (NOOP_METHODS.has(method)) return {}
                throw protocolError(`'${method}' wasn't found`)
        }
    }

    async pageCommand(page, method, params) {
        switch (method) {
            case 'Page.enable':
            case 'Page.setLifecycleEventsEnabled':
            case 'Runtime.enable':
            case 'Inspector.enable':
            case 'Network.enable':
            case 'Page.setInterceptFileChooserDialog':
            case 'Emulation.setScriptExecutionDisabled':
                if (method === 'Emulation.setScriptExecutionDisabled') page.emulation.javaScriptEnabled = params.value !== true
                return {}
            case 'Page.addScriptToEvaluateOnNewDocument':
                return { identifier: page.addInitScript(params.source) }
            case 'Page.removeScriptToEvaluateOnNewDocument':
                page.removeInitScript(params.identifier)
                return {}
            case 'Page.getFrameTree':
                return {
                    frameTree: {
                        frame: { id: page.frameId, loaderId: page.loaderId ?? undefined, url: page.url, domainAndRegistry: '', securityOrigin: page.origin, mimeType: 'text/html', secureContextType: 'Secure', crossOriginIsolatedContextType: 'NotIsolated', gatedAPIFeatures: [] },
                        childFrames: []
                    }
                }
            case 'Page.navigate':
                return page.navigate(params.url, { history: 'push' })
            case 'Page.reload':
                await page.navigate(page.url, { history: 'none' })
                return {}
            case 'Page.stopLoading':
                await page.stopLoading()
                return {}
            case 'Page.getNavigationHistory':
                return {
                    currentIndex: page.index,
                    entries: page.entries.map((entry) => ({ id: entry.id, url: entry.url, userTypedURL: entry.url, title: '', transitionType: 'typed' }))
                }
            case 'Page.navigateToHistoryEntry': {
                const index = page.entries.findIndex((entry) => entry.id === params.entryId)
                if (index < 0) throw protocolError('No entry with given id')
                page.index = index
                await page.navigate(page.entries[index].url, { history: 'none' })
                return {}
            }
            case 'Page.setDocumentContent':
                await page.setContent(params.html)
                return {}
            case 'Page.getLayoutMetrics': {
                const view = page.emulation.viewport
                const height = Math.max(page.doc.layout().contentHeight, view.height)
                const viewport = { pageX: 0, pageY: 0, clientWidth: view.width, clientHeight: view.height }
                return {
                    layoutViewport: viewport,
                    visualViewport: { offsetX: 0, offsetY: 0, ...viewport, scale: 1, zoom: 1 },
                    contentSize: { x: 0, y: 0, width: view.width, height },
                    cssLayoutViewport: viewport,
                    cssVisualViewport: { offsetX: 0, offsetY: 0, ...viewport, scale: 1, zoom: 1 },
                    cssContentSize: { x: 0, y: 0, width: view.width, height }
                }
            }
            case 'Page.captureScreenshot':
            case 'Page.printToPDF':
                throw protocolError('Screenshots and PDF output need pixel rendering, which the pure JS engine does not provide. Use the Chromium backend (executablePath or CHROMIUM_PATH).')
            case 'Runtime.evaluate':
                return page.evaluate(params.expression, { awaitPromise: params.awaitPromise === true })
            case 'Network.getResponseBody': {
                const body = page.bodies.get(params.requestId)
                if (!body) throw protocolError('No resource with given identifier found')
                return { body: body.toString('base64'), base64Encoded: true }
            }
            case 'Network.setExtraHTTPHeaders':
                page.emulation.extraHeaders = { ...headerObject(headerPairs(params.headers ?? {})) }
                return {}
            case 'Fetch.enable':
                page.fetchEnabled = true
                return {}
            case 'Fetch.disable':
                page.fetchEnabled = false
                return {}
            case 'Fetch.continueRequest':
                page.decide(params.requestId, {
                    kind: 'continue',
                    url: params.url,
                    method: params.method,
                    headers: params.headers ? headerObject(headerPairs(params.headers)) : undefined,
                    body: params.postData !== undefined ? Buffer.from(params.postData, 'base64') : undefined
                })
                return {}
            case 'Fetch.fulfillRequest':
                page.decide(params.requestId, {
                    kind: 'fulfill',
                    response: {
                        status: params.responseCode ?? 200,
                        statusText: '',
                        headers: headerPairs(params.responseHeaders ?? []).map(([name, value]) => [String(name).toLowerCase(), String(value)]),
                        body: params.body !== undefined ? Buffer.from(params.body, 'base64') : Buffer.alloc(0),
                        hops: []
                    }
                })
                return {}
            case 'Fetch.failRequest':
                page.decide(params.requestId, { kind: 'fail', errorText: page.errorReasonText(params.errorReason) })
                return {}
            case 'Input.dispatchMouseEvent':
                page.dispatchMouse(params)
                return {}
            case 'Input.dispatchKeyEvent':
                page.dispatchKey(params)
                return {}
            case 'Input.insertText':
                page.insertIntoFocused(params.text ?? '')
                return {}
            case 'Emulation.setDeviceMetricsOverride':
                page.setViewport({ width: params.width, height: params.height })
                return {}
            case 'Emulation.setUserAgentOverride':
                page.emulation.userAgent = params.userAgent || null
                page.emulation.locale = params.acceptLanguage ? params.acceptLanguage.split(',')[0] : page.emulation.locale
                return {}
            case 'Emulation.setLocaleOverride':
                page.emulation.locale = params.locale || null
                return {}
            case 'Emulation.setTimezoneOverride':
                page.emulation.timezoneId = params.timezoneId || null
                return {}
            case 'Emulation.setTouchEmulationEnabled':
                page.emulation.hasTouch = params.enabled === true
                return {}
            case 'Emulation.setEmulatedMedia': {
                const features = params.features ?? []
                const find = (name) => features.find((feature) => feature.name === name)?.value ?? null
                page.emulation.colorScheme = find('prefers-color-scheme') ?? page.emulation.colorScheme
                page.emulation.reducedMotion = find('prefers-reduced-motion') ?? page.emulation.reducedMotion
                return {}
            }
            default:
                if (NOOP_METHODS.has(method)) return {}
                throw protocolError(`'${method}' wasn't found`)
        }
    }
}
