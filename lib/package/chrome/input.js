import { sleep } from './util.js'

const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 }
const BUTTON_BITS = { none: 0, left: 1, right: 2, middle: 4, back: 8, forward: 16 }
const NAMED_KEYS = {
    Enter: { code: 'Enter', keyCode: 13, text: '\r' },
    Tab: { code: 'Tab', keyCode: 9 },
    Backspace: { code: 'Backspace', keyCode: 8 },
    Delete: { code: 'Delete', keyCode: 46 },
    Escape: { code: 'Escape', keyCode: 27 },
    Space: { code: 'Space', keyCode: 32, text: ' ' },
    ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
    ArrowUp: { code: 'ArrowUp', keyCode: 38 },
    ArrowRight: { code: 'ArrowRight', keyCode: 39 },
    ArrowDown: { code: 'ArrowDown', keyCode: 40 },
    Home: { code: 'Home', keyCode: 36 },
    End: { code: 'End', keyCode: 35 },
    PageUp: { code: 'PageUp', keyCode: 33 },
    PageDown: { code: 'PageDown', keyCode: 34 },
    Insert: { code: 'Insert', keyCode: 45 },
    Shift: { code: 'ShiftLeft', keyCode: 16 },
    Control: { code: 'ControlLeft', keyCode: 17 },
    Alt: { code: 'AltLeft', keyCode: 18 },
    Meta: { code: 'MetaLeft', keyCode: 91 }
}
for (let number = 1; number <= 12; number++) NAMED_KEYS[`F${number}`] = { code: `F${number}`, keyCode: 111 + number }

const resolveKeyName = (name) => (name === 'ControlOrMeta' ? (process.platform === 'darwin' ? 'Meta' : 'Control') : name)

const describeKey = (name) => {
    if (NAMED_KEYS[name]) return { key: name, ...NAMED_KEYS[name] }
    if (name.length === 1) {
        const upper = name.toUpperCase()
        if (/[A-Z]/i.test(name)) return { key: name, code: `Key${upper}`, keyCode: upper.charCodeAt(0), text: name }
        if (/[0-9]/.test(name)) return { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name }
        return { key: name, code: '', keyCode: name.charCodeAt(0), text: name }
    }
    throw new Error(`Unknown key: ${name}`)
}

export const withModifiers = async (keyboard, names = [], action) => {
    for (const name of names) await keyboard.down(name)
    try {
        return await action()
    } finally {
        for (const name of [...names].reverse()) await keyboard.up(name)
    }
}

export class Keyboard {
    constructor(session) {
        this._session = session
        this.modifiers = 0
    }

    async down(key) {
        const info = describeKey(resolveKeyName(key))
        const bit = MODIFIER_BITS[info.key] || 0
        this.modifiers |= bit
        await this._dispatch('keyDown', info, bit ? undefined : this._textFor(info))
    }

    async up(key) {
        const info = describeKey(resolveKeyName(key))
        const bit = MODIFIER_BITS[info.key] || 0
        await this._dispatch('keyUp', info, undefined)
        this.modifiers &= ~bit
    }

    async press(combo, options = {}) {
        const parts = String(combo).split('+')
        const key = parts.pop()
        await withModifiers(this, parts, async () => {
            await this.down(key)
            if (options.delay) await sleep(options.delay)
            await this.up(key)
        })
    }

    async type(text, options = {}) {
        for (const char of String(text)) {
            if (char === '\n') {
                await this.press('Enter')
            } else if (char.length === 1) {
                await this.down(char)
                await this.up(char)
            } else {
                await this.insertText(char)
            }
            if (options.delay) await sleep(options.delay)
        }
    }

    insertText(text) {
        return this._session.send('Input.insertText', { text })
    }

    _textFor(info) {
        if (!info.text) return undefined
        if (this.modifiers & (MODIFIER_BITS.Control | MODIFIER_BITS.Meta)) return undefined
        if (this.modifiers & MODIFIER_BITS.Shift && info.text.length === 1) return info.text.toUpperCase()
        return info.text
    }

    _dispatch(type, info, text) {
        return this._session.send('Input.dispatchKeyEvent', {
            type,
            key: info.key,
            code: info.code || undefined,
            windowsVirtualKeyCode: info.keyCode || undefined,
            nativeVirtualKeyCode: info.keyCode || undefined,
            text,
            unmodifiedText: text,
            modifiers: this.modifiers,
            autoRepeat: false,
            location: 0
        })
    }
}

export class Mouse {
    constructor(session, keyboard) {
        this._session = session
        this._keyboard = keyboard
        this._buttons = 0
        this.x = 0
        this.y = 0
    }

    async move(x, y, options = {}) {
        const steps = Math.max(1, Math.floor(options.steps ?? 1))
        const startX = this.x
        const startY = this.y
        for (let step = 1; step <= steps; step++) {
            await this._send('mouseMoved', startX + ((x - startX) * step) / steps, startY + ((y - startY) * step) / steps, 'none')
        }
        this.x = x
        this.y = y
    }

    async down(options = {}) {
        const button = options.button ?? 'left'
        this._buttons |= BUTTON_BITS[button] ?? 1
        await this._send('mousePressed', this.x, this.y, button, options.clickCount ?? 1)
    }

    async up(options = {}) {
        const button = options.button ?? 'left'
        this._buttons &= ~(BUTTON_BITS[button] ?? 1)
        await this._send('mouseReleased', this.x, this.y, button, options.clickCount ?? 1)
    }

    async click(x, y, options = {}) {
        await this.move(x, y)
        const count = options.clickCount ?? 1
        for (let index = 1; index <= count; index++) {
            await this.down({ button: options.button, clickCount: index })
            if (options.delay) await sleep(options.delay)
            await this.up({ button: options.button, clickCount: index })
        }
    }

    dblclick(x, y, options = {}) {
        return this.click(x, y, { ...options, clickCount: 2 })
    }

    wheel(deltaX = 0, deltaY = 0) {
        return this._session.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel',
            x: this.x,
            y: this.y,
            deltaX,
            deltaY,
            modifiers: this._keyboard.modifiers
        })
    }

    _send(type, x, y, button = 'none', clickCount) {
        return this._session.send('Input.dispatchMouseEvent', {
            type,
            x,
            y,
            button,
            buttons: this._buttons,
            clickCount,
            modifiers: this._keyboard.modifiers
        })
    }
}
