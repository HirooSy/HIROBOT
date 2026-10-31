import { spawn } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Browser } from './browser.js'
import { TimeoutError } from './errors.js'
import { Connection } from './transport.js'
import { DEFAULT_TIMEOUT } from './util.js'
import { createEngineChild } from './engine/pipe.js'

const LEAN_FLAGS = [
    '--aggressive-cache-discard',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-breakpad',
    '--disable-client-side-phishing-detection',
    '--disable-component-update',
    '--disable-default-apps',
    '--disable-dev-shm-usage',
    '--disable-domain-reliability',
    '--disable-extensions',
    '--disable-features=Translate,BackForwardCache,MediaRouter,DialMediaRouteProvider,OptimizationHints,AcceptCHFrame,InterestFeedContentSuggestions,CalculateNativeWinOcclusion',
    '--disable-hang-monitor',
    '--disable-infobars',
    '--disable-ipc-flooding-protection',
    '--disable-popup-blocking',
    '--disable-prompt-on-repost',
    '--disable-renderer-backgrounding',
    '--disable-search-engine-choice-screen',
    '--disable-sync',
    '--disable-translate',
    '--disk-cache-size=1048576',
    '--enable-unsafe-swiftshader',
    '--force-color-profile=srgb',
    '--metrics-recording-only',
    '--no-default-browser-check',
    '--no-first-run',
    '--no-service-autorun',
    '--no-startup-window',
    '--password-store=basic',
    '--use-mock-keychain'
]

const HEADLESS_FLAGS = [
    '--headless',
    '--hide-scrollbars',
    '--mute-audio',
    '--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'
]

const RELATIVE_PATHS = {
    linux: {
        headless: ['chrome-headless-shell-linux64/chrome-headless-shell'],
        full: ['chrome-linux64/chrome', 'chrome-linux/chrome']
    },
    darwin: {
        headless: ['chrome-headless-shell-mac-arm64/chrome-headless-shell', 'chrome-headless-shell-mac-x64/chrome-headless-shell'],
        full: [
            'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'chrome-mac/Chromium.app/Contents/MacOS/Chromium'
        ]
    },
    win32: {
        headless: ['chrome-headless-shell-win64/chrome-headless-shell.exe'],
        full: ['chrome-win64/chrome.exe', 'chrome-win/chrome.exe']
    }
}

const systemPaths = () => {
    if (process.platform === 'darwin') {
        return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium']
    }
    if (process.platform === 'win32') {
        const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files'
        const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'
        return [
            path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe')
        ]
    }
    return ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']
}

const cacheRoot = () => {
    if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
    if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright')
    if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright')
    return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'ms-playwright')
}

const isExecutable = (file) => {
    try {
        if (!fs.statSync(file).isFile()) return false
        fs.accessSync(file, fs.constants.X_OK)
        return true
    } catch {
        return false
    }
}

const listBuilds = (root, prefix) => {
    let entries
    try {
        entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
        return []
    }
    return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
        .map((entry) => ({ dir: path.join(root, entry.name), version: Number.parseInt(entry.name.slice(prefix.length + 1), 10) || 0 }))
        .sort((left, right) => right.version - left.version)
        .map((entry) => entry.dir)
}

const isRoot = () => typeof process.getuid === 'function' && process.getuid() === 0

const keepTail = (stream, limit = 4096) => {
    let text = ''
    stream.on('data', (chunk) => {
        text = (text + chunk.toString('utf8')).slice(-limit)
    })
    return () => text.trim()
}

const realPath = (file) => {
    try {
        return fs.realpathSync(file)
    } catch {
        return file
    }
}

export const resolveExecutable = (options = {}) => {
    if (options.executablePath) return realPath(options.executablePath)
    if (process.env.CHROMIUM_PATH && isExecutable(process.env.CHROMIUM_PATH)) return realPath(process.env.CHROMIUM_PATH)
    const platform = RELATIVE_PATHS[process.platform] ? process.platform : 'linux'
    const headless = options.headless !== false
    const root = cacheRoot()
    const candidates = []
    if (headless) {
        for (const build of listBuilds(root, 'chromium_headless_shell')) {
            for (const relative of RELATIVE_PATHS[platform].headless) candidates.push(path.join(build, relative))
        }
    }
    for (const build of listBuilds(root, 'chromium')) {
        for (const relative of RELATIVE_PATHS[platform].full) candidates.push(path.join(build, relative))
    }
    candidates.push(...systemPaths())
    const found = candidates.find(isExecutable)
    return found ? realPath(found) : null
}

const buildArgs = (options, profileDir, headless) => {
    const sandboxed = options.chromiumSandbox === true && !isRoot()
    const args = [...LEAN_FLAGS, `--user-data-dir=${profileDir}`, '--remote-debugging-pipe', '--window-size=1280,720']
    if (options.gpu !== true) args.push('--disable-gpu', '--in-process-gpu')
    if (!sandboxed) args.push('--no-sandbox', '--no-zygote')
    if (headless) args.push(...HEADLESS_FLAGS)
    if (options.ignoreHTTPSErrors === true) args.push('--ignore-certificate-errors')
    if (options.proxy && options.proxy.server) {
        args.push(`--proxy-server=${options.proxy.server}`)
        if (options.proxy.bypass) args.push(`--proxy-bypass-list=${options.proxy.bypass.split(',').map((item) => item.trim()).join(';')}`)
    }
    if (Array.isArray(options.args)) args.push(...options.args)
    return args
}

const waitForStart = (child, connection, timeout) =>
    new Promise((resolve, reject) => {
        let timer = null
        const settle = (error, value) => {
            clearTimeout(timer)
            child.removeListener('exit', onExit)
            child.removeListener('error', onError)
            if (error) reject(error)
            else resolve(value)
        }
        const onExit = (code, signal) => settle(new Error(`Chromium exited during launch (code ${code}, signal ${signal})`))
        const onError = (error) => settle(error)
        child.once('exit', onExit)
        child.once('error', onError)
        if (timeout > 0) timer = setTimeout(() => settle(new TimeoutError(`Timeout ${timeout}ms exceeded while launching Chromium`)), timeout)
        connection.send('Browser.getVersion').then((version) => settle(null, version), (error) => settle(new Error(`Chromium did not start: ${error.message}`)))
    })

const launchBinary = async (options = {}) => {
    const executable = resolveExecutable(options)
    if (!executable) {
        if (options.headless === false) {
            throw new Error('Headed Chromium (headless: false) needs a full Chromium build. Pass executablePath, set CHROMIUM_PATH, or install chromium into the Playwright browser cache.')
        }
        throw new Error('Chromium executable not found. Pass executablePath, set CHROMIUM_PATH, or install a build into the Playwright browser cache.')
    }
    if (!isExecutable(executable)) throw new Error(`Chromium executable is not accessible: ${executable}`)
    const headless = options.headless !== false
    const ownsProfile = options.userDataDir === undefined
    const profileDir = ownsProfile ? await fsp.mkdtemp(path.join(os.tmpdir(), 'hiro-chromium-')) : path.resolve(options.userDataDir)
    const child = spawn(executable, buildArgs(options, profileDir, headless), {
        stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
        env: options.env ? { ...process.env, ...options.env } : process.env,
        windowsHide: true
    })
    const readStderr = keepTail(child.stderr)
    const connection = new Connection(child.stdio[3], child.stdio[4])
    const browser = new Browser({ child, connection, profileDir, ownsProfile })
    try {
        const version = await waitForStart(child, connection, options.timeout ?? DEFAULT_TIMEOUT)
        browser._version = version.product
        await browser._setup()
    } catch (error) {
        browser._killSync()
        const tail = readStderr()
        if (tail) error.message = `${error.message}\n${tail}`
        throw error
    }
    return browser
}

const launchEngine = async (options = {}) => {
    const child = createEngineChild()
    const connection = new Connection(child.stdio[3], child.stdio[4])
    const browser = new Browser({ child, connection, profileDir: null, ownsProfile: false })
    try {
        const version = await waitForStart(child, connection, options.timeout ?? DEFAULT_TIMEOUT)
        browser._version = version.product
        await browser._setup()
    } catch (error) {
        browser._killSync()
        throw error
    }
    return browser
}

const usesBinary = (options) => options.backend === 'chromium' || (options.backend !== 'js' && Boolean(options.executablePath || process.env.CHROMIUM_PATH))

export const launch = async (options = {}) => (usesBinary(options) ? launchBinary(options) : launchEngine(options))
