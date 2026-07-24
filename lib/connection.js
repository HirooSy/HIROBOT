// @ts-check
import chalk from 'chalk'
import db, { loadDatabase } from './database.js'
import Helper from './helper.js'
import importFile from './import.js'
import P from 'pino'
import path, { resolve } from 'path'
import readline from 'readline'
import storeSystem from './store.js'
import single2multi from './single2multi.js'
import { fileURLToPath } from 'url'
import { HelperConnection } from './simple.js'

/** @type {import('@whiskeysockets/baileys')} */
// @ts-ignore
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  PHONENUMBER_MCC,
  useMultiFileAuthState,
  Browsers
} = await import('baileys')

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ─── Session paths ───────────────────────────────────────────────────────────
// Main bot  → data/sessions/main
// Jadibot   → data/sessions/jadibot/<jid>/
const authFolder = 'data/sessions/main'
const authFile   = `${Helper.opts._[0] || 'session'}.data.json`

const rl       = readline.createInterface({ input: process.stdin, output: process.stdout })
const question = (text) => new Promise((resolve) => rl.question(text, resolve))

let [
  isCredsExist,
  isAuthSingleFileExist,
  authState
] = await Promise.all([
  Helper.checkFileExists(authFolder + '/creds.json'),
  Helper.checkFileExists(authFile),
  useMultiFileAuthState(authFolder)
])

// Convert single auth to multi auth
if (Helper.opts['singleauth'] || Helper.opts['singleauthstate']) {
  if (!isCredsExist && isAuthSingleFileExist) {
    console.debug('- singleauth -', 'creds.json not found', 'compiling singleauth to multiauth...')
    await single2multi(authFile, authFolder, authState)
    console.debug('- singleauth -', 'compiled successfully')
    authState = await useMultiFileAuthState(authFolder)
  } else if (!isAuthSingleFileExist) {
    console.error('- singleauth -', 'singleauth file not found')
  }
}

const store     = storeSystem.makeInMemoryStore()
const storeFile = 'data/store.json'

try {
  store.readFromFile(storeFile)
} catch (e) {
  console.warn('Store failed to read store file, starting with empty store:', e.message)
}

const logger = P({
  level: 'silent',
  timestamp: () => `,"time":"${new Date().toJSON()}"`
}).child({ class: 'baileys' })

const { version, isLatest } = await fetchLatestBaileysVersion()

/** @type {import('@whiskeysockets/baileys').UserFacingSocketConfig} */
const connectionOptions = {
  printQRInTerminal: false,
  auth: authState.state,
  logger,
  version,
  browser: Browsers.windows('Firefox'),
}

/** @type {boolean} */
let pairingCodeRequested = false

/** Flag untuk mencegah multiple reconnect berjalan bersamaan */
let isReconnecting = false

/**
 * Ekstrak pesan aman dari error untuk di-log — HANYA .message/.stack,
 * BUKAN seluruh object error mentah. Beberapa error dari Baileys/libsignal
 * (mis. saat menutup session enkripsi yang corrupt/expired) menempelkan
 * property tambahan berisi seluruh SessionEntry (_chains, ratchet keys,
 * message keys, dsb — bisa ribuan baris). Kalau di-console.error(err)
 * langsung, semua isi object raksasa itu ikut ke-print — bikin log spam
 * besar dan membebani memori/CPU proses logging. Jadi selalu ekstrak
 * message-nya saja.
 * @param {any} err
 * @returns {string}
 */
function safeErr(err) {
  if (err instanceof Error) return err.stack || err.message
  return typeof err === 'string' ? err : (err?.message || String(err))
}

/** 
 * @typedef {{ 
 *  handler?: typeof import('../system/handler').handler; 
 *  participantsUpdate?: typeof import('../system/handler').participantsUpdate; 
 *  groupsUpdate?: typeof import('../system/handler').groupsUpdate; 
 *  onDelete?: typeof import('../system/handler').deleteUpdate; 
 *  connectionUpdate?: (update: import('@adiwajshing/baileys').BaileysEventMap<unknown>['connection.update']) => any; 
 *  credsUpdate?: () => void 
 * }} EventHandlers
 * @typedef {Required<import('@whiskeysockets/baileys').UserFacingSocketConfig>['logger']} Logger
 * @typedef {ReturnType<typeof makeWASocket> & EventHandlers & { 
 *  isInit?: boolean; 
 *  isReloadInit?: boolean; 
 *  msgqueque?: import('./queque').default;
 *  logger?: Logger
 * }} Socket 
 * @typedef {{ 
 *  handler?: Promise<typeof import('../system/handler')> | typeof import('../system/handler'); 
 *  isChild?: boolean; 
 *  connectionOptions?: Partial<import('@adiwajshing/baileys').UserFacingSocketConfig>; 
 *  logger?: Logger;
 *  store: typeof store;
 *  authState: Awaited<ReturnType<typeof useMultiFileAuthState>>
 * }} StartOptions
 */

/** 
 * Map sub-bot: key = JID pengguna (misal "628xxx@s.whatsapp.net"), value = Socket
 * @type {Map<string, Socket>} 
 */
let conns = new Map();

/** 
 * @param {Socket?} oldSocket 
 * @param {StartOptions} opts
 */
async function start(oldSocket = null, opts = { store, logger, authState }) {
  /** @type {Socket} */
  let conn = makeWASocket({
    ...connectionOptions,
    ...opts.connectionOptions,
    logger: opts.logger,
    auth: opts.authState.state,
    generateHighQualityLinkPreview: true,
    defaultQueryTimeoutMs: undefined,
    getMessage: async (key) => (
      opts.store.loadMessage(/** @type {string} */(key.remoteJid), key.id) ||
      opts.store.loadMessage(/** @type {string} */(key.id)) || {}
    ).message || { conversation: 'Please send messages again' },
    patchMessageBeforeSending: (message) => {
      const requiresPatch = !!(
        message.buttonsMessage ||
        message.templateMessage ||
        message.listMessage
      )
      if (requiresPatch) {
        message = {
          viewOnceMessage: {
            message: {
              messageContextInfo: {
                deviceListMetadataVersion: 2,
                deviceListMetadata: {},
              },
              ...message,
            },
          },
        }
      }
      return message
    },
  })

  // ─────────────────────────────────────────────────────────────
  // [ PATCH: profilePictureUrl hang fix ]
  // Baileys versi terbaru (>= rc.10-an) menambahkan logika tcToken
  // privacy pada profilePictureUrl (lih. src/Socket/chats.ts resmi).
  // Ada bug upstream yang belum di-fix per rc13: saat tcToken
  // di-attach ke query, server WhatsApp kadang tidak pernah membalas
  // sama sekali (function hang tanpa error/log/timeout).
  // Lihat: https://github.com/WhiskeySockets/Baileys/issues/2498
  // Workaround resmi yang disarankan maintainer: jangan sertakan
  // tcToken sama sekali (setara implementasi lama rc.9), cukup query
  // <picture type=preview|image query=url/> langsung.
  // Override ini dipasang SETELAH makeWASocket supaya menimpa method
  // bawaan Baileys, tapi tetap pakai internal query() milik conn
  // supaya perilaku lain (auth, xmlns, dsb) identik dengan aslinya.
  // ─────────────────────────────────────────────────────────────
  conn.profilePictureUrl = async (jid, type = 'preview', timeoutMs) => {
    const targetJid = conn.decodeJid ? conn.decodeJid(jid) : jid
    const result = await conn.query(
      {
        tag: 'iq',
        attrs: {
          target: targetJid,
          to: '@s.whatsapp.net',
          type: 'get',
          xmlns: 'w:profile:picture',
        },
        content: [{ tag: 'picture', attrs: { type, query: 'url' } }],
      },
      timeoutMs
    )
    const child = result?.content?.find?.(n => n.tag === 'picture')
    return child?.attrs?.url
  }

  HelperConnection(conn, { store: opts.store, logger })

  if (oldSocket) {
    conn.isInit       = oldSocket.isInit
    conn.isReloadInit = oldSocket.isReloadInit
  }
  if (conn.isInit == null) {
    conn.isInit       = false
    conn.isReloadInit = true
  }

  store.bind(conn.ev, { groupMetadata: conn.groupMetadata })

  if (isCredsExist && !conn.authState.creds.registered) {
    console.log(chalk.yellow('WARNING') + chalk.gray(' creds.json is broken, please delete it first'))
  }

  await reload(conn, false, opts)

  return conn
}

let OldHandler = null

/** 
 * @param {Socket} conn 
 * @param {boolean} restartConnection
 * @param {StartOptions} opts
 */
async function reload(conn, restartConnection, opts = { store, authState }) {
  if (!opts.handler) opts.handler = importFile(Helper.__filename(resolve('./lib/handler.js'))).catch(err => console.error(safeErr(err)))
  if (opts.handler instanceof Promise) opts.handler = await opts.handler
  if (!opts.handler && OldHandler) opts.handler = OldHandler
  OldHandler = opts.handler

  const isReloadInit = !!conn.isReloadInit
  if (restartConnection) {
    try { conn.ws.close() } catch {}
    // @ts-ignore
    conn.ev.removeAllListeners()

    await new Promise(resolve => setTimeout(resolve, 3000))

    Object.assign(conn, await start(conn, opts) || {})
    return true
  }

  Object.assign(conn, getMessageConfig())

  if (conn.handler)            conn.ev.off('messages.upsert', conn.handler)
  if (conn.participantsUpdate) conn.ev.off('group-participants.update', conn.participantsUpdate)
  if (conn.groupsUpdate)       conn.ev.off('groups.update', conn.groupsUpdate)
  if (conn.onDelete)           conn.ev.off('messages.delete', conn.onDelete)
  if (conn.connectionUpdate)   conn.ev.off('connection.update', conn.connectionUpdate)
  if (conn.credsUpdate)        conn.ev.off('creds.update', conn.credsUpdate)

  if (opts.handler) {
    const rawHandler = /** @type {typeof import('../system/handler')} */(opts.handler).handler.bind(conn)
    const startEpoch = Math.floor(Date.now() / 1000)

    // Skip backlog/offline messages that Baileys delivers on (re)connect —
    // only process messages timestamped at or after this reload.
    conn.handler = async (chatUpdate) => {
      if (chatUpdate?.messages) {
        chatUpdate.messages = chatUpdate.messages.filter((msg) => {
          const ts = typeof msg.messageTimestamp === 'object'
            ? msg.messageTimestamp?.low
            : msg.messageTimestamp
          return !ts || ts >= startEpoch
        })
        if (chatUpdate.messages.length === 0) return
      }
      return rawHandler(chatUpdate)
    }

    conn.participantsUpdate = /** @type {typeof import('../system/handler')} */(opts.handler).participantsUpdate.bind(conn)
    conn.groupsUpdate       = /** @type {typeof import('../system/handler')} */(opts.handler).groupsUpdate.bind(conn)
    conn.onDelete           = /** @type {typeof import('../system/handler')} */(opts.handler).deleteUpdate.bind(conn)
  }

  if (!opts.isChild) conn.connectionUpdate = connectionUpdate.bind(conn, opts)
  conn.credsUpdate = opts.authState.saveCreds.bind(conn)

  /** @typedef {Required<EventHandlers>} Event */
  if (conn.handler)            conn.ev.on('messages.upsert', /** @type {Event} */(conn).handler)
  if (conn.participantsUpdate) conn.ev.on('group-participants.update', /** @type {Event} */(conn).participantsUpdate)
  if (conn.groupsUpdate)       conn.ev.on('groups.update', /** @type {Event} */(conn).groupsUpdate)
  if (conn.onDelete)           conn.ev.on('messages.delete', /** @type {Event} */(conn).onDelete)
  if (!opts.isChild) {
    if (conn.connectionUpdate) conn.ev.on('connection.update', /** @type {Event} */(conn).connectionUpdate)
  }
  if (typeof conn.credsUpdate === 'function') conn.ev.on('creds.update', /** @type {Event} */(conn).credsUpdate)

  conn.isReloadInit = false
  return true
}

// ─────────────────────────────────────────────────────────────
// Localtunnel restart helper
// ─────────────────────────────────────────────────────────────
let isTunnelRestarting = false
async function restartTunnel() {
  if (typeof global.startTunnel !== 'function') return
  if (isTunnelRestarting) {
    console.log(chalk.yellow('Tunnel') + chalk.gray(' Already starting, skip duplicate call'))
    return
  }
  // Kalau tunnel yang lama masih ada/hidup (belum di-set null saat cleanup
  // di main.js), jangan bikin yang baru. Sebelumnya restartTunnel() dipanggil
  // TIAP KALI koneksi WA balik ke status 'open' — kalau WA sering reconnect
  // (krn leak lain atau jaringan tidak stabil), ini bikin tunnel baru numpuk
  // terus-terusan, masing-masing nempelin listener close/error baru juga.
  if (global.tunnel != null) {
    console.log(chalk.yellow('Tunnel') + chalk.gray(' Still alive, skip restart'))
    return
  }
  isTunnelRestarting = true
  try {
    await global.startTunnel()
  } finally {
    setTimeout(() => { isTunnelRestarting = false }, 5000)
  }
}

/**
 * @this {Socket}
 * @param {StartOptions} opts
 * @param {import('@whiskeysockets/baileys').BaileysEventMap<unknown>['connection.update']} update
 */
async function connectionUpdate(opts, update) {
  const { connection, lastDisconnect, isNewLogin, qr } = update

  if (connection) {
    console.log(chalk.yellow(`Connection status`) + chalk.gray(` ${connection}`))
  }

  if (qr && !pairingCodeRequested) {
    pairingCodeRequested = true
    try {
      console.log(chalk.yellow('\n⏳ Socket ready, requesting pairing code from WhatsApp...'))

      // --pair 628xxx: lewati prompt interaktif dan langsung pakai nomor
      // dari flag CLI. Dibutuhkan untuk lingkungan tanpa stdin interaktif
      // (mis. script publik yang dijalankan di Vercel/CI).
      const pairFlag  = Helper.opts['pair']
      const phoneNumber = pairFlag
        ? String(pairFlag).trim()
        : (await question('📱 Enter your WhatsApp number (example: 1305xxxx):\n')).trim()

      if (pairFlag) {
        console.log(chalk.gray(`Menggunakan nomor dari flag --pair: ${phoneNumber}`))
      }

      const pairingCode = await this.requestPairingCode(phoneNumber, process.env.CUSTOM_PAIRING)
      if (pairingCode) {
        const formattedCode = pairingCode.length === 8
          ? `${pairingCode.slice(0, 4)}-${pairingCode.slice(4)}`
          : pairingCode
        console.log('\n' + '='.repeat(50))
        console.log(chalk.greenBright('CODE PAIRING WHATSAPP'))
        console.log('='.repeat(50))
        console.log(chalk.bold(`\n-------------------------\n${formattedCode}\n-------------------------`))
        console.log('\nHow to use:')
        console.log('1. Open Whatsapp')
        console.log('2. Press three dots → Linked Devices → Link Device')
        console.log('3. Select "Link with Phone Number"')
        console.log('4. Enter the code above')
        console.log('\n' + '='.repeat(50) + '\n')
      } else {
        console.warn(chalk.yellow('• Did not receive pairing code, please try again'))
      }
    } catch (error) {
      console.error(chalk.red('Error getting pairing code:'), safeErr(error))
      console.log('• Make sure the WhatsApp number is correct and try again.')
    }
  }


  // @ts-ignore
  const code = lastDisconnect?.error?.output?.statusCode
    || lastDisconnect?.error?.output?.payload?.statusCode

  if (code && code !== DisconnectReason.loggedOut) {
    if (isReconnecting) {
      console.log(chalk.yellow('Reconnect') + chalk.gray(' is running, skip...'))
      return
    }
    isReconnecting = true

    try {
      await new Promise(resolve => setTimeout(resolve, 3000))
      await reload(this, true, opts).catch(err => console.error(chalk.red('Reload error:'), safeErr(err)))

      // @ts-ignore
      if (global?.timestamp) global.timestamp.connect = new Date()

      pairingCodeRequested = false
    } finally {
      isReconnecting = false
    }
  }

  if (connection === 'open') {
    isReconnecting = false
    setTimeout(() => {
      restartTunnel().catch(e => console.error('Tunnel restartTunnel error:', safeErr(e)))
    }, 5000)
  }

  if (db.data == null) {
    await loadDatabase().catch(e => console.error('DB loadDatabase error:', safeErr(e)))
  }
}

function getMessageConfig() {
  return {
    welcome:  'Hi @user!\nWelcome to @subject',
    bye:      'Good bye @user!',
    spromote: '@user is now admin',
    sdemote:  '@user is no longer admin',
    sDesc:    'Description changed\n\n@desc',
    sSubject: 'Group subject changed\n\n@subject',
    sIcon:    'Group icon changed',
    sRevoke:  'Group link has been changed'
  }
}

const conn = start(null, { store, logger, authState })
  .catch(err => console.error(chalk.red('Start error:'), safeErr(err)))

export default {
  start,
  reload,
  conn,
  conns,
  logger,
  connectionOptions,
  authFolder,
  storeFile,
  authState,
  store,
  getMessageConfig
}

export { conn, conns, logger }
