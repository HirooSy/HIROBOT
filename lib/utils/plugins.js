import fs from 'fs'
import { join, resolve } from 'path'
import * as os from 'os'
import Helper from './helper.js'
import chalk from './color.js'

const __dirname = Helper.__dirname(import.meta)
const rootDirectory = Helper.__dirname(join(__dirname, '../../'))
const pluginFolder = Helper.__dirname(join(__dirname, '../../plugins'))
const pluginFilter = filename => /\.(mc)?js$/.test(filename)

let plugins = {},
    pluginFolders = []

async function loadPluginFiles(
    pluginFolder = pluginFolder,
    pluginFilter = pluginFilter,
    opts = { recursiveRead: true }) {

    const folder = resolve(pluginFolder)
    if (pluginFolders.includes(folder)) return plugins
    pluginFolders.push(folder)

    const paths = await fs.promises.readdir(pluginFolder)
    await Promise.all(paths.map(async path => {
        const resolved = join(folder, path)
        const dirname = Helper.__filename(resolved, true)
        const formatedFilename = formatFilename(resolved)
        try {
            const stats = await fs.promises.lstat(dirname)
            if (!stats.isFile()) {
                if (opts.recursiveRead) await loadPluginFiles(dirname, pluginFilter, opts)
                return
            }

            const filename = Helper.__filename(resolved)
            const isValidFile = pluginFilter(filename)
            if (!isValidFile) return
            const module = await Helper.importFile(filename)
            if (module) plugins[formatedFilename] = module
        } catch (e) {
            console.log(e, `error while requiring ${formatedFilename}`)
            delete plugins[formatedFilename]
        }
    }))

    return plugins = sortedPlugins(plugins)
}

function deletePluginFolder(folder) {
    const resolved = resolve(folder)
    const idx = pluginFolders.indexOf(resolved)
    if (idx !== -1) pluginFolders.splice(idx, 1)
}

async function reload({
    pluginFolder = pluginFolder,
    pluginFilter = pluginFilter
} = {}, _ev, filename) {
    if (!filename || !pluginFilter(filename)) return

    const file = Helper.__filename(join(pluginFolder, filename), true)
    const formatedFilename = formatFilename(file)
    const exists = fs.existsSync(file)

    if (formatedFilename in plugins) {
        if (exists) console.log(chalk.green('Edit') + ` — ${chalk.white(formatedFilename)}`)
        else {
            console.log(chalk.red('Delete') + ` — ${chalk.white(formatedFilename)}`)
            delete plugins[formatedFilename]
            return
        }
    } else {
        if (!exists) return
        console.log(chalk.cyanBright('Add') + ` — ${chalk.white(formatedFilename)}`)
    }

    const src = await fs.promises.readFile(file)
    let err = Helper.checkSyntax(src, filename, {
        sourceType: 'module',
        allowAwaitOutsideFunction: true
    })
    if (err) return console.log(err, `syntax error while loading '${formatedFilename}'`)

    try {
        const module = await Helper.importFile(file)
        if (module) plugins[formatedFilename] = module
    } catch (e) {
        console.log(e, `error require plugin '${formatedFilename}'`)
        delete plugins[formatedFilename]
    } finally {
        plugins = sortedPlugins(plugins)
    }
}

function formatFilename(filename) {
    let dir = join(rootDirectory, './')
    if (os.platform() === 'win32') dir = dir.replace(/\\/g, '\\\\')
    const regex = new RegExp(`^${dir}`)
    const formated = filename.replace(regex, '')
    return formated
}

function sortedPlugins(plugins) {
    return Object.fromEntries(Object.entries(plugins).sort(([a], [b]) => a.localeCompare(b)))
}

export {
    pluginFolder,
    pluginFilter,

    plugins,
    pluginFolders,

    loadPluginFiles,
    deletePluginFolder,
    reload
}
