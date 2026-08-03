import { smsg, matchParticipant, resolveLidToNumber, updateUserMapping, autoMergeLidUsers } from './simple.js';
import { plugins } from './plugins.js';
import { format } from 'util';
import { fileURLToPath } from 'url';
import path, { join } from 'path';
import chalk from 'chalk';
import Connection from './connection.js';
import db, { loadDatabase } from './database.js';
global.db = db;
import { handleError as autoHeal } from './ai/mcp.js';
import EventEmitter from 'events';
const { getContentType, proto } = await import('baileys');
const isNumber = x => typeof x === 'number' && !isNaN(x);
const delay = ms => isNumber(ms) && new Promise(resolve => setTimeout(resolve, ms));
function ensureDefaults(obj, defaults, numericKeys = []) {
    for (const key in defaults) {
        const isMissing = numericKeys.includes(key) ? !isNumber(obj[key]) : !(key in obj);
        if (isMissing)
            obj[key] = defaults[key];
    }
    return obj;
}
const QUEUE_DELAY = 5 * 1000;
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
                    await delay(QUEUE_DELAY);
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
        let name = await conn.getName(m.sender).catch?.(() => '') || '';
        let senderLabel = name
            ? `${chalk.gray('(' + name + ')')} ${chalk.gray(m.sender)}`
            : chalk.gray(m.sender || 'unknown');
        let mtype = m.mtype
            ? m.mtype.replace(/message$/i, '').replace('audio', m.msg?.ptt ? 'PTT' : 'Audio').replace(/^./, v => v.toUpperCase())
            : '-';
        let typeLabel = m.isCommand
            ? `${chalk.gray(mtype)} ${chalk.greenBright('(Command)')}`
            : chalk.gray(mtype);
        let filesize = m.msg?.fileLength?.low || m.msg?.fileLength || m.text?.length || 0;
        let sizeLabel = filesize <= 0 ? chalk.gray('-')
            : filesize < 1000 ? chalk.gray(`${filesize}B`)
                : filesize < 1000000 ? chalk.gray(`${(filesize / 1000).toFixed(1)}KB`)
                    : chalk.gray(`${(filesize / 1000000).toFixed(1)}MB`);
        let raw = typeof m.text === 'string' && m.text ? m.text : '-';
        let msgText = raw.length > 60 ? raw.slice(0, 60) + '...' : raw;
        let msgLabel = m.error ? chalk.red(msgText) : chalk.gray(msgText);
        console.log([
            chalk.gray('-'),
            '• Sender  : ' + senderLabel,
            '• Type    : ' + typeLabel,
            '• Size    : ' + sizeLabel,
            '• Message : ' + msgLabel,
        ].join('\n'));
    }
    catch (e) {
        console.error('print.js >', e.message);
    }
}
setInterval(autoMergeLidUsers, 30 * 60 * 1000);
setTimeout(autoMergeLidUsers, 5000);
let _requiredGroupId = null;
let _requiredGroupJid = null;
let _requiredGroupPromise = null;
async function getRequiredGroupId(sock) {
    if (_requiredGroupJid) {
        return _requiredGroupJid;
    }
    if (_requiredGroupId === null && _requiredGroupPromise === null) {
        return null;
    }
    if (_requiredGroupPromise) {
        return _requiredGroupPromise;
    }
    _requiredGroupPromise = (async () => {
        try {
            const raw = (process.env.GROUP_ID || '').trim();
            if (!raw) {
                _requiredGroupId = null;
                _requiredGroupJid = null;
                return null;
            }
            if (raw.endsWith('@g.us')) {
                _requiredGroupJid = raw;
                return _requiredGroupJid;
            }
            if (raw.includes('chat.whatsapp.com')) {
                const code = raw.replace('https://chat.whatsapp.com/', '').replace('http://chat.whatsapp.com/', '').trim();
                try {
                    const info = await sock.groupGetInviteInfo(code);
                    if (info && info.id) {
                        _requiredGroupJid = info.id;
                        return _requiredGroupJid;
                    }
                    else {
                        _requiredGroupId = null;
                        _requiredGroupJid = null;
                        return null;
                    }
                }
                catch (inviteError) {
                    _requiredGroupId = null;
                    _requiredGroupJid = null;
                    return null;
                }
            }
            _requiredGroupId = null;
            _requiredGroupJid = null;
            return null;
        }
        catch (error) {
            console.error('[GROUP ACCESS CHECK] Failed to resolve GROUP_ID:', error);
            _requiredGroupId = null;
            _requiredGroupJid = null;
            return null;
        }
        finally {
            _requiredGroupPromise = null;
        }
    })();
    return _requiredGroupPromise;
}
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
        const isUserInGroup = async (jidOrJids, groupJid) => {
            const jids = (Array.isArray(jidOrJids) ? jidOrJids : [jidOrJids]).filter(Boolean);
            const jidLabel = jids.join(', ') || 'unknown';
            const matchAny = p => jids.some(jid => matchParticipant(this, p, jid));
            try {
                let meta;
                try {
                    meta = await this.groupMetadata(groupJid);
                }
                catch (metaError) {
                    console.error("[GROUP ACCESS CHECK] groupMetadata gagal:", metaError);
                    meta = null;
                }
                if (!meta || !meta.participants || meta.participants.length === 0) {
                    try {
                        const rawGroupId = (process.env.GROUP_ID || '').trim();
                        const inviteCode = rawGroupId.includes('chat.whatsapp.com')
                            ? rawGroupId.replace('https://chat.whatsapp.com/', '').replace('http://chat.whatsapp.com/', '').trim()
                            : await this.groupInviteCode(groupJid);
                        const inviteInfo = await this.groupGetInviteInfo(inviteCode);
                        if (inviteInfo?.id) {
                            console.log(`[GROUP ACCESS CHECK] groupGetInviteInfo tidak membawa participants, coba groupMetadata ulang pakai id: ${inviteInfo.id}`);
                            const retryMeta = await this.groupMetadata(inviteInfo.id).catch(() => null);
                            if (retryMeta?.participants?.length) {
                                meta = retryMeta;
                            }
                            else if (!meta) {
                                meta = inviteInfo;
                            }
                        }
                    }
                    catch (fallbackError) {
                        console.error("[GROUP ACCESS CHECK] Fallback groupGetInviteInfo juga gagal:", fallbackError);
                    }
                }
                if (!meta)
                    return false;
                if (meta.participants?.some(matchAny))
                    return true;
                if (meta.isCommunity) {
                    const allGroups = await this.groupFetchAllParticipating();
                    const linkedGroups = Object.values(allGroups || {}).filter(g => g.linkedParent === (meta.id || groupJid));
                    console.log(`[GROUP ACCESS CHECK] Community terdeteksi. Grup turunan yang bot ikuti: ${linkedGroups.length}`, linkedGroups.map(g => ({ id: g.id, subject: g.subject, isCommunityAnnounce: g.isCommunityAnnounce, totalParticipants: g.participants?.length })));
                    for (const g of linkedGroups) {
                        if (g.participants?.some(matchAny))
                            return true;
                    }
                    console.log(`[GROUP ACCESS CHECK] jid "${jidLabel}" tidak ditemukan di semua grup turunan community.`);
                    return false;
                }
                console.log(`[GROUP ACCESS CHECK] jid "${jidLabel}" TIDAK ditemukan di grup ${groupJid}.`);
                console.log(`[GROUP ACCESS CHECK] Total participants: ${meta.participants?.length}`);
                console.log(`[GROUP ACCESS CHECK] Sample participant ids:`, meta.participants?.slice(0, 5).map(p => ({ id: p.id, phoneNumber: p.phoneNumber })));
                return false;
            }
            catch (error) {
                console.error("[GROUP ACCESS CHECK] Error checking group/community membership:", error);
                return false;
            }
        };
        const rawKey = m.key || {};
        const rawParticipant = m.participant || rawKey.participant || '';
        const rawPnFromKey = rawKey.participantPn || rawKey.senderPn || null;
        const protoPN = rawPnFromKey
            ? (rawPnFromKey + '@s.whatsapp.net')
            : null;
        m = smsg(this, m) || m;
        if (!m)
            return;
        let candidates = [
            protoPN,
            m.key?.participantPn ? m.key.participantPn + '@s.whatsapp.net' : null,
            m.key?.senderPn ? m.key.senderPn + '@s.whatsapp.net' : null,
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
            actualNumber = await resolveLidToNumber(lidNumber, this, m.chat);
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
            if (typeof db.data.chats[m.chat] !== 'object')
                db.data.chats[m.chat] = {};
            ensureDefaults(db.data.chats[m.chat], {
                isBanned: false,
                welcome: false,
                detect: false,
                sWelcome: '',
                sBye: '',
                sPromote: '',
                sDemote: '',
                delete: false,
                useDocument: false,
                viewonce: false,
                aiChat: false,
                aiSessionChat: [],
                expired: 0,
                antiLink: false,
                antispam: false,
                antinsfw: false,
            }, ['expired']);
        }
        catch (e) {
            if (e)
                console.error(e);
        }
        try {
            if (!isValidSender)
                throw null;
            const userKey = resolvedUserKey || m.sender;
            if (typeof db.data.users[userKey] !== 'object')
                db.data.users[userKey] = {};
            let user = db.data.users[userKey];
            ensureDefaults(user, {
                exp: 0,
                limit: 10,
                registered: false,
                afk: -1,
                afkReason: '',
                banned: false,
                warn: 0,
                level: 0,
                password: '',
                premium: false,
                premiumTime: 0,
            }, ['exp', 'limit', 'afk', 'warn', 'level', 'premiumTime']);
            if (!user.registered) {
                ensureDefaults(user, {
                    name: m.name,
                    email: '',
                    age: -1,
                    regTime: -1,
                }, ['age', 'regTime']);
            }
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
            if (typeof db.data.settings[this.user.jid] !== 'object')
                db.data.settings[this.user.jid] = {};
            ensureDefaults(db.data.settings[this.user.jid], {
                self: false,
                restrict: false,
                status: 0,
                anticall: true,
                autoread: true,
                autorestart: false,
                clearlag: true,
                timeclearlag: 0,
                restartDB: 0,
                resetlimit: 0,
            }, ['status', 'timeclearlag', 'restartDB', 'resetlimit']);
        }
        catch (e) {
            if (e)
                console.error(e);
        }
        const isNewsletter = m.chat?.endsWith('@newsletter');
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
        const senderLookup = actualNumber || m.sender;
        const user = (m.isGroup ? participants.find(p => matchParticipant(this, p, senderLookup) ||
            (lidNumber && matchParticipant(this, p, lidNumber))) : {}) || {};
        const botJid = this.decodeJid(this.user.jid);
        const botNum = botJid.endsWith('@lid') ? null : botJid;
        const bot = (m.isGroup ? participants.find(p => matchParticipant(this, p, botJid) ||
            (botNum && matchParticipant(this, p, botNum)) ||
            matchParticipant(this, p, this.decodeJid(Connection.conn?.user?.id || ''))) : {}) || {};
        const isRAdmin = user?.admin == 'superadmin' || false;
        const isAdmin = isRAdmin || user?.admin == 'admin' || false;
        const isBotAdmin = bot?.admin === 'superadmin' || bot?.admin === 'admin' || false;
        const ___dirname = path.join(path.dirname(fileURLToPath(import.meta.url)), '../plugins');
        const ___rootdir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../');
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
            const str2Regex = str => str.replace(/[|\\{}()[\]^$+*?.]/g, '\\$&');
            let _prefix = plugin.customPrefix ? plugin.customPrefix : this.prefix ? this.prefix : global.prefix;
            let match = (_prefix instanceof RegExp ?
                [[_prefix.exec(m.text), _prefix]] :
                Array.isArray(_prefix) ?
                    _prefix.map(p => {
                        let re = p instanceof RegExp ? p : new RegExp(str2Regex(p));
                        return [re.exec(m.text), re];
                    }) :
                    typeof _prefix === 'string' ?
                        [[new RegExp(str2Regex(_prefix)).exec(m.text), new RegExp(str2Regex(_prefix))]] :
                        [[[], new RegExp]]).find(p => p[1]);
            if (typeof plugin.before === 'function') {
                let beforeResult;
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
                    });
                }
                catch (e) {
                    console.error(`[plugin.before] error di '${name}':`, e);
                    continue;
                }
                if (beforeResult)
                    continue;
            }
            if (typeof plugin !== 'function')
                continue;
            if ((usedPrefix = (match[0] || '')[0])) {
                let noPrefix = m.text.replace(usedPrefix, '');
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
                if (!isOwner && !m.chat.endsWith('@newsletter') && !m.chat.endsWith('@broadcast') && !db.data.chats[m.chat].isBanned) {
                    const chatData = db.data.chats[m.chat];
                    if (!chatData.isBanned) {
                        const requiredGroup = await getRequiredGroupId(this);
                        if (requiredGroup) {
                            const senderCandidates = [actualNumber, lidNumber, m.sender].filter(Boolean);
                            const userInGroup = await isUserInGroup(senderCandidates, requiredGroup);
                            if (!userInGroup) {
                                const hasNumber = !!db.data.users?.[m.sender]?.number;
                                if (!hasNumber) {
                                    const rawGroupId = (process.env.GROUP_ID || '').trim();
                                    let joinUrl = rawGroupId.includes('chat.whatsapp.com') ? rawGroupId : null;
                                    if (!joinUrl) {
                                        try {
                                            joinUrl = "https://chat.whatsapp.com/" + await this.groupInviteCode(requiredGroup);
                                        }
                                        catch (error) {
                                            console.error("[GROUP ACCESS CHECK] Gagal generate invite link untuk tombol Join:", error);
                                        }
                                    }
                                    try {
                                        await this.sendButton(m.chat, {
                                            text: `We cant find your JID, join here to make sure system working well`,
                                            ...(joinUrl ? {
                                                nativeFlow: [{
                                                        text: 'Join group',
                                                        url: joinUrl
                                                    }]
                                            } : {})
                                        }, m);
                                    }
                                    catch (error) {
                                        console.error("[GROUP ACCESS CHECK] sendButton gagal:", error);
                                    }
                                    continue;
                                }
                                console.log(`[GROUP ACCESS CHECK] User ${m.sender} tidak terdeteksi di grup, tapi number sudah tersimpan di db, lanjut proses command.`);
                            }
                        }
                    }
                }
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
                            console.error("[LIMIT CHECK] sendButton gagal:", error);
                        }
                        continue;
                    }
                }
                if (plugin.level > _user.level) {
                    let quoted = { key: { remoteJid: "0@s.whatsapp.net" }, message: { orderMessage: { orderId: '780642630945098', thumbnail: await this.resize(global.settings.icon, 500, 500), itemCount: 666, status: 1, surface: 1, message: "", orderTitle: 'Channel.', sellerJid: '6283143393763@s.whatsapp.net', token: 'AR6pyJ/fz5vRFxggGxURL7EA/vCtjKrhcJSNhHqX1iJh8A==', totalAmount1000: "0", totalCurrencyCode: "IDR" } } };
                    try {
                        await this.sendButton(m.chat, {
                            text: `Tier ${global.settings.tier.name[plugin.level]} required\nPlease upgrade your tier on our website`,
                            nativeFlow: [{
                                    text: 'Upgrade',
                                    url: global.getServerUrl()
                                }]
                        }, quoted);
                    }
                    catch (error) {
                        console.error("[LEVEL CHECK] sendButton gagal:", error);
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
                        this.sendLocUrl(id, pp, eventJoin, null, text, null, "", null, { mentions: this.parseMention(text) });
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
export async function onCall(info) {
    let ciko = db.data.settings[this.user.jid].anticall;
    let data = global.settings.owner.filter(([id, isCreator]) => id && isCreator);
    if (!ciko)
        return;
    console.log(info);
    for (let tihh of info) {
        if (tihh.isGroup == false) {
            if (tihh.status == "offer") {
                await this.reply(tihh.from, `> *${this.user.name}* tidak bisa menerima panggilan ${tihh.isVideo ? `video` : `suara`}. Maaf @${tihh.from.split('@')[0]} kamu akan diblokir. Jika tidak sengaja silahkan hubungi Owner untuk dibuka !`, null, { mentions: [tihh.from] });
                this.sendContact(tihh.from, data.map(([id, name]) => [id, name]), null);
                new Promise((resolve, reject) => setTimeout(resolve, 8000));
                await this.updateBlockStatus(tihh.from, "block");
            }
        }
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
