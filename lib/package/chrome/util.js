import { TimeoutError } from './errors.js'

export const DEFAULT_TIMEOUT = 30000

export const noop = () => {}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const remainingTime = (timeout, started) => (timeout > 0 ? Math.max(1, timeout - (Date.now() - started)) : 0)

export const poll = async (check, { timeout = DEFAULT_TIMEOUT, interval = 50, label = 'waiting' } = {}) => {
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity
    const ceiling = Math.max(interval, 250)
    let delay = interval
    for (;;) {
        const value = await check()
        if (value) return value
        const left = deadline - Date.now()
        if (left <= 0) throw new TimeoutError(`Timeout ${timeout}ms exceeded while ${label}`)
        await sleep(Math.min(delay, left))
        delay = Math.min(delay * 1.5, ceiling)
    }
}

export const serialize = (value) => (value === undefined ? 'undefined' : JSON.stringify(value))

export const functionSource = (fn) => `(${fn.toString()})`

export const expressionFor = (pageFunction, arg) =>
    typeof pageFunction === 'function' ? `${functionSource(pageFunction)}(${serialize(arg)})` : String(pageFunction)

const plainValue = (value) => (value instanceof RegExp ? { source: value.source, flags: value.flags.replace(/[gy]/g, '') } : value)

export const engine = (name, args) => {
    const plain = Object.fromEntries(
        Object.entries(args)
            .filter(([, value]) => value !== undefined)
            .map(([key, value]) => [key, plainValue(value)])
    )
    return `internal:${name}=${encodeURIComponent(JSON.stringify(plain))}`
}

const globCache = new Map()

const globToRegExp = (glob) => {
    let pattern = globCache.get(glob)
    if (pattern === undefined) {
        let source = ''
        for (let index = 0; index < glob.length; index++) {
            const char = glob[index]
            if (char === '*') {
                if (glob[index + 1] === '*') {
                    source += '.*'
                    index++
                } else {
                    source += '[^/]*'
                }
            } else if (char === '?') {
                source += '.'
            } else {
                source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
            }
        }
        pattern = new RegExp(`^${source}$`)
        globCache.set(glob, pattern)
    }
    return pattern
}

const toUrl = (value) => {
    try {
        return new URL(value)
    } catch {
        return value
    }
}

export const matchUrl = (matcher, url) => {
    if (typeof matcher === 'function') return Boolean(matcher(toUrl(url)))
    if (matcher instanceof RegExp) {
        matcher.lastIndex = 0
        return matcher.test(url)
    }
    return globToRegExp(String(matcher)).test(url)
}

export const parseLength = (value) => {
    if (typeof value === 'number') return value / 96
    const match = /^(-?\d*\.?\d+)(px|in|cm|mm)?$/i.exec(String(value).trim())
    if (!match) throw new Error(`Invalid length: ${value}`)
    const amount = Number(match[1])
    switch ((match[2] || 'px').toLowerCase()) {
        case 'in':
            return amount
        case 'cm':
            return amount / 2.54
        case 'mm':
            return amount / 25.4
        default:
            return amount / 96
    }
}
