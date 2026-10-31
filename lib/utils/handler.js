import { smsg, matchParticipant, resolveLidToNumber, updateUserMapping, autoMergeLidUsers, decodeJid } from './simple.js';
import { plugins, usageLine } from './plugins.js';
import { format } from 'util';
import { fileURLToPath } from 'url';
import path, { join } from 'path';
import chalk from './color.js';
import { printEntry, sizeLabel, printDiscord } from './print.js';
export { printDiscord } from './print.js';
import Connection from './connection.js';
import db, { loadDatabase, ensureUserDefaults, ensureChatDefaults, ensureSettingsDefaults, scheduleAutosave, getDiscordAccount } from './database.js';
global.db = db;
import { handleError as autoHeal } from '../package/ai/mcp.js';
import EventEmitter from 'events';
import fs from 'fs';
import axios from 'hiro/axios';
import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { FLAGS } from '../package/discord/permissions.js';
import { toRequest } from '../package/discord/structures.js';
import { smsgDiscord } from './simple.js';
import { waToDiscord, chunkText } from '../package/discord/text.js';
import { resolveMedia, buildGallery } from '../package/discord/payload.js';
import { canvas } from 'hiro/canvas';
const { getContentType, proto, generateWAMessageFromContent, areJidsSameUser } = await import('baileys');
const isNumber = x => typeof x === 'number' && !isNaN(x);
const delay = ms => isNumber(ms) && new Promise(resolve => setTimeout(resolve, ms));


const chatPrefixOf = chatId => {
  const value = global.db?.data?.chats?.[chatId]?.prefix
  return typeof value === 'string' && value ? value : null
}

function levenshtein(a, b) {
  const matrix = [];
  for (let i = 0; i <= b.length; i++) matrix[i] = [i];
  for (let j = 0; j <= a.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b[i - 1] === a[j - 1]) matrix[i][j] = matrix[i - 1][j - 1];
      else matrix[i][j] = Math.min(
        matrix[i - 1][j - 1] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j] + 1
      );
    }
  }
  return matrix[b.length][a.length];
}

function didYouMean(word, list) {
  if (!word || word.length < 2) return null;

  const threshold = word.length <= 4
    ? 1
    : Math.max(1, Math.floor(word.length * 0.25));

  let best = null;
  let bestScore = Infinity;
  let bestLen = -1;

  for (const item of list) {
    if (Math.abs(item.length - word.length) > threshold) continue;

    const score = levenshtein(word, item);
    if (score === 0 || score > threshold) continue;

    if (score < bestScore || (score === bestScore && item.length > bestLen)) {
      best = item;
      bestScore = score;
      bestLen = item.length;
    }
  }

  return best;
}

function extractCommandNames(regex) {
  if (!(regex instanceof RegExp)) return [];
  return regex.source
    .replace(/^\^|\$$/g, '')
    .replace(/\(\?:|[()?]/g, '')
    .split('|')
    .map(s => s.replace(/\\(.)/g, '$1').trim().toLowerCase())
    .filter(s => /^[a-z0-9_-]+$/i.test(s));
}

function helpToNames(help) {
  if (!Array.isArray(help)) return [];
  return help
    .map(h => String(h).trim().split(/\s+/)[0]?.toLowerCase())
    .filter(s => s && /^[a-z0-9_-]+$/i.test(s));
}


async function eventSystemBefore(m, { match, groupMetaData, command, isAdmin, isBotAdmin } = {}) {

  const db_users = db.data.users
  const db_chats = db.data.chats
  const setting  = db.data.settings[this.user?.jid || '']
  const user     = db_users[m.sender]
  const chat     = db_chats[m.chat]

  global.img = {
    profile: {
      bot: await this.profilePictureUrl(this.user.jid, 'image').catch(_ => 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg'),
      sender: await this.profilePictureUrl(m.sender, 'image').catch(_ => 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg'),
    }
  }

  if (!user || !chat || !setting) return

  if (user.premium && user.premiumTime && Date.now() >= user.premiumTime) {
    user.premium     = false
    user.premiumTime = 0
  }

  if (global.settings.system.autoblocknumber.some(p => m.sender?.startsWith(p))) {
    return this.updateBlockStatus(m.sender, 'block')
  }

  const usedPrefix = (match?.[0] || '')[0]
  if (usedPrefix) {
    const noPrefix      = (m.text?.slice(usedPrefix.length).trim() || '').split(/\s+/)[0]
    const allPlugins    = Object.values(plugins).filter(v => !v.disabled)
    const alias         = [...new Set(
      allPlugins.flatMap(v => [
        ...(v.command instanceof RegExp ? extractCommandNames(v.command) : []),
        ...helpToNames(v.help)
      ])
    )]

    const PROBE = '\u0000__zzqqxx_nonsense_probe_42__\u0000'
    const safeTest = (regex, str) => {
      if (!(regex instanceof RegExp)) return false
      try {
        regex.lastIndex = 0
        const result = regex.test(str)
        regex.lastIndex = 0
        return result
      } catch {
        return false
      }
    }
    const isSaneCommandRegex = (regex) => !safeTest(regex, PROBE)

    const isRealCommand = !!noPrefix && allPlugins.some(v => {
      if (v.command instanceof RegExp) {
        if (!isSaneCommandRegex(v.command)) return false
        return safeTest(v.command, noPrefix)
      }
      if (typeof v.command === 'string') return v.command.toLowerCase() === noPrefix.toLowerCase()
      if (Array.isArray(v.command)) return v.command.some(c => String(c).toLowerCase() === noPrefix.toLowerCase())
      return helpToNames(v.help).includes(noPrefix.toLowerCase())
    })

    const matchesCustomPrefix = allPlugins.some(v => {
      if (!v.customPrefix) return false
      const re = v.customPrefix instanceof RegExp ? v.customPrefix : new RegExp(v.customPrefix)
      return re.test(m.text)
    })

    if (noPrefix && !isRealCommand && !matchesCustomPrefix) {
      const mean = didYouMean(noPrefix.toLowerCase(), alias)
      if (mean && !chat.isBanned && global.settings.system.didyoumean && !(m.id).startsWith("3EB0")) { this.reply(m.chat, `Did You Mean: \`${usedPrefix + mean}\`?`, m) }
    }
  }

  const skipTypes = ['protocolMessage', 'pollUpdateMessage', 'reactionMessage']
  if (
    m.isBaileys ||
    skipTypes.includes(m.mtype) ||
    !m.msg || !m.message ||
    m.key.remoteJid !== m.chat ||
    user.banned ||
    chat.isBanned
  ) return

  const isGroupLink = /chat.whatsapp.com\/(?:invite\/)?([0-9A-Za-z]{20,24})/i.exec(m.text)
  if (chat.antiLink && isGroupLink && !isAdmin) {
    if (isBotAdmin) {
      const linkThisGroup = `https://chat.whatsapp.com/${await this.groupInviteCode(m.chat)}`
      if (m.text.includes(linkThisGroup)) return !0
      await this.sendMessage(m.chat, { delete: m.key })
    }
  }

}


async function eventButtonResponseAll(m, chatUpdate) {
    if (m.isBaileys) return
    if (!m.message) return

    const isInteractive = m.mtype === "interactiveResponseMessage"
    const isNativeFlow = !!m.message.nativeFlowResponseMessage
    const isButtons = !!m.message.buttonsResponseMessage
    const isTemplate = !!m.message.templateButtonReplyMessage
    const isList = !!m.message.listResponseMessage

    if (!(isInteractive || isNativeFlow || isButtons || isTemplate || isList)) return

    let id
    if (isButtons) {
        id = m.message.buttonsResponseMessage.selectedButtonId
    } else if (isTemplate) {
        id = m.message.templateButtonReplyMessage.selectedId
    } else if (isList) {
        id = m.message.listResponseMessage.singleSelectReply?.selectedRowId
    } else if (isInteractive || isNativeFlow) {
        try {
            const nativeFlow = m.message.interactiveResponseMessage?.nativeFlowResponseMessage
                ?? m.message.nativeFlowResponseMessage
            id = JSON.parse(nativeFlow?.paramsJson || '{}')?.id
        } catch (e) {
            id = null
        }
    }

    let text = m.message.buttonsResponseMessage?.selectedDisplayText
        || m.message.templateButtonReplyMessage?.selectedDisplayText
        || m.message.listResponseMessage?.title
        || id

    if (!id && !text) return

    let isIdMessage = false, usedPrefix

    for (let name in plugins) {
        let plugin = plugins[name]
        if (!plugin) continue
        if (plugin.disabled) continue
        if (typeof plugin !== 'function') continue
        if (!plugin.command) continue

        const str2Regex = str => '^' + str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&')
        let _prefix = plugin.customPrefix ? plugin.customPrefix : this.prefix ? this.prefix : global.prefix
        let match = (
            _prefix instanceof RegExp ?
                [[_prefix.exec(id), _prefix]] :
            Array.isArray(_prefix) ?
                _prefix.map(p => {
                    let re = p instanceof RegExp ? p : new RegExp(str2Regex(p))
                    return [re.exec(id), re]
                }) :
            typeof _prefix === 'string' ?
                [[new RegExp(str2Regex(_prefix)).exec(id), new RegExp(str2Regex(_prefix))]] :
                [[null, null]]
        ).find(p => p[0]) || [null, null]

        if ((usedPrefix = (match[0] || '')[0])) {
            let noPrefix = id.replace(usedPrefix, '')
            let [command] = noPrefix.trim().split` `.filter(v => v)
            command = (command || '').toLowerCase()

            let isId = plugin.command instanceof RegExp ?
                plugin.command.test(command) :
            Array.isArray(plugin.command) ?
                plugin.command.some(cmd => cmd instanceof RegExp ? cmd.test(command) : cmd === command) :
            typeof plugin.command === 'string' ?
                plugin.command === command :
                false

            if (!isId) continue
            isIdMessage = true
        }
    }

    const finalText = isIdMessage ? id : (text || id || '')
    if (!finalText) return

    let quotedObj = null
    if (m.quoted) {
        try {
            const fakeObj = m.quoted.fakeObj
            if (fakeObj && typeof fakeObj === 'object') {
                const msgContent = fakeObj.message ? { ...fakeObj.message } : {}
                const msgType = Object.keys(msgContent)[0]

                if (msgType && msgContent[msgType] && typeof msgContent[msgType] === 'object') {

                    if (!msgContent[msgType].contextInfo) {
                        msgContent[msgType] = {
                            ...msgContent[msgType],
                            contextInfo: {}
                        }
                    }
                    quotedObj = { ...fakeObj, message: msgContent }
                }
            }
        } catch (e) {
            console.error('Failed to build quotedObj:', e)
            quotedObj = null
        }
    }

    const messageOptions = {
        userJid: this.user.id,
        ...(quotedObj ? { quoted: quotedObj } : {})
    }

    const contentObj = {
        extendedTextMessage: {
            text: finalText,
            ...(m.mentionedJid?.length
                ? { contextInfo: { mentionedJid: m.mentionedJid } }
                : {}
            )
        }
    }

    let messages = await generateWAMessageFromContent(m.chat, contentObj, messageOptions)

    messages.key.fromMe = areJidsSameUser(m.sender, this.user.id)
    messages.key.id = m.key.id
    messages.pushName = m.name
    if (m.isGroup)
        messages.key.participant = messages.participant = m.sender

    let msg = {
        ...chatUpdate,
        messages: [proto.WebMessageInfo.fromObject(messages)].map(v => (v.conn = this, v)),
        type: 'append'
    }
    this.ev.emit('messages.upsert', msg)
}


class Queue extends EventEmitter {
    _queue = new Set();
    constructor() { super(); }
    add(item) { this._queue.add(item); }
    has(item) { return this._queue.has(item); }
    delete(item) { this._queue.delete(item); }
    first() { return [...this._queue].shift(); }
    isFirst(item) { return this.first() === item; }
    last() { return [...this._queue].pop(); }
    isLast(item) { return this.last() === item; }
    getIndex(item) { return [...this._queue].indexOf(item); }
    getSize() { return this._queue.size; }
    isEmpty() { return this.getSize() === 0; }
    unqueue(item) {
        let queue;
        if (item) {
            if (this.has(item)) {
                queue = item;
                const isFirst = this.isFirst(item);
                if (!isFirst) {
                    throw new Error('Item is not first in queue');
                }
            }
        }
        else {
            queue = this.first();
        }
        if (queue) {
            this.delete(queue);
            this.emit(queue);
        }
    }
    waitQueue(item, timeoutMs = 60 * 1000) {
        return new Promise((resolve, reject) => {
            if (this.has(item)) {
                let timer = null;
                const cleanup = () => {
                    if (timer)
                        clearTimeout(timer);
                    this.off(item, solve);
                };
                const solve = async (removeQueue = false) => {
                    cleanup();
                    await delay(5 * 1000);
                    if (removeQueue)
                        this.unqueue(item);
                    if (!this.isEmpty())
                        this.unqueue();
                    resolve();
                };
                if (this.isFirst(item)) {
                    solve(true);
                }
                else {
                    this.once(item, solve);
                    timer = setTimeout(() => {
                        cleanup();
                        this.delete(item);
                        reject(new Error(`waitQueue timeout after ${timeoutMs}ms for item`));
                    }, timeoutMs);
                }
            }
            else {
                reject(new Error('item not found'));
            }
        });
    }
}
async function printMessage(m, conn = { user: {} }) {
    try {
        let senderJid = m.sender;
        if (m.chat?.endsWith?.('@newsletter')) {
            const nlParticipant = m.key?.participant || m.participant;
            if (!nlParticipant || nlParticipant === m.chat)
                senderJid = m.chat;
        }
        let name = await conn.getName(senderJid).catch?.(() => '') || '';
        let senderLabel = name
            ? `${chalk.gray('(' + name + ')')} ${chalk.gray(senderJid)}`
            : chalk.gray(senderJid || 'unknown');
        let mtype = m.mtype
            ? m.mtype.replace(/message$/i, '').replace('audio', m.msg?.ptt ? 'PTT' : 'Audio').replace(/^./, v => v.toUpperCase())
            : '-';
        let typeLabel = m.isCommand
            ? `${chalk.gray(mtype)} ${chalk.greenBright('(Command)')}`
            : chalk.gray(mtype);
        let filesize = m.msg?.fileLength?.low || m.msg?.fileLength || m.text?.length || 0;
        let raw = typeof m.text === 'string' && m.text ? m.text : '-';
        let msgText = raw.length > 60 ? raw.slice(0, 60) + '...' : raw;
        printEntry({
            sender: senderLabel,
            type: typeLabel,
            size: sizeLabel(filesize),
            message: msgText,
            error: !!m.error,
        });
    }
    catch (e) {
        console.error('print.js >', e.message);
    }
}
setInterval(autoMergeLidUsers, 30 * 60 * 1000);
setTimeout(autoMergeLidUsers, 5000);
export async function handler(chatUpdate) {
    this.msgqueue = this.msgqueue || new Queue();
    if (!chatUpdate)
        return;
    let m = chatUpdate.messages[chatUpdate.messages.length - 1];
    if (!m)
        return;
    if (db.data == null)
        await loadDatabase();
    try {
        const rawKey = m.key || {};
        const rawParticipant = m.participant || rawKey.participant || '';
        const rawPnFromKey = rawKey.participantPn || rawKey.senderPn || null;
        
        
        
        
        
        
        
        const protoPN = rawPnFromKey
            ? decodeJid(rawPnFromKey + '@s.whatsapp.net')
            : null;
        m = smsg(this, m) || m;
        if (!m)
            return;
        let candidates = [
            protoPN,
            m.key?.participantPn ? decodeJid(m.key.participantPn + '@s.whatsapp.net') : null,
            m.key?.senderPn ? decodeJid(m.key.senderPn + '@s.whatsapp.net') : null,
            m.key?.participantAlt,
            m.key?.participant,
            m.key?.remoteJidAlt,
            m.key?.senderLid,
            m.sender,
        ].filter(Boolean);
        let actualNumber = candidates.find(jid => typeof jid === 'string' && jid.endsWith('@s.whatsapp.net'));
        let lidNumber = candidates.find(jid => typeof jid === 'string' && jid.endsWith('@lid'));
        if (!lidNumber && rawParticipant?.endsWith?.('@lid'))
            lidNumber = rawParticipant;
        if (lidNumber && !actualNumber) {
            actualNumber = await resolveLidToNumber(lidNumber, this, m.chat, m.key?.participantUsername || m.key?.remoteJidUsername);
        }
        const isValidSender = m.sender &&
            (!m.sender.endsWith('@newsletter') || m.fromMe) &&
            !m.sender.endsWith('@broadcast') &&
            !m.sender.endsWith('@g.us');
        let resolvedUserKey = m.sender;
        if (isValidSender && (actualNumber || lidNumber)) {
            resolvedUserKey = await updateUserMapping(m.sender, actualNumber, lidNumber);
        }
        const quotedRawSender = m.quoted?.sender;
        if (quotedRawSender?.endsWith?.('@lid') && !db.data.users?.[quotedRawSender]?.number) {
            const quotedActualNumber = await resolveLidToNumber(quotedRawSender, this, m.chat);
            if (quotedActualNumber) {
                await updateUserMapping(quotedActualNumber, quotedActualNumber, quotedRawSender);
            }
        }
        m.exp = 0;
        m.limit = false;
        try {
            ensureChatDefaults(m.chat);
        }
        catch (e) {
            if (e)
                console.error(e);
        }
        try {
            if (!isValidSender)
                throw null;
            const userKey = resolvedUserKey || m.sender;
            let user = ensureUserDefaults(userKey, { name: m.name });
            if (actualNumber && !user.number)
                user.number = actualNumber;
            if (lidNumber && !user.lid)
                user.lid = lidNumber;
        }
        catch (e) {
            if (e)
                console.error(e);
        }
        try {
            ensureSettingsDefaults(this.user.jid);
        }
        catch (e) {
            if (e)
                console.error(e);
        }
        const isNewsletter = m.chat?.endsWith('@newsletter');
        if (m.chat === 'status@broadcast' && !m.fromMe) {
            const reactCfg = global.settings.system?.autoReactStatus;
            if (Array.isArray(reactCfg) && reactCfg[0] && Array.isArray(reactCfg[1]) && reactCfg[1].length) {
                const emoji = reactCfg[1][Math.floor(Math.random() * reactCfg[1].length)];
                this.sendMessage('status@broadcast', { react: { text: emoji, key: m.key } }, { statusJidList: [m.sender] }).catch(() => {});
            }
        }
        if (global.opts['nyimak'])
            return;
        if (!([this.decodeJid(Connection.conn.user.id), ...global.settings.owner.map(([number]) => number)].map(v => v?.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender)) && !m.fromMe && global.opts['self'])
            return;
        if (global.opts['pconly'] && m.chat.endsWith('g.us') && !isNewsletter)
            return;
        if (global.opts['gconly'] && !m.chat.endsWith('g.us') && !isNewsletter)
            return;
        if (global.opts['swonly'] && m.chat !== 'status@broadcast')
            return;
        if (typeof m.text !== 'string')
            m.text = '';
        const isROwner = [this.decodeJid(Connection.conn.user.id), ...global.settings.owner.map(([number]) => number)].map(v => v?.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender);
        const isOwner = isROwner || m.fromMe;
        const isMods = isOwner || global.settings.mods.map(v => v.replace(/[^0-9]/g, '') + '@s.whatsapp.net').includes(m.sender);
        const isPrems = isROwner || db.data.users[m.sender]?.premiumTime > 1 || false;
        if (global.opts['queue'] && m.text && !m.fromMe && !(isMods || isPrems)) {
            const id = m.id;
            this.msgqueue.add(id);
            await this.msgqueue.waitQueue(id);
        }
        if (m.isBaileys && !isNewsletter)
            return;
        if ((m.id || '').startsWith('3EB0') && !isNewsletter)
            return;
        m.exp += Math.ceil(Math.random() * 20);
        if (isNewsletter) {
            const _pref = this.prefix ?? global.prefix;
            const prefixRe = _pref instanceof RegExp ? _pref
                : Array.isArray(_pref) ? new RegExp('^[' + _pref.map(p => p.replace(/[\\^$*+?.()|[\]{}]/g, '\\$&')).join('') + ']')
                    : new RegExp('^' + String(_pref).replace(/[\\^$*+?.()|[\]{}]/g, '\\$&'));
            const hasCustomPrefix = Object.values(plugins).some(p => {
                if (!p?.customPrefix)
                    return false;
                const re = p.customPrefix instanceof RegExp ? p.customPrefix : new RegExp(p.customPrefix);
                return re.test(m.text);
            });
            if (!prefixRe.test(m.text) && !hasCustomPrefix)
                return;
        }
        let usedPrefix;
        let _user = db.data?.users?.[resolvedUserKey] || {
            exp: 0, limit: 10, registered: false, banned: false,
            warn: 0, level: 0, role: 'user', premium: false, premiumTime: 0
        };
        const groupMetadata = (m.isGroup ? await Connection.store.fetchGroupMetadata(m.chat, this.groupMetadata) : {}) || {};
        const participants = (m.isGroup ? groupMetadata.participants : []) || [];
        let senderNumberJid = actualNumber;
        if (!senderNumberJid) {
            if (m.sender?.endsWith?.('@s.whatsapp.net')) {
                senderNumberJid = m.sender;
            } else if (m.sender?.endsWith?.('@lid')) {
                senderNumberJid = await resolveLidToNumber(m.sender, this, m.chat).catch(() => null);
            }
        }
        const senderLookup = senderNumberJid || m.sender;
        const user = (m.isGroup ? participants.find(p => {
            const pn = p.phoneNumber || p.pn || p.phone_number || '';
            return matchParticipant(this, p, senderLookup) ||
                (pn && senderLookup && pn.split('@')[0] === senderLookup.split('@')[0]);
        }) : {}) || {};
        const botJid = this.decodeJid(this.user.jid);
        let botNumberJid = botJid?.endsWith?.('@s.whatsapp.net') ? botJid : null;
        if (!botNumberJid && botJid?.endsWith?.('@lid')) {
            botNumberJid = await resolveLidToNumber(botJid, this, m.chat).catch(() => null);
        }
        const bot = (m.isGroup ? participants.find(p => {
            const pn = p.phoneNumber || p.pn || p.phone_number || '';
            return matchParticipant(this, p, botJid) ||
                (botNumberJid && matchParticipant(this, p, botNumberJid)) ||
                (pn && botNumberJid && pn.split('@')[0] === botNumberJid.split('@')[0]) ||
                matchParticipant(this, p, this.decodeJid(Connection.conn?.user?.id || ''));
        }) : {}) || {};
        const isRAdmin = user?.admin == 'superadmin' || false;
        const isAdmin = isRAdmin || user?.admin == 'admin' || false;
        const isBotAdmin = bot?.admin === 'superadmin' || bot?.admin === 'admin' || false;
        const ___dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../plugins');
        const ___rootdir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../');

        
        try {
            await eventButtonResponseAll.call(this, m, chatUpdate);
        }
        catch (e) {
            console.error(e);
            for (let [jid] of global.settings.owner.filter(([number, _, isDeveloper]) => isDeveloper && number)) {
                let data = (await this.onWhatsApp(jid))[0] || {};
                if (data.exists)
                    m.reply(`*Plugin:* plugins/_event/buttonResponse.js\n*Sender:* ${m.sender}\n*Chat:* ${m.chat}\n*Command:* ${m.text}\n\n\`\`\`${format(e)}\`\`\``.trim(), data.jid);
            }
        }

        
        {
            const str2Regex = str => '^' + str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
            let _defPrefix = chatPrefixOf(m.chat) || (this.prefix ? this.prefix : global.prefix);
            let _defMatch = (_defPrefix instanceof RegExp ?
                [[_defPrefix.exec(m.text), _defPrefix]] :
                Array.isArray(_defPrefix) ?
                    _defPrefix.map(p => {
                        let re = p instanceof RegExp ? p : new RegExp(str2Regex(p));
                        return [re.exec(m.text), re];
                    }) :
                    typeof _defPrefix === 'string' ?
                        [[new RegExp(str2Regex(_defPrefix)).exec(m.text), new RegExp(str2Regex(_defPrefix))]] :
                        [[null, null]]).find(p => p[0]) || [null, null];
            try {
                await eventSystemBefore.call(this, m, { match: _defMatch, isAdmin, isBotAdmin });
            }
            catch (e) {
                console.error(`[plugin.before] error in 'plugins/_event/system.js':`, e);
            }
        }

        for (let name in plugins) {
            let plugin = plugins[name];
            if (!plugin)
                continue;
            if (plugin.disabled)
                continue;
            const __filename = join(___rootdir, name);
            if (typeof plugin.all === 'function') {
                try {
                    await plugin.all.call(this, m, {
                        chatUpdate,
                        __dirname: ___dirname,
                        __filename
                    });
                }
                catch (e) {
                    console.error(e);
                    for (let [jid] of global.settings.owner.filter(([number, _, isDeveloper]) => isDeveloper && number)) {
                        let data = (await this.onWhatsApp(jid))[0] || {};
                        if (data.exists)
                            m.reply(`*Plugin:* ${name}\n*Sender:* ${m.sender}\n*Chat:* ${m.chat}\n*Command:* ${m.text}\n\n\`\`\`${format(e)}\`\`\``.trim(), data.jid);
                    }
                }
            }
            if (!global.opts['restrict'])
                if (plugin.tags && plugin.tags.includes('admin')) {
                    continue;
                }
            const str2Regex = str => '^' + str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
            const _chatPrefix = chatPrefixOf(m.chat);
            let _prefix = plugin.customPrefix ? plugin.customPrefix
                : _chatPrefix ? (plugin.anyPrefix ? [_chatPrefix, ...[].concat(this.prefix ? this.prefix : global.prefix)] : _chatPrefix)
                : this.prefix ? this.prefix : global.prefix;
            let match = (_prefix instanceof RegExp ?
                [[_prefix.exec(m.text), _prefix]] :
                Array.isArray(_prefix) ?
                    _prefix.map(p => {
                        let re = p instanceof RegExp ? p : new RegExp(str2Regex(p));
                        return [re.exec(m.text), re];
                    }) :
                    typeof _prefix === 'string' ?
                        [[new RegExp(str2Regex(_prefix)).exec(m.text), new RegExp(str2Regex(_prefix))]] :
                        [[null, null]]).find(p => p[0]) || [null, null];
            if (typeof plugin.before === 'function') {
                let beforeResult;
                try {
                    beforeResult = await plugin.before.call(this, m, {
                        match,
                        conn: this,
                        platform: 'whatsapp',
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
                    });
                }
                catch (e) {
                    console.error(`[plugin.before] error in '${name}':`, e);
                    continue;
                }
                if (beforeResult)
                    continue;
            }
            if (typeof plugin !== 'function')
                continue;
            usedPrefix = (match[0] || '')[0];
            const noPrefixMode = !!global.settings.system?.noPrefix;
            if (usedPrefix || noPrefixMode) {
                usedPrefix = usedPrefix || '';
                let noPrefix = usedPrefix ? m.text.replace(usedPrefix, '') : m.text;
                let [command, ...args] = noPrefix.trim().split ` `.filter(v => v);
                args = args || [];
                let _args = noPrefix.trim().split ` `.slice(1);
                let text = _args.join ` `;
                command = (command || '').toLowerCase();
                let fail = plugin.fail || global.dfail;
                let isAccept = plugin.command instanceof RegExp ?
                    plugin.command.test(command) :
                    Array.isArray(plugin.command) ?
                        plugin.command.some(cmd => cmd instanceof RegExp ? cmd.test(command) : cmd === command) :
                        typeof plugin.command === 'string' ?
                            plugin.command === command :
                            false;
                if (!isAccept)
                    continue;
                m.plugin = name;
                if (m.chat in db.data.chats || m.sender in db.data.users) {
                    let chat = db.data.chats[m.chat];
                    let user = db.data.users[m.sender];
                    if (!name.includes('tag') && !name.includes('banchat') && !name.includes('exec') && !name.includes('eval') && chat?.isBanned && !isOwner)
                        return;
                    if (!name.includes('unbanuser') && user?.banned && !isOwner)
                        return;
                }
                if (plugin.rowner && plugin.owner && !(isROwner || isOwner)) {
                    fail('owner', m, this);
                    continue;
                }
                if (plugin.rowner && !isROwner) {
                    fail('rowner', m, this);
                    continue;
                }
                if (plugin.owner && !isOwner) {
                    fail('owner', m, this);
                    continue;
                }
                if (plugin.mods && !isMods) {
                    fail('mods', m, this);
                    continue;
                }
                if (plugin.premium && !isPrems) {
                    fail('premium', m, this);
                    continue;
                }
                if (plugin.group && !m.isGroup) {
                    fail('group', m, this);
                    continue;
                }
                else if (plugin.botAdmin && !isBotAdmin) {
                    fail('botAdmin', m, this);
                    continue;
                }
                else if (plugin.admin && !isAdmin) {
                    fail('admin', m, this);
                    continue;
                }
                if (plugin.private && m.isGroup) {
                    fail('private', m, this);
                    continue;
                }
                if (plugin.register == true && _user.registered == false) {
                    fail('unreg', m, this);
                    continue;
                }
                const cooldownMs = global.settings.system.cooldown || 0;
                if (cooldownMs > 0 && !isOwner && m.sender == this.user.jid && (m.id).startsWith("3EB0")) {
                    if (!_user.cooldown || typeof _user.cooldown !== 'object') _user.cooldown = {};
                    const lastUsed = _user.cooldown[command] || 0;
                    const elapsed = Date.now() - lastUsed;
                    if (elapsed < cooldownMs) {
                        this.reply(m.chat, `Please wait ${Math.ceil((cooldownMs - elapsed) / 1000)}s before using *${usedPrefix + command}* again.`, m);
                        continue;
                    }
                    _user.cooldown[command] = Date.now();
                }
                m.isCommand = true;
                let xp = 'exp' in plugin ? parseInt(plugin.exp) : 1;
                if (xp > 200)
                    m.react('');
                else
                    m.exp += xp;
                if (!isPrems && plugin.limit && db.data.users[resolvedUserKey]?.limit < plugin.limit * 1) {
                    if (db.data.users[resolvedUserKey].registered == true) {
                        this.reply(m.chat, "Please wait a few moments for the system to refill your limit.", m);
                        continue;
                    }
                    else {
                        let quoted = { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: await this.resize(global.settings.icon, 500, 500), itemCount: 666, status: 1, surface: 1, message: "", orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } };
                        try {
                            await this.sendButton(m.chat, {
                                text: `Start registering to get more limits.`,
                                nativeFlow: [{
                                        text: 'Register',
                                        url: global.getServerUrl()
                                    }]
                            }, quoted);
                        }
                        catch (error) {
                            console.error("[LIMIT CHECK] sendButton failed:", error);
                        }
                        continue;
                    }
                }
                if (plugin.level > _user.level) {
                    let quoted = { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: await this.resize(global.settings.icon, 500, 500), itemCount: 666, status: 1, surface: 1, message: "", orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } };
                    try {
                        await this.sendButton(m.chat, {
                            text: `Tier ${global.settings.tier[plugin.level]?.name} required\nPlease upgrade your tier on our website`,
                            nativeFlow: [{
                                    text: 'Upgrade',
                                    url: global.getServerUrl()
                                }]
                        }, quoted);
                    }
                    catch (error) {
                        console.error("[LEVEL CHECK] sendButton failed:", error);
                    }
                    continue;
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
                    platform: 'whatsapp',
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
                };
                if (global.settings.system?.autoTyping) {
                    this.sendPresenceUpdate('composing', m.chat).catch(() => {});
                }
                try {
                    await plugin.call(this, m, extra);
                    if (!isPrems)
                        m.limit = m.limit || plugin.limit || false;
                }
                catch (e) {
                    m.error = e;
                    console.error(e);
                    if (!(e instanceof Error)) {
                        if (e)
                            m.reply(String(e));
                    }
                    else {
                        let text = format(e);
                        m.reply(text);
                        if (global.settings?.ai?.autoheal) {
                            try {
                                await autoHeal(this, m, e, m.plugin || command || 'unknown');
                            }
                            catch (healErr) {
                                console.error('[ AutoHeal ] Failed:', healErr.message);
                            }
                        }
                    }
                }
                finally {
                    if (global.settings.system?.autoTyping) {
                        this.sendPresenceUpdate('paused', m.chat).catch(() => {});
                    }
                    if (typeof plugin.after === 'function') {
                        try {
                            await plugin.after.call(this, m, extra);
                        }
                        catch (e) {
                            console.error(e);
                        }
                    }
                    if (m.limit)
                        this.reply(m.chat, ((db.data.users[resolvedUserKey].limit) - 1) + " Limit(s) remaining", { key: { participant: m.sender }, message: { newsletterAdminInviteMessage: { newsletterJid: '120363280758084443@newsletter', newsletterName: '.', caption: "       -" + (+m.limit) + " Limit" } } });
                }
                break;
            }
        }
    }
    catch (e) {
        console.error(e);
    }
    finally {
        if (global.opts['queue'] && m.text) {
            const id = m.id;
            this.msgqueue.unqueue(id);
        }
        let user, stats = db.data.stats;
        if (m) {
            if (m.sender && !m.sender.endsWith('@g.us') && (user = db.data.users[m.sender])) {
                user.exp += m.exp;
                if (!m.error) {
                    user.limit -= m.limit * 1;
                }
                scheduleAutosave();
            }
            let stat;
            if (m.plugin) {
                let now = +new Date;
                if (m.plugin in stats) {
                    stat = stats[m.plugin];
                    if (!isNumber(stat.total))
                        stat.total = 1;
                    if (!isNumber(stat.success))
                        stat.success = m.error != null ? 0 : 1;
                    if (!isNumber(stat.last))
                        stat.last = now;
                    if (!isNumber(stat.lastSuccess))
                        stat.lastSuccess = m.error != null ? 0 : now;
                }
                else
                    stat = stats[m.plugin] = {
                        total: 1,
                        success: m.error != null ? 0 : 1,
                        last: now,
                        lastSuccess: m.error != null ? 0 : now
                    };
                stat.total += 1;
                stat.last = now;
                if (m.error == null) {
                    stat.success += 1;
                    stat.lastSuccess = now;
                }
            }
        }
        try {
            if (!global.opts['noprint'])
                await printMessage(m, this);
        }
        catch (e) {
            console.log(m, m.quoted, e);
        }
        if (global.opts['autoread'])
            await this.readMessages([m.key]);
    }
}
export async function participantsUpdate({ id, participants, action }) {
    if (global.opts['self'])
        return;
    if (this.isInit)
        return;
    if (db.data == null)
        await loadDatabase();
    let chat = db.data.chats[id] || {};
    let text = '';
    switch (action) {
        case 'add':
        case 'remove':
            if (chat.welcome) {
                let groupMetadata = await Connection.store.fetchGroupMetadata(id, this.groupMetadata);
                for (let participant of participants) {
                    const participantId = typeof participant === 'string' ? participant : participant.id;
                    const participantName = participantId.split('@')[0];
                    let pp = 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg';
                    let eventJoin = '';
                    try {
                        pp = await this.profilePictureUrl(participantId, 'image');
                    }
                    catch (e) {
                    }
                    finally {
                        text = (action === 'add' ? (chat.sWelcome || this.welcome || Connection.conn.welcome || 'Welcome, @user!').replace('@subject', await this.getName(id)).replace('@desc', groupMetadata.desc?.toString() || ' ') :
                            (chat.sBye || this.bye || Connection.conn.bye || 'Bye, @user!')).replace('@user', '@' + participantName);
                        eventJoin = (action === 'add' ? 'W E L C O M E' : 'G O O D   B Y E');
                        this.sendLocation(id, pp, eventJoin,text, null, { mentions: this.parseMention(text) });
                    }
                }
            }
            break;
        case 'promote':
            text = (chat.sPromote || this.spromote || Connection.conn.spromote || '@user ```is now Admin```');
        case 'demote':
            if (!text)
                text = (chat.sDemote || this.sdemote || Connection.conn.sdemote || '@user ```is no longer Admin```');
            const demoterParticipant = participants[0];
            const demoterParticipantId = typeof demoterParticipant === 'string' ? demoterParticipant : demoterParticipant.id;
            text = text.replace('@user', '@' + demoterParticipantId.split('@')[0]);
            if (chat.detect)
                this.sendMessage(id, { text, mentions: this.parseMention(text) });
            break;
    }
}
export async function groupsUpdate(groupsUpdate) {
    if (global.opts['self'])
        return;
    for (const groupUpdate of groupsUpdate) {
        const id = groupUpdate.id;
        if (!id)
            continue;
        let chats = db.data.chats[id], text = '';
        if (!chats?.detect)
            continue;
        if (groupUpdate.desc)
            text = (chats.sDesc || this.sDesc || Connection.conn.sDesc || '> Description has been changed').replace('@desc', groupUpdate.desc);
        if (groupUpdate.subject)
            text = (chats.sSubject || this.sSubject || Connection.conn.sSubject || '> Subject has been changed').replace('@subject', groupUpdate.subject);
        if (groupUpdate.icon)
            text = (chats.sIcon || this.sIcon || Connection.conn.sIcon || '> Icon has been changed').replace('@icon', groupUpdate.icon);
        if (groupUpdate.revoke)
            text = (chats.sRevoke || this.sRevoke || Connection.conn.sRevoke || '> Group link has been changed').replace('@revoke', groupUpdate.revoke);
        if (!text)
            continue;
        await this.sendMessage(id, { text, mentions: this.parseMention(text) });
    }
}
export async function deleteUpdate(message) {
    if (Array.isArray(message.keys) && message.keys.length > 0) {
        const tasks = await Promise.allSettled(message.keys.map(async (key) => {
            if (key.fromMe)
                return;
            const msg = this.loadMessage(key.remoteJid, key.id) || this.loadMessage(key.id);
            if (!msg || !msg.message)
                return;
            let chat = db.data.chats[key.remoteJid];
            if (!chat || !chat.delete)
                return;
            const mtype = getContentType(msg.message);
            if (mtype === 'conversation') {
                msg.message.extendedTextMessage = { text: msg.message[mtype] };
                delete msg.message[mtype];
            }
            await this.reply(key.remoteJid, `- Deleted / edited Message Detected`.trim(), msg);
            return await this.copyNForward(key.remoteJid, msg).catch(e => console.log(e, msg));
        }));
        tasks.map(t => t.status === 'rejected' && console.error(t.reason));
    }
}
global.dfail = async (type, m, conn) => {
    let quoted = { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: await conn.resize(img.profile.sender, 150, 150), itemCount: 666, status: 1, surface: 1, message: "", orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } };
    if (type === 'unreg') {
        const url = typeof global.getServerUrl === 'function' ? global.getServerUrl() : 'https://not-loaded.yet';
        const text = 'Sorry User, You can only use this command after registering to the bot database.';
        return await conn.sendButton(m.chat, {
            text,
            nativeFlow: [{
                    text: 'Register',
                    url
                }]
        }, quoted);
    }
    let msg = global.settings.msg[type];
    if (msg)
        return await conn.reply(m.chat, msg, quoted);
};

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const COMMANDS_DIR = path.resolve(__dirname, '../../plugins')
const COMMAND_FILE = /\.m?js$/
const EPHEMERAL = 64
const EMBED_COLOR = 0x5865f2
const ACTION_MAX = 3000
const SLASH_LIMIT = 100
const UPLOAD_LIMITS_MB = [10, 10, 50, 100]

const OPTION_TYPES = {
  subcommand: 1,
  subcommandgroup: 2,
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  mentionable: 9,
  number: 10,
  attachment: 11
}

const commands = new Map()
const fileToName = new Map()
const watchers = new Map()
const timers = new Map()
const cooldowns = new Map()
const actions = new Map()

let client = null
let readyHandled = false
let lastSignature = ''
let syncTimer = null

function log(kind, text) {
  const label =
    kind === 'add' ? chalk.cyanBright('Add') :
    kind === 'edit' ? chalk.green('Edit') :
    kind === 'delete' ? chalk.red('Delete') :
    kind === 'error' ? chalk.red('Discord') :
    chalk.greenBright('Discord')
  console.log(`${label} — ${chalk.white(text)}`)
}

function debounce(key, ms, fn) {
  if (timers.has(key)) clearTimeout(timers.get(key))
  timers.set(key, setTimeout(() => {
    timers.delete(key)
    fn()
  }, ms))
}

async function loadDiscordJs() {
  return import('../package/discord/index.js')
}

function toApiOption(option) {
  const out = {
    type: typeof option.type === 'number' ? option.type : OPTION_TYPES[String(option.type || 'string').toLowerCase()] || 3,
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

let guildCommandsCleared = false

async function syncCommands() {
  if (!client?.application) return
  const ordered = [...commands.values()]
    .filter(cmd => !cmd.prefixOnly)
    .sort((x, y) => Number(!!x.bridge) - Number(!!y.bridge))
  if (ordered.length > SLASH_LIMIT) {
    log('error', `${ordered.length} commands defined, only the first ${SLASH_LIMIT} are registered as slash commands (the rest still work with the prefix)`)
  }
  const body = ordered.slice(0, SLASH_LIMIT).map(definitionOf)
  const signature = JSON.stringify(body)
  if (signature === lastSignature) return

  try {
    await client.application.commands.set(body)
    if (!guildCommandsCleared) {
      guildCommandsCleared = true
      for (const guild of client.guilds.cache.values()) await guild.commands.set([]).catch(() => {})
    }
    lastSignature = signature
    log('info', `${body.length} slash command(s) synced globally`)
  } catch (err) {
    log('error', `Failed to sync slash commands: ${err?.message || err}`)
  }
}

function scheduleSync() {
  if (!client?.application) return
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = setTimeout(() => {
    syncTimer = null
    syncCommands()
  }, 1500)
}

function listCommandFiles(dir, results = []) {
  if (!fs.existsSync(dir)) return results
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) listCommandFiles(full, results)
    else if (entry.isFile() && COMMAND_FILE.test(entry.name)) results.push(full)
  }
  return results
}

async function loadCommandFile(file, silent = false) {
  const rel = path.relative(process.cwd(), file).replace(/\\/g, '/')
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
        const owner = [...commands.values()].find(c => c.name === entry.name && c.file !== file && !c.bridge)
        if (owner) throw new Error(`command "${entry.name}" is already defined in ${path.relative(process.cwd(), owner.file)}`)
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
      if (!names.includes(previous)) commands.delete(previous)
    }
    for (const cmd of prepared) commands.set(cmd.name, cmd)
    fileToName.set(file, names)
    if (!silent) log(known ? 'edit' : 'add', rel)
    return true
  } catch (err) {
    log('error', `Failed to load ${rel}: ${err?.message || err}`)
    return false
  }
}

function removeCommandFile(file) {
  const names = fileToName.get(file)
  if (!names) return
  for (const name of names) commands.delete(name)
  fileToName.delete(file)
  log('delete', path.relative(process.cwd(), file).replace(/\\/g, '/'))
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

  if (!COMMAND_FILE.test(absPath)) return
  if (!stat) removeCommandFile(absPath)
  else await loadCommandFile(absPath)
  scheduleSync()
}

function watchDir(dir) {
  if (watchers.has(dir)) return
  try {
    const watcher = fs.watch(dir, (_event, filename) => {
      if (!filename) return
      const absPath = path.join(dir, filename)
      debounce(absPath, 300, () => onFsEvent(absPath))
    })
    watcher.on('error', () => {
      watcher.close()
      watchers.delete(dir)
    })
    watchers.set(dir, watcher)
  } catch (err) {
    log('error', `Cannot watch ${dir}: ${err?.message || err}`)
  }
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) watchDir(path.join(dir, entry.name))
  }
}

async function loadAllCommands() {
  fs.mkdirSync(COMMANDS_DIR, { recursive: true })
  for (const file of listCommandFiles(COMMANDS_DIR)) await loadCommandFile(file, true)
  watchDir(COMMANDS_DIR)
}

function ownerIds() {
  return (process.env.DISCORD_OWNER || '').split(',').map(v => v.trim()).filter(Boolean)
}

function checkOwner(userId, account) {
  if (ownerIds().includes(userId)) return true
  if (!account.linked) return false
  const number = account.key.replace(/@.*$/, '')
  return (global.settings?.owner || []).some(([n]) => n && String(n).replace(/\D/g, '') === number)
}

function parseOptions(options) {
  const args = {}
  let subcommand = null
  let group = null
  const walk = (list) => {
    for (const opt of list || []) {
      if (opt.type === 2) {
        group = opt.name
        walk(opt.options)
      } else if (opt.type === 1) {
        subcommand = opt.name
        walk(opt.options)
      } else {
        args[opt.name] = opt.user ?? opt.channel ?? opt.role ?? opt.attachment ?? opt.value
      }
    }
  }
  walk(options?.data)
  return { args, subcommand, group }
}

function randomId(size = 10) {
  return randomBytes(Math.ceil(size / 2)).toString('hex').slice(0, size)
}

function registerAction(userId, text, ttl = 30 * 60 * 1000) {
  const now = Date.now()
  if (actions.size >= ACTION_MAX) {
    for (const [key, entry] of actions) {
      if (entry.expires < now || actions.size >= ACTION_MAX) actions.delete(key)
      if (actions.size < ACTION_MAX * 0.8) break
    }
  }
  const key = randomId(12)
  actions.set(key, { text, userId, expires: now + ttl })
  return key
}

function prefixList() {
  const raw = global.settings?.system?.prefix
  const list = Array.isArray(raw) ? raw : raw ? [raw] : ['.', '/', '!']
  return list.filter(v => (typeof v === 'string' && v) || v instanceof RegExp)
}

function primaryPrefix(guildId = null) {
  const custom = guildPrefix(guildId)
  if (custom) return custom
  const first = prefixList().find(v => typeof v === 'string')
  return first || '.'
}

function prefixesFor(guildId = null) {
  const custom = guildPrefix(guildId)
  return custom ? [custom] : prefixList()
}

function matchPrefix(content, list) {
  const sorted = [...list].sort((x, y) => String(y).length - String(x).length)
  for (const item of sorted) {
    if (typeof item === 'string') {
      if (content.startsWith(item)) return item
    } else {
      item.lastIndex = 0
      const found = item.exec(content)
      if (found && found.index === 0 && found[0]) return found[0]
    }
  }
  return null
}

function findCommand(name) {
  const direct = commands.get(name)
  if (direct) return direct
  for (const cmd of commands.values()) if (cmd.aliases?.includes(name)) return cmd
  for (const cmd of commands.values()) if (typeof cmd.match === 'function' && cmd.match(name)) return cmd
  return null
}

function resolveInvocation(content, { allowBare = false, guildId = null } = {}) {
  let body = String(content || '').trim()
  if (!body) return null

  let prefix = null
  const botId = client?.user?.id
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

const COMPONENTS_V2 = 1 << 15

function normalizePayload(payload, { interaction = false } = {}) {
  const body = typeof payload === 'string' ? { content: payload } : { ...payload }
  const wantsEphemeral = !!body.ephemeral
  delete body.ephemeral
  if (wantsEphemeral && interaction) body.flags = (body.flags || 0) | EPHEMERAL
  if (!interaction) {
    const keep = (body.flags || 0) & COMPONENTS_V2
    if (keep) body.flags = keep
    else delete body.flags
  }
  if (!body.allowedMentions) body.allowedMentions = interaction ? { parse: [] } : { parse: [], repliedUser: false }
  return body
}

function toAttachment(att) {
  if (!att) return null
  return { url: att.url, name: att.name, contentType: att.contentType || '', size: att.size || 0 }
}

function uploadLimitOf(guild) {
  const tier = Number(guild?.premiumTier) || 0
  const mb = UPLOAD_LIMITS_MB[tier] || UPLOAD_LIMITS_MB[0]
  return mb * 1024 * 1024 - 512 * 1024
}

function makeInteractionSource(interaction, { raw = '', kindLabel = 'Slash' } = {}) {
  let firstId = null
  let expired = false
  const viaChannel = payload => {
    const body = normalizeEdit(normalizePayload(payload))
    return interaction.channel?.send?.(body)
  }
  const src = {
    raw,
    kindLabel,
    kind: 'interaction',
    interaction,
    message: null,
    user: interaction.user,
    member: interaction.member,
    guild: interaction.guild,
    channel: interaction.channel,
    inGuild: interaction.inGuild(),
    text: null,
    prefix: '/',
    attachment: null,
    async reply(payload) {
      if (expired) return viaChannel(payload)
      const body = normalizePayload(payload, { interaction: true })
      let sent
      try {
        if (interaction.replied) {
          sent = await interaction.followUp(body)
        } else if (interaction.deferred) {
          sent = await interaction.editReply(normalizeEdit(body))
        } else {
          await interaction.reply(body)
          sent = await interaction.fetchReply().catch(() => null)
        }
      } catch (err) {
        if (err?.code !== 10062) throw err
        expired = true
        return viaChannel(payload)
      }
      if (sent?.id && !firstId) firstId = sent.id
      return sent
    },
    async edit(payload) {
      if (expired) return viaChannel(payload)
      return interaction.editReply(normalizeEdit(normalizePayload(payload, { interaction: true })))
    },
    async editById(id, payload) {
      const body = normalizeEdit(normalizePayload(payload, { interaction: true }))
      if (!firstId || id === firstId) return interaction.editReply(body)
      return interaction.webhook.editMessage(id, body)
    },
    async deleteById(id) {
      if (!firstId || id === firstId) return interaction.deleteReply()
      return interaction.webhook.deleteMessage(id)
    },
    async defer(ephemeral = false) {
      if (expired || interaction.deferred || interaction.replied) return
      try {
        await interaction.deferReply(ephemeral ? { flags: EPHEMERAL } : {})
      } catch (err) {
        if (err?.code !== 10062) throw err
        expired = true
      }
    },
    async react() {},
    async getQuoted() {
      return null
    },
    async deny(content) {
      if (expired) return viaChannel({ content })
      const body = { content, flags: EPHEMERAL, allowedMentions: { parse: [] } }
      try {
        if (interaction.replied) return await interaction.followUp(body)
        if (interaction.deferred) return await interaction.editReply({ content, allowedMentions: { parse: [] } })
        return await interaction.reply(body)
      } catch (err) {
        if (err?.code !== 10062) throw err
        expired = true
        return viaChannel({ content })
      }
    }
  }
  return src
}

function normalizeEdit(body) {
  const copy = { ...body }
  const keep = (copy.flags || 0) & COMPONENTS_V2
  if (keep) copy.flags = keep
  else delete copy.flags
  return copy
}

function makeMessageSource(message, { kindLabel = 'Text' } = {}) {
  let last = null
  let reacted = null
  const sentMap = new Map()
  const attachment = message.attachments?.first?.()
  const src = {
    raw: message.content || '',
    kindLabel,
    kind: 'message',
    interaction: null,
    message,
    user: message.author,
    member: message.member,
    guild: message.guild,
    channel: message.channel,
    inGuild: !!message.guild,
    text: '',
    prefix: primaryPrefix(message.guild?.id ?? null),
    attachment: toAttachment(attachment),
    async reply(payload) {
      const body = normalizePayload(payload)
      try {
        last = await message.reply({ ...body, failIfNotExists: false })
      } catch {
        last = await message.channel.send(body)
      }
      if (last?.id) sentMap.set(last.id, last)
      return last
    },
    async editById(id, payload) {
      const target = sentMap.get(id) || await message.channel.messages.fetch(id).catch(() => null)
      return target?.edit(normalizePayload(payload))
    },
    async deleteById(id) {
      const target = sentMap.get(id) || await message.channel.messages.fetch(id).catch(() => null)
      sentMap.delete(id)
      return target?.delete()
    },
    async edit(payload) {
      if (!last) return src.reply(payload)
      last = await last.edit(normalizePayload(payload))
      return last
    },
    async defer() {
      message.channel?.sendTyping?.().catch(() => {})
    },
    async react(emoji) {
      if (typeof emoji !== 'string' || !emoji) return
      try {
        if (reacted && reacted !== emoji) await message.reactions.cache.get(reacted)?.users.remove(client.user.id).catch(() => {})
        await message.react(emoji)
        reacted = emoji
      } catch {}
    },
    async getQuoted() {
      const ref = message.reference?.messageId
      if (!ref) return null
      const replied = message.channel.messages.cache.get(ref) || await message.channel.messages.fetch(ref).catch(() => null)
      if (!replied) return null
      return {
        id: replied.id,
        authorId: replied.author?.id,
        text: replied.content || '',
        attachment: toAttachment(replied.attachments?.first?.())
      }
    },
    async deny(content) {
      return src.reply({ content })
    }
  }
  return src
}

async function parsePrefixArgs(cmd, src) {
  const args = {}
  const options = (cmd.options || []).filter(opt => !opt.slashOnly)
  if (!options.length) return args

  const typeOf = opt => (typeof opt.type === 'number' ? Object.keys(OPTION_TYPES).find(k => OPTION_TYPES[k] === opt.type) : String(opt.type || 'string').toLowerCase())
  const lastString = options.map(typeOf).lastIndexOf('string')
  let rest = src.text || ''

  const take = () => {
    const found = /^(\S+)\s*([\s\S]*)$/.exec(rest)
    if (!found) return null
    rest = found[2]
    return found[1]
  }

  for (let i = 0; i < options.length; i++) {
    const opt = options[i]
    const type = typeOf(opt)

    if (type === 'attachment') {
      if (src.attachment) args[opt.name] = src.attachment
      continue
    }

    if (type === 'string' && i === lastString) {
      const value = rest.trim()
      if (value) args[opt.name] = value
      rest = ''
      continue
    }

    const token = take()
    if (token == null) continue

    if (type === 'user') {
      const id = /^<@!?(\d+)>$/.exec(token)?.[1] || (/^\d{15,22}$/.test(token) ? token : null)
      if (id) {
        const found = src.message?.mentions?.users?.get(id) || await client.users.fetch(id).catch(() => null)
        if (found) args[opt.name] = found
      } else {
        rest = `${token} ${rest}`
      }
    } else if (type === 'integer' || type === 'number') {
      const num = Number(token)
      if (Number.isFinite(num)) args[opt.name] = type === 'integer' ? Math.trunc(num) : num
      else rest = `${token} ${rest}`
    } else if (type === 'boolean') {
      args[opt.name] = /^(true|yes|on|1|y)$/i.test(token)
    } else {
      args[opt.name] = token
    }
  }
  return args
}

function usageOf(cmd, prefix) {
  const parts = (cmd.options || []).map(o => (o.required ? `<${o.name}>` : `[${o.name}]`))
  return `${prefix}${cmd.name}${parts.length ? ` ${parts.join(' ')}` : ''}`
}

function buildContext(src, cmd, account, owner, args, invokedName) {
  const embed = (data = {}) => ({ color: EMBED_COLOR, ...data })
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
    commands,
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
    reply: payload => src.reply(payload),
    edit: payload => src.edit(payload),
    editMessage: (id, payload) => src.editById(id, payload),
    deleteMessage: id => src.deleteById(id),
    defer: ephemeral => src.defer(ephemeral),
    react: emoji => src.react(emoji),
    getQuoted: () => src.getQuoted(),
    registerAction: (text, opts = {}) => registerAction(opts.shared ? null : user.id, text, opts.ttl),
    randomId,
    embed,
    ...discordTools
  }
  extra.conn = withDiscord(conn, ctx)
  return ctx
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

async function dispatch(interaction) {
  if (interaction.isAutocomplete?.()) {
    const cmd = commands.get(interaction.commandName)
    if (typeof cmd?.autocomplete === 'function') await cmd.autocomplete(interaction, { client, commands, db })
    return
  }

  if (interaction.isMessageComponent?.()) return onComponent(interaction)
  if (!interaction.isChatInputCommand?.()) return

  let raw = `/${interaction.commandName}`
  try {
    raw = interaction.toString()
  } catch {}
  const src = makeInteractionSource(interaction, { raw, kindLabel: 'Slash' })
  const cmd = commands.get(interaction.commandName)
  if (!cmd) return src.deny('This command is no longer available.')

  const { args } = parseOptions(interaction.options)
  const timer = setTimeout(() => src.defer().catch(() => {}), 2000)
  try {
    await execute(src, cmd, { args, invokedName: cmd.name })
  } finally {
    clearTimeout(timer)
  }
}

async function onComponent(interaction) {
  const id = interaction.customId || ''
  if (!id.startsWith('hb:')) return

  const key = interaction.isStringSelectMenu?.() ? interaction.values?.[0] : id.slice(5)
  const entry = actions.get(key)
  const src = makeInteractionSource(interaction, { raw: entry?.text || '', kindLabel: interaction.isStringSelectMenu?.() ? 'Menu' : 'Button' })

  if (!entry || entry.expires < Date.now()) return src.deny('This menu has expired, run the command again.')
  if (entry.userId && entry.userId !== interaction.user.id) return src.deny('This menu belongs to someone else.')

  const inv = resolveInvocation(entry.text, { allowBare: true, guildId: interaction.guild?.id ?? null })
  if (!inv) return src.deny('This action is no longer available.')

  src.text = inv.text
  src.prefix = inv.prefix
  const args = await parsePrefixArgs(inv.cmd, src)
  const timer = setTimeout(() => src.defer().catch(() => {}), 2000)
  try {
    await execute(src, inv.cmd, { args, invokedName: inv.name })
  } finally {
    clearTimeout(timer)
  }
}

async function maybeAutoChat(message) {
  const cmd = commands.get('ai')
  if (!cmd || !client?.user) return
  if (db.data == null) await loadDatabase()

  const chat = db.data?.chats?.[message.channel.id]
  if (!chat?.aiChat && !chat?.gptChat) return

  const botId = client.user.id
  if (message.guild) {
    const mentioned = message.mentions?.users?.has?.(botId)
    let replied = false
    const ref = message.reference?.messageId
    if (ref) {
      const target = message.channel.messages.cache.get(ref) || await message.channel.messages.fetch(ref).catch(() => null)
      replied = target?.author?.id === botId
    }
    if (!mentioned && !replied) return
  }

  const text = String(message.content || '').replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim()
  if (!text && !message.attachments?.size) return

  const src = makeMessageSource(message, { kindLabel: 'AI Chat' })
  src.text = text
  src.prefix = primaryPrefix(message.guild?.id ?? null)
  await execute(src, cmd, { args: {}, invokedName: 'ai', quietAccess: true })
}

async function onMessage(message) {
  if (message.author?.bot || message.system) return
  if (!message.content && !message.attachments?.size) return
  const inv = message.content ? resolveInvocation(message.content, { guildId: message.guild?.id ?? null }) : null
  if (!inv) return maybeAutoChat(message)

  const src = makeMessageSource(message)
  src.text = inv.text
  src.prefix = inv.prefix
  const args = await parsePrefixArgs(inv.cmd, src)
  await execute(src, inv.cmd, { args, invokedName: inv.name })
}

async function onReady(readyClient) {
  if (readyHandled) return
  readyHandled = true
  log('info', `${readyClient.user.tag} • ${commands.size} command(s) • prefix ${prefixList().join(' ')}`)
  await syncCommands()
}

function createClient(discord, { messageContent = false, members = false } = {}) {
  const { Client, GatewayIntentBits, Partials } = discord
  const intents = [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMessageReactions, GatewayIntentBits.DirectMessages, GatewayIntentBits.GuildVoiceStates]
  if (messageContent) intents.push(GatewayIntentBits.MessageContent)
  if (members) intents.push(GatewayIntentBits.GuildMembers)

  const instance = new Client({ intents, partials: [Partials.Channel] })
  readyHandled = false
  instance.once('clientReady', onReady)
  instance.once('ready', onReady)
  instance.on('interactionCreate', interaction => {
    dispatch(interaction).catch(async err => {
      console.error(chalk.red('Discord') + chalk.gray(' dispatch error:'), err)
      const body = { content: `Error: ${String(err?.message || err).slice(0, 300)}`, flags: EPHEMERAL, allowedMentions: { parse: [] } }
      try {
        if (interaction.replied || interaction.deferred) await interaction.followUp(body)
        else await interaction.reply(body)
      } catch {}
    })
  })
  instance.on('messageCreate', message => {
    onMessage(message).catch(err => console.error(chalk.red('Discord') + chalk.gray(' message error:'), err))
  })
  instance.on('guildMemberAdd', member => {
    handleMemberAdd(member).catch(err => console.error(chalk.red('Discord') + chalk.gray(' member join error:'), err))
  })
  instance.on('messageReactionAdd', reaction => {
    onReaction(reaction, true).catch(err => console.error(chalk.red('Discord') + chalk.gray(' reaction role error:'), err))
  })
  instance.on('messageReactionRemove', reaction => {
    onReaction(reaction, false).catch(err => console.error(chalk.red('Discord') + chalk.gray(' reaction role error:'), err))
  })
  instance.on('voiceStateUpdate', (oldState, newState) => {
    try {
      global.discordMusic?.handleVoiceState?.(oldState, newState)
    } catch {}
  })
  instance.on('error', err => console.error(chalk.red('Discord') + chalk.gray(' client error:'), err?.message || err))
  instance.on('warn', warning => console.warn(chalk.yellow('Discord') + chalk.gray(` ${warning}`)))
  return instance
}

const WA_OFF = /\bwhatsapp\s*:\s*false\b/
const DISCORD_ON = /\bdiscord\s*:\s*(true|\{)/
const PLATFORM_AWARE = /\bplatform\s*(===?|!==?)\s*['"`](discord|whatsapp)['"`]/
function isNativeSource(source) {
  return DISCORD_ON.test(source) && (WA_OFF.test(source) || PLATFORM_AWARE.test(source))
}

function isBridgedSource(source) {
  return DISCORD_ON.test(source) && !WA_OFF.test(source) && !PLATFORM_AWARE.test(source)
}

function toDiscordPermission(name) {
  const raw = String(name).trim()
  const alias = {
    manageserver: 'ManageGuild',
    managewebhook: 'ManageWebhooks',
    createinvite: 'CreateInstantInvite',
    manageemojis: 'ManageEmojisAndStickers'
  }[raw.toLowerCase()]
  if (alias) return alias
  const found = Object.keys(FLAGS).find(key => key.toLowerCase() === raw.toLowerCase())
  if (!found) throw new Error(`unknown Discord permission "${raw}"`)
  return found
}

function discordAccessOf(h) {
  const d = h.platform?.discord
  const none = { owner: false, premium: false, permission: undefined }
  if (!d || typeof d !== 'object') return none

  const resolve = value => {
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
        const { flags } = resolve(d.permission(args, name))
        return flags.length ? flags : null
      }
    }
  }

  const { owner, premium, flags } = resolve(d.permission)
  return { owner, premium, permission: flags.length ? flags : undefined }
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

function categoryOf(tag) {
  const raw = String(tag || '')
  if (!raw) return 'Other'
  return { main: 'Info', info: 'Info' }[raw.toLowerCase()] || raw[0].toUpperCase() + raw.slice(1)
}

function discordEmoji(emoji) {
  return typeof emoji === 'string' ? { name: emoji } : emoji
}

function discordButton(ctx, item) {
  if (!item || typeof item !== 'object') return null
  const label = clip(item.label || item.text || '', 80)
  const base = {
    type: 2,
    ...(label ? { label } : {}),
    ...(item.emoji ? { emoji: discordEmoji(item.emoji) } : {}),
    ...(item.disabled ? { disabled: true } : {})
  }
  if (item.url) return { ...base, style: 5, url: item.url }
  const id = item.action ? `hb:b:${ctx.registerAction(String(item.action))}` : item.id
  if (!id) return null
  const style = typeof item.style === 'number' ? item.style : { primary: 1, secondary: 2, success: 3, danger: 4, link: 5 }[item.style] || 2
  return { ...base, style, custom_id: String(id) }
}

function discordButtonRows(ctx, button) {
  const list = [].concat(button)
  const groups = list.some(Array.isArray)
    ? list.map(group => [].concat(group))
    : Array.from({ length: Math.ceil(list.length / 5) }, (_, index) => list.slice(index * 5, index * 5 + 5))
  return groups
    .map(group => ({ type: 1, components: group.map(item => discordButton(ctx, item)).filter(Boolean).slice(0, 5) }))
    .filter(row => row.components.length)
}

function discordSelectRow(ctx, select) {
  const options = (select.options || []).slice(0, 25).map(option => ({
    label: clip(option.label || option.text || '-', 100),
    value: option.action ? ctx.registerAction(String(option.action)) : String(option.value ?? option.label ?? '-'),
    ...(option.description ? { description: clip(option.description, 100) } : {}),
    ...(option.emoji ? { emoji: discordEmoji(option.emoji) } : {}),
    ...(option.default ? { default: true } : {})
  }))
  if (!options.length) return null
  return {
    type: 1,
    components: [{
      type: 3,
      custom_id: select.id || `hb:m:${ctx.randomId()}`,
      placeholder: clip(select.placeholder || 'Select', 150),
      options,
      ...(select.min !== undefined ? { min_values: select.min } : {}),
      ...(select.max !== undefined ? { max_values: select.max } : {})
    }]
  }
}

async function discordMessage(ctx, chat, payload = {}) {
  const input = await resolveMedia(payload)
  if (input.text !== undefined) {
    input.content = input.text
    delete input.text
  }
  const embeds = [].concat(input.embeds || [], input.embed || [])
  delete input.embed
  if (embeds.length) input.embeds = embeds.slice(0, 10).map(embed => ({ color: EMBED_COLOR, ...embed }))
  if (input.file) input.files = [].concat(input.files || [], input.file)
  delete input.file
  const rows = [...(input.components || [])]
  if (input.button) rows.push(...discordButtonRows(ctx, input.button))
  for (const select of [].concat(input.select || [])) {
    const row = discordSelectRow(ctx, select)
    if (row) rows.push(row)
  }
  delete input.button
  delete input.select
  if (input.gallery) {
    const gallery = input.gallery
    delete input.gallery
    const built = await buildGallery(gallery.images, [...(input.files || [])])
    const inner = []
    const text = [gallery.text, input.content].filter(Boolean).join('\n')
    if (text) inner.push({ type: 10, content: text.slice(0, 4000) })
    if (built.items.length) inner.push({ type: 12, items: built.items })
    if (rows.length) inner.push({ type: 14, divider: true, spacing: 1 }, ...rows.slice(0, 5))
    input.components = [{ type: 17, accent_color: EMBED_COLOR, components: inner }]
    input.flags = COMPONENTS_V2
    if (built.files.length) input.files = built.files
    delete input.content
    delete input.embeds
  } else if (rows.length) {
    input.components = rows.slice(0, 5)
  }
  const target = chat || ctx.channel?.id
  const here = !target || String(target) === String(ctx.channel?.id || '')
  const deliverBody = body => here
    ? ctx.reply(body)
    : client.rest.post(`/channels/${target}/messages`, toRequest(normalizePayload(body)))
  const parts = input.content ? chunkText(String(input.content)) : []
  if (parts.length > 1) {
    for (const part of parts.slice(0, -1)) await deliverBody({ content: part })
    input.content = parts[parts.length - 1]
  }
  return deliverBody(input)
}

function withDiscord(conn, ctx) {
  return Object.assign(Object.create(conn), {
    discord: (chat, payload) => discordMessage(ctx, chat, payload)
  })
}

function bridgeGroups() {
  const groups = {}
  for (const full of listCommandFiles(COMMANDS_DIR)) {
    if (!isBridgedSource(fs.readFileSync(full, 'utf8'))) continue
    const folder = path.basename(path.dirname(full))
    ;(groups[folder] ||= []).push(path.basename(full, '.js'))
  }
  return groups
}

const NAME_RE = /^[\p{L}\p{N}_-]{1,32}$/u
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const EXT_MIME = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav',
  pdf: 'application/pdf', apk: 'application/vnd.android.package-archive', zip: 'application/zip',
  txt: 'text/plain', json: 'application/json'
}

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp',
  'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov',
  'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg', 'audio/wav': 'wav',
  'application/pdf': 'pdf', 'application/zip': 'zip', 'application/vnd.android.package-archive': 'apk'
}

const records = new Map()


function extOf(name = '') {
  const match = /\.([a-z0-9]{1,5})(?:\?.*)?$/i.exec(String(name))
  return match ? match[1].toLowerCase() : ''
}

function sniffMime(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg'
  if (buf.slice(0, 8).toString('hex') === '89504e470d0a1a0a') return 'image/png'
  if (buf.slice(0, 3).toString() === 'GIF') return 'image/gif'
  if (buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp'
  if (buf.slice(4, 8).toString() === 'ftyp') return 'video/mp4'
  if (buf.slice(0, 4).toString('hex') === '1a45dfa3') return 'video/webm'
  if (buf.slice(0, 3).toString() === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return 'audio/mpeg'
  if (buf.slice(0, 4).toString() === 'OggS') return 'audio/ogg'
  if (buf.slice(0, 4).toString() === '%PDF') return 'application/pdf'
  if (buf.slice(0, 2).toString() === 'PK') return 'application/zip'
  return ''
}

function formatSize(bytes) {
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${bytes} B`
}

function clip(value, max) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function mediaKind(mime = '') {
  if (/^image\//.test(mime)) return 'imageMessage'
  if (/^video\//.test(mime)) return 'videoMessage'
  if (/^audio\//.test(mime)) return 'audioMessage'
  return 'documentMessage'
}

function mediaProps(att) {
  const mime = String(att.contentType || '').split(';')[0] || EXT_MIME[extOf(att.name || att.url)] || ''
  const kind = mediaKind(mime)
  return {
    mimetype: mime,
    mediaType: kind,
    mtype: kind,
    fileName: att.name || '',
    fileLength: att.size || 0,
    msg: { mimetype: mime, fileLength: att.size || 0, fileName: att.name || '' },
    download: async () => {
      const res = await axios.get(att.url, { responseType: 'arraybuffer', timeout: 60000, headers: { 'User-Agent': USER_AGENT } })
      return Buffer.from(res.data)
    }
  }
}

async function acquire(kind, id, factory) {
  const key = `${kind}:${id}`
  const bucket = db.data?.[kind]
  if (!bucket) return () => {}
  const existing = records.get(key)
  if (existing) {
    existing.count += 1
  } else if (!bucket[id]) {
    bucket[id] = factory()
    records.set(key, { count: 1 })
  } else {
    return () => {}
  }
  return () => {
    const entry = records.get(key)
    if (!entry) return
    entry.count -= 1
    if (entry.count <= 0) {
      records.delete(key)
      delete bucket[id]
    }
  }
}

async function uploadBuffer(buffer, filename) {
  const upload = global.scraper?.upload?.default
  if (typeof upload !== 'function') throw new Error('Upload service is not available')
  const url = await upload(buffer, filename)
  if (!url) throw new Error('Upload failed')
  return url
}

function resultOf(ctx, message, chat) {
  return { key: { id: message?.id, remoteJid: chat || ctx.channel?.id, fromMe: true }, message, id: message?.id }
}

async function sendText(ctx, text) {
  const body = waToDiscord(text)
  if (!body.trim()) return null
  if (body.length > 7600) {
    const message = await ctx.reply({ files: [{ attachment: Buffer.from(body, 'utf8'), name: 'result.txt' }] })
    return resultOf(ctx, message)
  }
  let last = null
  for (const part of chunkText(body)) last = await ctx.reply({ content: part })
  return resultOf(ctx, last)
}

async function deliver(ctx, source, { filename, caption = '', mimetype } = {}) {
  const limit = ctx.fileLimit
  let buffer = null
  let url = null

  if (Buffer.isBuffer(source)) buffer = source
  else if (source instanceof Uint8Array) buffer = Buffer.from(source)
  else if (typeof source === 'string') {
    if (/^https?:\/\//i.test(source)) url = source
    else if (/^data:/i.test(source)) buffer = Buffer.from(source.split(',')[1] || '', 'base64')
    else if (fs.existsSync(source)) buffer = fs.readFileSync(source)
  } else if (source?.url) {
    if (/^https?:\/\//i.test(source.url)) url = source.url
    else if (fs.existsSync(source.url)) buffer = fs.readFileSync(source.url)
  }

  const text = waToDiscord(caption).trim()

  if (!buffer && url) {
    try {
      const res = await axios.get(url, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: limit,
        maxBodyLength: limit,
        headers: { 'User-Agent': USER_AGENT }
      })
      buffer = Buffer.from(res.data)
      mimetype = mimetype || String(res.headers['content-type'] || '').split(';')[0]
    } catch {
      return sendText(ctx, [text, url].filter(Boolean).join('\n'))
    }
  }

  if (!buffer) throw new Error('Nothing to send')

  const mime = (mimetype && mimetype !== 'application/octet-stream' ? mimetype : '') || sniffMime(buffer) || EXT_MIME[extOf(filename)] || 'application/octet-stream'
  let name = String(filename || '').trim() || (url ? path.basename(new URL(url).pathname) : '') || 'file'
  if (!extOf(name) && MIME_EXT[mime]) name = `${name}.${MIME_EXT[mime]}`

  if (buffer.length > limit) {
    const link = await uploadBuffer(buffer, name).catch(() => null)
    if (!link) throw new Error(`File is too large for Discord (${formatSize(buffer.length)}, limit ${formatSize(limit)})`)
    return sendText(ctx, [text, link].filter(Boolean).join('\n'))
  }

  const message = await ctx.reply({
    content: text ? text.slice(0, 2000) : undefined,
    files: [{ attachment: buffer, name }]
  })
  return resultOf(ctx, message)
}

function buildComponents(ctx, flow) {
  const rows = []
  let buttons = []
  const flush = () => {
    if (buttons.length && rows.length < 5) rows.push({ type: 1, components: buttons })
    buttons = []
  }

  for (const item of flow) {
    if (!item || typeof item !== 'object') continue

    if (Array.isArray(item.sections) && item.sections.length) {
      flush()
      const options = []
      for (const section of item.sections) {
        for (const row of section.rows || []) {
          if (options.length >= 25) break
          const id = row.id || row.rowId
          if (!id) continue
          const label = clip(row.title || row.header || '-', 100)
          const description = clip([row.header && row.title ? row.header : '', row.description].filter(Boolean).join(' · '), 100)
          options.push({ label, value: ctx.registerAction(String(id)), ...(description ? { description } : {}) })
        }
      }
      if (options.length && rows.length < 5) {
        rows.push({
          type: 1,
          components: [{ type: 3, custom_id: `hb:m:${ctx.randomId()}`, placeholder: clip(item.text || 'Select', 150), options }]
        })
      }
      continue
    }

    const label = clip(item.text || item.displayText || '', 80)
    if (!label) continue

    if (item.url && /^https?:\/\//i.test(item.url)) {
      buttons.push({ type: 2, style: 5, label, url: item.url })
    } else if (item.id) {
      buttons.push({ type: 2, style: 2, label, custom_id: `hb:b:${ctx.registerAction(String(item.id))}` })
    } else {
      continue
    }
    if (buttons.length >= 5) flush()
  }

  flush()
  return rows
}

function legacyButtons(buttons = []) {
  return buttons
    .map(b => ({ text: b.buttonText?.displayText || b.displayText || b.text, id: b.buttonId || b.id }))
    .filter(b => b.text && b.id)
}

function createConn(ctx, shared, account) {
  const methods = {
    async reply(_chat, text, _quoted, opts = {}) {
      if (Buffer.isBuffer(text)) return deliver(ctx, text, { filename: opts.fileName, mimetype: opts.mimetype })
      return sendText(ctx, typeof text === 'string' ? text : text?.text ?? String(text ?? ''))
    },
    async sendFile(_chat, source, filename, caption, _quoted, _ptt, opts = {}) {
      return deliver(ctx, source, { filename: filename || opts.fileName, caption: caption || '', mimetype: opts.mimetype })
    },
    async sendSticker(_chat, source) {
      return deliver(ctx, source, { filename: 'sticker.webp', mimetype: 'image/webp' })
    },
    async sendContact(_chat, contacts) {
      const lines = (contacts || []).map(([id, name]) => `${name || 'Contact'}: ${String(id).replace(/@.*$/, '')}`)
      return sendText(ctx, lines.join('\n'))
    },
    async sendMessage(_chat, content = {}, _opts) {
      if (content.delete) {
        await ctx.deleteMessage?.(content.delete.id).catch(() => {})
        return null
      }
      if (content.edit) {
        const parts = chunkText(waToDiscord(content.text || content.caption || ''))
        await ctx.editMessage(content.edit.id, { content: parts[0] || '\u200b' })
        for (const extra of parts.slice(1)) await ctx.reply({ content: extra })
        return { key: content.edit }
      }
      if (content.nativeFlow || content.interactiveButtons || content.buttons) return methods.sendButton(_chat, content)
      for (const kind of ['image', 'video', 'audio', 'document', 'sticker']) {
        if (!content[kind]) continue
        const fallback = { image: 'image.png', video: 'video.mp4', audio: 'audio.mp3', document: 'file', sticker: 'sticker.webp' }[kind]
        return deliver(ctx, content[kind], {
          filename: content.fileName || fallback,
          caption: content.caption || '',
          mimetype: content.mimetype
        })
      }
      if (content.text) return sendText(ctx, content.text)
      throw new Error('This message type is not supported on Discord')
    },
    async discord(chat, payload = {}) {
      const message = await discordMessage(ctx, chat, payload)
      return resultOf(ctx, message, chat)
    },
    async sendButton(_chat, payload = {}) {
      const flow = payload.nativeFlow || payload.interactiveButtons || legacyButtons(payload.buttons)
      const text = [payload.title, payload.text || payload.caption || payload.body, payload.footer ? `-# ${payload.footer}` : '']
        .filter(v => v && String(v).trim())
        .join('\n')
      const body = { content: waToDiscord(text).slice(0, 2000) || '\u200b', components: buildComponents(ctx, flow || []) }
      const media = payload.image || (payload.document && /^image\//.test(payload.mimetype || '') ? payload.document : null)
      if (media?.url && /^https?:\/\//i.test(media.url)) body.embeds = [{ image: { url: media.url } }]
      else if (Buffer.isBuffer(media)) body.files = [{ attachment: media, name: 'image.png' }]
      const message = await ctx.reply(body)
      return resultOf(ctx, message)
    },
    async resize(buffer) {
      return buffer
    },
    async sendPresenceUpdate() {},
    async readMessages() {},
    parseMention() {
      return []
    },
    async getName(jid) {
      if (String(jid) === String(ctx.key) || String(jid) === `${ctx.key}@discord`) return account.data?.name || ctx.discordUser.globalName || ctx.discordUser.username
      return 'User'
    },
    async react(_chat, emoji) {
      return ctx.react?.(typeof emoji === 'string' ? emoji : emoji?.text)
    },
    aiRich() {
      const state = { title: '', texts: [], images: [], codes: [], htmls: [] }
      const builder = {
        setTitle(value) {
          state.title = String(value || '')
          return builder
        },
        addText(value) {
          if (value) state.texts.push(String(value))
          return builder
        },
        addImage(value) {
          for (const item of [].concat(value || [])) if (item) state.images.push(item)
          return builder
        },
        addHtml(value, options = {}) {
          if (value) state.htmls.push({ html: String(value), options })
          return builder
        },
        addCode(language, code) {
          state.codes.push(`\`\`\`${language || ''}\n${code || ''}\n\`\`\``)
          return builder
        },
        async send() {
          const body = [state.title ? `**${state.title}**` : '', ...state.texts, ...state.codes].filter(Boolean).join('\n\n')
          let last = body.trim() ? await sendText(ctx, body) : null
          const urls = state.images.filter(v => typeof v === 'string' && /^https?:\/\//i.test(v)).slice(0, 4)
          if (urls.length) {
            const message = await ctx.reply({ embeds: urls.map(url => ({ image: { url } })) })
            last = resultOf(ctx, message)
          }
          for (const image of state.images.filter(v => Buffer.isBuffer(v)).slice(0, 4)) last = await deliver(ctx, image, { filename: 'image.png' })
          for (const item of state.htmls.slice(0, 4)) {
            const rendered = await canvas.html(item.html, { width: 1048, scale: 1, transparent: false, background: '#2b2d31', ...item.options })
            last = await deliver(ctx, await rendered.toBuffer('image/jpeg', { quality: 85 }), { filename: 'preview.jpg' })
          }
          return last
        }
      }
      return new Proxy(builder, {
        get(target, prop, receiver) {
          if (prop in target || typeof prop === 'symbol' || prop === 'then') return Reflect.get(target, prop, receiver)
          return () => receiver
        }
      })
    }
  }

  const botId = `${ctx.client?.user?.id || 'discord'}@discord`
  const botUser = { jid: botId, id: botId, lid: '', name: global.settings?.botname || 'Bot' }

  return new Proxy(shared, {
    get(target, prop, receiver) {
      if (prop === 'user') return botUser
      if (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(methods, prop)) return methods[prop]
      return Reflect.get(target, prop, receiver)
    },
    set(target, prop, value) {
      if (prop === 'user' || (typeof prop === 'string' && Object.prototype.hasOwnProperty.call(methods, prop))) return true
      target[prop] = value
      return true
    }
  })
}

async function buildMessage(ctx, { command, text, prefix }) {
  const own = ctx.attachment ? mediaProps(ctx.attachment) : null
  const quotedInfo = await ctx.getQuoted?.().catch(() => null)
  const quotedMedia = quotedInfo?.attachment ? mediaProps(quotedInfo.attachment) : null
  const sender = ctx.linked ? ctx.key : `${ctx.key}@discord`
  const botJid = `${ctx.client?.user?.id || 'discord'}@discord`
  const channelId = ctx.channel?.id || ctx.discordUser.id
  const messageId = ctx.message?.id || ctx.interaction?.id

  let contextInfo = null
  if (quotedInfo) {
    const quotedNode = quotedMedia
      ? { [quotedMedia.mediaType]: { mimetype: quotedMedia.mimetype, caption: quotedInfo.text || '', fileName: quotedMedia.fileName, __download: quotedMedia.download } }
      : { conversation: quotedInfo.text || '' }
    let participant = `${quotedInfo.authorId}@discord`
    if (quotedInfo.authorId === ctx.discordUser.id) participant = sender
    else if (quotedInfo.authorId === ctx.client?.user?.id) participant = botJid
    contextInfo = { stanzaId: quotedInfo.id, participant, quotedMessage: quotedNode, mentionedJid: [] }
  }

  const body = `${prefix}${command}${text ? ` ${text}` : ''}`
  const message = own
    ? { [own.mediaType]: { mimetype: own.mimetype, caption: text, fileName: own.fileName, __download: own.download } }
    : { conversation: body }

  const m = {
    platform: 'discord',
    chat: channelId,
    sender,
    id: messageId,
    isGroup: ctx.inGuild,
    isBaileys: false,
    fromMe: false,
    pushName: ctx.discordUser.globalName || ctx.discordUser.username,
    name: ctx.discordUser.globalName || ctx.discordUser.username,
    text: body,
    command,
    mentionedJid: [],
    error: null,
    limit: false,
    key: { id: messageId, remoteJid: channelId, fromMe: false, participant: sender },
    message,
    ...(own || {}),
    msg: { ...(own?.msg || {}), ...(contextInfo ? { contextInfo } : {}) },
    quoted: quotedInfo
      ? {
          id: quotedInfo.id,
          sender: contextInfo.participant,
          text: quotedInfo.text || '',
          ...(quotedMedia || {})
        }
      : null
  }

  m.reply = async (content) => {
    if (Buffer.isBuffer(content)) return deliver(ctx, content, {})
    if (content && typeof content === 'object' && !Array.isArray(content)) {
      if (content.text) return sendText(ctx, content.text)
      return null
    }
    return sendText(ctx, content)
  }
  m.react = async (emoji) => ctx.react?.(emoji)
  m.toString = () => m.text

  return m
}

function isUnsupported(err) {
  const message = typeof err === 'string' ? err : err?.message || ''
  return err instanceof TypeError && /(conn|this)\.[\w$]+ is not a function|aiRich|relayMessage|waUploadToServer/i.test(message)
}

async function runPlugin(entry, ctx) {
  let command = ctx.invokedName || entry.name
  if (entry.name === 'ai' && ctx.args?.model && !command.includes(':')) command = `ai:${ctx.args.model}`
  const text = String(ctx.text ?? (entry.inputNames || ['text']).map(n => ctx.args?.[n]).filter(v => v !== undefined && v !== null && v !== '').join(' ')).trim()
  const prefix = ctx.prefix || '.'
  const args = text.split(/\s+/).filter(Boolean)

  await ctx.defer()

  const account = { data: ctx.user }
  const m = await buildMessage(ctx, { command, text, prefix })
  const conn = createConn(ctx, entry.shared, account)

  const release = []
  if (entry.persistChat) ensureChatDefaults(m.chat)
  else release.push(await acquire('chats', m.chat, () => ({ useDocument: false, isBanned: false })))
  release.push(await acquire('users', m.sender, () => ctx.user))

  try {
    await entry.handler.call(conn, m, {
      conn,
      platform: 'discord',
      text,
      args,
      command,
      usedPrefix: prefix,
      noPrefix: text,
      isOwner: ctx.isOwner,
      isROwner: ctx.isOwner,
      isMods: ctx.isOwner,
      isPrems: ctx.isOwner || ctx.user?.premium === true,
      isAdmin: false,
      isBotAdmin: false,
      user: ctx.user,
      participants: [],
      groupMetadata: {}
    })
  } catch (err) {
    ctx.failed = true
    if (isUnsupported(err)) {
      await ctx.reply({ content: 'This command needs a WhatsApp-only feature that is not available on Discord.' }).catch(() => {})
    } else {
      const message = typeof err === 'string' ? err : err?.message || String(err)
      if (typeof err !== 'string') console.error(chalk.red('Discord') + chalk.gray(` ${command} failed:`), err)
      await sendText(ctx, message.slice(0, 1800)).catch(() => {})
    }
  } finally {
    for (const done of release) done()
  }
}

function matcherOf(command) {
  if (command instanceof RegExp) {
    return name => {
      command.lastIndex = 0
      return command.test(name)
    }
  }
  if (Array.isArray(command)) {
    return name => command.some(c => {
      if (c instanceof RegExp) {
        c.lastIndex = 0
        return c.test(name)
      }
      return String(c).toLowerCase() === name
    })
  }
  if (typeof command === 'string') return name => command.toLowerCase() === name
  return () => false
}

function namesOf(handler, match) {
  const helps = [].concat(handler.help || [])
    .map(h => String(h).trim().split(/\s+/)[0].toLowerCase())
    .filter(n => NAME_RE.test(n) && match(n))
  const names = [...new Set(helps)]
  if (!names.length && Array.isArray(handler.command)) {
    for (const c of handler.command) {
      const n = typeof c === 'string' ? c.toLowerCase() : ''
      if (NAME_RE.test(n)) names.push(n)
    }
  }
  return names
}

function bridgeUsageOf(handler, name) {
  const declared = [].concat(handler.help || []).filter(h => h && typeof h === 'object' && h.name)
  if (declared.length) return usageLine(name, declared)
  const found = [].concat(handler.help || []).map(h => String(h).trim()).find(h => h.split(/\s+/)[0].toLowerCase() === name)
  return found || name
}

async function loadBridgeCommands(existingNames = new Set()) {
  const commands = []
  const shared = {
    user: { jid: 'discord@bot', id: 'discord@bot', name: global.settings?.botname || 'Bot' },
    chats: {}
  }

  for (const [folder, files] of Object.entries(bridgeGroups())) {
    for (const file of files) {
      const full = path.join(COMMANDS_DIR, folder, `${file}.js`)
      if (!fs.existsSync(full)) continue

      let handler
      let source = ''
      try {
        const mod = await import(pathToFileURL(full).href)
        handler = mod.default
        source = fs.readFileSync(full, 'utf8')
      } catch (err) {
        console.error(chalk.red('Discord') + chalk.gray(` Failed to bridge ${folder}/${file}.js: ${err?.message || err}`))
        continue
      }
      if (typeof handler !== 'function' || !handler.command) continue

      const match = matcherOf(handler.command)
      const usesFile = /\.download\s*\(/.test(source)
      const tag = [].concat(handler.tags || [])[0] || folder
      const category = categoryOf(tag)
      const cost = handler.limit === true ? 1 : Number(handler.limit) || 0
      const access = discordAccessOf(handler)
      const entry = { handler, shared, name: '', persistChat: folder === 'ai' && file === 'ai' }

      for (const name of namesOf(handler, match)) {
        if (existingNames.has(name)) continue
        existingNames.add(name)
        const usage = bridgeUsageOf(handler, name)
        const declared = [].concat(handler.help || []).filter(h => h && typeof h === 'object' && h.name)
        const inputNames = declared.length ? declared.map(h => String(h.name).toLowerCase()) : ['text']
        const options = declared.length
          ? declared.map(h => ({ name: String(h.name).toLowerCase(), description: String(h.description || h.name).slice(0, 100), type: h.type || 'string', required: !!h.required }))
          : [{ name: 'text', description: 'Input: URL, query or text', type: 'string' }]
        if (usesFile || entry.persistChat) options.push({ name: 'file', description: 'File to process', type: 'attachment' })
        if (entry.persistChat) options.push({ name: 'model', description: 'AI model', type: 'string', slashOnly: true, choices: ['flash-lite', 'flash', 'pro', 'gemma', 'gemma-moe'].map(v => ({ name: v, value: v })) })
        const own = { ...entry, name, inputNames }
        commands.push({
          name,
          description: clip(entry.persistChat ? 'Chat with the AI assistant' : handler.ai?.description || usage, 100),
          usage,
          category,
          options,
          bridge: true,
          match,
          limit: cost,
          ...('exp' in handler ? { exp: Number(handler.exp) } : {}),
          owner: access.owner,
          permission: access.permission,
          premium: access.premium,
          cooldown: undefined,
          run: ctx => runPlugin(own, ctx)
        })
      }
    }
  }

  return commands
}

async function registerBridge() {
  const taken = new Set()
  for (const cmd of commands.values()) {
    taken.add(cmd.name)
    for (const alias of cmd.aliases || []) taken.add(alias)
  }
  const bridged = await loadBridgeCommands(taken)
  for (const cmd of bridged) commands.set(cmd.name, { ...cmd, file: null })
  if (bridged.length) log('info', `${bridged.length} WhatsApp command(s) bridged`)
}

const INTENT_HINTS = {
  messageContent: 'Message Content intent is disabled in the Developer Portal, prefix commands only work in DMs or when mentioning the bot. Enable it under Bot > Privileged Gateway Intents.',
  members: 'Server Members intent is disabled in the Developer Portal, welcome messages and auto role are off. Enable it under Bot > Privileged Gateway Intents.'
}

function isIntentError(err) {
  return err?.code === 'DisallowedIntents' || /disallowed intents/i.test(String(err?.message || err))
}

export async function startDiscord() {
  if (client) return client

  const token = process.env.DISCORD_TOKEN
  if (!token) {
    console.warn(chalk.yellow('Discord') + chalk.gray(' DISCORD_TOKEN is not set in .env, Discord bot skipped.'))
    return null
  }

  const discord = await loadDiscordJs()
  if (db.data == null) await loadDatabase()
  await loadAllCommands()
  await registerBridge()

  const attempts = [
    { messageContent: true, members: true },
    { messageContent: true, members: false },
    { messageContent: false, members: true },
    { messageContent: false, members: false }
  ]
  let instance = null
  for (let i = 0; i < attempts.length; i++) {
    const candidate = createClient(discord, attempts[i])
    client = candidate
    try {
      await candidate.login(token)
      instance = candidate
      break
    } catch (err) {
      await candidate.destroy().catch(() => {})
      client = null
      if (!isIntentError(err) || i === attempts.length - 1) throw err
      const prev = attempts[i]
      const next = attempts[i + 1]
      if (prev.messageContent && !next.messageContent) log('error', INTENT_HINTS.messageContent)
      if (prev.members && !next.members) log('error', INTENT_HINTS.members)
    }
  }
  client = instance

  global.discord = { client, commands }
  return client
}

export async function stopDiscord() {
  global.discordMusic?.stopAllMusic?.()
  for (const watcher of watchers.values()) watcher.close()
  watchers.clear()
  if (syncTimer) clearTimeout(syncTimer)
  syncTimer = null
  if (client) {
    await client.destroy()
    client = null
  }
  readyHandled = false
  lastSignature = ''
}

const getDiscordClient = () => client

setInterval(() => {
  const now = Date.now()
  for (const [key, readyAt] of cooldowns) {
    if (now >= readyAt) cooldowns.delete(key)
  }
  for (const [key, entry] of actions) {
    if (entry.expires < now) actions.delete(key)
  }
}, 5 * 60 * 1000).unref()

const DEFAULT_WELCOME = 'Welcome {user} to {server}! You are member #{count}.'


function snowflakeOf(input) {
  if (input && typeof input === 'object') return input.id ? String(input.id) : null
  const text = String(input ?? '').trim()
  return /^<(?:@[!&]?|#)(\d{15,22})>$/.exec(text)?.[1] || (/^\d{15,22}$/.test(text) ? text : null)
}

function guildConfig(guildId) {
  const guilds = db.data?.guilds
  if (!guilds || typeof guilds !== 'object') return null
  return guilds[String(guildId)] || null
}

function updateGuildConfig(guildId, patch) {
  if (!db.data) return null
  if (!db.data.guilds || typeof db.data.guilds !== 'object') db.data.guilds = {}
  const id = String(guildId)
  db.data.guilds[id] = { ...(db.data.guilds[id] || {}), ...patch }
  scheduleAutosave()
  return db.data.guilds[id]
}

function guildPrefix(guildId) {
  if (!guildId) return null
  const value = guildConfig(guildId)?.prefix
  return typeof value === 'string' && value ? value : null
}

function setGuildPrefix(guildId, value) {
  return updateGuildConfig(guildId, { prefix: value || null })
}

function prefixesOf(guildId = null) {
  return prefixesFor(guildId).filter(v => typeof v === 'string')
}

function findDiscordCommand(input) {
  const name = commandNameOf(input)
  return name ? findCommand(name) : null
}

function commandNameOf(input) {
  return String(input ?? '').trim().toLowerCase().replace(/^[./!]/, '')
}

const ACCESS_LOCKED = new Set(['prefix', 'access', 'allow', 'disallow', 'resetaccess'])


function permissionLabel(name) {
  return {
    ManageGuild: 'Manage Server',
    ModerateMembers: 'Timeout Members',
    CreateInstantInvite: 'Create Invite'
  }[name] || String(name).replace(/([a-z])([A-Z])/g, '$1 $2')
}

function accessRulesOf(guildId) {
  if (!guildId) return {}
  const access = guildConfig(guildId)?.access
  return access && typeof access === 'object' ? access : {}
}

function accessRoleIds(guildId, name) {
  const list = accessRulesOf(guildId)[name]
  return Array.isArray(list) ? list.map(String) : []
}

function setCommandRoles(guildId, name, roleIds) {
  const access = { ...accessRulesOf(guildId) }
  const unique = [...new Set(roleIds.map(String))]
  if (unique.length) access[name] = unique
  else delete access[name]
  return updateGuildConfig(guildId, { access })
}

function forgetRole(guildId, roleId) {
  const config = guildConfig(guildId)
  if (!config) return
  const id = String(roleId)
  const patch = {}
  if (String(config.autoRole || '') === id) patch.autoRole = null
  if (config.access && typeof config.access === 'object') {
    const access = {}
    for (const [name, list] of Object.entries(config.access)) {
      const rest = (Array.isArray(list) ? list : []).filter(value => String(value) !== id)
      if (rest.length) access[name] = rest
    }
    patch.access = access
  }
  if (config.reactionRoles && typeof config.reactionRoles === 'object') {
    const reactionRoles = {}
    for (const [messageId, entry] of Object.entries(config.reactionRoles)) {
      const emojis = Object.fromEntries(Object.entries(entry?.emojis || {}).filter(([, value]) => String(value?.roleId) !== id))
      if (Object.keys(emojis).length) reactionRoles[messageId] = { ...entry, emojis }
    }
    patch.reactionRoles = reactionRoles
  }
  if (Object.keys(patch).length) updateGuildConfig(guildId, patch)
}

function requiredPermissions(cmd, args) {
  const value = typeof cmd.permission === 'function' ? cmd.permission(args, cmd.name) : cmd.permission
  return value ? [].concat(value) : []
}

function accessDenial(cmd, { owner = false, inGuild = false, guild = null, member = null, args = {} } = {}) {
  if (owner || !inGuild) return null
  if (!guild || !member) return 'I could not check your roles in this server, try again.'
  if (member.permissions.has('Administrator')) return null

  if (!ACCESS_LOCKED.has(cmd.name)) {
    const roles = accessRoleIds(guild.id, cmd.name)
    if (roles.length) {
      if (roles.includes(String(guild.id)) || roles.some(id => (member.roleIds || []).includes(id))) return null
      return `Only members with one of these roles can use \`${cmd.name}\`: ${roles.map(id => `<@&${id}>`).join(' ')}`
    }
  }

  const needed = requiredPermissions(cmd, args)
  if (needed.length && !member.permissions.has(...needed)) {
    return `You need the ${needed.map(permissionLabel).join(' and ')} permission.`
  }
  return null
}

function parseColor(input) {
  const text = String(input ?? '').trim().toLowerCase()
  if (['off', 'none', 'default', 'reset'].includes(text)) return 0
  const match = /^(?:#|0x)?([0-9a-f]{6})$/.exec(text)
  return match ? parseInt(match[1], 16) : null
}

function keyPermissions(role) {
  const bits = BigInt(role.bits ?? 0)
  return [
    'Administrator', 'ManageGuild', 'ManageRoles', 'ManageChannels', 'ManageMessages',
    'ManageNicknames', 'KickMembers', 'BanMembers', 'ModerateMembers', 'MentionEveryone'
  ].filter(name => (bits & FLAGS[name]) === FLAGS[name])
}

async function roleManageError(guild, actor, role, isOwner = false) {
  if (role.managed) return 'That role is managed by an integration and cannot be changed.'
  return roleError(guild, actor, role, isOwner)
}

function displayNameOf(member) {
  return member.nick || member.user.globalName || member.user.username
}

function isTextChannel(channel) {
  return !!channel && [0, 5, 10, 11, 12, 15].includes(Number(channel.type))
}

async function resolveChannel(guild, input) {
  const id = snowflakeOf(input)
  if (!id) return null
  const cached = guild.channels.cache.get(id)
  if (cached) return cached
  const data = await guild.client.rest.get(`/channels/${id}`).catch(() => null)
  if (!data || data.guild_id !== guild.id) return null
  return guild.client.resolveChannel(data, guild)
}

async function resolveMember(guild, input) {
  const id = snowflakeOf(input)
  if (!id) return null
  return guild.members.cache.get(id) || (await guild.members.fetch(id).catch(() => null))
}

async function fetchRoles(guild) {
  const list = await guild.client.rest.get(`/guilds/${guild.id}/roles`).catch(() => null)
  if (Array.isArray(list)) guild.update({ roles: list })
  return guild.roles.cache
}

async function resolveRole(guild, input) {
  if (!input) return null
  if (typeof input === 'object' && input.id) return guild.roles.cache.get(input.id) || null
  const id = snowflakeOf(input)
  const find = () => {
    if (id) return guild.roles.cache.get(id) || null
    const name = String(input).trim().toLowerCase()
    return guild.roles.cache.find(role => role.name.toLowerCase() === name) || null
  }
  let role = find()
  if (!role) {
    await fetchRoles(guild)
    role = find()
  }
  return role
}

function topPosition(guild, member) {
  let top = 0
  for (const id of member.roleIds || []) {
    const role = guild.roles.cache.get(id)
    if (role && role.position > top) top = role.position
  }
  return top
}

async function botMember(guild) {
  return guild.members.me || (await guild.members.fetch(guild.client.user.id).catch(() => null))
}

async function canManage(guild, target) {
  if (target.id === guild.ownerId) return false
  const me = await botMember(guild)
  return !!me && topPosition(guild, me) > topPosition(guild, target)
}

async function roleAssignable(guild, role) {
  if (role.id === guild.id || role.managed) return false
  const me = await botMember(guild)
  return !!me && topPosition(guild, me) > role.position
}

function hierarchyError(guild, actor, target) {
  if (target.id === guild.ownerId) return 'I cannot act on the server owner.'
  if (actor.id === guild.ownerId) return null
  if (topPosition(guild, target) >= topPosition(guild, actor)) {
    return 'You cannot act on a member with an equal or higher role.'
  }
  return null
}

async function roleError(guild, actor, role, isOwner = false) {
  if (role.id === guild.id) return 'You cannot manage the @everyone role.'
  if (!(await roleAssignable(guild, role))) return 'I cannot manage that role, check my Manage Roles permission and role position.'
  if (!isOwner && actor.id !== guild.ownerId && role.position >= topPosition(guild, actor)) {
    return 'You cannot manage a role equal to or higher than your own.'
  }
  return null
}

function addMemberRole(guild, userId, roleId, reason) {
  return guild.client.rest.put(`/guilds/${guild.id}/members/${userId}/roles/${roleId}`, { reason })
}

function removeMemberRole(guild, userId, roleId, reason) {
  return guild.client.rest.delete(`/guilds/${guild.id}/members/${userId}/roles/${roleId}`, { reason })
}

function kickMember(guild, userId, reason) {
  return guild.client.rest.delete(`/guilds/${guild.id}/members/${userId}`, { reason })
}

function banMember(guild, userId, { reason, deleteSeconds = 0 } = {}) {
  return guild.client.rest.put(`/guilds/${guild.id}/bans/${userId}`, {
    body: { delete_message_seconds: deleteSeconds },
    reason
  })
}

function unbanMember(guild, userId, reason) {
  return guild.client.rest.delete(`/guilds/${guild.id}/bans/${userId}`, { reason })
}

function setMemberNick(guild, userId, nick, reason) {
  return guild.client.rest.patch(`/guilds/${guild.id}/members/${userId}`, { body: { nick }, reason })
}

async function slowmodeOf(channel) {
  const data = await channel.client.rest.get(`/channels/${channel.id}`).catch(() => null)
  return data?.rate_limit_per_user ?? 0
}

function setSlowmode(channel, seconds, reason) {
  return channel.client.rest.patch(`/channels/${channel.id}`, { body: { rate_limit_per_user: seconds }, reason })
}


function formatWelcome(template, member) {
  const guild = member.guild
  return String(template || DEFAULT_WELCOME)
    .replace(/\{user\}/g, `<@${member.id}>`)
    .replace(/\{username\}/g, member.user.globalName || member.user.username)
    .replace(/\{server\}/g, guild.name)
    .replace(/\{count\}/g, String(guild.memberCount ?? ''))
    .slice(0, 1000)
}

async function handleMemberAdd(member) {
  if (member.user?.bot) return
  const guild = member.guild
  const config = guildConfig(guild.id)
  if (!config) return

  if (config.autoRole) {
    const role = guild.roles.cache.get(config.autoRole)
    if (role && await roleAssignable(guild, role)) await addMemberRole(guild, member.id, role.id, 'Auto role').catch(() => {})
  }

  const welcome = config.welcome
  if (!welcome?.channelId) return
  const channel = await resolveChannel(guild, welcome.channelId)
  if (!isTextChannel(channel)) return
  await channel.send({
    content: `<@${member.id}>`,
    embeds: [{
      color: EMBED_COLOR,
      title: `Welcome to ${guild.name}!`,
      description: formatWelcome(welcome.message, member),
      thumbnail: { url: member.user.displayAvatarURL() }
    }],
    allowedMentions: { users: [member.id] }
  }).catch(() => {})
}

const REACTION_KEY = emoji => (emoji?.id ? `${emoji.name}:${emoji.id}` : String(emoji?.name || ''))

function parseEmoji(input) {
  const text = String(input ?? '').trim()
  const custom = /^<a?:(\w+):(\d{15,22})>$/.exec(text)
  if (custom) return { key: `${custom[1]}:${custom[2]}`, path: `${custom[1]}:${custom[2]}`, display: text }
  if (!text || /\s/.test(text) || text.length > 64) return null
  return { key: text, path: text, display: text }
}

function parseMessageRef(input, channelId) {
  const text = String(input ?? '').trim()
  const link = /discord(?:app)?\.com\/channels\/(\d{15,22}|@me)\/(\d{15,22})\/(\d{15,22})/.exec(text)
  if (link) return { guildId: link[1], channelId: link[2], messageId: link[3] }
  if (/^\d{15,22}$/.test(text)) return { guildId: null, channelId: String(channelId), messageId: text }
  return null
}

function reactionEntries(guildId) {
  if (!guildId) return {}
  const map = guildConfig(guildId)?.reactionRoles
  return map && typeof map === 'object' ? map : {}
}

function reactionRoleOf(guildId, messageId, key) {
  return reactionEntries(guildId)[String(messageId)]?.emojis?.[key]?.roleId ?? null
}

function addReactionRole(guildId, messageId, channelId, emoji, roleId) {
  const all = { ...reactionEntries(guildId) }
  const current = all[String(messageId)]
  all[String(messageId)] = {
    channelId: String(channelId),
    emojis: { ...(current?.emojis || {}), [emoji.key]: { roleId: String(roleId), display: emoji.display } }
  }
  return updateGuildConfig(guildId, { reactionRoles: all })
}

function removeReactionRole(guildId, messageId, key) {
  const all = { ...reactionEntries(guildId) }
  const current = all[String(messageId)]
  if (!current) return null
  const emojis = { ...(current.emojis || {}) }
  delete emojis[key]
  if (Object.keys(emojis).length) all[String(messageId)] = { ...current, emojis }
  else delete all[String(messageId)]
  return updateGuildConfig(guildId, { reactionRoles: all })
}

async function onReaction(reaction, added) {
  if (!reaction?.guildId || !client?.user || String(reaction.userId) === client.user.id) return
  const roleId = reactionRoleOf(reaction.guildId, reaction.messageId, REACTION_KEY(reaction.emoji))
  if (!roleId) return
  const guild = client.guilds?.cache?.get(reaction.guildId)
  if (!guild) return
  const role = guild.roles.cache.get(roleId)
  if (!role || !(await roleAssignable(guild, role))) return
  const change = added ? addMemberRole : removeMemberRole
  try {
    await change(guild, reaction.userId, roleId, 'Reaction role')
  } catch (err) {
    log('error', `Reaction role failed: ${err?.message || err}`)
  }
}

function parsePairs(text) {
  return String(text ?? '').split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const space = part.search(/\s/)
    return space < 0 ? { emoji: part, role: '' } : { emoji: part.slice(0, space), role: part.slice(space).trim() }
  })
}

async function resolveReactionPairs(guild, member, isOwner, text) {
  const pairs = parsePairs(text)
  if (!pairs.length) return { error: 'Use emoji and role pairs, for example `🎮 @Gamer, 🎵 @Music`.' }
  if (pairs.length > 20) return { error: 'A panel can have at most 20 roles.' }
  const seen = new Set()
  const out = []
  for (const pair of pairs) {
    const emoji = parseEmoji(pair.emoji)
    if (!emoji) return { error: `"${pair.emoji}" is not a valid emoji.` }
    if (seen.has(emoji.key)) return { error: `${emoji.display} is used more than once.` }
    seen.add(emoji.key)
    if (!pair.role) return { error: `Give a role after ${emoji.display}.` }
    const lookup = pair.role.startsWith('<@') ? pair.role : pair.role.replace(/^@/, '')
    const role = await resolveRole(guild, lookup)
    if (!role) return { error: `Role "${pair.role}" was not found in this server.` }
    if (role.id === guild.id) return { error: 'Pick a role other than @everyone.' }
    const problem = await roleManageError(guild, member, role, isOwner)
    if (problem) return { error: problem }
    out.push({ emoji, role })
  }
  return { pairs: out }
}

let discordConnection = null

function discordConn() {
  if (discordConnection) return discordConnection
  discordConnection = {
    get client() { return client },
    get user() { return client?.user ?? null },
    get commands() { return commands },
    db,
    embed: (data = {}) => ({ color: EMBED_COLOR, ...data }),
    account: getDiscordAccount,
    registerAction: (userId, text, ttl) => registerAction(userId, text, ttl),
    reply: (chat, content) => client.rest.post(`/channels/${chat}/messages`, { body: normalizePayload(content) }),
    ...discordTools
  }
  return discordConnection
}

const discordTools = {
  find: {
    member: resolveMember,
    role: resolveRole,
    channel: resolveChannel,
    command: findDiscordCommand,
    commandName: commandNameOf,
    id: snowflakeOf,
    displayName: displayNameOf,
    isText: isTextChannel
  },
  roles: {
    error: roleManageError,
    hierarchy: hierarchyError,
    fetch: fetchRoles,
    color: parseColor,
    perms: keyPermissions,
    label: permissionLabel,
    assignable: roleAssignable,
    top: topPosition
  },
  memberRole: { add: addMemberRole, remove: removeMemberRole },
  mod: {
    canManage,
    botMember,
    kick: kickMember,
    ban: banMember,
    unban: unbanMember,
    nick: setMemberNick,
    slowmode: setSlowmode,
    slowmodeOf
  },
  cfg: {
    get: guildConfig,
    set: updateGuildConfig,
    forget: forgetRole,
    welcome: { default: DEFAULT_WELCOME, format: formatWelcome },
    prefix: { get: guildPrefix, set: setGuildPrefix, list: prefixesOf },
    access: {
      rules: accessRulesOf,
      roles: accessRoleIds,
      set: setCommandRoles,
      locked: ACCESS_LOCKED,
      denial: accessDenial
    },
    reactions: {
      pairs: parsePairs,
      resolve: resolveReactionPairs,
      parseEmoji,
      parseMessage: parseMessageRef,
      list: reactionEntries,
      roleOf: reactionRoleOf,
      add: addReactionRole,
      remove: removeReactionRole,
      keyOf: REACTION_KEY
    }
  }
}
