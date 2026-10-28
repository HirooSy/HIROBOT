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
            const source = await fs.promises.readFile(filename, 'utf8')
            if (isDiscordOnly(source)) return
            storePlugin(formatedFilename, await Helper.importFile(filename))
        } catch (e) {
            console.log(e, `error while requiring ${formatedFilename}`)
            removePlugin(formatedFilename)
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

    if (hasPlugin(formatedFilename)) {
        if (exists) console.log(chalk.green('Edit') + ` — ${chalk.white(formatedFilename)}`)
        else {
            console.log(chalk.red('Delete') + ` — ${chalk.white(formatedFilename)}`)
            removePlugin(formatedFilename)
            return
        }
    } else {
        if (!exists) return
        console.log(chalk.cyanBright('Add') + ` — ${chalk.white(formatedFilename)}`)
    }

    const src = await fs.promises.readFile(file)
    if (isDiscordOnly(String(src))) {
        removePlugin(formatedFilename)
        return
    }
    let err = Helper.checkSyntax(src, filename, {
        sourceType: 'module',
        allowAwaitOutsideFunction: true
    })
    if (err) return console.log(err, `syntax error while loading '${formatedFilename}'`)

    try {
        storePlugin(formatedFilename, await Helper.importFile(file))
    } catch (e) {
        console.log(e, `error require plugin '${formatedFilename}'`)
        removePlugin(formatedFilename)
    } finally {
        plugins = sortedPlugins(plugins)
    }
}

function isDiscordOnly(source) {
    return /\bwhatsapp\s*:\s*false\b/.test(source) && !/\bwhatsapp\s*:\s*(true|\{)/.test(source)
}

function pluginKeys(key) {
    return Object.keys(plugins).filter(name => name === key || name.startsWith(`${key}#`))
}

function hasPlugin(key) {
    return pluginKeys(key).length > 0
}

function removePlugin(key) {
    for (const name of pluginKeys(key)) delete plugins[name]
}

function storePlugin(key, module) {
    removePlugin(key)
    const isList = Array.isArray(module)
    const list = isList ? module : [module]
    list.forEach((item, index) => {
        const plugin = applyPlatformMeta(item)
        if (!plugin) return
        if (isList && plugin.platform?.whatsapp === false) return
        plugins[index === 0 ? key : `${key}#${index}`] = plugin
    })
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

const WA_PERMISSIONS = ['admin', 'botAdmin', 'owner', 'rowner', 'mods', 'premium']

function toArray(value) {
  if (value === undefined || value === null || value === false) return []
  return Array.isArray(value) ? value : [value]
}

function primaryName(command) {
  const names = toArray(command).filter(name => typeof name === 'string' && name.length > 0)
  return names[0] || null
}

function isOption(item) {
  return item !== null && typeof item === 'object' && !Array.isArray(item)
}

function usageLine(name, options) {
  const parts = options.map(option => (option.required ? `<${option.name}>` : `[${option.name}]`))
  return [name, ...parts].join(' ')
}

function resolveHelp(handler) {
  const list = toArray(handler.help)
  const options = list.filter(isOption)
  if (!options.length) return
  const lines = list.filter(item => typeof item === 'string')
  if (lines.length) {
    handler.help = lines
    return
  }
  const primary = primaryName(handler.command)
  const groups = new Map()
  for (const option of options) {
    const name = option.command || primary
    if (!name) continue
    if (!groups.has(name)) groups.set(name, [])
    groups.get(name).push(option)
  }
  handler.help = [...groups].map(([name, items]) => usageLine(name, items))
}

function applyWhatsAppPlatform(handler) {
  const platform = handler.platform
  if (platform === null || typeof platform !== 'object') return

  const whatsapp = platform.whatsapp
  if (whatsapp === false) {
    handler.disabled = true
    return
  }
  if (whatsapp === null || typeof whatsapp !== 'object') return

  const granted = toArray(whatsapp.permission).map(name => String(name).toLowerCase())
  for (const flag of WA_PERMISSIONS) {
    if (granted.includes(flag.toLowerCase())) handler[flag] = true
  }
}

function applyPlatformMeta(handler) {
  if (handler === null || (typeof handler !== 'function' && typeof handler !== 'object')) return handler
  resolveHelp(handler)
  applyWhatsAppPlatform(handler)
  return handler
}

export {
    applyPlatformMeta,
    usageLine,
    pluginFolder,
    pluginFilter,

    plugins,
    pluginFolders,

    loadPluginFiles,
    deletePluginFolder,
    reload
}
