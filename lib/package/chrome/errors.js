export class TimeoutError extends Error {
    constructor(message) {
        super(message)
        this.name = 'TimeoutError'
    }
}

export class ProtocolError extends Error {
    constructor(method, message) {
        super(`${method} failed: ${message}`)
        this.name = 'ProtocolError'
        this.method = method
    }
}
