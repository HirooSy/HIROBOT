// ===========================[ MODULE ]=========================
import { promises } from 'fs'
import { join } from 'path'
import os from 'os'
import { plugins } from '../../lib/plugins.js'

let { generateWAMessageFromContent, prepareWAMessageMedia, proto } =
  (await import('baileys')).default



// ===========================[ DEFAULT MENU ]===================
const defaultMenu = {
  before: '',
  header: '*ᗢ %category*',
  body: '- %cmd %isPremium %islimit',
  footer: '',
  after: '',
}


// ===========================[ HANDLER ]=========================
let handler = async (m, { conn, usedPrefix: _p, __dirname, args, isPrems, isOwner, command: cmd }) => {

  // ===========================[ ARRAY MENU TYPE ]=================
  const arrayTags = ['all', 'main', 'group', 'sticker', 'ai', 'internet', 'adult', 'session', 'tools', 'downloader', 'owner', 'info']
  let teks = `${args[0]}`.toLowerCase()
  if (!arrayTags.includes(teks)) teks = '404'

  const tagMap = {
    all:        { main: 'Main', group: 'Grup', internet: 'Internet', adult:'Adult', downloader: 'Downloader', database: 'Database', sticker: 'Stiker', tools: 'Tools', ai: 'Artificial Intelligence', owner: 'Owner', info: 'Info' },
    main:       { main: 'Main' },
    ai:         { ai: 'Artificial Intelligence' },
    sticker:    { sticker: 'Stiker' },
    group:      { group: 'Group', admin: `Admin ${global.opts['restrict'] ? '' : '(Disabled)'}` },
    adult:      { adult: 'Adult' },
    session:    { session: 'Session (Jadibot)' },
    tools:      { tools: 'Tools', ai: 'Artificial Intelligence', database: 'Database' },
    downloader: { downloader: 'Downloader' },
    internet:   { internet: 'Internet' },
    info:       { info: 'Info' },
    owner:      { owner: 'Owner', advanced: 'Advanced' },
  }

  let tags = tagMap[teks] ?? null

  try {

    // ===========================[ DATA ]===========================
    const mode      = global.opts['self'] ? 'Private' : 'Publik'
    const _package  = JSON.parse(await promises.readFile(join(process.cwd() + '/package.json')).catch(_ => '{}')) || {}
    const { level, age, exp, limit, registered, money } = db.data.users[m.sender]
    const name      = db.data.users[m.sender].name
    const premium   = db.data.users[m.sender].premiumTime
    const prems     = premium > 0 ? 'Premium' : 'Free'
    const platform  = os.platform()
    const dev       = global.owner.filter(([id, isCreator]) => id && isCreator).map(([id]) => id)[0]


    // ===========================[ QUOTED ]=========================
    const allQuoted = {
      contact: {
        key: { remoteJid: '0@s.whatsapp.net' },
        message: {
          contactMessage: {
            displayName: name,
            vcard: `BEGIN:VCARD\nVERSION:3.0\nN:;a,;;;\nFN:${name}\nitem1.TEL;waid=${m.sender.split('@')[0]}:${m.sender.split('@')[0]}\nitem1.X-ABLabel:Ponsel\nEND:VCARD`,
          },
        },
      },
    }

    // ===========================[ TEKS BEFORE ]===================
    const TeksBefore = `──────────────────

*U S E R*
- \`Name:\` ${db.data.users[m.sender].name}
- \`Status:\` ${m.sender.split('@')[0] == dev ? 'Developer' : isOwner ? 'Owner' : isPrems ? 'Premium User' : 'User'}
- \`Registered:\` ${registered ? 'Yes' : 'No'}

──────────────────

*I N F O R M A T I O N*
- \`Bot Name:\` ${process.env.BOT_NAME}
- \`Developer:\` @${dev}
- \`Version:\` ${_package.version}

──────────────────`


    // ===========================[ MENU 404 ]======================
    if (teks === '404') {
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
          await (await (await import('node-fetch')).default(img.profile.bot)).buffer(),
          100, 100
        ),
        mimetype: 'image/webp',
        caption: TeksBefore,
        fileName: process.env.BOT_NAME,
        fileLength: '665666646645000',
        nativeFlow: [{},
          { text: '📢', url: 'https://whatsapp.com/channel/0029VaVJo460bIdoxTVoJY3e' },
          { text: '🌐', url: `${getServerUrl()}`, useWebview: true },
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


    // ===========================[ ARRAY PLUGINS ]=================
    const totalreg  = Object.keys(db.data.users).length
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


    // ===========================[ BUILD TEXT ]===================
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
      platform, mode, _p, money, age, name, prems, limit,
      totalreg, rtotalreg,
    }

    text = text.replace(
      new RegExp(`%(${Object.keys(replace).sort((a, b) => b.length - a.length).join('|')})`, 'g'),
      (_, key) => '' + replace[key]
    )


    // ===========================[ SEND MENU ]===================
    conn.reply(m.chat, text, {
      key: { remoteJid: '0@s.whatsapp.net' },
      message: {
        orderMessage: {
          orderId: '780642630945098',
          thumbnail: await conn.resize(img.profile.sender, 150, 150),
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

handler.help    = handler.dym = ['menu', 'help']
handler.tags    = ['main']
handler.command = /^(menu|help|\?)$/i

export default handler
