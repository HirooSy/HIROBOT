import axios from 'axios'
import { randomBytes, randomInt } from 'crypto'

const KEY = 'AIzaSyDtG1AU22ErnQD60AzBAcaknySiz9_CEq0'
const IDT = 'https://www.googleapis.com/identitytoolkit/v3/relyingparty'
const STK = 'https://securetoken.googleapis.com/v1/token'
const VFY = 'https://us-central1-alight-creative.cloudfunctions.net/verifyPurchase'
const TTL = 10 * 60 * 1000

const H1 = {
    'content-type'     : 'application/json',
    'x-android-package': 'com.alightcreative.motion',
    'x-android-cert'   : 'ECA6BF91B8715A6F810ED0BBFC65B6CD578F52A8',
    'user-agent'       : 'dalvik/2.1.0 (linux; u; android 15; 23127pn0cc build/bp1a.250505.005)'
}

const H2 = {
    'content-type'   : 'application/json; charset=utf-8',
    'user-agent'     : 'okhttp/3.12.1',
    'accept-encoding': 'gzip'
}

const dip = () => `${randomInt(1,255)}.${randomInt(0,255)}.${randomInt(0,255)}.${randomInt(1,255)}`

const sp = h => ({
    ...h,
    'x-forwarded-for'    : dip(),
    'x-real-ip'          : dip(),
    'client-ip'          : dip(),
    'x-client-ip'        : dip(),
    'x-originating-ip'   : dip(),
    'x-cluster-client-ip': dip()
})

const bad = e => {
    const d = e.response?.data
    return d ? (typeof d === 'object' ? JSON.stringify(d) : String(d)) : e.message
}

function extractCode(raw) {
    if (!raw) return null
    let s = String(raw).replace(/&amp;/g, '&')
    try { s = decodeURIComponent(s) } catch {}
    try {
        const u = new URL(s)
        let c = u.searchParams.get('oobCode')
        if (!c) {
            const n = u.searchParams.get('link') || u.searchParams.get('q') || u.searchParams.get('url')
            if (n) { try { c = new URL(n).searchParams.get('oobCode') } catch {} }
        }
        if (c) return c.replace(/[^a-zA-Z0-9_-]/g, '')
    } catch {}
    const m = s.match(/oobCode=([a-zA-Z0-9_-]+)/i)
    if (m) return m[1]
    const t = raw.trim()
    if (/^[a-zA-Z0-9_-]{10,}$/.test(t) && !t.includes('://')) return t
    return null
}

async function sendMagicLink(email) {
    try {
        await axios.post(`${IDT}/getOobConfirmationCode?key=${KEY}`, {
            requestType          : 6,
            email,
            androidInstallApp    : true,
            canHandleCodeInApp   : true,
            continueUrl          : 'https://alightcreative.com?ui_sid=0366624874&ui_sd=0',
            iosBundleId          : 'com.alightcreative.motion',
            androidPackageName   : 'com.alightcreative.motion',
            androidMinimumVersion: '585',
            clientType           : 'CLIENT_TYPE_ANDROID'
        }, { headers: sp(H1) })
        return { ok: true }
    } catch (e) { return { ok: false, why: bad(e) } }
}

async function verifyLink(email, rawLink) {
    const c = extractCode(rawLink)
    if (!c) return { ok: false, why: 'oobCode tidak ditemukan di link' }
    try {
        const a = await axios.post(`${IDT}/emailLinkSignin?key=${KEY}`, {
            email, oobCode: c, clientType: 'CLIENT_TYPE_ANDROID'
        }, { headers: sp(H1) })
        return {
            ok : true,
            id : a.data.idToken,
            ref: a.data.refreshToken,
            uid: a.data.localId,
            new: !!a.data.isNewUser
        }
    } catch (e) { return { ok: false, why: bad(e) } }
}

async function activatePremium(idToken) {
    const orderId = randomBytes(6).toString('hex')
    try {
        const r = await axios.post(VFY, {
            data: {
                productId: 'am.full.sub.annual.19q4',
                token    : 'mmgaobamlahbbeccfplmbkbb.AO-J1OzqG0or_GJJIx-ms8GrTm-jaglCRfhQSRPUZKpl2YspYS-oN7_94uv8RC5vQbvd_Ios2pPDStZ2n7F0hLE3FiOU7HS3R6Fquulv5xLXFECSv4ctElw',
                skuType  : 'subs',
                orderId
            }
        }, {
            headers: sp({
                ...H2,
                authorization               : 'Bearer ' + idToken,
                'firebase-instance-id-token': 'cSDnCyp3T-uwp07z3tL86T:APA91bFkmvvsHw5nnqa1SBFci-99DRsKClLiETdRrVcJjS5yBx1v_FbCb1d8WhBuea_zmwnYBktyTIzcRhN4b6uNOUur9wPc0gKXmJDoZic0LhNq5V2s0xI'
            })
        })
        return { ok: true, orderId, data: r.data }
    } catch (e) { return { ok: false, why: bad(e) } }
}

async function refreshAndActivate(refreshToken) {
    try {
        const r = await axios.post(`${STK}?key=${KEY}`, {
            grant_type: 'refresh_token', refresh_token: refreshToken
        })
        const result = await activatePremium(r.data.id_token)
        return { ...result, newRef: r.data.refresh_token }
    } catch (e) { return { ok: false, why: bad(e) } }
}

function getSettings() {
    if (!db.data.settings) db.data.settings = {}
    return db.data.settings
}

function getUserSettings(userJid) {
    const settings = getSettings()
    if (!settings[userJid]) settings[userJid] = {}
    return settings[userJid]
}

function getSession(userJid, email) {
    const user = getUserSettings(userJid)
    if (!user.amSession) user.amSession = {}
    return user.amSession[email] || null
}

function saveSession(userJid, email, data) {
    const user = getUserSettings(userJid)
    if (!user.amSession) user.amSession = {}
    user.amSession[email] = { ...data, savedAt: Date.now() }
    db.saveSync?.() || db.write?.()
}

let handler = async (m, { conn, text }) => {
    if (!text) return m.reply(`Usage:
- \`.ampro <email>\` - send magic link to email
- \`.amrefresh <email>\` - re-activate from saved session

Example: \`.ampro user@gmail.com\``)

    const userJid = conn.user.jid

    if (/^amrefresh$/i.test(m.command)) {
        const email = text.trim().toLowerCase()
        const sess  = getSession(userJid, email)
        if (!sess) return m.reply(`No saved session for *${email}*.

Send a link first: \`.ampro ${email}\``)

        await m.react(`🕜`)
        const r = await refreshAndActivate(sess.ref)
        if (!r.ok) return m.reply(`Failed:
\`${r.why}\`

Try again: \`.ampro ${email}\``)

        saveSession(userJid, email, { ...sess, ref: r.newRef || sess.ref })
        return m.reply(`Premium updated!
${email}
Order: \`${r.orderId}\``)
    }

    const email = text.trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return m.reply('Invalid email format.')

    await m.react(`📩`)
    const r = await sendMagicLink(email)
    if (!r.ok) return m.reply(`Failed to send link:
\`${r.why}\``)

    const prompt = await conn.sendMessage(m.chat, {
        text: `Magic link sent to *${email}*!\n\nOpen your email and copy the link from AlightMotion.\n*Reply to this message* with the link.`
    }, { quoted: m })

    if (!conn.ampro) conn.ampro = {}
    conn.ampro[m.sender] = {
        email    : email,
        messageId: prompt.key.id,
        at       : Date.now()
    }
}

handler.before = async (m, { conn }) => {
    if (!m.quoted?.id) return
    if (!conn.ampro?.[m.sender]) return

    const state = conn.ampro[m.sender]

    if (Date.now() - state.at > TTL) {
        delete conn.ampro[m.sender]
        return
    }

    if (state.messageId !== m.quoted.id) return
    const rawLink = m.text?.trim()
    if (!rawLink) return
    const code = extractCode(rawLink)
    if (!code) return

    delete conn.ampro[m.sender]
    const userJid = conn.user.jid
    await m.react(`🕜`)

    const v = await verifyLink(state.email, rawLink)
    if (!v.ok) return m.reply(`Verification failed:
\`${v.why}\`

Send again: \`.ampro ${state.email}\``)

    await m.react('✅')

    const p = await activatePremium(v.id)
    if (!p.ok) {
        saveSession(userJid, state.email, { id: v.id, ref: v.ref, uid: v.uid })
        return m.reply(`Login OK but activation failed:
\`${p.why}\`

Try: \`.amrefresh ${state.email}\``)
    }

    saveSession(userJid, state.email, { id: v.id, ref: v.ref, uid: v.uid })

    await m.reply(
`*AlightMotion Premium Activated!*

- Email: *${state.email}*
- Order: \`${p.orderId}\`
${v.new ? 'New account created' : 'Existing account updated'}

_Use \`.amrefresh ${state.email}\` to re-activate anytime._`)

    return true
}

handler.help    = ['ampro <email>', 'amrefresh <email>']
handler.command = /^(ampro|amrefresh)$/i
handler.tags    = ['tools']

export default handler