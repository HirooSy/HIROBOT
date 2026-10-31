import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { EventEmitter } from 'node:events'
import { BrowserContext, normalizeContextOptions } from './context.js'
import { Page } from './page.js'
import { noop, sleep } from './util.js'

const live = new Set()
let exitHookInstalled = false

const installExitHook = () => {
    if (exitHookInstalled) return
    exitHookInstalled = true
    process.once('exit', () => {
        for (const browser of [...live]) browser._killSync()
    })
}

export class Browser extends EventEmitter {
    constructor({ child, connection, profileDir, ownsProfile }) {
        super()
        this._child = child
        this.connection = connection
        this._profileDir = profileDir
        this._ownsProfile = ownsProfile
        this._contexts = new Map()
        this._pages = new Map()
        this._pendingPages = new Map()
        this._connected = true
        this._closing = null
        this._version = ''
        child.on('error', noop)
        child.once('exit', () => this._onExit())
        connection.on('event', (method, params) => this._onEvent(method, params))
        live.add(this)
        installExitHook()
    }

    version() {
        return this._version
    }

    isConnected() {
        return this._connected
    }

    contexts() {
        return [...this._contexts.values()]
    }

    async newContext(options = {}) {
        this._assertConnected()
        const normalized = normalizeContextOptions(options)
        const { browserContextId } = await this.connection.send('Target.createBrowserContext', {
            disposeOnDetach: true,
            proxyServer: normalized.proxy?.server,
            proxyBypassList: normalized.proxy?.bypass
        })
        const context = new BrowserContext(this, browserContextId, normalized)
        this._contexts.set(browserContextId, context)
        try {
            await context._setup()
        } catch (error) {
            await context.close().catch(noop)
            throw error
        }
        return context
    }

    async newPage(options = {}) {
        const context = await this.newContext(options)
        context._implicit = true
        try {
            return await context.newPage()
        } catch (error) {
            await context.close().catch(noop)
            throw error
        }
    }

    close() {
        if (!this._closing) this._closing = this._shutdown()
        return this._closing
    }

    attachPage(targetId, context) {
        let pending = this._pendingPages.get(targetId)
        if (!pending) {
            pending = this._createPage(targetId, context)
            this._pendingPages.set(targetId, pending)
            pending.catch(() => this._pendingPages.delete(targetId))
        }
        return pending
    }

    _removePage(page) {
        this._pages.delete(page._targetId)
        this._pendingPages.delete(page._targetId)
        this.connection.removeSession(page._session.id)
    }

    _killSync() {
        live.delete(this)
        try {
            this._child.kill('SIGKILL')
        } catch {}
        if (this._ownsProfile) {
            try {
                fs.rmSync(this._profileDir, { recursive: true, force: true })
            } catch {}
        }
    }

    async _setup() {
        await this.connection.send('Target.setDiscoverTargets', { discover: true })
        await this.connection.send('Browser.setDownloadBehavior', { behavior: 'deny' }).catch(noop)
    }

    async _createPage(targetId, context) {
        const { sessionId } = await this.connection.send('Target.attachToTarget', { targetId, flatten: true })
        const session = this.connection.createSession(sessionId)
        const page = new Page(this, context, targetId, session)
        this._pages.set(targetId, page)
        try {
            await page._init()
        } catch (error) {
            this._pages.delete(targetId)
            this.connection.removeSession(sessionId)
            throw error
        }
        context._attachPage(page)
        return page
    }

    _onEvent(method, params) {
        if (method === 'Target.targetCreated') this._onTargetCreated(params.targetInfo)
        else if (method === 'Target.targetDestroyed') this._pages.get(params.targetId)?._markClosed()
    }

    _onTargetCreated(info) {
        if (info.type !== 'page') return
        if (this._pages.has(info.targetId) || this._pendingPages.has(info.targetId)) return
        const context = this._contexts.get(info.browserContextId)
        if (!context || context._closed) {
            this.connection.send('Target.closeTarget', { targetId: info.targetId }).catch(noop)
            return
        }
        this.attachPage(info.targetId, context).catch(noop)
    }

    _onExit() {
        this._connected = false
        live.delete(this)
        this.connection.close()
        for (const context of this._contexts.values()) context._closed = true
        for (const page of [...this._pages.values()]) page._markClosed()
        for (const context of [...this._contexts.values()]) context._markClosed()
        this._contexts.clear()
        this._removeProfile().catch(noop)
        this.emit('disconnected')
    }

    async _shutdown() {
        if (this._connected) this.connection.send('Browser.close').catch(noop)
        if (!this._hasExited()) await Promise.race([this._exited(), sleep(5000)])
        if (!this._hasExited()) this._killSync()
        await this._exited()
        await this._removeProfile()
    }

    _hasExited() {
        return this._child.exitCode !== null || this._child.signalCode !== null
    }

    _exited() {
        return new Promise((resolve) => {
            if (this._hasExited()) resolve()
            else this._child.once('exit', resolve)
        })
    }

    async _removeProfile() {
        if (this._ownsProfile) await fsp.rm(this._profileDir, { recursive: true, force: true }).catch(noop)
    }

    _assertConnected() {
        if (!this._connected) throw new Error('Browser has been closed')
    }
}
