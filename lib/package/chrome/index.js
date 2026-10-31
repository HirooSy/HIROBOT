import { launch, resolveExecutable } from './launcher.js'
import { ProtocolError, TimeoutError } from './errors.js'
export { ProtocolError, TimeoutError }
export { STEALTH_SOURCE } from './stealth.js'
export { solveChallenge } from './challenge.js'
export { RecaptchaSolver } from './recaptcha.js'

export const chromium = Object.freeze({
    name: 'chromium',
    launch,
    executablePath: (options) => resolveExecutable(options)
})

export const errors = Object.freeze({ ProtocolError, TimeoutError })

export default chromium
