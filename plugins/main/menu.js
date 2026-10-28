import { promises } from 'fs'
import { join } from 'path'
import os from 'os'
import { plugins } from '../../lib/utils/plugins.js'

let handler = async (m, { conn, usedPrefix: _p, args, isPrems, isOwner, command: cmd, usedPrefix, platform }) => {
  if (platform == 'discord') {
    const view = { owner: isOwner, inGuild: m.isGroup, guild: m.guild, member: m.member, args: {} }
    const visible = [...conn.commands.values()].filter(cmd => !cmd.hidden && (isOwner || !cmd.owner) && !conn.cfg.access.denial(cmd, view))

    const accessOf = cmd => {
      if (cmd.owner) return 'Owner only'
      const ids = m.guild ? conn.cfg.access.roles(m.guild.id, cmd.name) : []
      if (ids.length) return ids.map(id => `<@&${id}>`).join(' ')
      if (cmd.permission && typeof cmd.permission !== 'function') return [].concat(cmd.permission).map(conn.roles.label).join(' and ')
      return 'Everyone'
    }

    const labelOf = key => ORDER.find(name => name.toLowerCase() === key) || key.charAt(0).toUpperCase() + key.slice(1)
    const groups = new Map()
    for (const item of visible) {
      const key = String(item.category || 'other').toLowerCase()
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key).push(item)
    }
    for (const list of groups.values()) list.sort((a, b) => a.name.localeCompare(b.name))

    const rank = key => {
      const index = ORDER.findIndex(name => name.toLowerCase() === key)
      return index === -1 ? 99 : index
    }
    const keys = [...groups.keys()].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))

    const lineOf = cmd => `- ${usedPrefix}${cmd.name}${cmd.premium ? ' Ⓟ' : ''}${cmd.limit ? ' Ⓛ' : ''}`
    const blockOf = key => `**ᗢ ${labelOf(key)}**\n${groups.get(key).map(lineOf).join('\n')}`
    const send = payload => conn.discord(m.chat, { ephemeral: true, ...payload })

    const query = String(args.command || '').trim().toLowerCase().replace(/^[./!]/, '')

    if (query === 'all') return send({ text: keys.map(blockOf).join('\n') })
    if (query && groups.has(query)) return send({ text: blockOf(query) })

    if (query) {
      const cmd = visible.find(c => c.name === query || c.aliases?.includes(query) || (typeof c.match === 'function' && c.match(query)))
      if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
      const fields = [{ name: 'Usage', value: `\`${usedPrefix}${cmd.usage || cmd.name}\`` }]
      if (cmd.aliases?.length) fields.push({ name: 'Aliases', value: cmd.aliases.map(a => `\`${a}\``).join(' '), inline: true })
      if (cmd.limit) fields.push({ name: 'Limit', value: String(Number(cmd.limit) || 1), inline: true })
      fields.push({ name: 'Access', value: accessOf(cmd), inline: true })
      return send({ embed: conn.embed({ title: cmd.name, description: cmd.description, fields }) })
    }

    const pkg = JSON.parse(await promises.readFile(join(process.cwd(), 'package.json')).catch(() => '{}')) || {}
    const dev = global.settings.owner.filter(([id, name, isCreator]) => id && isCreator).map(([id]) => id)[0]
    const status = isOwner ? 'Owner' : isPrems ? 'Premium User' : 'User'

    const header = `──────────────────

**U S E R**
- \`Name:\` ${m.name || '-'}
- \`Status:\` ${status}

──────────────────

**I N F O R M A T I O N**
- \`Bot Name:\` ${global.settings.botname}
- \`Developer:\` ${dev || '-'}
- \`Version:\` ${pkg.version || '-'}

──────────────────`

    const rows = keys.slice(0, 24).map(key => {
      const names = groups.get(key).map(c => c.name)
      const shown = names.slice(0, 5).join(', ')
      return {
        label: `• ${labelOf(key)}`,
        description: (names.length <= 5 ? shown : `${shown}, ...${names.length - 5}+`).slice(0, 100),
        action: `menu ${key}`
      }
    })

    return send({
      text: header,
      select: {
        placeholder: '✦ SHOW ALL MENU',
        options: [{ label: '• All', description: `${visible.length} commands`, action: 'menu all' }, ...rows]
      }
    })
  }
const defaultMenu = {
  before: '',
  header: '*ᗢ %category*',
  body: '- %cmd %isPremium %islimit',
  footer: '',
  after: '',
}
  const arrayTags = ['all', 'main', 'group', 'sticker', 'ai', 'internet', 'adult', 'subbot', 'tools', 'downloader', 'owner', 'info']
  let selected = `${args[0]}`.toLowerCase()
  if (!arrayTags.includes(selected)) selected = '404'

  const tagMap = {
    all:        { main: 'Main', group: 'Group', internet: 'Internet', adult:'Adult', downloader: 'Downloader', database: 'Database', sticker: 'Sticker', tools: 'Tools', subbot:'Sub-bot', ai: 'Artificial Intelligence', owner: 'Owner', info: 'Info' },
    main:       { main: 'Main' },
    ai:         { ai: 'Artificial Intelligence' },
    sticker:    { sticker: 'Sticker' },
    group:      { group: 'Group', admin: `Admin ${global.opts['restrict'] ? '' : '(Disabled)'}` },
    adult:      { adult: 'Adult' },
    subbot:    { subbot: 'Sub-bot' },
    tools:      { tools: 'Tools', ai: 'Artificial Intelligence', database: 'Database' },
    downloader: { downloader: 'Downloader' },
    internet:   { internet: 'Internet' },
    info:       { info: 'Info' },
    owner:      { owner: 'Owner', advanced: 'Advanced' },
  }

  let tags = tagMap[selected] ?? null

  try {

    const mode      = global.opts['self'] ? 'Private' : 'Public'
    const _package  = JSON.parse(await promises.readFile(join(process.cwd() + '/package.json')).catch(_ => '{}')) || {}
    const { level, age, exp, limit, registered, money } = db.data.users[m.sender]
    const name      = db.data.users[m.sender].name
    const premium   = db.data.users[m.sender].premiumTime
    const prems     = premium > 0 ? 'Premium' : 'Free'
    const osPlatform  = os.platform()
    const dev       = global.settings.owner.filter(([id, name, isCreator]) => id && isCreator).map(([id]) => id)[0]

    const allQuoted = {
      contact: {
        key: { remoteJid: '0@s.whatsapp.net' },
        message: {
          contactMessage: {
            displayName: name,
            vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;a,;;;\nFN:${name}\nitem1.TEL;waid=${m.sender.split('@')[0]}:${m.sender.split('@')[0]}\nitem1.X-ABLabel:Mobile\nEND:VCARD`,
          },
        },
      },
    }

    const TextBefore = `──────────────────

*U S E R*
- \`Name:\` ${db.data.users[m.sender].name}
- \`Status:\` ${m.sender.split('@')[0] == dev ? 'Developer' : isOwner ? 'Owner' : isPrems ? 'Premium User' : 'User'}
- \`Registered:\` ${registered ? 'Yes' : 'No'}

──────────────────

*I N F O R M A T I O N*
- \`Bot Name:\` ${global.settings.botname}
- \`Developer:\` @${dev}
- \`Version:\` ${_package.version}

──────────────────`

    if (selected === '404') {
      const jsonlist = arrayTags.filter(v => v !== 'all').map(v => {
        const tagCommands = Object.values(plugins)
          .filter(plugin => !plugin.disabled && plugin.tags?.includes(v) && plugin.help)
          .flatMap(plugin => Array.isArray(plugin.help) ? plugin.help : [plugin.help])
          .map(h => h.split(' ')[0])
          .filter((h, i, arr) => arr.indexOf(h) === i)

        const maxShow = 5
        const shown = tagCommands.slice(0, maxShow).join(', ')
        const remaining = tagCommands.length - maxShow
        const description = tagCommands.length === 0
          ? '-'
          : tagCommands.length <= maxShow
            ? shown
            : `${shown}, ...${remaining}+`

        return {
          header: '\u0000',
          title: '• ' + v.charAt(0).toUpperCase() + v.slice(1),
          description,
          id: '.menu ' + v,
        }
      })

      const totalCommands = Object.values(plugins)
        .filter(plugin => !plugin.disabled && plugin.help)
        .flatMap(plugin => Array.isArray(plugin.help) ? plugin.help : [plugin.help])
        .map(h => h.split(' ')[0])
        .filter((h, i, arr) => arr.indexOf(h) === i)
        .length

      conn.sendButton(m.chat, {
        document: { url: img.profile.bot },
        jpegThumbnail: await conn.resize(
          Buffer.from(await (await fetch(await global.img.profile.bot)).arrayBuffer()),
          100, 100
        ),
        mimetype: 'image/webp',
        caption: TextBefore,
        fileName: global.settings.botname,
        fileLength: '665666646645000',
        nativeFlow: [{},
          { text: '📢', url: 'https://whatsapp.com/channel/0029VaVJo460bIdoxTVoJY3e' },
          { text: '🌐', url: getServerUrl(), useWebview: false },
          { text: '\u0000', sections: [
            {
              highlight_label: '✦ SHOW ALL MENU',
              rows: [
                {
                  header: '\u0000',
                  title: '• All',
                  description: `${totalCommands} commands`,
                  id: '.menu all',
                },
                ...jsonlist
              ]
            }
          ]},
        ],
        mentions: [m.sender, `${dev}@s.whatsapp.net`]
      }, allQuoted.contact)

      return 0
    }

    const totalreg  = Object.keys(db.data.users).filter(k => !k.startsWith('bf:')).length
    const rtotalreg = Object.values(db.data.users).filter(u => u.registered === true).length
    const help = Object.values(plugins)
      .filter(plugin => !plugin.disabled)
      .map(plugin => ({
        help:    Array.isArray(plugin.help) ? plugin.help : [plugin.help],
        tags:    Array.isArray(plugin.tags) ? plugin.tags : [plugin.tags],
        prefix:  'customPrefix' in plugin,
        limit:   plugin.limit,
        premium: plugin.premium,
        enabled: !plugin.disabled,
      }))

    const groups = {}
    for (let tag in tags) {
      groups[tag] = []
      for (let plugin of help)
        if (plugin.tags?.includes(tag) && plugin.help)
          groups[tag].push(plugin)
    }

    conn.menu = conn.menu ?? {}
    const before = conn.menu.before  || defaultMenu.before
    const header = conn.menu.header  || defaultMenu.header
    const body   = conn.menu.body    || defaultMenu.body
    const footer = conn.menu.footer  || defaultMenu.footer
    const after  = conn.menu.after   || defaultMenu.after

    let _text = [
      before,
      ...Object.keys(tags).map(tag => {
        return (
          header.replace(/%category/g, tags[tag]) + '\n' +
          [
            ...help
              .filter(menu => menu.tags?.includes(tag) && menu.help)
              .map(menu =>
                menu.help.map(h =>
                  body
                    .replace(/%cmd/g,       menu.prefix ? h : _p + h)
                    .replace(/%islimit/g,   menu.limit   ? 'Ⓛ' : '')
                    .replace(/%isPremium/g, menu.premium ? 'Ⓟ' : '')
                    .trim()
                ).join('\n')
              ),
            footer,
          ].join('\n')
        )
      }),
      after,
    ].join('\n')

    let text =
      typeof conn.menu === 'string' ? conn.menu :
      typeof conn.menu === 'object' ? _text : ''

    const replace = {
      '%':        '%',
      me:         conn.getName(conn.user.jid),
      npmname:    _package.name,
      npmdesc:    _package.description,
      version:    _package.version,
      github:     _package.homepage?.url || _package.homepage || '[unknown github url]',
      platform: osPlatform, mode, _p, money, age, name, prems, limit,
      totalreg, rtotalreg,
    }

    text = text.replace(
      new RegExp(`%(${Object.keys(replace).sort((a, b) => b.length - a.length).join('|')})`, 'g'),
      (_, key) => '' + replace[key]
    )

    conn.reply(m.chat, text, {
      key: { remoteJid: '0@s.whatsapp.net' },
      message: {
        orderMessage: {
          orderId: '780642630945098',
          thumbnail: await conn.resize(global.img.profile.sender, 150, 150),
          itemCount: 666,
          status: 1,
          surface: 1,
          message: '• LIST COMMANDS',
          orderTitle: 'Channel.',
          sellerJid: '6283143393763@s.whatsapp.net',
          token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==',
          totalAmount1000: '0',
          totalCurrencyCode: 'IDR',
        },
      },
    })

  } catch (e) {
    m.error = e
    console.log(e)
    conn.reply(m.chat, '> *Sorry*, the menu is currently error', m)
  }
}

const ORDER = ['Info', 'Utility', 'Moderation', 'Roles', 'Settings', 'Server', 'Music', 'AI', 'Downloader', 'Tools', 'Sticker', 'Group', 'Adult', 'Owner']

handler.tags = ['main']
handler.command = ['menu', 'help', '?']
handler.description = 'Show all available commands'
handler.help = [{ name: 'command', description: 'Command or category to show', type: 'string' }]
handler.ai = { risk: 'low', description: 'Show menu list / command list' }
handler.platform = { whatsapp: true, discord: true }

export default handler
