import { EventEmitter } from 'node:events'
import { EngineBrowser } from './cdp.js'

export class EngineChild extends EventEmitter {
    constructor() {
        super()
        this.exitCode = null
        this.signalCode = null
        this.pid = undefined
        this.stderr = new EventEmitter()
        this.readable = new EventEmitter()
        this.writable = new EventEmitter()
        this.writable.write = (chunk) => {
            this.receive(String(chunk))
            return true
        }
        this.writable.end = () => {}
        this.stdio = [null, null, null, this.writable, this.readable]
        this.buffer = ''
        this.browser = new EngineBrowser({
            send: (message) => this.transmit(message),
            onClose: () => this.exit(0, null)
        })
    }

    receive(text) {
        this.buffer += text
        for (let index = this.buffer.indexOf('\0'); index !== -1; index = this.buffer.indexOf('\0')) {
            const raw = this.buffer.slice(0, index)
            this.buffer = this.buffer.slice(index + 1)
            let message
            try {
                message = JSON.parse(raw)
            } catch {
                continue
            }
            setImmediate(() => {
                this.browser.handle(message)
            })
        }
    }

    transmit(message) {
        if (this.exitCode !== null || this.signalCode !== null) return
        const frame = Buffer.from(`${JSON.stringify(message)}\0`, 'utf8')
        setImmediate(() => this.readable.emit('data', frame))
    }

    kill() {
        this.exit(null, 'SIGKILL')
    }

    exit(code, signal) {
        if (this.exitCode !== null || this.signalCode !== null) return
        this.exitCode = code ?? (signal ? null : 0)
        this.signalCode = signal ?? null
        this.browser.closed = true
        setImmediate(() => {
            this.emit('exit', this.exitCode, this.signalCode)
            this.readable.emit('close')
        })
    }
}

export const createEngineChild = () => new EngineChild()
