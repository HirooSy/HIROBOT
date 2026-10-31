import { EventEmitter } from 'node:events'
import { ProtocolError } from './errors.js'

class Session extends EventEmitter {
    constructor(connection, id) {
        super()
        this.connection = connection
        this.id = id
    }

    send(method, params = {}) {
        return this.connection.send(method, params, this.id)
    }
}

export class Connection extends EventEmitter {
    constructor(writable, readable) {
        super()
        this.writable = writable
        this.sessions = new Map()
        this.callbacks = new Map()
        this.lastId = 0
        this.pending = []
        this.closed = false
        writable.on('error', () => this.close())
        readable.on('error', () => this.close())
        readable.on('close', () => this.close())
        readable.on('data', (chunk) => this._receive(chunk))
    }

    createSession(id) {
        const session = new Session(this, id)
        this.sessions.set(id, session)
        return session
    }

    removeSession(id) {
        this.sessions.delete(id)
    }

    send(method, params = {}, sessionId) {
        if (this.closed) return Promise.reject(new ProtocolError(method, 'browser has been closed'))
        const id = ++this.lastId
        const message = sessionId === undefined ? { id, method, params } : { id, method, params, sessionId }
        return new Promise((resolve, reject) => {
            this.callbacks.set(id, { resolve, reject, method })
            this.writable.write(`${JSON.stringify(message)}\0`)
        })
    }

    close() {
        if (this.closed) return
        this.closed = true
        const callbacks = [...this.callbacks.values()]
        this.callbacks.clear()
        for (const callback of callbacks) callback.reject(new ProtocolError(callback.method, 'browser has been closed'))
        this.sessions.clear()
        this.emit('close')
    }

    _receive(chunk) {
        let start = 0
        let end = chunk.indexOf(0, start)
        while (end !== -1) {
            this.pending.push(chunk.subarray(start, end))
            const raw = this.pending.length === 1 ? this.pending[0] : Buffer.concat(this.pending)
            this.pending = []
            this._dispatch(raw)
            start = end + 1
            end = chunk.indexOf(0, start)
        }
        if (start < chunk.length) this.pending.push(chunk.subarray(start))
    }

    _dispatch(raw) {
        let message
        try {
            message = JSON.parse(raw.toString('utf8'))
        } catch {
            return
        }
        if (message.id !== undefined) {
            const callback = this.callbacks.get(message.id)
            if (!callback) return
            this.callbacks.delete(message.id)
            if (message.error) callback.reject(new ProtocolError(callback.method, message.error.message))
            else callback.resolve(message.result)
            return
        }
        if (message.sessionId === undefined) this.emit('event', message.method, message.params)
        else this.sessions.get(message.sessionId)?.emit('event', message.method, message.params)
    }
}
