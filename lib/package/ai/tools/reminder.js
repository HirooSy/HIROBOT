import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { ctx, runAgent } from '../mcp.js';
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
                const fakeM = { ...currentM, key: { ...currentM?.key, remoteJid: jid }, chat: jid, sender: jid }
                const result = await runAgent(conn, fakeM, `[Reminder fired] Tell the user that the time has come for: "${message}". Say it in a natural style, not stiff.`, { senderJid: jid })
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
        description: 'Create a reminder that will be sent automatically to this chat after a certain amount of time. Use it when the user asks to be reminded of something (e.g. "remind me in 20 minutes to take a bath", "reminder in 1 hour for a meeting").',
        parameters: {
            time_text: { type: 'string', description: 'Text containing a time duration, in the natural wording the user used (examples: "20 minutes", "1 hour 30 minutes", "2 days", or the Indonesian "20 menit lagi"). This tool parses the duration itself.', required: true },
            message: { type: 'string', description: 'The reminder message content (examples: "take a bath", "take medicine", "meeting"). If it is unclear, fill it with a short summary of the user\'s request.', required: true }
        },
        execute: async ({ time_text, message }) => {
            const delayMs = parseRelativeTime(time_text)
            if (!delayMs) return `Cannot parse time from "${time_text}". Ask for a format like "20 minutes" or "1 hour 30 minutes".`
            if (delayMs > 30 * 24 * 60 * 60 * 1000) return 'Max reminder duration is 30 days.'

            const { currentJid } = ctx()
            if (!ctx().conn || !currentJid) return 'WA connection not ready'

            const cleanMsg = message?.trim() || "It's time!"
            const { id, fireAt } = createReminder({ jid: currentJid, message: cleanMsg, delayMs })

            const totalMin = Math.round(delayMs / 60000)
            const displayTime = totalMin >= 60
                ? `${Math.floor(totalMin / 60)} hours ${totalMin % 60} minutes`
                : `${totalMin} minutes`

            return `reminder_created:${id}:${displayTime}:${cleanMsg}`
        }
    },
    {
        name: 'list_reminders',
        description: 'See all active reminders in this chat.',
        parameters: {},
        execute: async () => {
            const { currentJid } = ctx()
            if (!currentJid) return 'Chat context not available'
            const mine = listReminders(currentJid)
            if (!mine.length) return 'There are no active reminders in this chat yet.'
            return mine.map((r, i) => {
                const minutesLeft = Math.max(0, Math.round((r.fireAt - Date.now()) / 60000))
                return `${i + 1}. "${r.message}" — ${minutesLeft} minutes left (ID: ${r.id})`
            }).join('\n')
        }
    },
    {
        name: 'cancel_reminder',
        description: 'Cancel a reminder that was already created, by its ID (get the ID from list_reminders).',
        parameters: {
            reminder_id: { type: 'string', description: 'The ID of the reminder to cancel', required: true }
        },
        execute: async ({ reminder_id }) => {
            const ok = removeReminder(reminder_id)
            return ok ? `Reminder ${reminder_id} cancelled.` : `Reminder "${reminder_id}" not found.`
        }
    }
]
