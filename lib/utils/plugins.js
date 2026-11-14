import fs from 'fs'
import { join, relative, resolve } from 'path'
import { pathToFileURL } from 'url'
import * as os from 'os'
import Helper from './helper.js'
import chalk from './color.js'
import db, { loadDatabase, scheduleAutosave, getDiscordAccount, accessLocked, accessRoleIds, accessRulesOf, setCommandRoles, guildConfig, updateGuildConfig, setGuildPrefix, guildPrefix, forgetRole, reactionEntries, addReactionRole, removeReactionRole } from './database.js'
import { printLog, printDiscord } from './print.js'
import { optionTypes, actions, randomId, registerAction, prefixList, prefixesFor, prefixesOf, primaryPrefix, matchPrefix, smsgDiscord, withDiscord, resolveMember, resolveRole, resolveChannel, isTextChannel, fetchRoles, canManage, roleManageError, hierarchyError, addMemberRole, removeMemberRole, displayNameOf } from './simple.js'
import { snowflakeOf, parseEmoji, parseMessageRef, defaultWelcome, formatWelcome } from '../package/discord/text.js'
import { normalizePayload, embedColor, uploadLimitOf, toAttachment } from '../package/discord/payload.js'
import { toDiscordPermission, permissionLabel, keyPermissions } from '../package/discord/permissions.js'

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
    reload,

    discordCommands,
    loadAllCommands,
    stopCommands,
    syncCommands,
    resolveInvocation,
    execute
}

const discordCommands = new Map()
const fileToName = new Map()
const watchers = new Map()
const timers = new Map()
const cooldowns = new Map()
const slashLimit = 100
let slashSignature = ''
let syncTimer = null
let guildCommandsCleared = false
let discordConnection = null

function debounce(key, ms, fn) {
  if (timers.has(key)) clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    fn()
  }, ms))
}

function listCommandFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) listCommandFiles(full, results)
    else if (entry.isFile() && pluginFilter(entry.name)) results.push(full)
  }
  return results
}

function categoryOf(tag) {
  const raw = String(tag || '')
  if (!raw) return 'Other'
  return { main: 'Info', info: 'Info' }[raw.toLowerCase()] || raw[0].toUpperCase() + raw.slice(1)
}

function optionsOf(h, name, primary = name) {
  return [].concat(h.help || [])
    .filter(item => item && typeof item === 'object' && item.name && String(item.command || primary).toLowerCase() === name)
    .map(({ command, ...item }) => ({
      ...item,
      name: String(item.name).toLowerCase(),
      description: String(item.description || item.name).slice(0, 100),
      type: item.type || 'string'
    }))
}

function commandsOf(h, names = [].concat(h.command || []).map(v => String(v).toLowerCase())) {
  const described = h.description && typeof h.description === 'object' ? h.description : null
  const slash = described ? Object.keys(described).map(key => key.toLowerCase()) : [names[0]]
  for (const key of slash) {
    if (!names.includes(key)) throw new Error(`"${key}" has a description but is not in handler.command`)
  }
  slash.sort((a, b) => names.indexOf(a) - names.indexOf(b))
  if (slash[0] !== names[0]) throw new Error('the first name in handler.command must have a description')
  return slash.map((name, index) => {
    const from = names.indexOf(name)
    const to = index + 1 < slash.length ? names.indexOf(slash[index + 1]) : names.length
    const key = described ? Object.keys(described).find(k => k.toLowerCase() === name) : null
    return {
      name,
      aliases: names.slice(from + 1, to),
      description: String(described ? described[key] : h.description || '').trim(),
      options: optionsOf(h, name, slash[0])
    }
  })
}

function discordAccessOf(h) {
  const d = h.platform?.discord
  const none = { owner: false, premium: false, permission: undefined }
  if (!d || typeof d !== 'object') return none

  const parseAccess = value => {
    const list = [].concat(value || []).filter(Boolean).map(String)
    const lower = list.map(item => item.toLowerCase())
    return {
      owner: lower.includes('owner') || lower.includes('rowner'),
      premium: lower.includes('premium'),
      flags: list.filter(item => !['owner', 'rowner', 'premium'].includes(item.toLowerCase())).map(toDiscordPermission)
    }
  }

  if (typeof d.permission === 'function') {
    return {
      ...none,
      permission: (args, name) => {
        const { flags } = parseAccess(d.permission(args, name))
        return flags.length ? flags : null
      }
    }
  }

  const { owner, premium, flags } = parseAccess(d.permission)
  return { owner, premium, permission: flags.length ? flags : undefined }
}

function toApiOption(option) {
  const out = {
    type: typeof option.type === 'number' ? option.type : optionTypes[String(option.type || 'string').toLowerCase()] || 3,
    name: String(option.name).toLowerCase(),
    description: String(option.description || 'No description').slice(0, 100)
  }
  if (out.type !== 1 && out.type !== 2) out.required = !!option.required
  if (option.choices) out.choices = option.choices
  if (option.options) out.options = option.options.map(toApiOption)
  for (const key of ['min_value', 'max_value', 'min_length', 'max_length', 'channel_types', 'autocomplete']) {
    if (option[key] !== undefined) out[key] = option[key]
  }
  return out
}

function definitionOf(cmd) {
  return {
    name: cmd.name,
    description: cmd.description,
    options: (cmd.options || []).map(toApiOption),
    dm_permission: !cmd.group
  }
}

async function syncCommands() {
  const client = global.discord?.client
  if (!client?.application) return
  const ordered = [...discordCommands.values()].filter(cmd => !cmd.prefixOnly)
  if (ordered.length > slashLimit) {
    printLog('error', `${ordered.length} commands defined, only the first ${slashLimit} are registered as slash commands (the rest still work with the prefix)`)
  }
  const body = ordered.slice(0, slashLimit).map(definitionOf)
  const signature = JSON.stringify(body)
  if (signature === slashSignature) return

  try {
    await client.application.commands.set(body)
    if (!guildCommandsCleared) {
      guildCommandsCleared = true
      for (const guild of client.guilds.cache.values()) await guild.commands.set([]).catch(() => {})
    }
    slashSignature = signature
    printLog('info', `${body.length} slash command(s) synced globally`)
  } catch (err) {
    printLog('error', `Failed to sync slash commands: ${err?.message || err}`)
  }
}

function scheduleSync() {
  if (!global.discord?.client?.application) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    syncCommands()
  }, 1500)
}

function isNativeSource(source) {
  const discordOn = /\bdiscord\s*:\s*(true|\{)/.test(source)
  const whatsappOff = /\bwhatsapp\s*:\s*false\b/.test(source)
  const platformAware = /\bplatform\s*(===?|!==?)\s*['"`](discord|whatsapp)['"`]/.test(source)
  return discordOn && (whatsappOff || platformAware)
}

async function loadCommandFile(file, silent = false) {
  const rel = relative(process.cwd(), file).replace(/\\/g, '/')
  const known = fileToName.has(file)
  let source = ''
  try { source = fs.readFileSync(file, 'utf8') } catch { return false }
  if (!isNativeSource(source)) return false
  try {
    const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
    const list = (Array.isArray(mod.default) ? mod.default : [mod.default]).filter(Boolean)
    if (!list.length) throw new Error('must default-export a handler function or an array of them')

    const prepared = []
    for (const h of list) {
      if (typeof h !== 'function') throw new Error('must default-export a handler: let handler = async (m, ctx) => {}')
      if (!h.platform?.discord) continue
      const names = [].concat(h.command || []).map(v => (typeof v === 'string' ? v.toLowerCase() : ''))
      if (!names.length || !/^[\p{L}\p{N}_-]{1,32}$/u.test(names[0]) || names.slice(1).some(v => !v || /\s/.test(v))) {
        throw new Error('handler.command must be a command name or a list of names')
      }
      const access = discordAccessOf(h)
      for (const entry of commandsOf(h, names)) {
        if (!entry.description) throw new Error(`"${entry.name}" has no handler.description`)
        const owner = [...discordCommands.values()].find(c => c.name === entry.name && c.file !== file)
        if (owner) throw new Error(`command "${entry.name}" is already defined in ${relative(process.cwd(), owner.file)}`)
        prepared.push({
          name: entry.name,
          aliases: entry.aliases,
          description: entry.description.slice(0, 100),
          category: categoryOf([].concat(h.tags || [])[0]),
          group: !!h.group,
          owner: access.owner,
          premium: access.premium,
          private: !!h.private,
          permission: access.permission,
          options: entry.options,
          limit: h.limit,
          exp: h.exp,
          hidden: !!h.hidden,
          prefixOnly: !!h.prefixOnly,
          file,
          handler: h,
          run: ctx => h(ctx.m, ctx.extra)
        })
      }
    }

    const names = prepared.map(c => c.name)
    for (const cmd of prepared) cmd.aliases = cmd.aliases.filter(alias => !names.includes(alias))
    for (const previous of fileToName.get(file) || []) {
      if (!names.includes(previous)) discordCommands.delete(previous)
    }
    for (const cmd of prepared) discordCommands.set(cmd.name, cmd)
    fileToName.set(file, names)
    if (!silent) printLog(known ? 'edit' : 'add', rel)
    return true
  } catch (err) {
    printLog('error', `Failed to load ${rel}: ${err?.message || err}`)
    return false
  }
}

function removeCommandFile(file) {
  const names = fileToName.get(file)
  if (!names) return
  for (const name of names) discordCommands.delete(name)
  fileToName.delete(file)
  printLog('delete', relative(process.cwd(), file).replace(/\\/g, '/'))
}

async function onFsEvent(absPath) {
  let stat = null
  try { stat = fs.statSync(absPath) } catch {}

  if (stat?.isDirectory()) {
    watchDir(absPath)
    for (const file of listCommandFiles(absPath)) await loadCommandFile(file)
    scheduleSync()
    return
  }

  if (!pluginFilter(absPath)) return
  if (!stat) removeCommandFile(absPath)
  else await loadCommandFile(absPath)
  scheduleSync()
}

function watchDir(dir) {
  if (watchers.has(dir)) return
  try {
    const watcher = fs.watch(dir, (_event, filename) => {
      if (!filename) return
      const absPath = join(dir, filename)
      debounce(absPath, 300, () => onFsEvent(absPath))
    })
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(dir)
    })
    watchers.set(dir, watcher)
  } catch (err) {
    printLog('error', `Cannot watch ${dir}: ${err?.message || err}`)
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) watchDir(join(dir, entry.name))
  }
}

async function loadAllCommands() {
  fs.mkdirSync(pluginFolder, { recursive: true })
  for (const file of listCommandFiles(pluginFolder)) await loadCommandFile(file, true)
  watchDir(pluginFolder)
}

function stopCommands() {
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  slashSignature = ''
}

function findCommand(name) {
  return discordCommands.get(name) || [...discordCommands.values()].find(cmd => cmd.aliases?.includes(name)) || null
}

function commandNameOf(input) {
  return String(input ?? '').trim().toLowerCase().replace(/^[./!]/, '')
}

function resolveInvocation(content, { allowBare = false, guildId = null } = {}) {
  let body = String(content || '').trim()
  if (!body) return null

  let prefix = null
  const botId = global.discord?.client?.user?.id
  const mention = botId ? new RegExp(`^<@!?${botId}>\\s*`).exec(body) : null
  if (mention) {
    body = body.slice(mention[0].length)
    prefix = primaryPrefix(guildId)
  } else {
    const active = prefixesFor(guildId)
    const list = allowBare ? [...new Set([...active, ...prefixList()])] : active
    const used = matchPrefix(body, list)
    if (used) {
      body = body.slice(used.length).trimStart()
      prefix = used
    } else if (allowBare || global.settings?.system?.noPrefix === true) {
      prefix = primaryPrefix(guildId)
    } else {
      return null
    }
  }

  const parts = /^(\S+)(?:\s+([\s\S]*))?$/.exec(body)
  if (!parts) return null
  const name = parts[1].toLowerCase()
  const cmd = findCommand(name)
  if (!cmd) return null
  return { cmd, name, text: (parts[2] || '').trim(), prefix }
}

function usageOf(cmd, prefix) {
  const parts = (cmd.options || []).map(o => (o.required ? `<${o.name}>` : `[${o.name}]`))
  return `${prefix}${cmd.name}${parts.length ? ` ${parts.join(' ')}` : ''}`
}

function checkOwner(userId, account) {
  if ((process.env.DISCORD_OWNER || '').split(',').map(v => v.trim()).filter(Boolean).includes(userId)) return true
  if (!account.linked) return false
  const number = account.key.replace(/@.*$/, '')
  return (global.settings?.owner || []).some(([n]) => n && String(n).replace(/\D/g, '') === number)
}

function accessDenial(cmd, { owner = false, inGuild = false, guild = null, member = null, args = {} } = {}) {
  if (owner || !inGuild) return null
  if (!guild || !member) return 'I could not check your roles in this server, try again.'
  if (member.permissions.has('Administrator')) return null

  if (!accessLocked.has(cmd.name)) {
    const roles = accessRoleIds(guild.id, cmd.name)
    if (roles.length) {
      if (roles.includes(String(guild.id)) || roles.some(id => (member.roleIds || []).includes(id))) return null
      return `Only members with one of these roles can use \`${cmd.name}\`: ${roles.map(id => `<@&${id}>`).join(' ')}`
    }
  }

  const value = typeof cmd.permission === 'function' ? cmd.permission(args, cmd.name) : cmd.permission
  const needed = value ? [].concat(value) : []
  if (needed.length && !member.permissions.has(...needed)) {
    return `You need the ${needed.map(permissionLabel).join(' and ')} permission.`
  }
  return null
}

function recordStat(cmd, ok) {
  if (!db.data) return
  if (!db.data.stats) db.data.stats = {}
  const key = `discord:${cmd.name}`
  const now = Date.now()
  const stat = db.data.stats[key] || (db.data.stats[key] = { total: 0, success: 0, last: 0, lastSuccess: 0 })
  stat.total += 1
  stat.last = now
  if (ok) {
    stat.success += 1
    stat.lastSuccess = now
  }
}

function buildContext(src, cmd, account, owner, args, invokedName) {
  const client = global.discord?.client ?? null
  const user = src.user
  const conn = discordConn()
  const m = smsgDiscord(conn, src, src.attachment || toAttachment(args.file))
  const perms = src.member?.permissions
  const me = src.guild?.members?.me
  const extra = {
    usedPrefix: src.prefix || '/',
    platform: 'discord',
    command: invokedName || cmd.name,
    args,
    text: src.text ?? args.text ?? '',
    conn,
    participants: [],
    groupMetadata: src.guild ? { id: src.guild.id, subject: src.guild.name, size: src.guild.memberCount ?? null } : null,
    user: account.data,
    bot: client?.user ?? null,
    isROwner: owner,
    isOwner: owner,
    isPrems: account.data?.premium === true,
    isAdmin: !!perms?.has?.('ManageGuild'),
    isBotAdmin: !!me?.permissions?.has?.('ManageGuild')
  }

  const ctx = {
    m,
    extra,
    client,
    src,
    interaction: src.interaction,
    message: src.message,
    command: cmd,
    commands: discordCommands,
    db,
    getAccount: getDiscordAccount,
    key: account.key,
    user: account.data,
    linked: account.linked,
    isOwner: owner,
    discordUser: user,
    member: src.member,
    guild: src.guild,
    channel: src.channel,
    inGuild: src.inGuild,
    options: src.interaction?.options || null,
    args,
    text: src.text ?? args.text ?? '',
    prefix: src.prefix || '/',
    invokedName,
    attachment: src.attachment || toAttachment(args.file),
    fileLimit: uploadLimitOf(src.guild),
    failed: false,
    reply: src.reply,
    edit: src.edit,
    editMessage: src.editById,
    deleteMessage: src.deleteById,
    defer: src.defer,
    react: src.react,
    getQuoted: src.getQuoted,
    registerAction: (text, opts = {}) => registerAction(opts.shared ? null : user.id, text, opts.ttl),
    randomId,
    embed: (data = {}) => ({ color: embedColor, ...data }),
    ...discordTools()
  }
  extra.conn = withDiscord(conn, ctx)
  return ctx
}

async function execute(src, cmd, { args, invokedName, quietAccess = false }) {
  if (db.data == null) await loadDatabase()

  const user = src.user
  const account = getDiscordAccount(user.id, {
    name: user.globalName || user.username,
    username: user.username,
    avatar: user.avatar || '',
    lastSeen: Date.now()
  })
  const owner = checkOwner(user.id, account)
  const data = account.data
  const msg = global.settings?.msg || {}

  try {
    printDiscord({
      user,
      guild: src.guild,
      channel: src.channel,
      kind: src.attachment ? 'Media' : (src.kindLabel || 'Text'),
      text: src.raw || `${src.prefix || '/'}${cmd.name}`,
      size: src.attachment?.size || 0
    })
  } catch {}

  if (data.banned && !owner) return src.deny('You are banned from using this bot.')
  if (cmd.owner && !owner) return src.deny(msg.owner || 'This command is only for bot owners')
  if (cmd.premium && !owner && data.premium !== true) return src.deny(msg.premium || 'This command is only for premium users.')
  if (cmd.group && !src.inGuild) return src.deny(msg.group || 'This command can only be used in a server.')
  if (cmd.private && src.inGuild) return src.deny(msg.private || 'This command can only be used in DMs.')
  if (cmd.linked && !account.linked) return src.deny('Connect your WhatsApp account first with `/connect`.')
  const denial = accessDenial(cmd, { owner, inGuild: src.inGuild, guild: src.guild, member: src.member, args })
  if (denial) return quietAccess ? null : src.deny(denial)

  const missing = (cmd.options || []).find(opt => opt.required && args[opt.name] === undefined)
  if (missing) return src.deny(`Usage: \`${usageOf(cmd, src.prefix || '/')}\``)

  const cooldownMs = global.settings?.system?.cooldown || 0
  if (cooldownMs > 0 && !owner) {
    const cooldownKey = `${user.id}:${cmd.name}`
    const readyAt = cooldowns.get(cooldownKey) || 0
    const now = Date.now()
    if (now < readyAt) return src.deny(`Please wait ${Math.ceil((readyAt - now) / 1000)}s before using \`${cmd.name}\` again.`)
    cooldowns.set(cooldownKey, now + cooldownMs)
  }

  const cost = Number(cmd.limit) || 0
  const unlimited = owner || data.premium === true
  if (cost > 0 && !unlimited && (data.limit || 0) < cost) {
    return src.deny('Please wait a few moments for the system to refill your limit.')
  }

  const ctx = buildContext(src, cmd, account, owner, args, invokedName)
  let ok = true
  try {
    await cmd.run(ctx)
    if (ctx.failed) {
      ok = false
    } else {
      const live = getDiscordAccount(user.id)?.data || data
      live.exp = (live.exp || 0) + (Number.isFinite(cmd.exp) ? cmd.exp : 1)
      if (cost > 0 && !unlimited) live.limit = Math.max(0, (live.limit || 0) - cost)
    }
  } catch (err) {
    ok = false
    console.error(chalk.red('Discord') + chalk.gray(` ${cmd.name} failed:`), err)
    await src.deny('Something went wrong while running this command.').catch(() => {})
  } finally {
    recordStat(cmd, ok)
    scheduleAutosave()
  }
}

function discordTools() {
  return {
    find: {
      member: resolveMember,
      role: resolveRole,
      channel: resolveChannel,
      command: input => findCommand(commandNameOf(input)),
      commandName: commandNameOf,
      id: snowflakeOf,
      displayName: displayNameOf,
      isText: isTextChannel
    },
    roles: {
      error: roleManageError,
      hierarchy: hierarchyError,
      fetch: fetchRoles,
      perms: keyPermissions,
      label: permissionLabel
    },
    memberRole: { add: addMemberRole, remove: removeMemberRole },
    mod: { canManage },
    cfg: {
      get: guildConfig,
      set: updateGuildConfig,
      forget: forgetRole,
      welcome: { default: defaultWelcome, format: formatWelcome },
      prefix: { get: guildPrefix, set: setGuildPrefix, list: prefixesOf },
      access: {
        rules: accessRulesOf,
        roles: accessRoleIds,
        set: setCommandRoles,
        locked: accessLocked,
        denial: accessDenial
      },
      reactions: {
        parseEmoji,
        parseMessage: parseMessageRef,
        list: reactionEntries,
        add: addReactionRole,
        remove: removeReactionRole
      }
    }
  }
}

function discordConn() {
  if (discordConnection) return discordConnection
  discordConnection = {
    get client() { return global.discord?.client ?? null },
    get user() { return global.discord?.client?.user ?? null },
    get commands() { return discordCommands },
    db,
    embed: (data = {}) => ({ color: embedColor, ...data }),
    account: getDiscordAccount,
    registerAction: (userId, text, ttl) => registerAction(userId, text, ttl),
    reply: (chat, content) => global.discord.client.rest.post(`/channels/${chat}/messages`, { body: normalizePayload(content) }),
    ...discordTools()
  }
  return discordConnection
}

setInterval(() => {
  const now = Date.now()
  for (const [key, readyAt] of cooldowns) {
    if (now >= readyAt) cooldowns.delete(key)
  }
  for (const [key, entry] of actions) {
    if (entry.expires < now) actions.delete(key)
  }
}, 5 * 60 * 1000).unref()
