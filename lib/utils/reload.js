import fs from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
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

function parseEnv(content) {
  const env = {}
  const lines = content.replace(/\r\n?/g, '\n').split('\n')
  for (let i = 0; i < lines.length; i++) {
    const match = /^\s*(?:export\s+)?([\w.-]+)\s*=\s*(.*)$/.exec(lines[i])
    if (!match) continue
    let value = match[2].trim()
    const quote = value[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      let body = value.slice(1)
      while (!body.includes(quote) && i + 1 < lines.length) body += '\n' + lines[++i]
      const end = body.indexOf(quote)
      value = end === -1 ? body : body.slice(0, end)
      if (quote === '"') value = value.replace(/\\n/g, '\n')
    } else {
      value = value.replace(/\s+#.*$/, '').trim()
    }
    env[match[1]] = value
  }
  return env
}

const __dirname = Helper.__dirname(import.meta)
const libDir = Helper.__dirname(join(__dirname, '../'))
const scraperSrcDir = resolve(libDir, 'scrapers', 'src')
const isScraperSrc = p => p === scraperSrcDir || p.startsWith(scraperSrcDir + sep)
const envFile = resolve(libDir, '..', '.env')
const configFile = resolve(libDir, 'config.js')
const excludedDirs = new Set(['node_modules', '.git', 'data', '.cache'])
const ignoredName = name => name.startsWith('.') || name.endsWith('~') || /\.(swp|swx|tmp)$/.test(name)

let started = false
let envSnapshot = {}
let restartTimer = null
let restartRequested = false
const timers = new Map()
const libWatchers = new Map()
const pluginWatchers = new Map()
const knownLibFiles = new Set()

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
    restartRequested = true
    if (typeof process.send !== 'function' || !process.connected) {
        console.log(chalk.yellow('Reload') + ' — restart the bot to apply the changes')
        return
    }
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

async function reloadConfig() {
    const previous = global.settings
    try {
        await import(`${pathToFileURL(configFile).href}?t=${Date.now()}`)
    } catch (e) {
        global.settings = previous
        console.error(chalk.red('Reload') + ' — config.js failed to load, previous settings kept:', e?.message || e)
        return
    }
    const next = global.settings
    const changed = Object.keys({ ...previous, ...next }).filter(key => JSON.stringify(previous[key]) !== JSON.stringify(next[key]))
    if (!changed.length) {
        console.log(chalk.green('Reload') + ' — config.js reloaded, no setting changed')
        return
    }
    for (const key of changed) console.log(chalk.green('Reload') + ` — settings.${key} updated`)
    if (changed.some(key => key === 'bot' || key === 'connection')) scheduleRestart()
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

    if (absFile === configFile && exists) {
        reloadConfig()
        return
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

function envPattern(key) {
    const esc = escapeRegExp(key)
    return new RegExp(`process\\.env(?:\\.${esc}\\b|\\[\\s*['"]${esc}['"]\\s*\\])`)
}

function readEnvFile() {
    try {
        return parseEnv(fs.readFileSync(envFile, 'utf8'))
    } catch {
        return null
    }
}

function onEnvKeyChanged(key) {
    const isOwnerKey = key === 'OWNER' || key === 'MODERATOR'
    if (isOwnerKey) refreshOwnersAndMods()
    if (isOwnerKey || key === 'DISCORD_OWNER') global.syncDeveloperBadges?.()

    const pattern = envPattern(key)
    reloadPluginsMatching(pattern)
    if (isOwnerKey) return

    if (readSourceFiles(libDir).some(file => {
        try { return pattern.test(fs.readFileSync(file, 'utf8')) } catch { return false }
    })) {
        console.log(chalk.yellow('Env') + ` — ${key} is read by lib/, restarting the bot to apply`)
        scheduleRestart()
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

    for (const key of changed) {
        console.log(chalk.green('Env') + ` — ${key}`)
        onEnvKeyChanged(key)
    }
}

function watchEnvFile() {
    fs.watch(dirname(envFile), (_ev, filename) => {
        if (filename !== '.env') return
        debounce(envFile, applyEnvChange)
    })
}

async function startReloadSystem(opts = {}) {
    if (started) return
    started = true

    if (opts.plugins !== false) {
        await loadPluginFiles(pluginFolder, pluginFilter, { logger: opts.logger, recursiveRead: true }).catch(console.error)
        for (const folder of pluginFolders) watchPluginDir(folder)

        scraper.events.on('update', reloadScraperDependents)
    }

    envSnapshot = readEnvFile() || {}
    watchEnvFile()

    watchLibTree()
}

export {
    startReloadSystem
}
