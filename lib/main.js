import path from 'path';
import { fileURLToPath } from 'url';
import events from 'events';
import './config.js'
import P from 'pino'
import Connection from './connection.js'
import Helper from './helper.js'
import { spawn } from 'child_process'
import { protoType, serialize } from './simple.js'
import { plugins, loadPluginFiles, pluginFolder, pluginFilter } from './plugins.js'
import chalk from 'chalk'
import fs from 'fs';
import { tmpdir, platform } from 'os'

// ────────────────CLEAR DATA STORE (10 MINUTES)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_STORE_PATH = path.join(process.cwd(), 'data', 'store.json');

function clearDataStore() {
    try {
        // Prune in-memory chats store dulu (bukan file, tapi object di RAM)
        // biar nggak growing terus tanpa batas selama proses hidup.
        if (Connection.store?.pruneChats) {
            Connection.store.pruneChats(7 * 24 * 60 * 60 * 1000)
        }

        if (!fs.existsSync(DATA_STORE_PATH)) {
            // Pastikan folder data ada
            const dataDir = path.dirname(DATA_STORE_PATH);
            if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
            
            fs.writeFileSync(DATA_STORE_PATH, '{}', 'utf8');
            return;
        }
        const content = fs.readFileSync(DATA_STORE_PATH, 'utf8');
        if (content.trim() === '{}') {
            return;
        }
        fs.writeFileSync(DATA_STORE_PATH, '{}', 'utf8');
    } catch (error) {
        console.error(chalk.red('DataStore Error:'), error.message);
    }
}

// ────────────────CLEAR TMP
async function clearTmp() {
    // Gunakan path.join yang benar
    const tmpDir = path.join(process.cwd(), process.env.TMP || 'data/tmp');
    const dirs = [tmpdir(), tmpDir];
    const AGE_LIMIT = 1000 * 60 * 60; // 1 Jam (biar aman)

    for (const dir of dirs) {
        if (!fs.existsSync(dir)) continue;
        const files = await fs.promises.readdir(dir).catch(() => []);
        for (const file of files) {
            const filePath = path.join(dir, file);
            const stat = await fs.promises.stat(filePath);
            if (stat.isFile() && (Date.now() - stat.mtimeMs >= AGE_LIMIT)) {
                await fs.promises.unlink(filePath).catch(() => {});
            }
        }
    }
}

// ────────────────────

events.EventEmitter.defaultMaxListeners = 10;

// ──────────GLOBAL ERROR HANDLER
const BAILEYS_STACK_MARKERS = ['/baileys/', '@whiskeysockets/baileys', '/baileys-caller/']
const IGNORED_ERRORS = [
  'isZero',
  'toJSON',
  'writeToFile',
  "reading 'child'",
  'makeNoiseHandler',
  'Cannot read properties of undefined',
  'noise-handler',
  'socket.js',
]

function isBaileysInternalError(err) {
  if (!err) return false
  const stack = err.stack || ''
  const isFromBaileys = BAILEYS_STACK_MARKERS.some(marker => stack.includes(marker))
  if (!isFromBaileys) return false

  const msg = err.message || ''
  return IGNORED_ERRORS.some(e => msg.includes(e) || stack.includes(e))
}

// ─────STUCK-CONNECTION WATCHDOG
const IGNORED_ERROR_WINDOW_MS = 60 * 1000
const IGNORED_ERROR_THRESHOLD = 5

let ignoredErrorTimestamps = []

function noteIgnoredErrorAndMaybeRestart(label, msg) {
  const now = Date.now()
  ignoredErrorTimestamps.push(now)
  ignoredErrorTimestamps = ignoredErrorTimestamps.filter(t => now - t <= IGNORED_ERROR_WINDOW_MS)

  console.error(chalk.yellow(label) + chalk.gray(` Baileys internal error (${ignoredErrorTimestamps.length}/${IGNORED_ERROR_THRESHOLD} in window): `) + chalk.gray(msg))

  if (ignoredErrorTimestamps.length >= IGNORED_ERROR_THRESHOLD) {
    console.error(chalk.red('Watchdog') + chalk.gray(` Detected ${ignoredErrorTimestamps.length}x internal errors in ${IGNORED_ERROR_WINDOW_MS / 1000}s — connection looks stuck. Restarting process...`))
    ignoredErrorTimestamps = []
    setTimeout(() => process.exit(1), 200)
  }
}

process.on('uncaughtException', (err) => {
  if (isBaileysInternalError(err)) {
    noteIgnoredErrorAndMaybeRestart('Ignored', err.message)
    return
  }
  console.error(chalk.red('[ UncaughtException ]'), err)
})

process.on('unhandledRejection', (reason) => {
  if (isBaileysInternalError(reason)) {
    noteIgnoredErrorAndMaybeRestart('Ignored', reason?.message)
    return
  }
  console.error(chalk.red('[ UnhandledRejection ]'), reason)
})

// ──────────────────── PATCH WAProto
try {
  const { Long } = await import('protobufjs');
  if (Long?.prototype && !Long.prototype.isZero) {
    Long.prototype.isZero = function() { return this.eq(0); };
    console.log(chalk.yellow("Patch") + chalk.gray(' Long.prototype.isZero added'));
  }
} catch(e) {
  console.log(chalk.yellow("Patch") + chalk.gray(' protobufjs Long not available, trying alternative...'));
  if (global.proto?.Long && !global.proto.Long.prototype.isZero) {
    global.proto.Long.prototype.isZero = function() { return this.eq(0); };
  }
}

global.safeStringify = (obj) => {
  try { return JSON.stringify(obj) }
  catch (e) {
    if (e.message?.includes('isZero') || e.message?.includes('toJSON')) return '{}'
    throw e
  }
}

// ──────────────MEMORY MONITOR
const HEAP_WARN_MB = 250;
const HEAP_EXIT_MB = 500;

function forceGC() {
  if (global.gc) {
    global.gc()
    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
  }
  return null
}

function checkMemory() {
  const mem         = process.memoryUsage();
  const heapUsedMB  = Math.round(mem.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(mem.heapTotal / 1024 / 1024);
  const rssMB       = Math.round(mem.rss / 1024 / 1024);

  const afterGC = forceGC()
  const gcInfo  = afterGC !== null ? ` → After GC: ${afterGC}MB` : ' (--expose-gc tidak aktif)'

  const finalHeap = afterGC ?? heapUsedMB
  if (finalHeap > HEAP_EXIT_MB) {
    console.error(`${chalk.red('Memory')}${chalk.gray(` Heap ${finalHeap}MB > ${HEAP_EXIT_MB}MB! Restarting...`)}`);
    process.exit(1);
  } else if (finalHeap > HEAP_WARN_MB) {
    console.warn(`${chalk.yellow('Memory')}${chalk.gray(` Heap ${finalHeap}MB almost reaching the limit`)}`);
  }
}

const memMonitorInterval = setInterval(checkMemory, 10 * 60 * 1000);

// ─────────INTERVAL REGISTRY
global.activeIntervals = global.activeIntervals || new Set();

let writeInterval  = null
let refillInterval = null
let clearStoreInterval = null
let tmpClearInterval = null

function registerInterval(interval) {
  global.activeIntervals.add(interval);
  return interval;
}

function cleanupConnectionIntervals() {
  for (const interval of global.activeIntervals) {
    if (interval === memMonitorInterval) continue  
    if (interval === refillInterval) continue 
    if (interval === writeInterval) continue 
    if (interval === clearStoreInterval) continue 
    if (interval === tmpClearInterval) continue
    clearInterval(interval)
    global.activeIntervals.delete(interval)
  }
}

registerInterval(memMonitorInterval);

// ────────CLEAR DATA.STORE - START TIMER
clearDataStore();
clearStoreInterval = setInterval(clearDataStore, 10 * 60 * 1000);
registerInterval(clearStoreInterval);
// ─────────────────

const PORT = process.env.PORT || process.env.SERVER_PORT || 5497

protoType()
serialize()

Object.assign(global, {
  ...Helper,
  timestamp: { start: Date.now() }
})

// ──────────────CONNECTION
const conn = Object.defineProperty(Connection, 'conn', {
  value: await Connection.conn,
  enumerable: true,
  configurable: true,
  writable: true
}).conn

// Patch writeToFile
if (Connection.store?.writeToFile) {
  const _orig = Connection.store.writeToFile;
  Connection.store.writeToFile = function(...args) {
    try {
      return _orig.apply(this, args);
    } catch (err) {
      console.error('Store writeToFile error:', err.message);
      if (err.message?.includes('isZero') || err.message?.includes('toJSON')) return;
      throw err;
    }
  };
}

conn.ev.on('connection.update', async (update) => {
  const { connection } = update;

  if (connection === 'close' || connection === 'disconnecting') {
    console.log(chalk.greenBright('CleanUp') + chalk.gray(' Connection closed. Cleaning up...'))
    
    cleanupConnectionIntervals()
    forceGC()
  }
})

// ───────────PLUGINS
const logger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }).child({})
loadPluginFiles(pluginFolder, pluginFilter, { logger, recursiveRead: true })
  .then(_ => {
    console.log(chalk.greenBright('Plugins') + chalk.gray(` Loaded ${Object.keys(plugins).length} Plugins`) )
  })
  .catch(console.error)

// ──────DB WRITE (every 20 minutes, untuk remote database)
// Kalau DATABASE di .env kosong (default .json), ga perlu auto-save (file-based)
// Kalau DATABASE ada (token/connection string), auto-save setiap 20 menit ke remote DB

const shouldAutoSaveDb = !!process.env.DATABASE // auto-save kalau DATABASE ada (remote/MongoDB)

if (shouldAutoSaveDb) {
  writeInterval = setInterval(async () => {
    await (db.data ? db.write() : Promise.resolve())
    Connection.store.writeToFile(Connection.storeFile)
  }, 20 * 60 * 1000)
  registerInterval(writeInterval)
}

// ──────CLEAR TMP (every 20 minutes, terlepas dari DATABASE diisi atau tidak)
if (opts['autocleartmp'] || opts['cleartmp']) {
  tmpClearInterval = setInterval(() => { clearTmp() }, 20 * 60 * 1000)
  registerInterval(tmpClearInterval)
}


// ──── REFILL LIMIT (tiap 10 menit, hanya user registered)
const LIMIT_REFILL_MS = 10 * 60 * 1000

refillInterval = setInterval(() => {
  if (!db.data?.users || !db.data?.settings) return
  const setting = Object.values(db.data.settings)[0]
  if (!setting) return
  if (Date.now() - (setting.resetlimit || 0) < LIMIT_REFILL_MS) return

  let refilledCount = 0
  for (const [, data] of Object.entries(db.data.users)) {
    if (!data.registered) continue
    const cap = global.tierAsset?.limit?.[data.level] || 10
    const current = data.limit || 0
    if (current >= cap) continue // skip user yang limitnya udah penuh (mis. 10/10)

    data.limit = Math.min(current + 1, cap)
    refilledCount++
  }

  setting.resetlimit = Date.now()
  if (refilledCount > 0) {
    console.log(chalk.greenBright('Refill Limit') + chalk.gray(` +${global.settings.refillLimit[0]} limit every ${global.settings.refillLimit[1]} minutes (${refilledCount} user${refilledCount > 1 ? 's' : ''} refilled)`))
  }
}, LIMIT_REFILL_MS)

registerInterval(refillInterval)

// ─────SERVER

const WEBSITE_ENV = (process.env.WEBSITE || '').trim()
const useTunnel    = WEBSITE_ENV.toLowerCase() === 'true'
const manualServerUrl = (!useTunnel && WEBSITE_ENV && WEBSITE_ENV.toLowerCase() !== 'false')
  ? WEBSITE_ENV
  : null

global.websiteState = {
  mode: useTunnel ? 'tunnel' : (manualServerUrl ? 'manual' : 'off'),
  url: manualServerUrl || null, 
}
global.getServerUrl = () => global.websiteState.url || 'https://not-loaded.yet'


opts['server'] = useTunnel ? true : (manualServerUrl || true)

{
  const { default: startServer } = await import('./server.js?update=' + Date.now())
  const httpServer = startServer(conn, PORT)
  if (httpServer?.on && !httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.once('listening', resolve)
      httpServer.once('error', resolve)
    })
  } else {
    await new Promise(resolve => setTimeout(resolve, 500))
  }
}

if (!useTunnel) {
  if (manualServerUrl) {
    console.log(chalk.yellow('Tunnel') + chalk.gray(` Disabled (WEBSITE="${manualServerUrl}") — using manual URL as server link`))
  } else {
    console.log(chalk.yellow('Tunnel') + chalk.gray(' Disabled (WEBSITE=false or unset) — using host-provided/fallback link only'))
  }
}

// ─────────────AUTO TUNNEL (Cloudflare Quick Tunnel)
//
// Switched from localtunnel-plus to Cloudflare's free Quick Tunnel.
// localtunnel.me (the free relay localtunnel depends on) has long-standing,
// widely-reported reliability problems — intermittent 502 Bad Gateway even
// when the local server and the tunnel connection itself are both healthy.
// Cloudflare's infrastructure doesn't have that problem, and Quick Tunnel
// needs no account, no domain, and no payment — just the free `cloudflared`
// binary, which is auto-downloaded by the `cloudflared` npm package.
//
// Trade-off vs localtunnel: the URL is always random and changes on every
// restart/reconnect (no custom subdomain without owning a real domain in
// Cloudflare). That's an acceptable trade for actually working reliably.

if (useTunnel) {
  let reconnectAttempts = 0
  let isReconnecting    = false
  let tunnelRetryTimer  = null
  let cfBinPromise      = null
  let lastTunnelStartAt = 0 // dipakai monitor untuk restart preventif berkala

  // ─── Reuse tunnel lintas-restart ───────────────────────────────────────
  // PENTING — batasan nyata Cloudflare Quick Tunnel (bukan pilihan desain
  // kode ini): hostname *.trycloudflare.com HANYA valid selama proses
  // `cloudflared` yang menghasilkannya masih hidup dan koneksinya ke
  // Cloudflare edge belum putus. Ini bukan sesuatu yang bisa "dipaksa"
  // lewat menyimpan URL ke file — kalau proses cloudflared-nya sudah mati
  // (server reboot, OOM kill, pkill manual, dst), URL di file manapun
  // TIDAK akan bekerja lagi walau ditulis ulang ke opts['server'], karena
  // Cloudflare sendiri yang sudah men-deregister hostname itu begitu
  // koneksi WebSocket-nya putus.
  //
  // Yang BISA dilakukan (dan itu yang dikerjakan blok ini): kalau proses
  // `cloudflared` dari run sebelumnya TERNYATA masih hidup (mis. restart
  // ini cuma reload modul di proses Node yang sama, atau child process
  // itu numpuk di background tanpa ikut mati), maka reuse URL & PID-nya
  // tanpa spawn cloudflared baru — sesuai permintaan. Kalau ternyata sudah
  // mati, otomatis fallback spawn baru (karena memang tidak ada pilihan
  // lain yang bisa bekerja).
  const TUNNEL_URL_PATH = path.join(process.cwd(), 'data', 'tunnel', 'tunnel.txt')
  const TUNNEL_PID_PATH = path.join(process.cwd(), 'data', 'tunnel', 'tunnel.pid')

  function isPidAlive(pid) {
    if (!pid || Number.isNaN(pid)) return false
    try {
      process.kill(pid, 0) // signal 0 = cek keberadaan proses, tidak membunuh
      return true
    } catch (e) {
      return false // ESRCH (tidak ada) atau EPERM (punya orang lain, anggap tidak reusable)
    }
  }

  function readSavedTunnel() {
    try {
      if (!fs.existsSync(TUNNEL_URL_PATH) || !fs.existsSync(TUNNEL_PID_PATH)) return null
      const url = fs.readFileSync(TUNNEL_URL_PATH, 'utf8').trim()
      const pid = parseInt(fs.readFileSync(TUNNEL_PID_PATH, 'utf8').trim(), 10)
      if (!url || !url.startsWith('https://') || !pid) return null
      return { url, pid }
    } catch (_) {
      return null
    }
  }

  function saveTunnel(url, pid) {
    try {
      const dataDir = path.dirname(TUNNEL_URL_PATH)
      if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true })
      fs.writeFileSync(TUNNEL_URL_PATH, url, 'utf8')
      fs.writeFileSync(TUNNEL_PID_PATH, String(pid), 'utf8')
    } catch (e) {
      console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed saving tunnel.txt/pid: ${e.message}`))
    }
  }

  function clearSavedTunnel() {
    try { fs.unlinkSync(TUNNEL_URL_PATH) } catch (_) {}
    try { fs.unlinkSync(TUNNEL_PID_PATH) } catch (_) {}
  }

  // ─── Push tunnel URL ke GitHub repo homepage (opsional) ────────────────
  // Hanya jalan kalau GIT_CLASSIC_KEY diisi di .env. GIT_USER & GIT_REPO
  // juga dibaca dari .env. Kalau GIT_CLASSIC_KEY kosong, fungsi ini no-op.
  async function pushTunnelUrlToGithub(url) {
    const token = process.env.GIT_CLASSIC_KEY
    if (!token) return // opsional — skip kalau key kosong

    const gitUser = process.env.GIT_USER
    const gitRepo = process.env.GIT_REPO
    if (!gitUser || !gitRepo) {
      console.warn(chalk.yellow('Tunnel') + chalk.gray(' GIT_USER/GIT_REPO belum diset di .env, skip push tunnel URL'))
      return
    }

    try {
      const apiUrl = `https://api.github.com/repos/${gitUser}/${gitRepo}`

      const patchRes = await fetch(apiUrl, {
        method: 'PATCH',
        headers: {
          Authorization: `token ${token}`,
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ homepage: url })
      })

      if (!patchRes.ok) {
        const errText = await patchRes.text().catch(() => '')
        console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed to update repo homepage on GitHub (${patchRes.status}): ${errText}`))
        return
      }

    } catch (e) {
      console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed to update repo homepage on Github: ${e.message}`))
    }
  }

  async function getCloudflaredBin() {
    if (!cfBinPromise) {
      cfBinPromise = (async () => {
        const { bin, install } = await import('cloudflared')
        if (!fs.existsSync(bin)) {
          console.log(chalk.yellow('Tunnel') + chalk.gray(' Downloading cloudflared binary (first run only)...'))
          await install(bin)
        }
        return bin
      })()
    }
    return cfBinPromise
  }

  async function spawnTunnel() {
    if (isReconnecting) {
      console.log(chalk.yellow('Tunnel') + chalk.gray(' Already reconnecting, skipping...'))
      return
    }

    if (tunnelRetryTimer) {
      clearTimeout(tunnelRetryTimer)
      tunnelRetryTimer = null
    }

    // Kalau ada tunnel tersimpan dari run sebelumnya DAN proses cloudflared
    // itu ternyata masih hidup (misalnya numpuk di background) — reuse URL
    // & PID-nya langsung, TIDAK spawn cloudflared baru, TIDAK hapus file.
    const saved = readSavedTunnel()
    if (saved && isPidAlive(saved.pid)) {
      global.tunnel  = { proc: null, url: saved.url, pid: saved.pid, reused: true }
      opts['server'] = saved.url
      global.websiteState.url = saved.url
      lastTunnelStartAt = Date.now()
      console.log(chalk.greenBright('Tunnel ') + chalk.gray(`${saved.url.replace('https://', '')} (reused from previous run, PID ${saved.pid} still alive)`))
      pushTunnelUrlToGithub(saved.url).catch(() => {})
      return
    }
    if (saved && !isPidAlive(saved.pid)) {
      console.log(chalk.yellow('Tunnel') + chalk.gray(` PID ${saved.pid} is no longer alive, spawning a new one...`))
      clearSavedTunnel()
    }

    // If a previous run's cloudflared process is still alive but we've
    // decided to reach this point (i.e. we're about to spawn a fresh
    // tunnel rather than reuse it), make sure the old one actually gets
    // killed instead of being abandoned. Leaving it running is what was
    // causing cloudflared processes to accumulate across restarts (each
    // one holding ~35-40MB RSS), inflating total memory usage over time
    // without ever showing up as a JS heap leak.
    if (saved && isPidAlive(saved.pid)) {
      console.log(chalk.yellow('Tunnel') + chalk.gray(` Killing PID ${saved.pid} before spawning a new tunnel...`))
      try { process.kill(saved.pid, 'SIGTERM') } catch (e) {}
      clearSavedTunnel()
    }

    isReconnecting = true

    try {
      if (global.tunnel?.proc) {
        try { global.tunnel.proc.kill() } catch (e) {}
        global.tunnel = null
      }

      console.log(chalk.yellow('Tunnel') + chalk.gray(' Connecting...'))
      const bin = await getCloudflaredBin()

      const proc = spawn(bin, ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'])
      let resolved = false

      const urlPromise = new Promise((resolve, reject) => {
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i
        const onData = (chunk) => {
          const text = chunk.toString()
          const match = text.match(urlRegex)
          if (match && !resolved) {
            resolved = true
            resolve(match[0])
          }
        }
        // cloudflared logs the URL to stderr, not stdout
        proc.stdout.on('data', onData)
        proc.stderr.on('data', onData)

        proc.once('error', reject)
        proc.once('exit', (code) => {
          if (!resolved) reject(new Error(`cloudflared exited early with code ${code}`))
        })

        setTimeout(() => {
          if (!resolved) reject(new Error('Timed out waiting for tunnel URL'))
        }, 20000)
      })

      const url = await urlPromise

      // cloudflared prints the URL as soon as it's assigned, but the DNS
      // record for that *.trycloudflare.com hostname can take a couple of
      // seconds to actually propagate. Opening the link right away can hit
      // ERR_NAME_NOT_RESOLVED even though the tunnel itself is fine. Poll
      // DNS briefly before announcing the tunnel as ready.
      const hostname = new URL(url).hostname
      const dns = await import('dns/promises')
      let dnsReady = false
      for (let i = 0; i < 10; i++) {
        try {
          await dns.lookup(hostname)
          dnsReady = true
          break
        } catch (e) {
          await new Promise(r => setTimeout(r, 1000))
        }
      }
      if (!dnsReady) {
        console.log(chalk.yellow('Tunnel') + chalk.gray(' DNS not confirmed yet, URL may take a few more seconds to load'))
      }

      global.tunnel     = { proc, url, pid: proc.pid, reused: false }
      opts['server']    = url
      global.websiteState.url = url
      reconnectAttempts = 0
      isReconnecting    = false
      lastTunnelStartAt = Date.now()
      saveTunnel(url, proc.pid)
      pushTunnelUrlToGithub(url).catch(() => {})

      console.log(chalk.greenBright('Tunnel ') + chalk.gray(url.replace('https://', '')))

      proc.once('exit', (code) => {
        console.log(chalk.yellow('Tunnel') + chalk.gray(` Process exited (code ${code}), reconnecting in 5 seconds...`))
        clearSavedTunnel()
        isReconnecting = false
        tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), 5000)
      })

      proc.once('error', (err) => {
        console.error(chalk.red('Tunnel Error:'), err.message)
        clearSavedTunnel()
        isReconnecting = false
        tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), 5000)
      })

    } catch (err) {
      console.error(chalk.red('Tunnel Failed to spawn:'), err.message || err)
      reconnectAttempts++
      const delay = Math.min(30000, 5000 * reconnectAttempts)
      console.log(chalk.yellow(`[tunnel] Coba lagi dalam ${delay / 1000}s... (attempt ${reconnectAttempts})`))
      isReconnecting = false
      tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), delay)
    }
  }
  global.startTunnel = spawnTunnel

  // ─── HEALTH MONITOR (tiap 1 menit) ─────────────────────────────────────
  // PID hidup ≠ tunnel bisa diakses. Cloudflare bisa deregister hostname
  // *.trycloudflare.com (mis. koneksi WebSocket edge putus) walau proses
  // cloudflared di server masih hidup — itu penyebab Error 1033. Jadi selain
  // cek PID (sudah ditangani spawnTunnel di atas), monitor ini juga cek
  // URL-nya beneran bisa diakses (HTTP), dan generate tunnel baru kalau tidak.
  //
  // Dua tahap, bukan langsung fetch ke URL publik:
  //   1. Cek /api/health di localhost dulu — cepat, tidak lewat internet.
  //      Kalau ini gagal, servernya sendiri yang bermasalah, BUKAN tunnel —
  //      generate tunnel baru saat itu percuma, jadi skip.
  //   2. Baru kalau server lokal sehat tapi URL publik gagal, itu baru
  //      berarti tunnel-nya yang putus → regenerate.
  const TUNNEL_HEALTH_INTERVAL_MS = 60 * 1000
  const TUNNEL_HEALTH_TIMEOUT_MS  = 15000

  // Quick Tunnel gratis makin lama makin rawan putus sendiri (limitasi
  // Cloudflare, bukan sesuatu yang bisa dihindari dari sisi kode). Daripada
  // nunggu dia mati sendiri di waktu acak (mis. pas ada yang lagi pakai),
  // tunnel di-refresh preventif tiap beberapa jam pada saat kita yang pilih.
  const TUNNEL_PREVENTIVE_RESTART_MS = 4 * 60 * 60 * 1000

  async function pingUrl(url, timeoutMs) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      const res = await fetch(url, { method: 'GET', signal: controller.signal })
      clearTimeout(timer)
      // Error 1033 dari Cloudflare tetap balikin response (bukan network
      // error) tapi statusnya bukan 2xx/3xx normal — anggap itu juga "mati".
      return res.status < 500
    } catch (e) {
      return false
    }
  }

  async function checkTunnelHealth() {
    const url = global.tunnel?.url
    const pid = global.tunnel?.pid

    if (!url || !isPidAlive(pid)) {
      // Proses sudah mati duluan — biarkan proc.once('exit'/'error') di
      // spawnTunnel yang menangani reconnect, tidak perlu duplikat di sini.
      return
    }

    const localOk = await pingUrl(`http://127.0.0.1:${PORT}/api/health`, TUNNEL_HEALTH_TIMEOUT_MS)
    if (!localOk) {
      // Server lokal sendiri yang lagi bermasalah (bukan tunnel). Regenerate
      // tunnel di sini tidak akan menolong apa-apa, biarkan proses lain
      // (mis. memory watchdog) yang menangani ini.
      return
    }

    const now = Date.now()
    const dueForPreventiveRestart = lastTunnelStartAt && (now - lastTunnelStartAt >= TUNNEL_PREVENTIVE_RESTART_MS)

    const publicOk = await pingUrl(url, TUNNEL_HEALTH_TIMEOUT_MS)
    if (publicOk && !dueForPreventiveRestart) return

    // Tunnel publik tidak bisa diakses (padahal server lokal sehat) ATAU
    // sudah waktunya restart preventif → generate tunnel baru.
    try { global.tunnel?.proc?.kill() } catch (_) {}
    global.tunnel = null
    clearSavedTunnel()
    spawnTunnel().catch(() => {})
  }

  const tunnelHealthInterval = setInterval(checkTunnelHealth, TUNNEL_HEALTH_INTERVAL_MS)
  registerInterval(tunnelHealthInterval)
}


async function _quickTest() {
  const results = await Promise.all([
    spawn('ffmpeg'),
    spawn('ffprobe'),
    spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_complex', 'color', '-frames:v', '1', '-f', 'webp', '-']),
    spawn('convert'),
    spawn('magick'),
    spawn('gm'),
    spawn('find', ['--version'])
  ].map(p => Promise.race([
    new Promise(resolve => p.on('close', code => resolve(code !== 127))),
    new Promise(resolve => p.on('error', () => resolve(false)))
  ])))

  const [ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find] = results
  global.support = Object.freeze({ ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find })

  if (!ffmpeg) console.log(chalk.red('FFMPEG') + chalk.gray(' Not installed'))
  if (ffmpeg && !ffmpegWebp) console.log(chalk.red('FFMPEG WEBP') + chalk.gray(' Not installed'))
  if (!convert && !magick && !gm) console.log(chalk.red('IMAGEMAGICK') + chalk.gray(' Not installed'))
}

_quickTest()
  .catch(console.error)
