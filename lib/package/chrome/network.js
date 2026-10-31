import fs from 'node:fs/promises'

const ABORT_REASONS = {
    aborted: 'Aborted',
    accessdenied: 'AccessDenied',
    failed: 'Failed',
    blockedbyclient: 'BlockedByClient',
    blockedbyresponse: 'BlockedByResponse',
    timedout: 'TimedOut',
    connectionrefused: 'ConnectionRefused',
    connectionreset: 'ConnectionReset',
    connectionclosed: 'ConnectionClosed',
    connectionaborted: 'ConnectionAborted',
    internetdisconnected: 'InternetDisconnected',
    addressunreachable: 'AddressUnreachable'
}

const toEntries = (headers) => Object.entries(headers).map(([name, value]) => ({ name, value: String(value) }))

const lowerHeaders = (headers = {}) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]))

const setHeaderIfMissing = (headers, name, value) => {
    const lower = name.toLowerCase()
    if (!Object.keys(headers).some((key) => key.toLowerCase() === lower)) headers[name] = value
}

export class Request {
    constructor(params) {
        this._requestId = params.requestId
        this._request = params.request
        this._type = params.resourceType || ''
        this._redirectedFrom = params.redirectedFrom || null
        this._response = null
        this._failure = null
    }

    url() {
        return this._request.url
    }

    method() {
        return this._request.method
    }

    headers() {
        return lowerHeaders(this._request.headers)
    }

    postData() {
        return this._request.postData ?? null
    }

    resourceType() {
        return String(this._type).toLowerCase()
    }

    isNavigationRequest() {
        return this._type === 'Document'
    }

    redirectedFrom() {
        return this._redirectedFrom
    }

    async response() {
        return this._response
    }

    failure() {
        return this._failure
    }
}

export class Response {
    constructor(data, request, session, requestId) {
        this._data = data
        this._request = request ?? null
        this._session = session ?? null
        this._requestId = requestId ?? null
        this._body = null
        this._finishedError = null
        this._settle = null
        this._finished = new Promise((resolve) => {
            this._settle = resolve
        })
    }

    _settleFinished(errorText) {
        if (errorText) this._finishedError = new Error(errorText)
        this._settle()
    }

    async finished() {
        await this._finished
        return this._finishedError
    }

    url() {
        return this._data.url
    }

    status() {
        return this._data.status
    }

    statusText() {
        return this._data.statusText || ''
    }

    ok() {
        return this._data.status >= 200 && this._data.status <= 299
    }

    headers() {
        return lowerHeaders(this._data.headers)
    }

    request() {
        return this._request
    }

    body() {
        this._body ??= this._finished.then(() => {
            if (this._finishedError) throw this._finishedError
            return this._load()
        })
        return this._body
    }

    async text() {
        return (await this.body()).toString('utf8')
    }

    async json() {
        return JSON.parse(await this.text())
    }

    async _load() {
        if (!this._session || !this._requestId) throw new Error('Response body is not available')
        const { body, base64Encoded } = await this._session.send('Network.getResponseBody', { requestId: this._requestId })
        return Buffer.from(body, base64Encoded ? 'base64' : 'utf8')
    }
}

export class Route {
    constructor(session, params) {
        this._session = session
        this._requestId = params.requestId
        this._request = new Request({ requestId: params.requestId, request: params.request, resourceType: params.resourceType })
        this._handled = false
    }

    request() {
        return this._request
    }

    async continue(overrides = {}) {
        this._claim()
        const params = { requestId: this._requestId }
        if (overrides.url) params.url = overrides.url
        if (overrides.method) params.method = overrides.method
        if (overrides.headers) params.headers = toEntries(overrides.headers)
        if (overrides.postData !== undefined) params.postData = Buffer.from(String(overrides.postData)).toString('base64')
        await this._session.send('Fetch.continueRequest', params)
    }

    async fulfill(options = {}) {
        this._claim()
        const headers = { ...(options.headers || {}) }
        let body = options.body ?? ''
        if (options.json !== undefined) {
            body = JSON.stringify(options.json)
            setHeaderIfMissing(headers, 'content-type', 'application/json')
        }
        if (options.path) body = await fs.readFile(options.path)
        if (options.contentType) setHeaderIfMissing(headers, 'content-type', options.contentType)
        const buffer = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
        await this._session.send('Fetch.fulfillRequest', {
            requestId: this._requestId,
            responseCode: options.status ?? 200,
            responseHeaders: toEntries(headers),
            body: buffer.toString('base64')
        })
    }

    async abort(errorCode = 'failed') {
        this._claim()
        await this._session.send('Fetch.failRequest', {
            requestId: this._requestId,
            errorReason: ABORT_REASONS[String(errorCode).toLowerCase()] || 'Failed'
        })
    }

    _claim() {
        if (this._handled) throw new Error('Route has already been handled')
        this._handled = true
    }
}

export class Dialog {
    constructor(session, params) {
        this._session = session
        this._params = params
    }

    type() {
        return this._params.type
    }

    message() {
        return this._params.message
    }

    defaultValue() {
        return this._params.defaultPrompt ?? ''
    }

    accept(promptText) {
        return this._session.send('Page.handleJavaScriptDialog', { accept: true, promptText })
    }

    dismiss() {
        return this._session.send('Page.handleJavaScriptDialog', { accept: false })
    }
}
