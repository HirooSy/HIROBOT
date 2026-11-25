import fs from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import chalk from './color.js'
import Helper from './helper.js'
import scraper from '../scrapers/index.js'
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
const configFile = resolve(libDir, '..', 'config.js')
async function readConfigFile() {
    const { default: config } = await import(`${pathToFileURL(configFile).href}?v=${Date.now()}`)
    if (!config || typeof config !== 'object') throw new Error('config.js must export default an object')
    return config
}
const scraperSrcDir = resolve(libDir, 'scrapers', 'src')
const isScraperSrc = p => p === scraperSrcDir || p.startsWith(scraperSrcDir + sep)
const excludedDirs = new Set(['node_modules', '.git', 'data', '.cache'])
const ignoredName = name => name.startsWith('.') || name.endsWith('~') || /\.(swp|swx|tmp)$/.test(name)

let started = false
let restartTimer = null
let restartRequested = false
const timers = new Map()
const libWatchers = new Map()
const pluginWatchers = new Map()
const knownLibFiles = new Set()
const libState = new Map()

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
    }, 300))
}

function restartBot() {
    if (typeof process.send !== 'function' || !process.connected) {
        console.log(chalk.yellow('Reload') + ' — restart the bot to apply the changes')
        return
    }
    restartRequested = true
    console.log(chalk.yellow('Reload') + ' — restarting the bot to apply the changes')
    process.send('reset')
}

function scheduleRestart() {
    if (restartRequested) return
    clearTimeout(restartTimer)
    restartTimer = setTimeout(restartBot, 1500)
}

function collectLibDirs(dir, results = []) {
    if (isScraperSrc(resolve(dir))) return results
    results.push(resolve(dir))
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !excludedDirs.has(entry.name)) {
            collectLibDirs(join(dir, entry.name), results)
        }
    }
    return results
}

function collectLibFiles(dir, results = []) {
    if (isScraperSrc(resolve(dir))) return results
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (!excludedDirs.has(entry.name)) collectLibFiles(join(dir, entry.name), results)
        } else if (entry.isFile() && !ignoredName(entry.name)) {
            results.push(resolve(join(dir, entry.name)))
        }
    }
    return results
}

function configPathPattern(path) {
    const segments = path.split('.').map(escapeRegExp)
    const chain = segments.map((_, i) => segments.slice(0, i + 1).join('\\??\\.'))
    const ancestors = chain.slice(0, -1).map(prefix => `${prefix}(?![\\w.?])`)
    const leaf = `${chain[chain.length - 1]}(?!\\w)`
    return new RegExp(`global\\.config\\??\\.(?:${[...ancestors, leaf].join('|')})`)
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function changedConfigPaths(previous, next, base = []) {
    if (JSON.stringify(previous) === JSON.stringify(next)) return []
    if (isPlainObject(previous) && isPlainObject(next)) {
        return [...new Set([...Object.keys(previous), ...Object.keys(next)])]
            .flatMap(key => changedConfigPaths(previous[key], next[key], [...base, key]))
    }
    return base.length ? [base.join('.')] : []
}

function onConfigPathChanged(path) {
    const pattern = configPathPattern(path)
    reloadPluginsMatching(pattern)
    if (path === 'owner') global.syncDeveloperBadges?.()
    if (path === 'owner' || path === 'mods') return
    if (readSourceFiles(libDir).some(file => {
        try { return pattern.test(fs.readFileSync(file, 'utf8')) } catch { return false }
    })) {
        console.log(chalk.yellow('Config') + ` — ${path} is read by lib/, restarting the bot to apply`)
        scheduleRestart()
    }
}

async function reloadConfig() {
    let next
    try {
        next = await readConfigFile()
    } catch (e) {
        console.error(chalk.red('Reload') + ' — config.js failed to load, previous settings kept:', e?.message || e)
        return
    }
    const previous = global.config
    const changed = changedConfigPaths(previous, next)
    global.config = next
    if (!changed.length) {
        console.log(chalk.green('Reload') + ' — config.js reloaded, no setting changed')
        return
    }
    for (const path of changed) {
        console.log(chalk.green('Config') + ` — ${path} updated`)
        onConfigPathChanged(path)
    }
}

function handleLibEvent(absFile) {
    const relPath = relative(libDir, absFile).replace(/\\/g, '/')
    const rel = 'lib/' + relPath
    const exists = fs.existsSync(absFile)
    const wasKnown = knownLibFiles.has(absFile)

    if (!exists) {
        if (!wasKnown) return
        knownLibFiles.delete(absFile)
        log('delete', rel)
    } else {
        knownLibFiles.add(absFile)
        log(wasKnown ? 'edit' : 'add', rel)
    }

    if (relPath === 'start.js') {
        console.log(chalk.yellow('Reload') + ' — lib/start.js is the process supervisor, restart it from the panel to apply')
        return
    }
    scheduleRestart()
}

function watchLibDir(dir) {
    const resolved = resolve(dir)
    if (isScraperSrc(resolved) || libWatchers.has(resolved)) return

    const watcher = fs.watch(resolved, (_ev, filename) => {
        if (!filename || ignoredName(filename)) return
        const absFile = resolve(join(resolved, filename))

        if (!fs.existsSync(absFile)) {
            for (const f of knownLibFiles) {
                if (f === absFile || f.startsWith(absFile + sep)) debounce(f, () => handleLibEvent(f))
            }
            return
        }

        if (fs.statSync(absFile).isDirectory()) {
            if (!excludedDirs.has(filename)) {
                watchLibDir(absFile)
                for (const f of collectLibFiles(absFile)) debounce(f, () => handleLibEvent(f))
            }
            return
        }

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
        const abs = resolve(libDir, '..', key.split('#')[0])
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
            if (!excludedDirs.has(entry.name)) readSourceFiles(full, results)
        } else if (entry.isFile() && /\.(mc)?js$/.test(entry.name)) {
            results.push(full)
        }
    }
    return results
}

function watchConfigFile() {
    fs.watch(dirname(configFile), (_ev, filename) => {
        if (filename !== basename(configFile)) return
        debounce(configFile, reloadConfig)
    })
}

function fileStamp(file) {
    try {
        const st = fs.statSync(file)
        return `${st.mtimeMs}:${st.size}`
    } catch {
        return null
    }
}

async function startReloadSystem(opts = {}) {
    if (started) return
    started = true

    watchLibTree()
    for (const file of collectLibFiles(libDir)) {
        if (libState.get(file) !== fileStamp(file)) handleLibEvent(file)
    }
    watchConfigFile()

    if (opts.plugins !== false) {
        await loadPluginFiles(pluginFolder, pluginFilter, { logger: opts.logger, recursiveRead: true }).catch(console.error)
        for (const folder of pluginFolders) watchPluginDir(folder)

        scraper.events.on('update', reloadScraperDependents)
    }
}

for (const file of collectLibFiles(libDir)) libState.set(file, fileStamp(file))

export {
    startReloadSystem
}
