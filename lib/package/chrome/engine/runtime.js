import vm from 'node:vm'
import os from 'node:os'
import * as dom from './dom.js'
import { compile } from './select.js'

const DOM_EXPORTS = [
    'Node', 'Element', 'HTMLElement', 'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLSelectElement', 'HTMLOptionElement',
    'HTMLFormElement', 'HTMLButtonElement', 'HTMLAnchorElement', 'HTMLImageElement', 'HTMLScriptElement', 'HTMLLinkElement',
    'HTMLLabelElement', 'HTMLIFrameElement', 'Text', 'Comment', 'DocumentFragment', 'DocumentType', 'Document', 'CharacterData',
    'EventTarget', 'Event', 'CustomEvent', 'UIEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent', 'FocusEvent', 'WheelEvent',
    'NodeFilter', 'TreeWalker', 'HTMLCanvasElement'
]

const BOOTSTRAP = `function (host) {
    var listeners = new WeakMap();
    function XMLHttpRequest() {
        this.readyState = 0;
        this.status = 0;
        this.statusText = '';
        this.responseText = '';
        this.response = '';
        this.responseURL = '';
        this.responseType = '';
        this.timeout = 0;
        this.withCredentials = false;
        this.onreadystatechange = null;
        this.onload = null;
        this.onerror = null;
        this.onloadend = null;
        this.onabort = null;
        this.ontimeout = null;
        this._method = 'GET';
        this._url = '';
        this._headers = {};
        this._responseHeaders = [];
        this._listeners = {};
    }
    XMLHttpRequest.UNSENT = 0;
    XMLHttpRequest.OPENED = 1;
    XMLHttpRequest.HEADERS_RECEIVED = 2;
    XMLHttpRequest.LOADING = 3;
    XMLHttpRequest.DONE = 4;
    XMLHttpRequest.prototype._fire = function (type) {
        var event = { type: type, target: this, currentTarget: this };
        var handler = this['on' + type];
        if (typeof handler === 'function') handler.call(this, event);
        var list = this._listeners[type] || [];
        for (var i = 0; i < list.length; i++) list[i].call(this, event);
    };
    XMLHttpRequest.prototype._setState = function (state) {
        this.readyState = state;
        this._fire('readystatechange');
    };
    XMLHttpRequest.prototype.open = function (method, url) {
        this._method = String(method).toUpperCase();
        this._url = String(url);
        this._headers = {};
        this._setState(1);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        this._headers[name] = String(value);
    };
    XMLHttpRequest.prototype.send = function (body) {
        var self = this;
        host.xhr(this._method, this._url, this._headers, body === undefined ? null : body).then(function (res) {
            self.status = res.status;
            self.statusText = res.statusText;
            self.responseURL = res.url;
            self._responseHeaders = res.headers;
            self._setState(2);
            self._setState(3);
            self.responseText = res.text;
            self.response = self.responseType === 'json' ? JSON.parse(res.text) : res.text;
            self._setState(4);
            self._fire('load');
            self._fire('loadend');
        }, function () {
            self.status = 0;
            self._setState(4);
            self._fire('error');
            self._fire('loadend');
        });
    };
    XMLHttpRequest.prototype.abort = function () {
        this._fire('abort');
    };
    XMLHttpRequest.prototype.getAllResponseHeaders = function () {
        return this._responseHeaders.map(function (pair) { return pair[0] + ': ' + pair[1]; }).join('\\r\\n');
    };
    XMLHttpRequest.prototype.getResponseHeader = function (name) {
        var wanted = String(name).toLowerCase();
        var found = this._responseHeaders.filter(function (pair) { return pair[0].toLowerCase() === wanted; });
        return found.length ? found.map(function (pair) { return pair[1]; }).join(', ') : null;
    };
    XMLHttpRequest.prototype.addEventListener = function (type, fn) {
        (this._listeners[type] = this._listeners[type] || []).push(fn);
    };
    XMLHttpRequest.prototype.removeEventListener = function (type, fn) {
        this._listeners[type] = (this._listeners[type] || []).filter(function (item) { return item !== fn; });
    };
    globalThis.XMLHttpRequest = XMLHttpRequest;
    function Observer(callback) {
        this._callback = callback;
    }
    Observer.prototype.observe = function (target) {
        var self = this;
        setTimeout(function () {
            self._callback([{ target: target, isIntersecting: true, intersectionRatio: 1, isVisible: true, contentRect: target.getBoundingClientRect(), boundingClientRect: target.getBoundingClientRect(), intersectionRect: target.getBoundingClientRect() }], self);
        }, 0);
    };
    Observer.prototype.unobserve = function () {};
    Observer.prototype.disconnect = function () {};
    Observer.prototype.takeRecords = function () { return []; };
    globalThis.MutationObserver = function (callback) { this._callback = callback; };
    globalThis.MutationObserver.prototype.observe = function () {};
    globalThis.MutationObserver.prototype.disconnect = function () {};
    globalThis.MutationObserver.prototype.takeRecords = function () { return []; };
    globalThis.IntersectionObserver = Observer;
    globalThis.ResizeObserver = Observer;
    globalThis.PerformanceObserver = function () {};
    globalThis.PerformanceObserver.prototype.observe = function () {};
    globalThis.PerformanceObserver.prototype.disconnect = function () {};
    globalThis.requestIdleCallback = function (callback) {
        return setTimeout(function () { callback({ didTimeout: false, timeRemaining: function () { return 50; } }); }, 1);
    };
    globalThis.cancelIdleCallback = function (id) { clearTimeout(id); };
    globalThis.CSS = { supports: function () { return false; }, escape: function (value) { return String(value).replace(/[^a-zA-Z0-9_-]/g, function (c) { return '\\\\' + c; }); } };
}`

const describeValue = (value) => {
    if (value === undefined) return { type: 'undefined' }
    if (value === null) return { type: 'object', subtype: 'null', value: null }
    const kind = typeof value
    if (kind === 'string' || kind === 'number' || kind === 'boolean') return { type: kind, value }
    if (kind === 'bigint') return { type: 'bigint', unserializableValue: `${value}n`, description: `${value}n` }
    if (kind === 'symbol') return { type: 'symbol', description: String(value) }
    if (kind === 'function') return { type: 'function', className: 'Function', description: 'function' }
    let json
    try {
        json = JSON.stringify(value)
    } catch {
        json = undefined
    }
    let description
    try {
        description = json ?? String(value)
    } catch {
        description = '[object]'
    }
    return {
        type: 'object',
        className: value?.constructor?.name ?? 'Object',
        description,
        value: json === undefined ? undefined : JSON.parse(json)
    }
}

const MEDIA_FEATURES = {
    'prefers-color-scheme': (value, env) => value === env.colorScheme,
    'prefers-reduced-motion': (value, env) => value === env.reducedMotion,
    'min-width': (value, env) => env.width >= Number.parseFloat(value),
    'max-width': (value, env) => env.width <= Number.parseFloat(value),
    'min-height': (value, env) => env.height >= Number.parseFloat(value),
    'max-height': (value, env) => env.height <= Number.parseFloat(value),
    orientation: (value, env) => value === (env.width >= env.height ? 'landscape' : 'portrait'),
    hover: (value) => value === 'hover',
    pointer: (value) => value === 'fine',
    'any-hover': (value) => value === 'hover',
    'any-pointer': (value) => value === 'fine'
}

export const evaluateMedia = (query, env) => {
    const text = String(query).trim().toLowerCase()
    if (text === '' || text === 'all' || text === 'screen') return true
    if (text === 'print') return false
    const negate = text.startsWith('not ')
    const body = negate ? text.slice(4).trim() : text
    const ok = body.split(/\s+and\s+/).every((part) => {
        const piece = part.trim()
        const match = /^\(\s*([a-z-]+)\s*(?::\s*([^)]+))?\)$/.exec(piece)
        if (!match) return piece === 'screen' || piece === 'all'
        const check = MEDIA_FEATURES[match[1]]
        if (!check) return false
        return Boolean(check(match[2]?.trim() ?? '', env))
    })
    return negate ? !ok : ok
}

const BORDER_SIDES = ['top', 'right', 'bottom', 'left']

const COMPUTED_DEFAULTS = {
    'font-family': '"Times New Roman"',
    'font-weight': '400',
    'font-style': 'normal',
    'font-variant': 'normal',
    'font-stretch': 'normal',
    'line-height': 'normal',
    'letter-spacing': 'normal',
    'word-spacing': '0px',
    'text-align': 'start',
    'text-indent': '0px',
    'text-transform': 'none',
    'text-decoration': 'none solid rgb(0, 0, 0)',
    'text-overflow': 'clip',
    'white-space': 'normal',
    'word-break': 'normal',
    'overflow-wrap': 'normal',
    'overflow': 'visible',
    'overflow-x': 'visible',
    'overflow-y': 'visible',
    'z-index': 'auto',
    'cursor': 'auto',
    'box-sizing': 'content-box',
    'transform': 'none',
    'transition': 'all 0s ease 0s',
    'animation-name': 'none',
    'animation-duration': '0s',
    'content': 'normal',
    'quotes': 'auto',
    'float': 'none',
    'clear': 'none',
    'top': 'auto',
    'left': 'auto',
    'right': 'auto',
    'bottom': 'auto',
    'max-width': 'none',
    'max-height': 'none',
    'min-width': '0px',
    'min-height': '0px',
    'background-color': 'rgba(0, 0, 0, 0)',
    'background-image': 'none',
    'border-radius': '0px',
    'box-shadow': 'none',
    'filter': 'none',
    'direction': 'ltr',
    'writing-mode': 'horizontal-tb',
    'unicode-bidi': 'normal',
    'vertical-align': 'baseline',
    'user-select': 'auto',
    'flex-direction': 'row',
    'flex-wrap': 'nowrap',
    'justify-content': 'normal',
    'align-items': 'normal',
    'will-change': 'auto',
    ...Object.fromEntries(BORDER_SIDES.flatMap((side) => [
        [`border-${side}-width`, '0px'],
        [`border-${side}-style`, 'none'],
        [`border-${side}-color`, 'rgb(0, 0, 0)']
    ]))
}

const userAgentDataFor = (ua) => {
    const mobile = /Mobile/.test(ua)
    const version = (/Chrome\/(\d+)/.exec(ua) ?? [])[1] ?? '131'
    const platform = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /Mac OS X/.test(ua) ? 'macOS' : /CrOS/.test(ua) ? 'Chrome OS' : 'Linux'
    const brands = [
        { brand: 'Google Chrome', version },
        { brand: 'Chromium', version },
        { brand: 'Not_A Brand', version: '24' }
    ]
    const fullVersionList = brands.map((item) => ({ brand: item.brand, version: item.version === '24' ? '24.0.0.0' : `${version}.0.0.0` }))
    return {
        brands,
        mobile,
        platform,
        getHighEntropyValues: () => Promise.resolve({
            architecture: 'x86',
            bitness: '64',
            brands,
            fullVersionList,
            mobile,
            model: '',
            platform,
            platformVersion: '10.0.0',
            uaFullVersion: `${version}.0.0.0`
        }),
        toJSON() {
            return { brands, mobile, platform }
        }
    }
}

export const createRealm = ({ page, doc, jar, storage }) => {
    const win = new dom.EventTarget()
    doc.hooks.window = win
    vm.createContext(win, { name: 'hiro-page' })
    const globalObject = vm.runInContext('globalThis', win)
    const timers = new Map()
    let timerSeq = 0
    const trackTimer = (handle) => {
        const id = ++timerSeq
        timers.set(id, handle)
        return id
    }
    const runCallback = (fn, args) => {
        try {
            if (typeof fn === 'function') fn(...args)
            else if (typeof fn === 'string') evaluate(fn, 'timer')
        } catch (error) {
            page.reportError(error)
        }
    }
    const setTimer = (fn, ms, args, repeat) => {
        const delay = Math.max(0, Number(ms) || 0)
        const id = timerSeq + 1
        const handle = repeat
            ? setInterval(() => runCallback(fn, args), delay)
            : setTimeout(() => {
                  timers.delete(id)
                  runCallback(fn, args)
              }, delay)
        return trackTimer(handle)
    }
    const clearTimer = (id) => {
        const handle = timers.get(id)
        if (handle !== undefined) {
            clearTimeout(handle)
            clearInterval(handle)
            timers.delete(id)
        }
    }
    class MessageEvent extends dom.Event {
        constructor(type, init = {}) {
            super(type, init)
            this.data = init.data ?? null
            this.origin = init.origin ?? ''
            this.lastEventId = init.lastEventId ?? ''
            this.source = init.source ?? null
            this.ports = init.ports ?? []
        }
    }

    class MessagePort extends dom.EventTarget {
        constructor() {
            super()
            this._peer = null
            this._queue = []
            this._started = false
            this._closed = false
            this._timer = null
        }

        addEventListener(type, listener, options) {
            super.addEventListener(type, listener, options)
            if (type === 'message') this.start()
        }

        start() {
            if (this._closed || this._started) return
            this._started = true
            this._schedule()
        }

        close() {
            this._closed = true
            this._started = false
            this._queue = []
            if (this._timer !== null) clearTimer(this._timer)
            this._timer = null
            this._peer = null
        }

        postMessage(message) {
            if (this._closed || !this._peer) return
            this._peer._enqueue(structuredClone(message))
        }

        _enqueue(data) {
            if (this._closed) return
            this._queue.push(data)
            if (this._started) this._schedule()
        }

        _schedule() {
            if (this._timer === null && this._queue.length > 0) {
                this._timer = setTimer(() => this._drain(), 0, [], false)
            }
        }

        _drain() {
            this._timer = null
            while (this._started && !this._closed && this._queue.length > 0) {
                this.dispatchEvent(new MessageEvent('message', { data: this._queue.shift() }))
            }
        }
    }

    class MessageChannel {
        constructor() {
            this.port1 = new MessagePort()
            this.port2 = new MessagePort()
            this.port1._peer = this.port2
            this.port2._peer = this.port1
        }
    }

    const env = () => ({
        colorScheme: page.emulation.colorScheme ?? 'light',
        reducedMotion: page.emulation.reducedMotion ?? 'no-preference',
        width: doc.viewport.width,
        height: doc.viewport.height
    })

    const perfOrigin = performance.now()
    const started = Math.round(performance.timeOrigin + perfOrigin)
    const timing = {
        navigationStart: started,
        unloadEventStart: 0,
        unloadEventEnd: 0,
        redirectStart: 0,
        redirectEnd: 0,
        fetchStart: started,
        domainLookupStart: started,
        domainLookupEnd: started,
        connectStart: started,
        connectEnd: started,
        secureConnectionStart: 0,
        requestStart: started,
        responseStart: started + 1,
        responseEnd: started + 1,
        domLoading: started + 1,
        domInteractive: started + 2,
        domContentLoadedEventStart: started + 2,
        domContentLoadedEventEnd: started + 2,
        domComplete: started + 3,
        loadEventStart: started + 3,
        loadEventEnd: started + 3
    }
    const navigationEntry = () => {
        const elapsed = performance.now() - perfOrigin
        return {
            name: page.url,
            entryType: 'navigation',
            startTime: 0,
            duration: elapsed,
            initiatorType: 'navigation',
            nextHopProtocol: 'http/1.1',
            workerStart: 0,
            redirectStart: 0,
            redirectEnd: 0,
            fetchStart: 1,
            domainLookupStart: 1,
            domainLookupEnd: 1,
            connectStart: 1,
            connectEnd: 1,
            secureConnectionStart: 0,
            requestStart: 1,
            responseStart: 1,
            responseEnd: 1,
            transferSize: 0,
            encodedBodySize: 0,
            decodedBodySize: 0,
            unloadEventStart: 0,
            unloadEventEnd: 0,
            domInteractive: 2,
            domContentLoadedEventStart: 2,
            domContentLoadedEventEnd: 2,
            domComplete: elapsed,
            loadEventStart: elapsed,
            loadEventEnd: elapsed,
            type: 'navigate',
            redirectCount: 0
        }
    }
    const pagePerformance = {
        timeOrigin: performance.timeOrigin + perfOrigin,
        timing,
        navigation: { type: 0, redirectCount: 0 },
        now: () => performance.now() - perfOrigin,
        mark: (...args) => performance.mark(...args),
        measure: (...args) => performance.measure(...args),
        clearMarks: (...args) => performance.clearMarks(...args),
        clearMeasures: (...args) => performance.clearMeasures(...args),
        getEntries: () => [navigationEntry(), ...performance.getEntries()],
        getEntriesByType: (type) => (String(type) === 'navigation' ? [navigationEntry()] : performance.getEntriesByType(type)),
        getEntriesByName: (name, type) => performance.getEntriesByName(name, type),
        toJSON: () => ({ timeOrigin: performance.timeOrigin + perfOrigin })
    }

    const location = {
        get href() {
            return page.url
        },
        set href(value) {
            page.scheduleNavigation(String(value), { history: 'push' })
        },
        get origin() {
            return new URL(page.url).origin
        },
        get protocol() {
            return new URL(page.url).protocol
        },
        get host() {
            return new URL(page.url).host
        },
        get hostname() {
            return new URL(page.url).hostname
        },
        get port() {
            return new URL(page.url).port
        },
        get pathname() {
            return new URL(page.url).pathname
        },
        get search() {
            return new URL(page.url).search
        },
        get hash() {
            return new URL(page.url).hash
        },
        assign(value) {
            page.scheduleNavigation(String(value), { history: 'push' })
        },
        replace(value) {
            page.scheduleNavigation(String(value), { history: 'replace' })
        },
        reload() {
            page.scheduleNavigation(page.url, { history: 'none' })
        },
        toString() {
            return page.url
        }
    }

    const history = {
        get length() {
            return page.entries.length
        },
        get state() {
            return page.entries[page.index]?.state ?? null
        },
        scrollRestoration: 'auto',
        pushState(state, title, url) {
            page.pushHistory(state, url, 'push')
        },
        replaceState(state, title, url) {
            page.pushHistory(state, url, 'replace')
        },
        back() {
            page.traverse(-1)
        },
        forward() {
            page.traverse(1)
        },
        go(delta = 0) {
            page.traverse(Number(delta) || 0)
        }
    }

    const navigator = {
        get userAgent() {
            return page.emulation.userAgent ?? page.defaultUserAgent
        },
        get appVersion() {
            return (page.emulation.userAgent ?? page.defaultUserAgent).replace(/^Mozilla\//, '')
        },
        appName: 'Netscape',
        appCodeName: 'Mozilla',
        product: 'Gecko',
        productSub: '20030107',
        vendor: 'Google Inc.',
        platform: 'Linux x86_64',
        get language() {
            return page.emulation.locale ?? 'en-US'
        },
        get languages() {
            return [page.emulation.locale ?? 'en-US', 'en']
        },
        webdriver: true,
        cookieEnabled: true,
        onLine: true,
        doNotTrack: null,
        hardwareConcurrency: os.cpus().length || 1,
        deviceMemory: 8,
        maxTouchPoints: page.emulation.hasTouch ? 1 : 0,
        plugins: [],
        mimeTypes: [],
        pdfViewerEnabled: true,
        connection: {
            effectiveType: '4g',
            downlink: 10,
            rtt: 50,
            saveData: false,
            onchange: null,
            addEventListener() {},
            removeEventListener() {}
        },
        get userAgentData() {
            return userAgentDataFor(page.emulation.userAgent ?? page.defaultUserAgent)
        },
        sendBeacon() {
            return true
        },
        javaScriptEnabled: true
    }

    const screen = {
        width: 1920,
        height: 1080,
        availWidth: 1920,
        availHeight: 1080,
        colorDepth: 24,
        pixelDepth: 24,
        orientation: { type: 'landscape-primary', angle: 0 }
    }

    const makeStorage = (kind) => {
        const bucket = () => storage.bucket(kind, page.origin)
        return {
            get length() {
                return bucket().size
            },
            key(index) {
                return [...bucket().keys()][index] ?? null
            },
            getItem(key) {
                const value = bucket().get(String(key))
                return value === undefined ? null : value
            },
            setItem(key, value) {
                bucket().set(String(key), String(value))
            },
            removeItem(key) {
                bucket().delete(String(key))
            },
            clear() {
                bucket().clear()
            }
        }
    }

    const computedFor = (el) => {
        const style = doc.layout().computed(el)
        const px = (v) => (typeof v === 'number' ? `${v}px` : 'auto')
        const values = {
            ...COMPUTED_DEFAULTS,
            display: style.display === 'inline-block' ? 'inline-block' : style.display,
            visibility: style.visibility,
            width: style.width === null ? 'auto' : px(style.width),
            height: style.height === null ? 'auto' : px(style.height),
            position: 'static',
            opacity: '1',
            color: 'rgb(0, 0, 0)',
            'font-size': '16px',
            'pointer-events': 'auto',
            'margin-top': px(style.margin.top),
            'margin-right': px(style.margin.right),
            'margin-bottom': px(style.margin.bottom),
            'margin-left': px(style.margin.left),
            'padding-top': px(style.padding.top),
            'padding-right': px(style.padding.right),
            'padding-bottom': px(style.padding.bottom),
            'padding-left': px(style.padding.left)
        }
        const camel = (name) => name.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
        const out = {}
        for (const [name, value] of Object.entries(values)) {
            out[name] = value
            out[camel(name)] = value
        }
        out.getPropertyValue = (name) => values[String(name).toLowerCase()] ?? ''
        return out
    }

    const matchMedia = (query) => {
        const matches = evaluateMedia(query, env())
        return {
            matches,
            media: String(query),
            onchange: null,
            addListener() {},
            removeListener() {},
            addEventListener() {},
            removeEventListener() {}
        }
    }

    const selectionStub = () => {
        const range = () => ({
            startContainer: null,
            endContainer: null,
            commonAncestorContainer: null,
            setStart() {},
            setEnd() {},
            setStartBefore() {},
            setEndAfter() {},
            selectNodeContents() {},
            selectNode() {},
            collapse() {},
            cloneRange() {
                return range()
            },
            deleteContents() {},
            getBoundingClientRect() {
                return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }
            },
            toString() {
                return ''
            }
        })
        return {
            rangeCount: 0,
            anchorNode: null,
            focusNode: null,
            isCollapsed: true,
            type: 'None',
            addRange() {},
            removeAllRanges() {},
            removeRange() {},
            collapse() {},
            getRangeAt() {
                return range()
            },
            toString() {
                return ''
            }
        }
    }

    const consoleFor = (type) => (...values) => {
        page.emitConsole(type, values.map(describeValue))
    }
    const consoleObject = {}
    for (const [name, type] of [['log', 'log'], ['info', 'info'], ['debug', 'debug'], ['warn', 'warning'], ['error', 'error'], ['trace', 'trace'], ['dir', 'dir'], ['table', 'table'], ['group', 'startGroup'], ['groupCollapsed', 'startGroupCollapsed'], ['groupEnd', 'endGroup'], ['clear', 'clear']]) {
        consoleObject[name] = consoleFor(type)
    }
    consoleObject.assert = (condition, ...values) => {
        if (!condition) page.emitConsole('assert', values.map(describeValue))
    }
    const counts = new Map()
    consoleObject.count = (label = 'default') => {
        const key = String(label)
        counts.set(key, (counts.get(key) ?? 0) + 1)
        page.emitConsole('count', [describeValue(`${key}: ${counts.get(key)}`)])
    }
    consoleObject.countReset = (label = 'default') => counts.delete(String(label))
    consoleObject.time = () => {}
    consoleObject.timeEnd = (label = 'default') => page.emitConsole('timeEnd', [describeValue(`${label}`)])
    consoleObject.timeLog = () => {}

    const dialog = (kind) => (message, defaultValue) => {
        page.emitDialog(kind, String(message ?? ''), defaultValue === undefined ? '' : String(defaultValue))
        if (kind === 'confirm') return false
        if (kind === 'prompt') return null
        return undefined
    }

    Object.assign(win, {
        window: win,
        self: win,
        top: win,
        parent: win,
        frames: win,
        document: doc,
        location,
        history,
        navigator,
        screen,
        console: consoleObject,
        localStorage: makeStorage('local'),
        sessionStorage: makeStorage('session'),
        performance: pagePerformance,
        crypto: globalThis.crypto,
        structuredClone,
        URL,
        URLSearchParams,
        TextEncoder,
        TextDecoder,
        AbortController,
        AbortSignal,
        Headers,
        Request,
        Response,
        FormData,
        Blob,
        MessageChannel,
        MessagePort,
        MessageEvent,
        atob: (data) => Buffer.from(String(data), 'base64').toString('binary'),
        btoa: (data) => Buffer.from(String(data), 'binary').toString('base64'),
        setTimeout: (fn, ms, ...args) => setTimer(fn, ms, args, false),
        clearTimeout: clearTimer,
        setInterval: (fn, ms, ...args) => setTimer(fn, ms, args, true),
        clearInterval: clearTimer,
        setImmediate: (fn, ...args) => setTimer(fn, 0, args, false),
        clearImmediate: clearTimer,
        queueMicrotask: (fn) => {
            Promise.resolve().then(() => {
                try {
                    fn()
                } catch (error) {
                    page.reportError(error)
                }
            })
        },
        requestAnimationFrame: (fn) => setTimer(() => fn(performance.now()), 16, [], false),
        cancelAnimationFrame: clearTimer,
        getComputedStyle: (el) => computedFor(el),
        matchMedia,
        getSelection: () => selectionStub(),
        alert: dialog('alert'),
        confirm: dialog('confirm'),
        prompt: dialog('prompt'),
        fetch: (input, init) => page.fetchFromScript(input, init),
        scroll: (x, y) => {
            doc.scrollY = Math.max(0, Number(y?.top ?? y) || 0)
        },
        scrollTo: (x, y) => {
            doc.scrollY = Math.max(0, Number(y?.top ?? y) || 0)
        },
        scrollBy: (x, y) => {
            doc.scrollY = Math.max(0, doc.scrollY + (Number(y?.top ?? y) || 0))
        },
        XPathResult: class XPathResult {
            static get ORDERED_NODE_SNAPSHOT_TYPE() {
                return 7
            }
        },
        Range: class Range {},
        devicePixelRatio: 1,
        outerWidth: 1920,
        outerHeight: 1080,
        closed: false,
        opener: null,
        name: '',
        origin: '',
        isSecureContext: true,
        crossOriginIsolated: false,
        open: () => null,
        close() {},
        focus() {},
        blur() {},
        print() {},
        stop() {},
    })
    win.postMessage = (message) => {
        const data = structuredClone(message)
        setTimer(() => {
            win.dispatchEvent(new MessageEvent('message', { data, origin: page.origin, source: globalObject }))
        }, 0, [], false)
    }
    for (const name of ['innerWidth']) Object.defineProperty(win, name, { get: () => doc.viewport.width, enumerable: true, configurable: true })
    for (const name of ['innerHeight']) Object.defineProperty(win, name, { get: () => doc.viewport.height, enumerable: true, configurable: true })
    for (const name of ['scrollY', 'pageYOffset']) Object.defineProperty(win, name, { get: () => doc.scrollY, enumerable: true, configurable: true })
    for (const name of ['scrollX', 'pageXOffset']) Object.defineProperty(win, name, { get: () => 0, enumerable: true, configurable: true })
    for (const name of DOM_EXPORTS) win[name] = dom[name]
    win.Event = dom.Event
    win.EventTarget = dom.EventTarget

    doc.hooks.getCookie = () => jar.documentCookie(new URL(page.url))
    doc.hooks.setCookie = (text) => {
        if (/^https?:/.test(page.url)) jar.setLine(text, new URL(page.url))
    }
    doc.hooks.compile = (code) => {
        try {
            return vm.runInContext(`(function (event) {\n${code}\n})`, win, { filename: 'inline-handler', timeout: 5000 })
        } catch (error) {
            page.reportError(error)
            return null
        }
    }
    doc.hooks.getSelection = () => selectionStub()
    dom.setErrorSink((error) => page.reportError(error))

    const bootstrap = vm.runInContext(`(${BOOTSTRAP})`, win, { filename: 'bootstrap' })
    bootstrap({
        xhr: (method, url, headers, body) => page.xhrFromScript(method, url, headers, body)
    })

    const evaluate = (code, filename = 'page') => vm.runInContext(code, win, { filename, timeout: 5000 })

    const dispose = () => {
        for (const id of [...timers.keys()]) clearTimer(id)
        dom.setErrorSink(() => {})
    }

    return {
        window: win,
        context: win,
        evaluate,
        describeValue,
        dispose,
        compileSelector: compile
    }
}
