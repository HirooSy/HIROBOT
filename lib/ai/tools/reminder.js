// ─── tools/reminder.js ──────────────────────────────────────────────────────
// Semua tool kategori "reminder" digabung 1 file: create_reminder,
// list_reminders, cancel_reminder + helper internalnya.
// Export default: array of tool-def, di-loop & di-registerTool() otomatis
// sama loader di mcp.js (lihat loadToolsDir()).

import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ctx, getRunAgent } from '../context.js'

const ROOT = process.cwd()
const REMINDER_PATH = path.join(ROOT, 'data', 'reminder.json')
const _reminders = new Map()

function loadReminderFile() {
    try { return JSON.parse(fs.readFileSync(REMINDER_PATH, 'utf-8')) }
    catch { return { reminders: [] } }
}

function saveReminderFile() {
    try {
        fs.mkdirSync(path.dirname(REMINDER_PATH), { recursive: true })
        const plain = [..._reminders.values()].map(({ id, jid, message, fireAt }) => ({ id, jid, message, fireAt }))
        fs.writeFileSync(REMINDER_PATH, JSON.stringify({ reminders: plain }, null, 2), 'utf-8')
    } catch (e) {
        console.warn('[reminder] Gagal simpan reminder.json:', e.message)
    }
}

function parseRelativeTime(text) {
    const pattern = /(\d+)\s*(hari|days?|d|jam|hours?|h|j|menit|minutes?|min|m|detik|seconds?|sec|s)\b/gi
    let totalMs = 0
    let matched = false
    let m
    while ((m = pattern.exec(text)) !== null) {
        matched = true
        const num = parseInt(m[1], 10)
        const unit = m[2].toLowerCase()
        if (/^(hari|days?|d)$/.test(unit)) totalMs += num * 24 * 60 * 60 * 1000
        else if (/^(jam|hours?|h|j)$/.test(unit)) totalMs += num * 60 * 60 * 1000
        else if (/^(menit|minutes?|min|m)$/.test(unit)) totalMs += num * 60 * 1000
        else if (/^(detik|seconds?|sec|s)$/.test(unit)) totalMs += num * 1000
    }
    return matched ? totalMs : null
}

function _scheduleFire(id, jid, message, fireAt) {
    const delayMs = Math.max(0, fireAt - Date.now())
    const timer = setTimeout(async () => {
        _reminders.delete(id)
        saveReminderFile()
        try {
            const { conn, currentM } = ctx()
            if (conn && currentM) {
                const runAgent = await getRunAgent()
                const fakeM = { ...currentM, key: { ...currentM?.key, remoteJid: jid }, chat: jid, sender: jid }
                const result = await runAgent(conn, fakeM, `[Reminder fired] Kasih tahu user bahwa waktunya tiba untuk: "${message}". Sampaikan dengan gaya natural, jangan kaku.`, { senderJid: jid })
                if (result?.text) await conn.sendMessage(jid, { text: result.text })
            } else {
                console.warn(`[reminder] conn/currentM belum tersedia saat reminder ${id} harusnya jalan.`)
            }
        } catch (e) {
            console.warn(`[reminder] Gagal kirim reminder ${id}:`, e.message)
        }
    }, delayMs)

    if (typeof timer.unref === 'function') timer.unref()
    _reminders.get(id).timer = timer
}

function createReminder({ jid, message, delayMs }) {
    const id = crypto.randomUUID().slice(0, 8)
    const fireAt = Date.now() + delayMs
    _reminders.set(id, { id, jid, message, fireAt, timer: null })
    _scheduleFire(id, jid, message, fireAt)
    saveReminderFile()
    return { id, fireAt }
}

function listReminders(jid) {
    return [..._reminders.values()]
        .filter(r => r.jid === jid)
        .sort((a, b) => a.fireAt - b.fireAt)
        .map(({ id, message, fireAt }) => ({ id, message, fireAt }))
}

function removeReminder(id) {
    const r = _reminders.get(id)
    if (!r) return false
    if (r.timer) clearTimeout(r.timer)
    _reminders.delete(id)
    saveReminderFile()
    return true
}

function _restoreReminders() {
    const data = loadReminderFile()
    const list = Array.isArray(data.reminders) ? data.reminders : []
    for (const r of list) {
        if (!r?.id || !r?.jid || !r?.fireAt) continue
        _reminders.set(r.id, { id: r.id, jid: r.jid, message: r.message, fireAt: r.fireAt, timer: null })
        _scheduleFire(r.id, r.jid, r.message, r.fireAt)
    }
    if (list.length) console.log(`[reminder] ${list.length} reminder di-restore dari reminder.json`)
}
_restoreReminders()

export default [
    {
        name: 'create_reminder',
        description: 'Buat pengingat yang akan dikirim otomatis ke chat ini setelah waktu tertentu. Pakai kalau user minta diingatkan sesuatu (mis. "ingetin aku 20 menit lagi buat mandi", "reminder 1 jam lagi meeting").',
        parameters: {
            time_text: { type: 'string', description: 'Teks yang mengandung durasi waktu, dalam bahasa natural apa adanya dari user (contoh: "20 menit lagi", "1 jam 30 menit", "2 hari lagi"). Tool ini yang akan parse durasinya sendiri.', required: true },
            message: { type: 'string', description: 'Isi pesan pengingat (contoh: "mandi", "minum obat", "meeting"). Kalau tidak jelas, isi dengan ringkasan singkat dari permintaan user.', required: true }
        },
        execute: async ({ time_text, message }) => {
            const delayMs = parseRelativeTime(time_text)
            if (!delayMs) return `Cannot parse time from "${time_text}". Ask for format like "20 menit lagi" or "1 jam 30 menit lagi".`
            if (delayMs > 30 * 24 * 60 * 60 * 1000) return 'Max reminder duration is 30 days.'

            const { currentJid } = ctx()
            if (!ctx().conn || !currentJid) return 'WA connection not ready'

            const cleanMsg = message?.trim() || 'Waktunya!'
            const { id, fireAt } = createReminder({ jid: currentJid, message: cleanMsg, delayMs })

            const totalMin = Math.round(delayMs / 60000)
            const displayTime = totalMin >= 60
                ? `${Math.floor(totalMin / 60)} jam ${totalMin % 60} menit`
                : `${totalMin} menit`

            return `reminder_created:${id}:${displayTime}:${cleanMsg}`
        }
    },
    {
        name: 'list_reminders',
        description: 'Lihat semua pengingat aktif di chat ini.',
        parameters: {},
        execute: async () => {
            const { currentJid } = ctx()
            if (!currentJid) return 'Chat context not available'
            const mine = listReminders(currentJid)
            if (!mine.length) return 'Belum ada pengingat aktif di chat ini.'
            return mine.map((r, i) => {
                const sisaMin = Math.max(0, Math.round((r.fireAt - Date.now()) / 60000))
                return `${i + 1}. "${r.message}" — ${sisaMin} menit lagi (ID: ${r.id})`
            }).join('\n')
        }
    },
    {
        name: 'cancel_reminder',
        description: 'Batalkan pengingat yang sudah dibuat, berdasarkan ID-nya (dapatkan ID dari list_reminders).',
        parameters: {
            reminder_id: { type: 'string', description: 'ID reminder yang mau dibatalkan', required: true }
        },
        execute: async ({ reminder_id }) => {
            const ok = removeReminder(reminder_id)
            return ok ? `Reminder ${reminder_id} cancelled.` : `Reminder "${reminder_id}" not found.`
        }
    }
]
