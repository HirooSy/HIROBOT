import { DEFAULT_TIMEOUT, expressionFor, sleep } from './util.js'
import { RecaptchaSolver } from './recaptcha.js'
import { fieldFilled, hitCheckbox, humanClick, pageRun, scrollWidget, settledCheckbox, waitUntil } from './solver.js'

const BLOCK = 'cloudflare-block'

const TURNSTILE = {
    checkbox: '.cf-turnstile input[type="checkbox"]',
    parts: ['challenges.cloudflare.com'],
    exclude: null,
    offsetX: 30
}

const TURNSTILE_RESPONSE = 'input[name="cf-turnstile-response"]'

const TURNSTILE_WIDGET = '.cf-turnstile, iframe[src*="challenges.cloudflare.com"]'

const detectInPage = () => {
    const query = (selector) => document.querySelector(selector)
    const emptyField = (selector) => {
        const field = query(selector)
        return field !== null && String(field.value || '').trim() === ''
    }
    const title = String(document.title || '')
    if (query('#cf-error-details') || query('.cf-error-details') || (/attention required/i.test(title) && query('.cf-error-code'))) {
        return ['cloudflare-block']
    }
    const found = []
    if (/just a moment/i.test(title) || query('#challenge-form') || query('#challenge-running') || query('#cf-challenge-running')) {
        found.push('cloudflare')
    }
    const turnstileFrame = Array.from(document.querySelectorAll('iframe[src]')).some((node) => (node.getAttribute('src') || '').includes('challenges.cloudflare.com'))
    if ((query('.cf-turnstile') !== null || turnstileFrame) && emptyField('input[name="cf-turnstile-response"]')) found.push('turnstile')
    if ((query('.g-recaptcha') !== null || window.location.pathname.includes('/sorry')) && emptyField('textarea[name="g-recaptcha-response"]')) found.push('recaptcha')
    if (query('.h-captcha') !== null && emptyField('textarea[name="h-captcha-response"]')) found.push('hcaptcha')
    return found
}

export const CHALLENGE_EXPRESSION = expressionFor(detectInPage)

export const waitForChallengeClear = async (check, options = {}) => {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const interval = options.interval ?? 500
    const deadline = timeout > 0 ? Date.now() + timeout : Infinity
    const settled = (types) => types.length === 0 || types.includes(BLOCK)
    let types = await check()
    while (!settled(types) && Date.now() < deadline) {
        await sleep(Math.min(interval, Math.max(deadline - Date.now(), 0)))
        types = (await check().catch(() => null)) ?? types
    }
    return { types, cleared: types.length === 0 }
}

const settleTypes = async (check, budget) => {
    const deadline = Date.now() + budget
    let types = await check().catch(() => [])
    while (types.length === 0 && Date.now() < deadline) {
        await sleep(250)
        types = await check().catch(() => [])
    }
    return types
}

const solveTurnstile = async (page, options) => {
    await pageRun(page, scrollWidget, TURNSTILE_WIDGET)
    const point = await settledCheckbox(page, TURNSTILE)
    if (!point) return false
    const guard = () => pageRun(page, hitCheckbox, { ...TURNSTILE, x: point.x, y: point.y })
    const clicked = await humanClick(page, point.x, point.y, guard)
    if (!clicked) return false
    return waitUntil(() => pageRun(page, fieldFilled, TURNSTILE_RESPONSE), options.solveTimeout ?? 15000, 300)
}

export const solveChallenge = async (page, options = {}) => {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT
    const check = () => page._evaluate(CHALLENGE_EXPRESSION)

    let types = await settleTypes(check, 3000)
    if (types.length === 0) return { types, cleared: true }
    if (types.includes(BLOCK)) return { types, cleared: false }

    if (types.includes('cloudflare')) {
        const result = await waitForChallengeClear(check, { timeout, interval: 500 })
        types = result.types
        if (result.cleared) return result
    }

    if (types.includes('turnstile')) {
        const solved = await solveTurnstile(page, options)
        if (!solved) return { types, cleared: false }
        const result = await waitForChallengeClear(check, { timeout: 10000, interval: 500 })
        if (result.cleared) return result
        types = result.types
    }

    if (types.includes('recaptcha')) {
        const solver = new RecaptchaSolver(page, { transcribe: options.transcribe })
        const solved = await solver.solve()
        await solver.dispose()
        if (!solved) return { types, cleared: false }
        return waitForChallengeClear(check, { timeout: 10000, interval: 500 })
    }

    return { types, cleared: false }
}
