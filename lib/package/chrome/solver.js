import { expressionFor, sleep } from './util.js'

const between = (min, max) => min + Math.random() * (max - min)

const bezier = (p0, p1, p2, p3, t) => {
    const u = 1 - t
    return u * u * u * p0 + 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t * p3
}

export const humanClick = async (page, x, y, guard = null) => {
    const mouse = page.mouse
    const startX = mouse.x
    const startY = mouse.y
    const dx = x - startX
    const dy = y - startY
    const distance = Math.hypot(dx, dy)
    const steps = Math.max(6, Math.min(36, Math.round(distance / 12)))
    const bend = Math.min(60, distance * 0.15)
    const c1x = startX + dx * between(0.2, 0.4) + between(-bend, bend)
    const c1y = startY + dy * between(0.2, 0.4) + between(-bend, bend)
    const c2x = startX + dx * between(0.6, 0.8) + between(-bend, bend)
    const c2y = startY + dy * between(0.6, 0.8) + between(-bend, bend)
    for (let step = 1; step <= steps; step++) {
        const t = step / steps
        const progress = t * t * (3 - 2 * t)
        await mouse.move(bezier(startX, c1x, c2x, x, progress), bezier(startY, c1y, c2y, y, progress))
        await sleep(between(6, 16))
    }
    await mouse.move(x, y)
    await sleep(between(70, 180))
    if (guard && !(await guard())) return false
    await mouse.down({ button: 'left', clickCount: 1 })
    await sleep(between(50, 120))
    await mouse.up({ button: 'left', clickCount: 1 })
    return true
}

export const pageRun = (page, fn, arg) =>
    Promise.resolve()
        .then(() => page._evaluate(expressionFor(fn, arg)))
        .catch(() => null)

export const pollValue = async (produce, timeout, interval = 250) => {
    const deadline = Date.now() + timeout
    for (;;) {
        const value = await Promise.resolve().then(produce).catch(() => null)
        if (value) return value
        const left = deadline - Date.now()
        if (left <= 0) return null
        await sleep(Math.min(interval, left))
    }
}

export const waitUntil = async (check, timeout, interval = 250) => Boolean(await pollValue(check, timeout, interval))

const findFrameId = (node, pattern) => {
    if (!node) return null
    if (node.frame && pattern.test(node.frame.url || '')) return node.frame.id
    for (const child of node.childFrames || []) {
        const found = findFrameId(child, pattern)
        if (found) return found
    }
    return null
}

const runIn = async (send, expression, extra = {}) => {
    const result = await send('Runtime.evaluate', { expression: expression, awaitPromise: true, returnByValue: true, userGesture: true, ...extra }).catch(() => null)
    if (!result || result.exceptionDetails) return null
    return result.result?.value ?? null
}

export const attachFrame = async (page, pattern, timeout) => {
    const session = page._session
    const connection = page._browser.connection
    const deadline = Date.now() + timeout
    for (;;) {
        const tree = await session.send('Page.getFrameTree').catch(() => null)
        const frameId = tree ? findFrameId(tree.frameTree, pattern) : null
        if (frameId) {
            const world = await session.send('Page.createIsolatedWorld', { frameId: frameId, worldName: 'solver', grantUniversalAccess: true }).catch(() => null)
            if (world) {
                const contextId = world.executionContextId
                return {
                    run: (expression) => runIn((method, params) => session.send(method, params), expression, { contextId: contextId }),
                    release: async () => {}
                }
            }
        }
        const listed = await connection.send('Target.getTargets').catch(() => null)
        if (!listed) return null
        const info = (listed.targetInfos || []).find((item) => item.type === 'iframe' && pattern.test(item.url))
        if (info) {
            const attached = await connection.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }).catch(() => null)
            if (attached) {
                const child = connection.createSession(attached.sessionId)
                return {
                    run: (expression) => runIn((method, params) => child.send(method, params), expression),
                    release: async () => {
                        await connection.send('Target.detachFromTarget', { sessionId: attached.sessionId }).catch(() => null)
                        connection.removeSession(attached.sessionId)
                    }
                }
            }
        }
        const left = deadline - Date.now()
        if (left <= 0) return null
        await sleep(Math.min(300, left))
    }
}

export const frameEvaluate = (frame, fn, arg) => (frame ? frame.run(expressionFor(fn, arg)) : Promise.resolve(null))

export const releaseFrame = async (frame) => {
    if (!frame) return
    await frame.release()
}

export const rectOf = (selector) => {
    const node = document.querySelector(selector)
    if (!node) return null
    const box = node.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return null
    return { x: box.left, y: box.top, width: box.width, height: box.height }
}

export const fieldFilled = (selector) => {
    const field = document.querySelector(selector)
    return field !== null && String(field.value || '').trim() !== ''
}

export const locateFrameBox = (config) => {
    const node = Array.from(document.querySelectorAll('iframe[src]')).find((item) => {
        const src = item.getAttribute('src') || ''
        return config.parts.some((part) => src.includes(part)) && !(config.exclude && src.includes(config.exclude))
    })
    if (!node) return null
    const box = node.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return null
    return { x: box.left, y: box.top, width: box.width, height: box.height }
}

export const locateCheckbox = (config) => {
    const direct = config.checkbox ? document.querySelector(config.checkbox) : null
    if (direct) {
        const box = direct.getBoundingClientRect()
        if (box.width > 0 && box.height > 0) {
            return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
        }
    }
    const node = Array.from(document.querySelectorAll('iframe[src]')).find((item) => {
        const src = item.getAttribute('src') || ''
        return config.parts.some((part) => src.includes(part)) && !(config.exclude && src.includes(config.exclude))
    })
    if (!node) return null
    const box = node.getBoundingClientRect()
    if (box.width <= 0 || box.height <= 0) return null
    return { x: box.left + config.offsetX, y: box.top + box.height / 2 }
}

export const scrollWidget = (selector) => {
    const node = document.querySelector(selector)
    if (node) node.scrollIntoView({ block: 'center' })
    return Boolean(node)
}

export const hitCheckbox = (config) => {
    const hit = document.elementFromPoint(config.x, config.y)
    if (!hit) return false
    if (config.checkbox && hit.closest && hit.closest(config.checkbox)) return true
    if (hit.tagName === 'IFRAME') {
        const src = hit.getAttribute('src') || ''
        return config.parts.some((part) => src.includes(part)) && !(config.exclude && src.includes(config.exclude))
    }
    return false
}

export const settledCheckbox = async (page, config, timeout = 5000) => {
    const deadline = Date.now() + timeout
    let previous = null
    while (Date.now() < deadline) {
        const point = await pageRun(page, locateCheckbox, config)
        if (point && previous && Math.abs(point.x - previous.x) < 1 && Math.abs(point.y - previous.y) < 1) return point
        previous = point
        await sleep(250)
    }
    return null
}
