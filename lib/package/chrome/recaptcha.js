import {
    attachFrame,
    fieldFilled,
    frameEvaluate,
    hitCheckbox,
    humanClick,
    locateFrameBox,
    pageRun,
    pollValue,
    rectOf,
    releaseFrame,
    scrollWidget,
    settledCheckbox,
    waitUntil
} from './solver.js'

const ANCHOR = {
    checkbox: '#recaptcha-anchor',
    parts: ['/recaptcha/api2/anchor', '/recaptcha/enterprise/anchor'],
    exclude: 'size=invisible',
    offsetX: 26
}

const CHALLENGE = {
    parts: ['/recaptcha/api2/bframe', '/recaptcha/enterprise/bframe'],
    exclude: null
}

const WIDGET_SELECTOR = '.g-recaptcha, iframe[src*="recaptcha"]'
const CHALLENGE_FRAME = /\/recaptcha\/(api2|enterprise)\/bframe/
const RESPONSE = 'textarea[name="g-recaptcha-response"]'
const LINK = '.rc-audiochallenge-tdownload-link'
const AUDIO_ATTEMPTS = 3

const hrefOf = (selector) => {
    const node = document.querySelector(selector)
    return node && node.href ? String(node.href) : null
}

const decodeToPcm = async (url) => {
    const response = await fetch(url).catch(() => null)
    if (!response || !response.ok) return null
    const audioData = await response.arrayBuffer()
    const decoder = new OfflineAudioContext(1, 1, 16000)
    const decoded = await decoder.decodeAudioData(audioData)
    const samples = decoded.getChannelData(0)
    const pcm = new Int16Array(samples.length)
    for (let index = 0; index < samples.length; index++) {
        const value = Math.max(-1, Math.min(1, samples[index]))
        pcm[index] = value < 0 ? value * 0x8000 : value * 0x7fff
    }
    const bytes = new Uint8Array(pcm.buffer)
    let binary = ''
    for (let index = 0; index < bytes.length; index += 8192) {
        binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 8192))
    }
    return btoa(binary)
}

const setAnswer = (answer) => {
    const input = document.getElementById('audio-response')
    if (!input) return false
    input.value = answer
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return true
}

const normalizeAnswer = (text) =>
    String(text ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()

const clickBox = (page, origin, box) =>
    humanClick(page, origin.x + box.x + box.width / 2, origin.y + box.y + box.height / 2)

const pollFreshLink = (frame, previous) =>
    pollValue(async () => {
        const value = await frameEvaluate(frame, hrefOf, LINK)
        return value && value !== previous ? value : null
    }, 8000)

export class RecaptchaSolver {
    constructor(page, options = {}) {
        this._page = page
        this._transcribe = typeof options.transcribe === 'function' ? options.transcribe : null
        this._frame = null
    }

    dispose() {
        const frame = this._frame
        this._frame = null
        return releaseFrame(frame)
    }

    async solve() {
        await pageRun(this._page, scrollWidget, WIDGET_SELECTOR)
        const point = await settledCheckbox(this._page, ANCHOR)
        if (!point) return false
        const guard = () => pageRun(this._page, hitCheckbox, { ...ANCHOR, x: point.x, y: point.y })
        const clicked = await humanClick(this._page, point.x, point.y, guard)
        if (!clicked) return false
        if (await this._awaitToken(6000)) return true
        if (!this._transcribe) return false
        try {
            return await this._solveAudio()
        } finally {
            await this.dispose()
        }
    }

    _awaitToken(timeout) {
        return waitUntil(() => pageRun(this._page, fieldFilled, RESPONSE), timeout, 300)
    }

    async _solveAudio() {
        const page = this._page
        let previous = null
        for (let attempt = 0; attempt < AUDIO_ATTEMPTS; attempt++) {
            const frame = await attachFrame(page, CHALLENGE_FRAME, 8000)
            if (!frame) return false
            this._frame = frame

            const origin = await pageRun(page, locateFrameBox, CHALLENGE)
            if (!origin) return false

            if (attempt === 0) {
                const audioButton = await pollValue(() => frameEvaluate(frame, rectOf, '#recaptcha-audio-button'), 8000)
                if (!audioButton) return false
                await clickBox(page, origin, audioButton)
            }

            const link = await pollFreshLink(frame, previous)
            if (!link) return false
            previous = link

            const pcm = await frameEvaluate(frame, decodeToPcm, link)
            if (!pcm) return false

            let transcript = null
            try {
                transcript = await this._transcribe(Buffer.from(pcm, 'base64'))
            } catch {
                return false
            }

            const answer = normalizeAnswer(transcript)
            if (answer && (await frameEvaluate(frame, setAnswer, answer))) {
                const verify = await pollValue(() => frameEvaluate(frame, rectOf, '#recaptcha-verify-button'), 4000)
                if (verify) await clickBox(page, origin, verify)
                if (await this._awaitToken(6000)) return true
            }

            const reload = await pollValue(() => frameEvaluate(frame, rectOf, '#recaptcha-reload-button'), 3000)
            if (!reload) return false
            await clickBox(page, origin, reload)
            await this.dispose()
        }
        return false
    }
}
