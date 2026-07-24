import { smsg, matchParticipant, resolveLidToNumber, updateUserMapping, autoMergeLidUsers } from './simple.js'
import { plugins } from './plugins.js'
import { format } from 'util'
import { fileURLToPath } from 'url'
import path, { join } from 'path'
import { unwatchFile, watchFile } from 'fs'
import chalk from 'chalk'
import fetch from 'node-fetch'
import Connection from './connection.js'
import printMessage from './print.js'
import Helper from './helper.js'
import db, { loadDatabase } from './database.js'
import Queque from './queque.js'
import { handleError as autoHeal } from './ai/mcp.js'

/** @type {import('hiroosy')} */
const { getContentType, proto } = await import('baileys')

const isNumber = x => typeof x === 'number' && !isNaN(x)

setInterval(autoMergeLidUsers, 30 * 60 * 1000)
setTimeout(autoMergeLidUsers, 5000)

let _requiredGroupId = null
let _requiredGroupJid = null
let _requiredGroupPromise = null

async function getRequiredGroupId(sock) {
    if (_requiredGroupJid) {
        return _requiredGroupJid
    }
    
    if (_requiredGroupId === null && _requiredGroupPromise === null) {
        return null
    }
    
    if (_requiredGroupPromise) {
        return _requiredGroupPromise
    }
    
    _requiredGroupPromise = (async () => {
        try {
            const raw = (process.env.GROUP_ID || '').trim()
            
            if (!raw) {
                console.log('[GROUP ACCESS CHECK] GROUP_ID not set. Group check disabled.')
                _requiredGroupId = null
                _requiredGroupJid = null
                return null
            }

            if (raw.endsWith('@g.us')) {
                _requiredGroupJid = raw
                console.log(`[GROUP ACCESS CHECK] GROUP_ID langsung dipakai sebagai JID: ${_requiredGroupJid}`)
                return _requiredGroupJid
            }

            if (raw.includes('chat.whatsapp.com')) {
                const code = raw.replace('https://chat.whatsapp.com/', '').replace('http://chat.whatsapp.com/', '').trim()
                console.log(`[GROUP ACCESS CHECK] Mengekstrak invite code: ${code}`)
                
                try {
                    const info = await sock.groupGetInviteInfo(code)
                    if (info && info.id) {
                        _requiredGroupJid = info.id
                        console.log(`[GROUP ACCESS CHECK] Resolved GROUP_ID dari invite link -> JID: ${_requiredGroupJid} (subject: ${info.subject}, size: ${info.size})`)
                        return _requiredGroupJid
                    } else {
                        console.error('[GROUP ACCESS CHECK] groupGetInviteInfo tidak mengembalikan id yang valid')
                        _requiredGroupId = null
                        _requiredGroupJid = null
                        return null
                    }
                } catch (inviteError) {
                    console.error('[GROUP ACCESS CHECK] Gagal resolve invite code:', inviteError.message)
                    _requiredGroupId = null
                    _requiredGroupJid = null
                    return null
                }
            }

            console.warn(`[GROUP ACCESS CHECK] Format GROUP_ID tidak dikenali: ${raw}. Group check disabled.`)
            _requiredGroupId = null
            _requiredGroupJid = null
            return null
            
        } catch (error) {
            console.error('[GROUP ACCESS CHECK] Gagal resolve GROUP_ID:', error)
            _requiredGroupId = null
            _requiredGroupJid = null
            return null
        } finally {
            _requiredGroupPromise = null
        }
    })()
    
    return _requiredGroupPromise
}

export async function handler(chatUpdate) {
    this.msgqueque = this.msgqueque || new Queque()
    if (!chatUpdate)
        return
    let m = chatUpdate.messages[chatUpdate.messages.length - 1]
    if (!m)
        return
    if (db.data == null)
        await loadDatabase()

    try {

        const isUserInGroup = async (jid, groupJid) => {
            try {
                const meta = await this.groupMetadata(groupJid)

                if (meta.participants?.some(p => matchParticipant(this, p, jid)))
                    return true

                if (meta.isCommunity) {
                    const allGroups = await this.groupFetchAllParticipating()
                    const linkedGroups = Object.values(allGroups || {}).filter(g => g.linkedParent === groupJid)
                    console.log(`[GROUP ACCESS CHECK] Community terdeteksi. Grup turunan yang bot ikuti: ${linkedGroups.length}`, linkedGroups.map(g => ({ id: g.id, subject: g.subject, isCommunityAnnounce: g.isCommunityAnnounce, totalParticipants: g.participants?.length })))
                    for (const g of linkedGroups) {
                        if (g.participants?.some(p => matchParticipant(this, p, jid)))
                            return true
                    }
                    console.log(`[GROUP ACCESS CHECK] jid "${jid}" tidak ditemukan di semua grup turunan community.`)
                    return false
                }

                console.log(`[GROUP ACCESS CHECK] jid "${jid}" TIDAK ditemukan di grup ${groupJid}.`)
                console.log(`[GROUP ACCESS CHECK] Total participants: ${meta.participants?.length}`)
                console.log(`[GROUP ACCESS CHECK] Sample participant ids:`, meta.participants?.slice(0, 5).map(p => ({ id: p.id, phoneNumber: p.phoneNumber })))
                return false
            } catch (error) {
                console.error("[GROUP ACCESS CHECK] Error checking group/community membership:", error)
                return false
            }
        }

        const rawKey = m.key || {}
        const rawParticipant = m.participant || rawKey.participant || ''
        const rawPnFromKey = rawKey.participantPn || rawKey.senderPn || null
        const protoPN = rawPnFromKey
            ? (rawPnFromKey + '@s.whatsapp.net')
            : null

        m = smsg(this, m) || m
        if (!m)
            return

        let candidates = [
            protoPN,
            m.key?.participantPn ? m.key.participantPn + '@s.whatsapp.net' : null,
            m.key?.senderPn ? m.key.senderPn + '@s.whatsapp.net' : null,
            m.key?.participantAlt,
            m.key?.participant,
            m.key?.remoteJidAlt,
            m.key?.senderLid,
            m.sender,
        ].filter(Boolean)

        let actualNumber = candidates.find(jid => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net'))

        let lidNumber = candidates.find(jid => typeof jid === 'string' && jid.endsWith('@lid'))
        if (!lidNumber && rawParticipant?.endsWith?.('@lid')) lidNumber = rawParticipant

        if (lidNumber && !actualNumber) {
            actualNumber = await resolveLidToNumber(lidNumber, this, m.chat)
        }

        const isValidSender = m.sender &&
            (!m.sender.endsWith('@newsletter') || m.fromMe) &&
            !m.sender.endsWith('@broadcast') &&
            !m.sender.endsWith('@g.us')

        let resolvedUserKey = m.sender
        if (isValidSender && (actualNumber || lidNumber)) {
            resolvedUserKey = await updateUserMapping(m.sender, actualNumber, lidNumber)
        }

        const quotedRawSender = m.quoted?.sender
        if (quotedRawSender?.endsWith?.('@lid') && !db.data.users?.[quotedRawSender]?.number) {
            const quotedActualNumber = await resolveLidToNumber(quotedRawSender, this, m.chat)
            if (quotedActualNumber) {
                await updateUserMapping(quotedActualNumber, quotedActualNumber, quotedRawSender)
            }
        }

        m.exp = 0
        m.limit = false

        try {
            if (typeof db.data.chats[m.chat] !== 'object') db.data.chats[m.chat] = {}
            let chat = db.data.chats[m.chat]
            if (!('isBanned' in chat))     chat.isBanned = false
            if (!('welcome' in chat))      chat.welcome = false
            if (!('detect' in chat))       chat.detect = false
            if (!('sWelcome' in chat))     chat.sWelcome = ''
            if (!('sBye' in chat))         chat.sBye = ''
            if (!('sPromote' in chat))     chat.sPromote = ''
            if (!('sDemote' in chat))      chat.sDemote = ''
            if (!('delete' in chat))       chat.delete = false
            if (!('useDocument' in chat))  chat.useDocument = false
            if (!('viewonce' in chat))     chat.viewonce = false
            if (!('aiChat' in chat))     chat.aiChat = false
            if (!('aiSessionChat' in chat))
chat.aiSessionChat = []
            if (!isNumber(chat.expired))   chat.expired = 0
            if (!('antiLink' in chat))     chat.antiLink = false
            if (!('antispam' in chat))     chat.antispam = false
            if (!('antinsfw' in chat))     chat.antinsfw = false
        } catch (e) {
            if (e) console.error(e)
        }

        try {
            if (!isValidSender) throw null

            const userKey = resolvedUserKey || m.sender
            if (typeof db.data.users[userKey] !== 'object') db.data.users[userKey] = {}
            let user = db.data.users[userKey]

            if (!isNumber(user.exp))         user.exp = 0
            if (!isNumber(user.limit))       user.limit = 10
            if (!('registered' in user))     user.registered = false
            if (!user.registered) {
                if (!('name' in user))       user.name = m.name
                if (!('email' in user))      user.email = ''
                if (!isNumber(user.age))     user.age = -1
                if (!isNumber(user.regTime)) user.regTime = -1
            }
            if (!isNumber(user.afk))         user.afk = -1
            if (!('afkReason' in user))      user.afkReason = ''
            if (!('banned' in user))         user.banned = false
            if (!isNumber(user.warn))        user.warn = 0
            if (!isNumber(user.level))       user.level = 0
            if (!('password' in user))       user.password = ''
            if (!('premium' in user))        user.premium = false
            if (!isNumber(user.premiumTime)) user.premiumTime = 0
            if (actualNumber && !user.number) user.number = actualNumber
            if (lidNumber && !user.lid)      user.lid = lidNumber

        } catch (e) {
            if (e) console.error(e)
        }

        try {
            if (typeof db.data.settings[this.user.jid] !== 'object') db.data.settings[this.user.jid] = {}
            let settings = db.data.settings[this.user.jid]
            if (!('self' in settings))            settings.self = false
            if (!('restrict' in settings))        settings.restrict = false
            if (!isNumber(settings.status))       settings.status = 0
            if (!('anticall' in settings))        settings.anticall = true
            if (!('autoread' in settings))        settings.autoread = true
            if (!('autorestart' in settings))     settings.autorestart = false
            if (!('clearlag' in settings))        settings.clearlag = true
            if (!isNumber(settings.timeclearlag)) settings.timeclearlag = 0
            if (!isNumber(settings.restartDB))    settings.restartDB = 0
            if (!isNumber(settings.resetlimit))   settings.resetlimit = 0
        } catch (e) {
            if (e) console.error(e)
        }

        const isNewsletter = m.chat?.endsWith('@newsletter')

        if (global.opts['nyimak'])
            return
        if (!([this.decodeJid(Connection.conn.user.id), ...global.owner.map(([number]) => number)].map(v => v?.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender)) && !m.fromMe && global.opts['self'])
            return
        if (global.opts['pconly'] && m.chat.endsWith('g.us') && !isNewsletter)
            return
        if (global.opts['gconly'] && !m.chat.endsWith('g.us') && !isNewsletter)
            return
        if (global.opts['swonly'] && m.chat !== 'status@broadcast')
            return
        if (typeof m.text !== 'string')
            m.text = ''

        const isROwner = [this.decodeJid(Connection.conn.user.id), ...global.owner.map(([number]) => number)].map(v => v?.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender)
        const isOwner = isROwner || m.fromMe
        const isMods = isOwner || global.mods.map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender)
        const isPrems = isROwner || db.data.users[m.sender]?.premiumTime > 1 || false

        if (global.opts['queque'] && m.text && !m.fromMe && !(isMods || isPrems)) {
            const id = m.id
            this.msgqueque.add(id)
            await this.msgqueque.waitQueue(id)
        }

        if (m.isBaileys && !isNewsletter)
            return
        m.exp += Math.ceil(Math.random() * 20)

        if (isNewsletter) {
            const _pref = this.prefix ?? global.prefix
            const prefixRe = _pref instanceof RegExp ? _pref
                : Array.isArray(_pref) ? new RegExp('^[' + _pref.map(p => p.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')).join('') + ']')
                : new RegExp('^' + String(_pref).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'))
            const hasCustomPrefix = Object.values(plugins).some(p => {
                if (!p?.customPrefix) return false
                const re = p.customPrefix instanceof RegExp ? p.customPrefix : new RegExp(p.customPrefix)
                return re.test(m.text)
            })
            if (!prefixRe.test(m.text) && !hasCustomPrefix) return
        }

        let usedPrefix
        let _user = db.data?.users?.[resolvedUserKey] || {
            exp: 0, limit: 10, registered: false, banned: false,
            warn: 0, level: 0, role: 'user', premium: false, premiumTime: 0
        }

        const groupMetadata = (m.isGroup ? await Connection.store.fetchGroupMetadata(m.chat, this.groupMetadata) : {}) || {}
        const participants = (m.isGroup ? groupMetadata.participants : []) || []

        const senderLookup = actualNumber || m.sender
        const user = (m.isGroup ? participants.find(p =>
            matchParticipant(this, p, senderLookup) ||
            (lidNumber && matchParticipant(this, p, lidNumber))
        ) : {}) || {}

        const botJid = this.decodeJid(this.user.jid)
        const botNum = botJid.endsWith('@lid') ? null : botJid
        const bot = (m.isGroup ? participants.find(p =>
            matchParticipant(this, p, botJid) ||
            (botNum && matchParticipant(this, p, botNum)) ||
            matchParticipant(this, p, this.decodeJid(Connection.conn?.user?.id || ''))
        ) : {}) || {}

        const isRAdmin = user?.admin == 'superadmin' || false
        const isAdmin = isRAdmin || user?.admin == 'admin' || false
        const isBotAdmin = bot?.admin === 'superadmin' || bot?.admin === 'admin' || false

        const ___dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugins')
        const ___rootdir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../')

        for (let name in plugins) {
            let plugin = plugins[name]
            if (!plugin)
                continue
            if (plugin.disabled)
                continue
            const __filename = join(___rootdir, name)
            if (typeof plugin.all === 'function') {
                try {
                    await plugin.all.call(this, m, {
                        chatUpdate,
                        __dirname: ___dirname,
                        __filename
                    })
                } catch (e) {
                    console.error(e)
                    for (let [jid] of global.owner.filter(([number, _, isDeveloper]) => isDeveloper && number)) {
                        let data = (await this.onWhatsApp(jid))[0] || {}
                        if (data.exists)
                            m.reply(`*Plugin:* ${name}\n*Sender:* ${m.sender}\n*Chat:* ${m.chat}\n*Command:* ${m.text}\n\n\`\`\`${format(e)}\`\`\``.trim(), data.jid)
                    }
                }
            }
            if (!global.opts['restrict'])
                if (plugin.tags && plugin.tags.includes('admin')) {
                    continue
                }
            const str2Regex = str => str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
            let _prefix = plugin.customPrefix ? plugin.customPrefix : this.prefix ? this.prefix : global.prefix
            let match = (_prefix instanceof RegExp ?
                [[_prefix.exec(m.text), _prefix]] :
                Array.isArray(_prefix) ?
                    _prefix.map(p => {
                        let re = p instanceof RegExp ? p : new RegExp(str2Regex(p))
                        return [re.exec(m.text), re]
                    }) :
                    typeof _prefix === 'string' ?
                        [[new RegExp(str2Regex(_prefix)).exec(m.text), new RegExp(str2Regex(_prefix))]] :
                        [[[], new RegExp]]
            ).find(p => p[1])

            if (typeof plugin.before === 'function') {
                let beforeResult
                try {
                    beforeResult = await plugin.before.call(this, m, {
                        match,
                        conn: this,
                        participants,
                        groupMetadata,
                        user,
                        bot,
                        isROwner,
                        isOwner,
                        isRAdmin,
                        isAdmin,
                        isBotAdmin,
                        isPrems,
                        chatUpdate,
                        __dirname: ___dirname,
                        __filename
                    })
                } catch (e) {
                    console.error(`[plugin.before] error di '${name}':`, e)
                    continue
                }
                if (beforeResult)
                    continue
            }
            if (typeof plugin !== 'function')
                continue
            if ((usedPrefix = (match[0] || '')[0])) {
                let noPrefix = m.text.replace(usedPrefix, '')
                let [command, ...args] = noPrefix.trim().split` `.filter(v => v)
                args = args || []
                let _args = noPrefix.trim().split` `.slice(1)
                let text = _args.join` `
                command = (command || '').toLowerCase()
                let fail = plugin.fail || global.dfail
                let isAccept = plugin.command instanceof RegExp ?
                    plugin.command.test(command) :
                    Array.isArray(plugin.command) ?
                        plugin.command.some(cmd => cmd instanceof RegExp ? cmd.test(command) : cmd === command) :
                        typeof plugin.command === 'string' ?
                            plugin.command === command :
                            false

                if (!isAccept)
                    continue

                if (!isOwner && !m.chat.endsWith('@newsletter') && !m.chat.endsWith('@broadcast') && !db.data.chats[m.chat].isBanned) {
                    const chatData = db.data.chats[m.chat]
                    if (!chatData.isBanned) {
                        const requiredGroup = await getRequiredGroupId(this)
                        if (requiredGroup) {
                            const userInGroup = await isUserInGroup(m.sender, requiredGroup)
                            if (!userInGroup) {
                                const rawGroupId = (process.env.GROUP_ID || '').trim()
                                let joinUrl = rawGroupId.includes('chat.whatsapp.com') ? rawGroupId : null
                                if (!joinUrl) {
                                    try {
                                        joinUrl = "https://chat.whatsapp.com/" + await this.groupInviteCode(requiredGroup)
                                    } catch (error) {
                                        console.error("[GROUP ACCESS CHECK] Gagal generate invite link untuk tombol Join:", error)
                                    }
                                }
                                await this.sendButton(m.chat, {
                                    text: `Since the last update, You need to join this group before access the bot`,
                                    ...(joinUrl ? {
                                        nativeFlow: [{
                                            text: 'Join group',
                                            url: joinUrl
                                        }]
                                    } : {})
                                }, m)
                                continue
                            }
                        }
                    }
                }

                m.plugin = name
                if (m.chat in db.data.chats || m.sender in db.data.users) {
                    let chat = db.data.chats[m.chat]
                    let user = db.data.users[m.sender]
                    
                    if (!name.includes('tag') && !name.includes('banchat') && !name.includes('exec') && !name.includes('eval') && chat?.isBanned && !isOwner)
                        return
                    
                    if (!name.includes('unbanuser') && user?.banned && !isOwner)
                        return
                }
                if (plugin.rowner && plugin.owner && !(isROwner || isOwner)) {
                    fail('owner', m, this)
                    continue
                }
                if (plugin.rowner && !isROwner) {
                    fail('rowner', m, this)
                    continue
                }
                if (plugin.owner && !isOwner) {
                    fail('owner', m, this)
                    continue
                }
                if (plugin.mods && !isMods) {
                    fail('mods', m, this)
                    continue
                }
                if (plugin.premium && !isPrems) {
                    fail('premium', m, this)
                    continue
                }
                if (plugin.group && !m.isGroup) {
                    fail('group', m, this)
                    continue
                } else if (plugin.botAdmin && !isBotAdmin) {
                    fail('botAdmin', m, this)
                    continue
                } else if (plugin.admin && !isAdmin) {
                    fail('admin', m, this)
                    continue
                }
                if (plugin.private && m.isGroup) {
                    fail('private', m, this)
                    continue
                }
                if (plugin.register == true && _user.registered == false) {
                    fail('unreg', m, this)
                    continue
                }
                m.isCommand = true
                let xp = 'exp' in plugin ? parseInt(plugin.exp) : 1
                if (xp > 200)
                    m.react('')
                else
                    m.exp += xp

                if (!isPrems && plugin.limit && db.data.users[resolvedUserKey]?.limit < plugin.limit * 1) {
                	if (db.data.users[resolvedUserKey].registered == true) {
                                 this.reply(m.chat, "Please wait a few moments for the system to refill your limit.", m)
                                 continue
                         } else {
                                 this.sendUrlPreview(m.chat, await this.resize(img.profile.bot, 500, 500), global.getServerUrl(), `Start registering to get more limits.`, `_____________________________\n`,7, m)
                                 continue
                          }
                }
                if (plugin.level > _user.level) {
                    this.sendUrlPreview(m.chat, await this.resize(img.profile.bot, 500, 500), global.getServerUrl(), `Tier ${global.tierAsset.name[plugin.level]} required`,`_____________________________\nPlease upgrade your tier on our website\n\n`,7, m)
             continue
                }
                let extra = {
                    match,
                    usedPrefix,
                    noPrefix,
                    _args,
                    args,
                    command,
                    text,
                    conn: this,
                    participants,
                    groupMetadata,
                    user,
                    bot,
                    isROwner,
                    isOwner,
                    isRAdmin,
                    isAdmin,
                    isBotAdmin,
                    isPrems,
                    chatUpdate,
                    __dirname: ___dirname,
                    __filename
                }
                try {
                    await plugin.call(this, m, extra)
                    if (!isPrems)
                        m.limit = m.limit || plugin.limit || false
                } catch (e) {
                    m.error = e
                    console.error(e)

                   
                    if (!(e instanceof Error)) {
                        if (e) m.reply(String(e))
                    } else {
                        let text = format(e)
                        if (e.name)
                            for (let [jid] of global.owner.filter(([number, _, isDeveloper]) => isDeveloper && number)) {
                                let data = (await this.onWhatsApp(jid))[0] || {}
                                if (data.exists)
                                    m.reply(`>  *Plugins :* ${m.plugin}\n>  *Sender :* @${m.sender.split`@`[0]}\n>  *Chat :* ${m.chat}\n>  *Command :* ${usedPrefix}${command} ${args.join(' ')}\n\n\n\`\`\`${text}\`\`\``.trim(), data.jid)
                            }
                        m.reply(text)

                        try {
                            await autoHeal(this, m, e, m.plugin || command || 'unknown')
                        } catch (healErr) {
                            console.error('[ AutoHeal ] Failed:', healErr.message)
                        }
                    }
                } finally {
                    if (typeof plugin.after === 'function') {
                        try {
                            await plugin.after.call(this, m, extra)
                        } catch (e) {
                            console.error(e)
                        }
                    }
                    if (m.limit)
                        this.reply(m.chat, ((db.data.users[resolvedUserKey].limit) - 1) + " Limit(s) remaining", { key: { participant: m.sender }, message: { newsletterAdminInviteMessage: { newsletterJid: '120363280758084443@newsletter', newsletterName: '.', caption: "       -" + (+m.limit) + " Limit" } } })
                }
                break
            }
        }
    } catch (e) {
        console.error(e)
    } finally {
        if (global.opts['queque'] && m.text) {
            const id = m.id
            this.msgqueque.unqueue(id)
        }
        let user, stats = db.data.stats
        if (m) {
            if (m.sender && !m.sender.endsWith('@g.us') && (user = db.data.users[m.sender])) {
                user.exp += m.exp
                if (!m.error) {
                     user.limit -= m.limit * 1
                }
            }

            let stat
            if (m.plugin) {
                let now = +new Date
                if (m.plugin in stats) {
                    stat = stats[m.plugin]
                    if (!isNumber(stat.total))      stat.total = 1
                    if (!isNumber(stat.success))    stat.success = m.error != null ? 0 : 1
                    if (!isNumber(stat.last))       stat.last = now
                    if (!isNumber(stat.lastSuccess)) stat.lastSuccess = m.error != null ? 0 : now
                } else
                    stat = stats[m.plugin] = {
                        total: 1,
                        success: m.error != null ? 0 : 1,
                        last: now,
                        lastSuccess: m.error != null ? 0 : now
                    }
                stat.total += 1
                stat.last = now
                if (m.error == null) {
                    stat.success += 1
                    stat.lastSuccess = now
                }
            }
        }

        try {
            if (!global.opts['noprint']) await printMessage(m, this)
        } catch (e) {
            console.log(m, m.quoted, e)
        }
        if (global.opts['autoread'])
            await this.readMessages([m.key])
    }
}

export async function participantsUpdate({ id, participants, action }) {
    if (global.opts['self'])
        return
    if (this.isInit)
        return
    if (db.data == null)
        await loadDatabase()
    let chat = db.data.chats[id] || {}
    let text = ''
    switch (action) {
        case 'add':
        case 'remove':
            if (chat.welcome) {
                let groupMetadata = await Connection.store.fetchGroupMetadata(id, this.groupMetadata)
                for (let participant of participants) {
                    
                    const participantId = typeof participant === 'string' ? participant : participant.id
                    const participantName = participantId.split('@')[0]
                    
                    let pp = 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg'
                    let eventJoin = ''
                    try {
                        pp = await this.profilePictureUrl(participantId, 'image')
                    } catch (e) {
                    } finally {
                        text = (action === 'add' ? (chat.sWelcome || this.welcome || Connection.conn.welcome || 'Welcome, @user!').replace('@subject', await this.getName(id)).replace('@desc', groupMetadata.desc?.toString() || ' ') :
                            (chat.sBye || this.bye || Connection.conn.bye || 'Bye, @user!')).replace('@user', '@' + participantName)
                         eventJoin = ( action === 'add' ? 'W E L C O M E' : 'G O O D   B Y E')
                        this.sendLocUrl(id, pp, eventJoin, null, text, null, "", null, { mentions: this.parseMention(text) })
                    }
                }
            }
            break
        case 'promote':
            text = (chat.sPromote || this.spromote || Connection.conn.spromote || '@user ```is now Admin```')
        case 'demote':
            if (!text)
                text = (chat.sDemote || this.sdemote || Connection.conn.sdemote || '@user ```is no longer Admin```')
            const demoterParticipant = participants[0]
            const demoterParticipantId = typeof demoterParticipant === 'string' ? demoterParticipant : demoterParticipant.id
            text = text.replace('@user', '@' + demoterParticipantId.split('@')[0])
            if (chat.detect)
                this.sendMessage(id, { text, mentions: this.parseMention(text) })
            break
    }
}

export async function groupsUpdate(groupsUpdate) {
    if (global.opts['self'])
        return
    for (const groupUpdate of groupsUpdate) {
        const id = groupUpdate.id
        if (!id) continue
        let chats = db.data.chats[id], text = ''
        if (!chats?.detect) continue
        if (groupUpdate.desc) text = (chats.sDesc || this.sDesc || Connection.conn.sDesc || '> Description has been changed').replace('@desc', groupUpdate.desc)
        if (groupUpdate.subject) text = (chats.sSubject || this.sSubject || Connection.conn.sSubject || '> Subject has been changed').replace('@subject', groupUpdate.subject)
        if (groupUpdate.icon) text = (chats.sIcon || this.sIcon || Connection.conn.sIcon || '> Icon has been changed').replace('@icon', groupUpdate.icon)
        if (groupUpdate.revoke) text = (chats.sRevoke || this.sRevoke || Connection.conn.sRevoke || '> Group link has been changed').replace('@revoke', groupUpdate.revoke)
        if (!text) continue
        await this.sendMessage(id, { text, mentions: this.parseMention(text) })
    }
}

export async function deleteUpdate(message) {
    if (Array.isArray(message.keys) && message.keys.length > 0) {
        const tasks = await Promise.allSettled(message.keys.map(async (key) => {
            if (key.fromMe) return
            const msg = this.loadMessage(key.remoteJid, key.id) || this.loadMessage(key.id)
            if (!msg || !msg.message) return
            let chat = db.data.chats[key.remoteJid]
            if (!chat || !chat.delete) return

            const mtype = getContentType(msg.message)
            if (mtype === 'conversation') {
                msg.message.extendedTextMessage = { text: msg.message[mtype] }
                delete msg.message[mtype]
            }

            await this.reply(key.remoteJid, `- Deleted / edited Message Detected`.trim(), msg)
            return await this.copyNForward(key.remoteJid, msg).catch(e => console.log(e, msg))
        }))
        tasks.map(t => t.status === 'rejected' && console.error(t.reason))
    }
}

export async function onCall(info) {
    let ciko = db.data.settings[this.user.jid].anticall
    let data = global.owner.filter(([id, isCreator]) => id && isCreator)
    if (!ciko) return
    console.log(info)
    for (let tihh of info) {
        if (tihh.isGroup == false) {
            if (tihh.status == "offer") {
                await this.reply(tihh.from, `> *${this.user.name}* tidak bisa menerima panggilan ${tihh.isVideo ? `video` : `suara`}. Maaf @${tihh.from.split('@')[0]} kamu akan diblokir. Jika tidak sengaja silahkan hubungi Owner untuk dibuka !`, null, { mentions: [tihh.from] })
                this.sendContact(tihh.from, data.map(([id, name]) => [id, name]), null)
                new Promise((resolve, reject) => setTimeout(resolve, 8000))
                await this.updateBlockStatus(tihh.from, "block")
            }
        }
    }
}

global.dfail = async (type, m, conn) => {
    let msg = {
        rowner:   { text: ' ', body: 'This command is only for developer bot' },
        owner:    { text: ' ', body: 'This command is only for bot owners' },
        mods:     { text: ' ', body: 'This command is only for bot moderators.' },
        premium:  { text: ' ', body: 'This command is only for premium users.' },
        group:    { text: ' ', body: 'This command can only be used in group chat.' },
        private:  { text: ' ', body: 'This command can only be used in private chat' },
        admin:    { text: ' ', body: 'This command can only be used by the admin group.' },
        botAdmin: { text: '  ', body: 'This command can only be used if the bot is an admin.' },
        restrict: { text: '', body: 'Restrict is disabled in this chat' },
        unreg:    { text: " ", body: `Sorry User, You can only use this command after registering to the bot database.\n> ${global.getServerUrl()}` }
    }[type]
    if (msg) return await conn.sendMessage(m.chat, {
        document: { url: img.profile.bot },
        jpegThumbnail: await conn.resize(await (await fetch("https://telegra.ph/file/f5c3d077e1950d1ecaeb8.jpg")).buffer(), 100, 100),
        mimetype: 'image/webp',
        fileName: msg.text,
        fileLength: '665666646645000',
        pageCount: '666',
        caption: msg.body,
    }, { quoted: { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: await conn.resize(img.profile.sender, 150, 150), itemCount: 666, status: 1, surface: 1, message: "", orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } } })
}

let file = Helper.__filename(import.meta.url, true)
watchFile(file, async () => {
    unwatchFile(file)
    console.log(chalk.greenBright(" [ Update 'handler.js' ]"))
    if (Connection.reload) console.log(await Connection.reload(await Connection.conn))
})