const describe = (arg) => {
    if ('value' in arg) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value)
    return arg.unserializableValue ?? arg.description ?? arg.type
}

export class ConsoleMessage {
    constructor(params) {
        this._type = params.type
        this._text = (params.args || []).map(describe).join(' ')
        const frame = params.stackTrace?.callFrames?.[0]
        this._location = {
            url: frame?.url ?? '',
            lineNumber: frame?.lineNumber ?? 0,
            columnNumber: frame?.columnNumber ?? 0
        }
    }

    type() {
        return this._type
    }

    text() {
        return this._text
    }

    location() {
        return { ...this._location }
    }
}

export const exceptionToError = (details) => {
    const description = String(details.exception?.description || details.text || 'Uncaught exception')
    const head = description.split('\n')[0]
    const match = /^(\w+): ([\s\S]*)$/.exec(head)
    const error = new Error(match ? match[2] : head)
    error.name = match ? match[1] : 'Error'
    error.stack = description
    return error
}
