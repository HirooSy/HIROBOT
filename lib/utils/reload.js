import fs from 'fs'
import { join, relative, resolve } from 'path'
import chalk from './color.js'
import Helper from './helper.js'
import Connection from './connection.js'
import {
    pluginFolder,
    pluginFolders,
    pluginFilter,
    loadPluginFiles,
    deletePluginFolder,
    reload as reloadPlugin
} from './plugins.js'

const __dirname = Helper.__dirname(import.meta)
const libDir = Helper.__dirname(join(__dirname, '../'))

const DEBOUNCE_MS = 300
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'data', '.cache'])
const SKIP_LIB_FILES = new Set(['start.js'])

let started = false
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
    }, DEBOUNCE_MS))
}

function collectLibDirs(dir, results = []) {
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

async function reimportLibFile(file, rel) {
    const mod = await Helper.importFile(file)

    if (rel === 'utils/simple.js') {
        const { protoType, serialize, HelperConnection } = mod
        if (typeof protoType === 'function') protoType()
        if (typeof serialize === 'function') serialize()
        const conn = await Connection.conn
        if (conn && typeof HelperConnection === 'function') {
            HelperConnection(conn, { store: Connection.store, logger: conn.logger })
        }
    }

    if (rel === 'utils/plugins.js') {
        await mod.loadPluginFiles(pluginFolder, pluginFilter, { recursiveRead: true }).catch(console.error)
    }

    if (Connection.reload) await Connection.reload(await Connection.conn)

    return mod
}

function handleLibEvent(absFile) {
    const rel = 'lib/' + relative(libDir, absFile).replace(/\\/g, '/')
    if (SKIP_LIB_FILES.has(relative(libDir, absFile))) return

    const exists = fs.existsSync(absFile)
    const wasKnown = knownLibFiles.has(absFile)

    if (!exists) {
        knownLibFiles.delete(absFile)
        if (wasKnown) log('delete', rel)
        return
    }

    reimportLibFile(absFile, relative(libDir, absFile).replace(/\\/g, '/'))
        .then(() => {
            log(wasKnown ? 'edit' : 'add', rel)
            knownLibFiles.add(absFile)
        })
        .catch(e => console.error(chalk.red(`Reload Failed — [${rel}]:`), e.message))
}

function watchLibDir(dir) {
    const resolved = resolve(dir)
    if (libWatchers.has(resolved)) return

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

async function startReloadSystem(opts = {}) {
    if (started) return
    started = true

    await loadPluginFiles(pluginFolder, pluginFilter, { logger: opts.logger, recursiveRead: true }).catch(console.error)
    for (const folder of pluginFolders) watchPluginDir(folder)

    watchLibTree()
}

export {
    startReloadSystem
}
