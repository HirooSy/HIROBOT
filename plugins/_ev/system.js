import fs from 'fs';
import didyoumean from 'didyoumean';
import { plugins } from "../../lib/plugins.js"
import { performance } from 'perf_hooks';
import chalk from 'chalk';

// ── Konfigurasi ──────────────────────────────────────────────
const SPAM_LIMIT       = 3;
const SPAM_WINDOW_MS   = 10_000;
const SPAM_COOLDOWN_MS = 5_000;
const CLEARLAG_MS      = 2 * 60 * 60 * 1000; // 2 jam
const STATUS_REACT_TTL = 5 * 60 * 1000;     // 5 menit
const BANNED_PREFIXES  = ['212', '265', '234'];     // prefix nomor yang di-autoblok
// ─────────────────────────────────────────────────────────────

// ── Helper: baca owner.json ──────────────────────────────────
// Format: [ ['628xxx'], ['628xxx', 'Name', true], ... ]
// Kembalikan array nomor saja (tanpa @s.whatsapp.net)
function getOwnerNumbers() {
  try {
    const raw    = fs.readFileSync('./data/owner.json', 'utf-8');
    const parsed = JSON.parse(raw);
    return parsed
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
// ─────────────────────────────────────────────────────────────

let handler = m => m

handler.before = async function (m, { match, groupMetaData, command }) {

  const db_users = db.data.users
  const db_chats = db.data.chats
  const setting  = db.data.settings[this.user?.jid || '']
  const user     = db_users[m.sender]
  const chat     = db_chats[m.chat]

  // ── Guard: user atau chat tidak ada / incomplete ─────────
  if (!user || !chat || !setting) return

  // ── React ke Status Broadcast ────────────────────────────
  /*if (m.key.remoteJid === 'status@broadcast') {
    if (m.key.fromMe) return
    const isRecent = Date.now() - m.messageTimestamp * 1000 <= STATUS_REACT_TTL
    if (isRecent) {
      await this.sendMessage(m.chat,
        { react: { key: m.key, text: '🖤' } },
        { statusJidList: [m.sender, this.user.jid] }
      )
    }
    return
  }*/

  // ── Cek Online ───────────────────────────────────────────
  if ((/^bot$/i.test(m.text || '')) && !db.data.chats[m.chat].isBanned) {
    return this.reply(m.chat, '- *`Active!`*', m)
  }

  // ── Expire Premium ───────────────────────────────────────
  if (user.premium && user.premiumTime && Date.now() >= user.premiumTime) {
    user.premium     = false
    user.premiumTime = 0
  }

  // ── Auto-block Nomor Mencurigakan ────────────────────────
  if (BANNED_PREFIXES.some(p => m.sender?.startsWith(p))) {
    return this.updateBlockStatus(m.sender, 'block')
  }

  // ── Did You Mean ─────────────────────────────────────────
  const usedPrefix = (match?.[0] || '')[0]
  if (usedPrefix) {
    const noPrefix = m.text?.slice(usedPrefix.length).trim()
    const alias    = Object.values(plugins)
      .filter(v => v.dym && !v.disabled)
      .flatMap(v => v.dym)

    if (noPrefix && !alias.includes(noPrefix)) {
      const mean = didyoumean(noPrefix, alias)
      if (mean && !chat.isBanned) {
        this.reply(m.chat,
          `- \`Did You Mean\`\n> 〉 \`\`\`[ ${usedPrefix + mean} ]\`\`\``,
          m
        )
      }
    }
  }

  // ── Clear Lag (tiap 2 jam) ───────────────────────────────
  /*if (setting.clearlag && Date.now() - setting.timeclearlag > CLEARLAG_MS) {
    await db.write()
    fs.writeFileSync('./data/store.json', '{"chats":{},"messages":{}}')

    // Bersihkan duplicate session keys — simpan hanya 1 token per JID
    const sessions = db.data.sessions
    if (sessions) {
      const seen = {}
      for (const [key, jid] of Object.entries(sessions)) {
        if (seen[jid]) delete sessions[key]
        else seen[jid] = true
      }
      await db.write()
    }

    setting.timeclearlag = Date.now()
    console.log('[ ClearLag ] Store & sessions berhasil dibersihkan!')
  }*/

  // ── Guard: skip pesan sistem / banned ───────────────────
  const skipTypes = ['protocolMessage', 'pollUpdateMessage', 'reactionMessage']
  if (
    m.isBaileys ||
    skipTypes.includes(m.mtype) ||
    !m.msg || !m.message ||
    m.key.remoteJid !== m.chat ||
    user.banned ||
    chat.isBanned
  ) return

  // ── Anti-Spam ────────────────────────────────────────────
  // Bypass anti-spam untuk bot sendiri dan semua owner di owner.json
  const ownerNumbers = getOwnerNumbers()
  const senderNumber = m.sender?.replace(/[^0-9]/g, '') || ''
  const isExempted   = m.sender === this.user?.jid || ownerNumbers.includes(senderNumber)
  
  // Perbaikan: Tambahkan optional chaining dan safe text
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
          this.sendMessage(m.chat, { react: { text: '✅', key: m.key } }).catch(() => {})
        }, SPAM_COOLDOWN_MS)

        return this.sendMessage(m.chat, { react: { text: '❌', key: m.key } }).catch(() => {})
      }
    } else {
      spamData.count = 0
    }
    spamData.lastspam = now
  }
}

export default handler
