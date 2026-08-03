import { plugins } from "../../lib/plugins.js"
import { performance } from 'perf_hooks';
import chalk from 'chalk';

const linkRegex = /chat.whatsapp.com\/(?:invite\/)?([0-9A-Za-z]{20,24})/i
const SPAM_LIMIT       = 3;
const SPAM_WINDOW_MS   = 10_000;
const SPAM_COOLDOWN_MS = 5_000;
const CLEARLAG_MS      = 2 * 60 * 60 * 1000;
const STATUS_REACT_TTL = 5 * 60 * 1000;
const BANNED_PREFIXES  = ['212', '265', '234'];

function getOwnerNumbers() {
  try {
    const owners = global.settings?.owner || [];
    return owners
      .map(entry => {
        const raw = Array.isArray(entry) ? entry[0] : entry;
        if (!raw) return null;
        return String(raw).replace(/[^0-9]/g, '');
      })
      .filter(Boolean);
  } catch {
    return [];
  }
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

let handler = m => m

handler.before = async function (m, { match, groupMetaData, command, isAdmin, isBotAdmin }) {

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

  if (BANNED_PREFIXES.some(p => m.sender?.startsWith(p))) {
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

    if (noPrefix && !isRealCommand) {
      const mean = didYouMean(noPrefix.toLowerCase(), alias)
      if (mean && !chat.isBanned) { this.reply(m.chat, `Did You Mean: \`${usedPrefix + mean}\`?`, m) }
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

  const ownerNumbers = getOwnerNumbers()
  const senderNumber = m.sender?.replace(/[^0-9]/g, '') || ''
  const isExempted   = m.sender === this.user?.jid || ownerNumbers.includes(senderNumber)

  const isCommandTriggered = !!command || m.isCommand === true || (global.prefix?.test?.(m.text || ''));

  if (!isExempted && isCommandTriggered) {
    if (!this.spam) this.spam = {}
    if (!this.spam[m.sender]) this.spam[m.sender] = { count: 0, lastspam: 0 }

    const spamData = this.spam[m.sender]
    const now      = performance.now()

    if (now - spamData.lastspam < SPAM_WINDOW_MS) {
      spamData.count++

      if (spamData.count >= SPAM_LIMIT) {
        user.banned       = true
        spamData.lastspam = now + SPAM_COOLDOWN_MS

        setTimeout(() => {
          if (user) user.banned    = false
          spamData.count = 0
        }, SPAM_COOLDOWN_MS)

        return;
      }
    } else {
      spamData.count = 0
    }
    spamData.lastspam = now
  }

  const isGroupLink = linkRegex.exec(m.text)
  if (chat.antiLink && isGroupLink && !isAdmin) {
    if (isBotAdmin) {
      const linkThisGroup = `https://chat.whatsapp.com/${await this.groupInviteCode(m.chat)}`
      if (m.text.includes(linkThisGroup)) return !0
      await this.sendMessage(m.chat, { delete: m.key })
    }
  }

}

export default handler
