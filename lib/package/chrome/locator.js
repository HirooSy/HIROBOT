import { withModifiers } from './input.js'
import { engine, poll } from './util.js'

const ready = (state) => state.attached && state.visible && state.enabled
const editable = (state) => ready(state) && state.editable
const visible = (state) => state.attached && state.visible
const STATES = {
    attached: (state) => state.attached,
    detached: (state) => !state.attached,
    visible,
    hidden: (state) => !state.attached || !state.visible
}

export class Locator {
    constructor(page, selector) {
        this.page = page
        this.selector = selector
    }

    locator(selector) {
        return new Locator(this.page, `${this.selector} >> ${selector}`)
    }

    getByRole(role, options = {}) {
        return this.locator(engine('role', { role, ...options }))
    }

    getByText(text, options = {}) {
        return this.locator(engine('text', { text, exact: options.exact === true }))
    }

    getByLabel(text, options = {}) {
        return this.locator(engine('label', { text, exact: options.exact === true }))
    }

    getByPlaceholder(text, options = {}) {
        return this.locator(engine('placeholder', { text, exact: options.exact === true }))
    }

    getByAltText(text, options = {}) {
        return this.locator(engine('alt', { text, exact: options.exact === true }))
    }

    getByTitle(text, options = {}) {
        return this.locator(engine('title', { text, exact: options.exact === true }))
    }

    getByTestId(testId) {
        return this.locator(engine('testid', { text: testId, attribute: 'data-testid' }))
    }

    filter(options = {}) {
        if (options.hasText === undefined) return new Locator(this.page, this.selector)
        return new Locator(this.page, `${this.selector} >> ${engine('has-text', { text: options.hasText })}`)
    }

    nth(index) {
        return new Locator(this.page, `${this.selector} >> nth=${index}`)
    }

    first() {
        return this.nth(0)
    }

    last() {
        return this.nth(-1)
    }

    async all() {
        const count = await this.count()
        return Array.from({ length: count }, (_, index) => this.nth(index))
    }

    count() {
        return this.page._dom('count', this.selector)
    }

    allTextContents() {
        return this.page._dom('texts', this.selector)
    }

    async boundingBox() {
        const box = await this.page._dom('box', this.selector)
        return box ? { x: box.left, y: box.top, width: box.width, height: box.height } : null
    }

    async waitFor(options = {}) {
        const state = options.state ?? 'visible'
        const predicate = STATES[state]
        if (!predicate) throw new Error(`Unsupported state: ${state}`)
        await this._waitState(predicate, options.timeout, `waiting for "${this.selector}" to be ${state}`)
    }

    async click(options = {}) {
        await this._prepare(options, ready, 'clicking')
        await this._clickNow(options)
    }

    async dblclick(options = {}) {
        await this._prepare(options, ready, 'double clicking')
        await this._clickNow({ ...options, clickCount: 2 })
    }

    async hover(options = {}) {
        await this._prepare(options, visible, 'hovering')
        const box = await this._reveal()
        await withModifiers(this.page.keyboard, options.modifiers, () => this.page.mouse.move(box.x, box.y))
    }

    async fill(value, options = {}) {
        await this._prepare(options, editable, 'filling')
        await this._focus(true)
        if (value === '') await this.page.keyboard.press('Backspace')
        else await this.page.keyboard.insertText(String(value))
    }

    async type(text, options = {}) {
        await this._prepare(options, ready, 'typing into')
        await this._focus(false)
        await this.page.keyboard.type(text, { delay: options.delay })
    }

    async press(key, options = {}) {
        await this._prepare(options, ready, 'pressing a key on')
        await this._focus(false)
        await this.page.keyboard.press(key, { delay: options.delay })
    }

    async focus(options = {}) {
        await this._waitState((state) => state.attached, options.timeout, `focusing "${this.selector}"`)
        await this._focus(false)
    }

    async setChecked(checked, options = {}) {
        await this._prepare(options, ready, 'checking')
        const before = await this.page._dom('state', this.selector)
        if (before.checked === checked) return
        await this._clickNow(options)
        const after = await this.page._dom('state', this.selector)
        if (after.checked !== checked) throw new Error(`Clicking did not change the checked state of "${this.selector}"`)
    }

    check(options) {
        return this.setChecked(true, options)
    }

    uncheck(options) {
        return this.setChecked(false, options)
    }

    async selectOption(values, options = {}) {
        await this._prepare(options, ready, 'selecting an option in')
        const list = (Array.isArray(values) ? values : [values]).map((value) => (typeof value === 'string' ? value : value.value ?? value.label))
        return this.page._dom('select', this.selector, list)
    }

    textContent(options = {}) {
        return this._read({ kind: 'textContent' }, options)
    }

    innerText(options = {}) {
        return this._read({ kind: 'innerText' }, options)
    }

    innerHTML(options = {}) {
        return this._read({ kind: 'innerHTML' }, options)
    }

    inputValue(options = {}) {
        return this._read({ kind: 'value' }, options)
    }

    getAttribute(name, options = {}) {
        return this._read({ kind: 'attr', name }, options)
    }

    async isVisible() {
        return visible(await this.page._dom('state', this.selector))
    }

    async isHidden() {
        return !(await this.isVisible())
    }

    async isEnabled() {
        const state = await this.page._dom('state', this.selector)
        return state.attached && state.enabled === true
    }

    async isDisabled() {
        return !(await this.isEnabled())
    }

    async isChecked() {
        const state = await this.page._dom('state', this.selector)
        return state.attached && state.checked === true
    }

    async isEditable() {
        const state = await this.page._dom('state', this.selector)
        return state.attached && state.editable === true
    }

    async screenshot(options = {}) {
        await this._prepare(options, visible, 'taking a screenshot of')
        const box = await this._reveal()
        return this.page.screenshot({ ...options, clip: { x: box.left, y: box.top, width: box.width, height: box.height } })
    }

    evaluate(pageFunction, arg) {
        return this.page.$eval(this.selector, pageFunction, arg)
    }

    evaluateAll(pageFunction, arg) {
        return this.page.$$eval(this.selector, pageFunction, arg)
    }

    async _waitState(predicate, timeout, label) {
        return poll(
            async () => {
                const state = await this.page._dom('state', this.selector)
                return predicate(state) ? state : null
            },
            { timeout: this.page._timeoutFor(timeout), label }
        )
    }

    async _prepare(options, predicate, action) {
        if (!options.force) await this._waitState(predicate, options.timeout, `${action} "${this.selector}"`)
    }

    async _reveal() {
        const box = await this.page._dom('reveal', this.selector)
        if (!box) throw new Error(`Element not found: "${this.selector}"`)
        return box
    }

    async _focus(select) {
        const focused = await this.page._dom('focus', this.selector, { select })
        if (!focused) throw new Error(`Element not found: "${this.selector}"`)
    }

    async _clickNow(options) {
        const box = await this._reveal()
        const x = options.position ? box.left + options.position.x : box.x
        const y = options.position ? box.top + options.position.y : box.y
        await withModifiers(this.page.keyboard, options.modifiers, () =>
            this.page.mouse.click(x, y, {
                button: options.button,
                clickCount: options.clickCount,
                delay: options.delay
            })
        )
    }

    async _read(arg, options) {
        await this._waitState((state) => state.attached, options.timeout, `reading "${this.selector}"`)
        return this.page._dom('text', this.selector, arg)
    }
}
