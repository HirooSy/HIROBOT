import fs from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { spawnSync } from 'child_process'
import { parseEnv } from 'util'
import chalk from './color.js'
import Helper from './helper.js'
import scraper from '../scrapers/index.js'
import { refreshOwnersAndMods } from '../config.js'
import {
    pluginFolder,
    pluginFolders,
    pluginFilter,
    plugins,
    loadPluginFiles,
    deletePluginFolder,
    reload as reloadPlugin
} from './plugins.js'

const __dirname = Helper.__dirname(import.meta)
const libDir = Helper.__dirname(join(__dirname, '../'))
const SCRAPER_SRC_DIR = resolve(libDir, 'scrapers', 'src')
const isScraperSrc = p => p === SCRAPER_SRC_DIR || p.startsWith(SCRAPER_SRC_DIR + sep)
const ENV_FILE = resolve(libDir, '..', '.env')
const ENV_ROOT = dirname(ENV_FILE)

const DEBOUNCE_MS = 300
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'data', '.cache'])
const SKIP_LIB_FILES = new Set(['start.js'])
const TOOLS_DIR = resolve(libDir, 'package', 'ai', 'tools')
const RESTART_DEBOUNCE_MS = 1500

let started = false
const timers = new Map()
const libWatchers = new Map()
const pluginWatchers = new Map()
const knownLibFiles = new Set()
let envSnapshot = {}

function log(kind, relPath) {
    const label =
        kind === 'add' ? chalk.cyanBright('Add') :
        kind === 'edit' ? chalk.green('Edit') :
        chalk.red('Delete')
    console.log(`${label} — ${chalk.white(relPath)}`)
}

function debounce(absPath, fn) {
    if (timers.has(absPath)) clearTimeout(timers.get(absPath))
    timers.set(absPath, setTimeout(() => {
        timers.delete(absPath)
        fn()
    }, DEBOUNCE_MS))
}

function collectLibDirs(dir, results = []) {
    if (isScraperSrc(resolve(dir))) return results
    results.push(resolve(dir))
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.isDirectory() && !EXCLUDED_DIRS.has(entry.name)) {
            collectLibDirs(join(dir, entry.name), results)
        }
    }
    return results
}

function collectLibFiles(dir, results = []) {
    if (isScraperSrc(resolve(dir))) return results
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRS.has(entry.name)) collectLibFiles(join(dir, entry.name), results)
        } else if (entry.isFile() && /\.(mc)?js$/.test(entry.name)) {
            results.push(resolve(join(dir, entry.name)))
        }
    }
    return results
}

const pendingRestartFiles = new Set()
let restartTimer = null

function checkLibSyntax(absFile) {
    const res = spawnSync(process.execPath, ['--check', absFile], { encoding: 'utf8' })
    if (res.status === 0) return true
    console.error(chalk.red('Reload') + chalk.gray(` syntax error in ${relative(libDir, absFile)}, restart skipped`))
    if (res.stderr) console.error(res.stderr.trim())
    return false
}

async function restartForLibChanges() {
    restartTimer = null
    const files = [...pendingRestartFiles]
    pendingRestartFiles.clear()
    if (!files.length) return

    const names = files.map(f => relative(libDir, f).replace(/\\/g, '/'))
    if (!files.every(f => !fs.existsSync(f) || checkLibSyntax(f))) return

    console.log(chalk.yellow('Reload') + ` — restarting to apply: lib/${names.join(', lib/')}`)
    try {
        if (global.db?.data) await global.db.write()
    } catch (e) {
        console.error(chalk.red('Reload'), 'db.write failed before restart:', e?.message || e)
    }
    if (typeof process.send === 'function') process.send('reset')
    else console.log(chalk.yellow('Reload') + ' — not running under start.js, restart the bot manually to apply lib changes')
}

function requestLibRestart(absFile) {
    pendingRestartFiles.add(absFile)
    if (restartTimer) clearTimeout(restartTimer)
    restartTimer = setTimeout(restartForLibChanges, RESTART_DEBOUNCE_MS)
}

function handleLibEvent(absFile) {
    const rel = 'lib/' + relative(libDir, absFile).replace(/\\/g, '/')
    if (SKIP_LIB_FILES.has(relative(libDir, absFile))) return
    if (isScraperSrc(absFile)) return
    if (absFile === TOOLS_DIR || absFile.startsWith(TOOLS_DIR + sep)) return

    const exists = fs.existsSync(absFile)
    const wasKnown = knownLibFiles.has(absFile)

    if (!exists) {
        knownLibFiles.delete(absFile)
        if (wasKnown) {
            log('delete', rel)
            requestLibRestart(absFile)
        }
        return
    }

    knownLibFiles.add(absFile)
    log(wasKnown ? 'edit' : 'add', rel)
    requestLibRestart(absFile)
}

function watchLibDir(dir) {
    const resolved = resolve(dir)
    if (isScraperSrc(resolved) || libWatchers.has(resolved)) return

    const watcher = fs.watch(resolved, (_ev, filename) => {
        if (!filename) return
        const absFile = resolve(join(resolved, filename))

        if (fs.existsSync(absFile) && fs.statSync(absFile).isDirectory()) {
            if (!EXCLUDED_DIRS.has(filename)) {
                watchLibDir(absFile)
                for (const f of collectLibFiles(absFile)) debounce(f, () => handleLibEvent(f))
            }
            return
        }

        if (!/\.(mc)?js$/.test(filename)) return
        debounce(absFile, () => handleLibEvent(absFile))
    })
    watcher.on('close', () => libWatchers.delete(resolved))
    libWatchers.set(resolved, watcher)
}

function watchLibTree() {
    for (const file of collectLibFiles(libDir)) knownLibFiles.add(file)
    for (const dir of collectLibDirs(libDir)) watchLibDir(dir)
}

function watchPluginDir(dir) {
    const resolved = resolve(dir)
    if (pluginWatchers.has(resolved)) return

    const watcher = fs.watch(resolved, (ev, filename) => {
        if (!filename) return
        const absPath = resolve(join(resolved, filename))

        if (fs.existsSync(absPath) && fs.statSync(absPath).isDirectory()) {
            if (!pluginWatchers.has(absPath)) {
                loadPluginFiles(absPath, pluginFilter, { recursiveRead: true })
                    .then(() => watchPluginTreeFrom(absPath))
                    .catch(console.error)
            }
            return
        }

        debounce(absPath, () => {
            reloadPlugin({ pluginFolder: resolved, pluginFilter }, ev, filename)
                .catch(e => console.log(e, `error while reloading '${filename}'`))
        })
    })
    watcher.on('close', () => {
        pluginWatchers.delete(resolved)
        deletePluginFolder(resolved)
    })
    pluginWatchers.set(resolved, watcher)
}

function watchPluginTreeFrom(dir) {
    watchPluginDir(dir)
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) watchPluginTreeFrom(join(dir, entry.name))
    }
}

function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')
}

function reloadPluginsMatching(pattern) {
    for (const key of Object.keys(plugins)) {
        const abs = resolve(libDir, '..', key)
        let src
        try { src = fs.readFileSync(abs, 'utf8') } catch { continue }
        if (!pattern.test(src)) continue
        reloadPlugin({ pluginFolder: dirname(abs), pluginFilter }, 'change', basename(abs))
            .catch(e => console.log(e, `error while reloading '${key}'`))
    }
}

function reloadScraperDependents(name) {
    const esc = escapeRegExp(name)
    reloadPluginsMatching(new RegExp(`global\\.scraper(?:\\.${esc}\\b|\\[\\s*['"]${esc}['"]\\s*\\])`))
}

function readSourceFiles(dir, results = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (!EXCLUDED_DIRS.has(entry.name)) readSourceFiles(full, results)
        } else if (entry.isFile() && /\.(mc)?js$/.test(entry.name)) {
            results.push(full)
        }
    }
    return results
}

function envPattern(key) {
    const esc = escapeRegExp(key)
    return new RegExp(`process\\.env(?:\\.${esc}\\b|\\[\\s*['"]${esc}['"]\\s*\\])`)
}

function readEnvFile() {
    try {
        return parseEnv(fs.readFileSync(ENV_FILE, 'utf8'))
    } catch {
        return null
    }
}

function onEnvKeyChanged(key) {
    const isOwnerKey = key === 'OWNER' || key === 'MODERATOR'
    if (isOwnerKey) refreshOwnersAndMods()

    const pattern = envPattern(key)
    reloadPluginsMatching(pattern)
    if (isOwnerKey) return

    const usedInLib = readSourceFiles(libDir).some(file => {
        try { return pattern.test(fs.readFileSync(file, 'utf8')) } catch { return false }
    })
    if (usedInLib) {
        console.log(chalk.yellow('Env') + ` — ${key} changed; lib/ modules read it at startup, restart if it does not apply`)
    }
}

function applyEnvChange() {
    const next = readEnvFile()
    if (!next) return

    const prev = envSnapshot
    envSnapshot = next

    const changed = [...new Set([...Object.keys(prev), ...Object.keys(next)])]
        .filter(key => prev[key] !== next[key])
    if (!changed.length) return

    for (const key of changed) {
        if (next[key] === undefined) delete process.env[key]
        else process.env[key] = next[key]
    }

    console.log(chalk.green('Env') + ` — ${changed.join(', ')}`)
    for (const key of changed) onEnvKeyChanged(key)
}

function watchEnvFile() {
    fs.watch(ENV_ROOT, (_ev, filename) => {
        if (filename !== '.env') return
        debounce(ENV_FILE, applyEnvChange)
    })
}

async function startReloadSystem(opts = {}) {
    if (started) return
    started = true

    await loadPluginFiles(pluginFolder, pluginFilter, { logger: opts.logger, recursiveRead: true }).catch(console.error)
    for (const folder of pluginFolders) watchPluginDir(folder)

    scraper.events.on('update', reloadScraperDependents)

    envSnapshot = readEnvFile() || {}
    watchEnvFile()

    watchLibTree()
}

export {
    startReloadSystem
}
