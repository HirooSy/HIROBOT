import http from 'node:http'
import https from 'node:https'
import zlib from 'node:zlib'
import { pipeline } from 'node:stream'

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308])
const DEFAULT_HEADERS = {
    Accept: 'application/json, text/plain, */*',
    'User-Agent': 'Mozilla/5.0 (compatible; hiro/1.0)',
    'Accept-Encoding': 'gzip, deflate, br'
}
const SENSITIVE_HEADERS = ['authorization', 'cookie', 'proxy-authorization']
const ABSOLUTE_URL = /^[a-z][a-z\d+\-.]*:\/\//i

const BASE_DEFAULTS = Object.freeze({
    method: 'get',
    headers: Object.freeze({}),
    timeout: 0,
    maxRedirects: 21,
    maxContentLength: -1,
    maxBodyLength: -1,
    decompress: true,
    validateStatus: (status) => status >= 200 && status < 300
})

export class AxiosError extends Error {
    constructor(message, code, config, request, response) {
        super(message)
        this.name = 'AxiosError'
        this.code = code
        this.config = config
        this.request = request
        this.response = response
        this.isAxiosError = true
    }
}

export class CanceledError extends AxiosError {
    constructor(message, config, request) {
        super(message || 'canceled', 'ERR_CANCELED', config, request)
        this.name = 'CanceledError'
    }
}

export const isAxiosError = (value) => value instanceof AxiosError || value?.isAxiosError === true
export const isCancel = (value) => value instanceof CanceledError || value?.code === 'ERR_CANCELED'

const findKey = (headers, name) => {
    const lower = name.toLowerCase()
    return Object.keys(headers).find((key) => key.toLowerCase() === lower)
}

const getHeader = (headers, name) => {
    const key = findKey(headers, name)
    return key === undefined ? undefined : headers[key]
}

const setHeaderIfMissing = (headers, name, value) => {
    if (findKey(headers, name) === undefined) headers[name] = value
}

const removeHeader = (headers, name) => {
    const key = findKey(headers, name)
    if (key !== undefined) delete headers[key]
}

function mergeHeaders(base = {}, extra = {}) {
    const out = { ...base }
    for (const [name, value] of Object.entries(extra)) {
        const key = findKey(out, name)
        if (key !== undefined) delete out[key]
        out[name] = value
    }
    return out
}

function mergeConfig(base, extra = {}) {
    const out = { ...base, ...extra }
    out.headers = mergeHeaders(base.headers, extra.headers)
    if (extra.params instanceof URLSearchParams) out.params = extra.params
    else if (base.params || extra.params) out.params = { ...base.params, ...extra.params }
    return out
}

function serializeParams(params) {
    if (params instanceof URLSearchParams) return params.toString()
    const search = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === null) continue
        if (Array.isArray(value)) {
            for (const item of value) if (item !== undefined && item !== null) search.append(`${key}[]`, String(item))
        } else if (value instanceof Date) {
            search.append(key, value.toISOString())
        } else if (typeof value === 'object') {
            search.append(key, JSON.stringify(value))
        } else {
            search.append(key, String(value))
        }
    }
    return search.toString()
}

function buildURL(config) {
    let url = String(config.url ?? '')
    if (config.baseURL && !ABSOLUTE_URL.test(url)) {
        const base = config.baseURL.replace(/\/+$/, '')
        url = url ? `${base}/${url.replace(/^\/+/, '')}` : base
    }
    if (config.params) {
        const query = serializeParams(config.params)
        if (query) url += (url.includes('?') ? '&' : '?') + query
    }
    return url
}

async function encodeBody(data, headers) {
    if (data === undefined || data === null) return null
    if (typeof data === 'string' || Buffer.isBuffer(data)) return data
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
    if (data instanceof ArrayBuffer) return Buffer.from(data)
    if (typeof data.pipe === 'function') return data
    if (data instanceof URLSearchParams) {
        setHeaderIfMissing(headers, 'Content-Type', 'application/x-www-form-urlencoded;charset=utf-8')
        return data.toString()
    }
    if (typeof FormData !== 'undefined' && data instanceof FormData) {
        const response = new Response(data)
        setHeaderIfMissing(headers, 'Content-Type', response.headers.get('content-type'))
        return Buffer.from(await response.arrayBuffer())
    }
    if (typeof Blob !== 'undefined' && data instanceof Blob) {
        if (data.type) setHeaderIfMissing(headers, 'Content-Type', data.type)
        return Buffer.from(await data.arrayBuffer())
    }
    if (typeof data === 'object') {
        if (/x-www-form-urlencoded/i.test(String(getHeader(headers, 'Content-Type') || ''))) {
            return new URLSearchParams(data).toString()
        }
        setHeaderIfMissing(headers, 'Content-Type', 'application/json')
        return JSON.stringify(data)
    }
    return String(data)
}

function decodeBody(res, decompress, method) {
    if (decompress === false || method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304) return res
    const encoding = String(res.headers['content-encoding'] || '').trim().toLowerCase()
    let decoder = null
    if (encoding === 'gzip' || encoding === 'x-gzip' || encoding === 'deflate') decoder = zlib.createUnzip()
    else if (encoding === 'br') decoder = zlib.createBrotliDecompress()
    if (!decoder) return res
    pipeline(res, decoder, () => {})
    return decoder
}

async function readBody(stream, limit, config) {
    const chunks = []
    let total = 0
    for await (const chunk of stream) {
        total += chunk.length
        if (limit > -1 && total > limit) {
            throw new AxiosError(`maxContentLength size of ${limit} exceeded`, 'ERR_BAD_RESPONSE', config)
        }
        chunks.push(chunk)
    }
    return Buffer.concat(chunks, total)
}

function convertData(buffer, config, headers, status) {
    const type = config.responseType
    const transforms = config.transformResponse
    if (type === 'arraybuffer' && !transforms) return buffer
    let data = type === 'arraybuffer' ? buffer : buffer.toString('utf8')
    if (transforms) {
        for (const transform of [].concat(transforms)) data = transform.call(config, data, headers, status)
        return data
    }
    if (type === 'text') return data
    if ((!type || type === 'json' || type === 'stream') && typeof data === 'string' && data.length) {
        try {
            return JSON.parse(data)
        } catch {
            return data
        }
    }
    return data
}

function transfer(config, ctx, url, method, headers, payload) {
    return new Promise((resolve, reject) => {
        let target
        try {
            target = new URL(url)
        } catch (error) {
            reject(new AxiosError(error.message, 'ERR_INVALID_URL', config))
            return
        }
        const secure = target.protocol === 'https:'
        if (!secure && target.protocol !== 'http:') {
            reject(new AxiosError(`Unsupported protocol ${target.protocol}`, 'ERR_BAD_REQUEST', config))
            return
        }

        const options = { method, headers }
        const agent = secure ? config.httpsAgent : config.httpAgent
        if (agent) options.agent = agent
        if (config.family) options.family = config.family
        if (config.lookup) options.lookup = config.lookup

        let settled = false
        const req = (secure ? https : http).request(target, options, (res) => {
            settled = true
            resolve(res)
        })

        const abort = (error) => {
            if (!ctx.error) ctx.error = error
            req.destroy(error)
        }

        req.on('error', (error) => {
            if (!settled) {
                settled = true
                reject(ctx.error || error)
            }
        })

        if (config.timeout > 0) {
            req.setTimeout(config.timeout, () => abort(new AxiosError(`timeout of ${config.timeout}ms exceeded`, 'ECONNABORTED', config, req)))
        }

        if (config.signal) {
            if (config.signal.aborted) {
                abort(new CanceledError(undefined, config, req))
            } else {
                const onAbort = () => abort(new CanceledError(undefined, config, req))
                config.signal.addEventListener('abort', onAbort, { once: true })
                ctx.cleanups.push(() => config.signal.removeEventListener('abort', onAbort))
            }
        }

        if (payload === null || payload === undefined) req.end()
        else if (typeof payload.pipe === 'function') payload.pipe(req)
        else req.end(payload)
    })
}

async function finalize(res, url, config, ctx, method) {
    const status = res.statusCode
    const stream = decodeBody(res, config.decompress, method)
    const headers = res.headers
    const request = { res: { responseUrl: url }, responseURL: url }
    const meta = { status, statusText: res.statusMessage || '', headers, config, request }
    const validate = config.validateStatus || BASE_DEFAULTS.validateStatus
    const ok = validate(status)

    if (config.responseType === 'stream' && ok) {
        stream.once('close', () => ctx.dispose())
        return { ...meta, data: stream }
    }

    let buffer
    try {
        buffer = await readBody(stream, config.maxContentLength, config)
    } catch (error) {
        throw ctx.error || error
    } finally {
        ctx.dispose()
    }

    const data = convertData(buffer, config, headers, status)
    if (ok) return { ...meta, data }
    throw new AxiosError(
        `Request failed with status code ${status}`,
        status >= 400 && status < 500 ? 'ERR_BAD_REQUEST' : 'ERR_BAD_RESPONSE',
        config,
        request,
        { ...meta, data }
    )
}

async function dispatch(config) {
    if (config.signal?.aborted) throw new CanceledError(undefined, config)

    const ctx = { error: null, cleanups: [], dispose: null }
    ctx.dispose = () => {
        const cleanups = ctx.cleanups.splice(0)
        for (const cleanup of cleanups) cleanup()
    }

    let method = String(config.method || 'get').toUpperCase()
    let url = buildURL(config)
    const headers = mergeHeaders(DEFAULT_HEADERS, config.headers)
    for (const key of Object.keys(headers)) if (headers[key] === undefined || headers[key] === null) delete headers[key]

    let payload = null
    if (method !== 'HEAD') payload = await encodeBody(config.data, headers)
    if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        setHeaderIfMissing(headers, 'Content-Type', 'application/x-www-form-urlencoded')
    }
    if (typeof payload === 'string' || Buffer.isBuffer(payload)) {
        setHeaderIfMissing(headers, 'Content-Length', String(Buffer.byteLength(payload)))
    }

    let redirects = 0
    for (;;) {
        let res
        try {
            res = await transfer(config, ctx, url, method, headers, payload)
        } catch (error) {
            ctx.dispose()
            throw error
        }

        const location = res.headers.location
        if (REDIRECT_CODES.has(res.statusCode) && location && config.maxRedirects !== 0) {
            res.resume()
            if (redirects >= config.maxRedirects) {
                ctx.dispose()
                throw new AxiosError('Maximum number of redirects exceeded', 'ERR_FR_TOO_MANY_REDIRECTS', config)
            }
            redirects++
            const next = new URL(location, url)
            if (next.origin !== new URL(url).origin) for (const name of SENSITIVE_HEADERS) removeHeader(headers, name)
            url = next.toString()
            if (res.statusCode === 303 || ((res.statusCode === 301 || res.statusCode === 302) && method === 'POST')) {
                method = 'GET'
                payload = null
                removeHeader(headers, 'Content-Type')
                removeHeader(headers, 'Content-Length')
            }
            continue
        }

        return finalize(res, url, config, ctx, method)
    }
}

function createInstance(instanceConfig) {
    const instance = (input, extra) => {
        const config = typeof input === 'string' ? { ...extra, url: input } : { ...input }
        return dispatch(mergeConfig(instanceConfig, config))
    }
    instance.request = instance
    for (const method of ['get', 'delete', 'head', 'options']) {
        instance[method] = (url, config) => instance({ ...config, method, url })
    }
    for (const method of ['post', 'put', 'patch']) {
        instance[method] = (url, data, config) => instance({ ...config, method, url, data })
    }
    instance.create = (config) => createInstance(mergeConfig(instanceConfig, config))
    instance.defaults = instanceConfig
    instance.isCancel = isCancel
    instance.isAxiosError = isAxiosError
    instance.AxiosError = AxiosError
    instance.CanceledError = CanceledError
    return instance
}

const axios = createInstance(BASE_DEFAULTS)

export const create = (config) => axios.create(config)

export default axios
