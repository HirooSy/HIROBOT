import fs from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 20

export class NetError extends Error {
    constructor(errorText) {
        super(errorText)
        this.errorText = errorText
    }
}

const errorTextOf = (error) => {
    const code = error?.cause?.code ?? error?.code ?? ''
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError' || code === 'UND_ERR_CONNECT_TIMEOUT' || code === 'ETIMEDOUT') return 'net::ERR_TIMED_OUT'
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'net::ERR_NAME_NOT_RESOLVED'
    if (code === 'ECONNREFUSED') return 'net::ERR_CONNECTION_REFUSED'
    if (code === 'ECONNRESET') return 'net::ERR_CONNECTION_RESET'
    if (/CERT|SSL|TLS/.test(code)) return 'net::ERR_CERT_AUTHORITY_INVALID'
    return 'net::ERR_FAILED'
}

const headerPairs = (headers) => [...headers.entries()]

const dataResponse = (url) => {
    const match = /^data:([^,]*?)(;base64)?,([\s\S]*)$/.exec(url)
    if (!match) throw new NetError('net::ERR_INVALID_URL')
    const mime = match[1] || 'text/plain;charset=US-ASCII'
    const body = match[2] ? Buffer.from(decodeURIComponent(match[3]), 'base64') : Buffer.from(decodeURIComponent(match[3]), 'utf8')
    return { url, status: 200, statusText: 'OK', headers: [['content-type', mime]], body, hops: [] }
}

export const fetchResource = async ({ url, method = 'GET', headers = {}, body = null, jar, timeout = 30000 }) => {
    const target = new URL(url)
    if (target.protocol === 'data:') return dataResponse(url)
    if (target.protocol === 'about:') return { url, status: 200, statusText: 'OK', headers: [['content-type', 'text/html']], body: Buffer.alloc(0), hops: [] }
    if (target.protocol === 'file:') {
        try {
            const body = await fs.readFile(fileURLToPath(target))
            return { url, status: 200, statusText: 'OK', headers: [['content-type', 'text/html']], body, hops: [] }
        } catch {
            throw new NetError('net::ERR_FILE_NOT_FOUND')
        }
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new NetError('net::ERR_UNKNOWN_URL_SCHEME')
    let current = target
    let currentMethod = String(method).toUpperCase()
    let currentBody = body
    const hops = []
    for (let index = 0; ; index++) {
        const requestHeaders = { ...headers }
        const cookie = jar ? jar.header(current) : ''
        if (cookie && !Object.keys(requestHeaders).some((key) => key.toLowerCase() === 'cookie')) requestHeaders.cookie = cookie
        let response
        try {
            response = await fetch(current, {
                method: currentMethod,
                headers: requestHeaders,
                body: currentBody ?? undefined,
                redirect: 'manual',
                signal: AbortSignal.timeout(timeout)
            })
        } catch (error) {
            throw new NetError(errorTextOf(error))
        }
        jar?.storeAll(response.headers.getSetCookie?.() ?? [], current)
        const hop = { url: current.href, method: currentMethod, requestHeaders, status: response.status, statusText: response.statusText, headers: headerPairs(response.headers) }
        hops.push(hop)
        const location = response.headers.get('location')
        if (REDIRECTS.has(response.status) && location) {
            await response.arrayBuffer().catch(() => {})
            if (index >= MAX_REDIRECTS) throw new NetError('net::ERR_TOO_MANY_REDIRECTS')
            current = new URL(location, current)
            if (response.status !== 307 && response.status !== 308) {
                currentMethod = 'GET'
                currentBody = null
            }
            continue
        }
        const buffer = Buffer.from(await response.arrayBuffer().catch(() => new ArrayBuffer(0)))
        return { url: current.href, status: response.status, statusText: response.statusText, headers: headerPairs(response.headers), body: buffer, hops }
    }
}

const defaultPath = (pathname) => {
    if (!pathname.startsWith('/') || pathname === '/') return '/'
    const index = pathname.lastIndexOf('/')
    return index <= 0 ? '/' : pathname.slice(0, index)
}

export class CookieJar {
    constructor() {
        this.store = new Map()
    }

    _live(cookie) {
        if (cookie.expires !== null && cookie.expires <= Date.now()) {
            this.store.delete(`${cookie.domain}|${cookie.path}|${cookie.name}`)
            return false
        }
        return true
    }

    _put(cookie) {
        const key = `${cookie.domain}|${cookie.path}|${cookie.name}`
        if (cookie.expires !== null && cookie.expires <= Date.now()) this.store.delete(key)
        else this.store.set(key, cookie)
    }

    setLine(line, url) {
        const parts = String(line).split(';').map((part) => part.trim())
        const eq = parts[0].indexOf('=')
        if (eq <= 0) return
        const host = url.hostname.toLowerCase()
        const cookie = {
            name: parts[0].slice(0, eq).trim(),
            value: parts[0].slice(eq + 1).trim(),
            domain: host,
            hostOnly: true,
            path: defaultPath(url.pathname),
            secure: false,
            httpOnly: false,
            sameSite: 'Lax',
            expires: null
        }
        for (const attribute of parts.slice(1)) {
            const split = attribute.indexOf('=')
            const key = (split < 0 ? attribute : attribute.slice(0, split)).trim().toLowerCase()
            const value = split < 0 ? '' : attribute.slice(split + 1).trim()
            if (key === 'domain') {
                const domain = value.replace(/^\./, '').toLowerCase()
                if (domain && (host === domain || host.endsWith(`.${domain}`))) {
                    cookie.domain = domain
                    cookie.hostOnly = false
                }
            } else if (key === 'path') cookie.path = value.startsWith('/') ? value : '/'
            else if (key === 'secure') cookie.secure = true
            else if (key === 'httponly') cookie.httpOnly = true
            else if (key === 'samesite') {
                const lower = value.toLowerCase()
                cookie.sameSite = lower === 'strict' ? 'Strict' : lower === 'none' ? 'None' : 'Lax'
            } else if (key === 'max-age') {
                const seconds = Number(value)
                if (Number.isFinite(seconds)) cookie.expires = Date.now() + seconds * 1000
            } else if (key === 'expires' && cookie.expires === null) {
                const time = Date.parse(value)
                if (!Number.isNaN(time)) cookie.expires = time
            }
        }
        this._put(cookie)
    }

    storeAll(lines, url) {
        for (const line of lines) this.setLine(line, url)
    }

    matching(url, { includeHttpOnly = true } = {}) {
        const out = []
        for (const cookie of [...this.store.values()]) {
            if (!this._live(cookie)) continue
            if (!includeHttpOnly && cookie.httpOnly) continue
            const hostMatches = cookie.hostOnly ? url.hostname === cookie.domain : url.hostname === cookie.domain || url.hostname.endsWith(`.${cookie.domain}`)
            if (!hostMatches || !url.pathname.startsWith(cookie.path)) continue
            if (cookie.secure && url.protocol !== 'https:') continue
            out.push(cookie)
        }
        return out.sort((a, b) => b.path.length - a.path.length)
    }

    header(url) {
        return this.matching(url).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }

    documentCookie(url) {
        return this.matching(url, { includeHttpOnly: false }).map((cookie) => `${cookie.name}=${cookie.value}`).join('; ')
    }

    add(cookies) {
        for (const item of cookies) {
            const raw = String(item.domain ?? '')
            const domain = raw.replace(/^\./, '').toLowerCase()
            this._put({
                name: String(item.name),
                value: String(item.value ?? ''),
                domain,
                hostOnly: !raw.startsWith('.'),
                path: item.path || '/',
                secure: item.secure === true,
                httpOnly: item.httpOnly === true,
                sameSite: item.sameSite || 'Lax',
                expires: typeof item.expires === 'number' && item.expires > 0 ? item.expires * 1000 : null
            })
        }
    }

    list() {
        return [...this.store.values()].filter((cookie) => this._live(cookie)).map((cookie) => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
            path: cookie.path,
            expires: cookie.expires === null ? -1 : cookie.expires / 1000,
            size: cookie.name.length + cookie.value.length,
            httpOnly: cookie.httpOnly,
            secure: cookie.secure,
            session: cookie.expires === null,
            sameSite: cookie.sameSite
        }))
    }

    clear() {
        this.store.clear()
    }
}
