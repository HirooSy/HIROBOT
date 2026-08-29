import path from 'path';
import events from 'events';
import './config.js'
import P from 'pino'
import Connection from './utils/connection.js'
import Helper from './utils/helper.js'
import { spawn } from 'child_process'
import { protoType, serialize } from './utils/simple.js'
import { startReloadSystem } from './utils/reload.js'
import chalk from './utils/color.js'
import fs from 'fs';
import { tmpdir } from 'os'

global.opts = { ...Helper.runtimeOpts };
global.prefix = Helper.prefixList;

const BAILEYS_STACK_MARKERS = ['/baileys/', '@whiskeysockets/baileys', '/baileys-caller/'];
const IGNORED_ERRORS = [
  'isZero', 'toJSON', 'writeToFile', "reading 'child'",
  'makeNoiseHandler', 'Cannot read properties of undefined',
  'noise-handler', 'socket.js',
];
const IGNORED_ERROR_WINDOW_MS = 60 * 1000;

const MUTED_LOG_PATTERNS = [
  'Closing session',
];
const isMutedLog = (args) => {
  const text = args.map((a) => (typeof a === 'string' ? a : '')).join(' ');
  return MUTED_LOG_PATTERNS.some((pattern) => text.includes(pattern));
};
const originalConsoleLog = console.log.bind(console);
const originalConsoleError = console.error.bind(console);
const originalConsoleWarn = console.warn.bind(console);
console.log = (...args) => { if (!isMutedLog(args)) originalConsoleLog(...args); };
console.error = (...args) => { if (!isMutedLog(args)) originalConsoleError(...args); };
console.warn = (...args) => { if (!isMutedLog(args)) originalConsoleWarn(...args); };
const IGNORED_ERROR_THRESHOLD = 5;
const HEAP_WARN_MB = 350;
const HEAP_EXIT_MB = 512;
const LIMIT_REFILL_MS = 10 * 60 * 1000;
const TUNNEL_URL_PATH = path.join(process.cwd(), 'data', 'tunnel', 'tunnel.txt');
const TUNNEL_PID_PATH = path.join(process.cwd(), 'data', 'tunnel', 'tunnel.pid');
const TUNNEL_HEALTH_INTERVAL_MS = 60 * 1000;
const TUNNEL_HEALTH_TIMEOUT_MS = 15000;
const TUNNEL_PREVENTIVE_RESTART_MS = 4 * 60 * 60 * 1000;

const NAMED_TUNNEL_TOKEN = process.env.CLOUDFLARE_TUNNEL_TOKEN || '';
const NAMED_TUNNEL_HOSTNAME = (process.env.CLOUDFLARE_TUNNEL_HOSTNAME || '').replace(/^https?:\/\//, '').replace(/\/$/, '');

const PORT = process.env.PORT || process.env.SERVER_PORT || 8080;

const PUBLIC_HOSTNAME = process.env.HOSTNAME_PUBLIC || process.env.PUBLIC_HOSTNAME || '';

global.activeIntervals = global.activeIntervals || new Set();
let ignoredErrorTimestamps = [];
let writeInterval = null;
let refillInterval = null;
let tmpClearInterval = null;
let memMonitorInterval = null;

function registerInterval(interval) {
  global.activeIntervals.add(interval);
  return interval;
}

function cleanupConnectionIntervals() {
  const kept = [memMonitorInterval, refillInterval, writeInterval, tmpClearInterval];
  for (const interval of global.activeIntervals) {
    if (kept.includes(interval)) continue;
    clearInterval(interval);
    global.activeIntervals.delete(interval);
  }
}

function isBaileysInternalError(err) {
  if (!err) return false;
  const stack = err.stack || '';
  if (!BAILEYS_STACK_MARKERS.some(marker => stack.includes(marker))) return false;
  const msg = err.message || '';
  return IGNORED_ERRORS.some(e => msg.includes(e) || stack.includes(e));
}

function noteIgnoredErrorAndMaybeRestart(label, msg) {
  const now = Date.now();
  ignoredErrorTimestamps.push(now);
  ignoredErrorTimestamps = ignoredErrorTimestamps.filter(t => now - t <= IGNORED_ERROR_WINDOW_MS);

  console.error(chalk.yellow(label) + chalk.gray(` Baileys internal error (${ignoredErrorTimestamps.length}/${IGNORED_ERROR_THRESHOLD} in window): `) + chalk.gray(msg));

  if (ignoredErrorTimestamps.length >= IGNORED_ERROR_THRESHOLD) {
    console.error(chalk.red('Watchdog') + chalk.gray(` Detected ${ignoredErrorTimestamps.length}x internal errors in ${IGNORED_ERROR_WINDOW_MS / 1000}s — connection looks stuck. Restarting process...`));
    ignoredErrorTimestamps = [];
    setTimeout(() => flushDatabaseAndExit(1, 'watchdog restart'), 200);
  }
}

function setupGlobalErrorHandlers() {
  process.on('uncaughtException', (err) => {
    if (isBaileysInternalError(err)) return noteIgnoredErrorAndMaybeRestart('Ignored', err.message);
    console.error(chalk.red('[ UncaughtException ]'), err);
  });

  process.on('unhandledRejection', (reason) => {
    if (isBaileysInternalError(reason)) return noteIgnoredErrorAndMaybeRestart('Ignored', reason?.message);
    console.error(chalk.red('[ UnhandledRejection ]'), reason);
  });
}

let _shuttingDown = false
async function flushDatabaseAndExit(code, signalName) {
  if (_shuttingDown) return
  _shuttingDown = true
  if (signalName) console.log(chalk.yellow(`[ Shutdown ]`) + chalk.gray(` Received ${signalName}, saving database...`));
  try {
    await Promise.race([
      global.db?.data ? global.db.write() : Promise.resolve(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5000))
    ]);
  } catch (err) {
    console.error(chalk.red('[ Shutdown ]'), 'Failed to save database before exit:', err.message);
  } finally {
    process.exit(code);
  }
}

function setupGracefulShutdown() {
  process.on('SIGTERM', () => flushDatabaseAndExit(0, 'SIGTERM'));
  process.on('SIGINT', () => flushDatabaseAndExit(0, 'SIGINT'));
}

function forceGC() {
  if (global.gc) {
    global.gc();
    return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  }
  return null;
}

function checkMemory() {
  const mem = process.memoryUsage();
  const heapUsedMB = Math.round(mem.heapUsed / 1024 / 1024);
  const afterGC = forceGC();
  const finalHeap = afterGC ?? heapUsedMB;

  if (finalHeap > HEAP_EXIT_MB) {
    console.error(`${chalk.red('Memory')}${chalk.gray(` Heap ${finalHeap}MB > ${HEAP_EXIT_MB}MB! Restarting...`)}`);
    flushDatabaseAndExit(1, 'memory limit');
  } else if (finalHeap > HEAP_WARN_MB) {
    console.warn(`${chalk.yellow('Memory')}${chalk.gray(` Heap ${finalHeap}MB almost reaching the limit`)}`);
  }
}

function startMemoryMonitor() {
  memMonitorInterval = setInterval(checkMemory, 10 * 60 * 1000);
  registerInterval(memMonitorInterval);
}

async function clearTmp() {
  const tmpDir = path.join(process.cwd(), 'data/tmp');
  const dirs = [tmpdir(), tmpDir];
  const AGE_LIMIT = 1000 * 60 * 60;

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const files = await fs.promises.readdir(dir).catch(() => []);
    for (const file of files) {
      const filePath = path.join(dir, file);
      const stat = await fs.promises.stat(filePath).catch(() => null);
      if (stat?.isFile() && (Date.now() - stat.mtimeMs >= AGE_LIMIT)) {
        await fs.promises.unlink(filePath).catch(() => {});
      }
    }
  }
}

function startTmpCleanup() {
  tmpClearInterval = setInterval(() => { clearTmp(); }, 20 * 60 * 1000);
  registerInterval(tmpClearInterval);
}

function startLimitRefill() {
  refillInterval = setInterval(() => {
    if (!db.data?.users || !db.data?.settings) return;
    const setting = Object.values(db.data.settings)[0];
    if (!setting) return;
    if (Date.now() - (setting.resetlimit || 0) < LIMIT_REFILL_MS) return;

    let refilledCount = 0;
    for (const [, data] of Object.entries(db.data.users)) {
      if (!data.registered) continue;
      const cap = global.settings.tier?.limit_capacity?.[data.level] || 10;
      const current = data.limit || 0;
      if (current >= cap) continue;
      data.limit = Math.min(current + 1, cap);
      refilledCount++;
    }

    setting.resetlimit = Date.now();
  }, LIMIT_REFILL_MS);
  registerInterval(refillInterval);
}

function startDbAutoSave() {
  writeInterval = setInterval(async () => {
    await (db.data ? db.write() : Promise.resolve());
    Connection.store.writeToFile(Connection.storeFile);
  }, 20 * 60 * 1000);
  registerInterval(writeInterval);
}

function patchStoreWriteToFile() {
  if (!Connection.store?.writeToFile) return;
  const _orig = Connection.store.writeToFile;
  Connection.store.writeToFile = function (...args) {
    try {
      return _orig.apply(this, args);
    } catch (err) {
      console.error('Store writeToFile error:', err.message);
      if (err.message?.includes('isZero') || err.message?.includes('toJSON')) return;
      throw err;
    }
  };
}

function isPidAlive(pid) {
  if (!pid || Number.isNaN(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function getCloudflaredBinPath() {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(process.cwd(), 'data', 'tunnel', `cloudflared${ext}`);
}
const CLOUDFLARED_BIN_PATH = getCloudflaredBinPath();
const CLOUDFLARED_DOWNLOAD_URLS = {
  'linux-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64',
  'linux-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64',
  'linux-arm': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm',
  'win32-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe',
  'win32-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-arm64.exe',
  'darwin-x64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-amd64.tgz',
  'darwin-arm64': 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz',
};

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed with status ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

async function extractMacTarball(tarballPath, destBinPath) {

  const destDir = path.dirname(destBinPath);
  await new Promise((resolve, reject) => {
    const proc = spawn('tar', ['-xzf', tarballPath, '-C', destDir]);
    proc.once('error', reject);
    proc.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar exited with code ${code}`)));
  });
  fs.unlinkSync(tarballPath);
  const extractedPath = path.join(destDir, 'cloudflared');
  if (extractedPath !== destBinPath) fs.renameSync(extractedPath, destBinPath);
}

async function ensureCloudflaredBinary() {
  if (fs.existsSync(CLOUDFLARED_BIN_PATH)) return CLOUDFLARED_BIN_PATH;

  const platform = process.platform;
  const arch = process.arch;

  let key;
  if (platform === 'linux') {
    key = arch === 'arm64' ? 'linux-arm64' : arch === 'arm' ? 'linux-arm' : 'linux-x64';
  } else if (platform === 'win32') {
    key = arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  } else if (platform === 'darwin') {
    key = arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  } else {
    console.warn(chalk.yellow('Tunnel') + chalk.gray(` Unsupported platform ${platform}. Falling back to 'cloudflared' on PATH.`));
    return 'cloudflared';
  }
  const url = CLOUDFLARED_DOWNLOAD_URLS[key];

  console.log(chalk.red('Tunnel') + chalk.gray(` binary not found, downloading (${key})...`));
  try {
    const dir = path.dirname(CLOUDFLARED_BIN_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    if (platform === 'darwin') {
      const tarballPath = path.join(dir, 'cloudflared.tgz');
      await downloadFile(url, tarballPath);
      await extractMacTarball(tarballPath, CLOUDFLARED_BIN_PATH);
    } else {
      await downloadFile(url, CLOUDFLARED_BIN_PATH);
    }
    if (platform !== 'win32') fs.chmodSync(CLOUDFLARED_BIN_PATH, 0o755);

    console.log(chalk.greenBright('Tunnel') + chalk.gray(' cloudflared downloaded successfully.'));
    return CLOUDFLARED_BIN_PATH;
  } catch (e) {
    console.error(chalk.red('Tunnel') + chalk.gray(` Failed to auto-download cloudflared: ${e.message}. Falling back to 'cloudflared' on PATH.`));
    return 'cloudflared';
  }
}

function readSavedTunnel() {
  try {
    if (!fs.existsSync(TUNNEL_URL_PATH) || !fs.existsSync(TUNNEL_PID_PATH)) return null;
    const url = fs.readFileSync(TUNNEL_URL_PATH, 'utf8').trim();
    const pid = parseInt(fs.readFileSync(TUNNEL_PID_PATH, 'utf8').trim(), 10);
    if (!url || !url.startsWith('https://') || !pid) return null;
    return { url, pid };
  } catch (_) {
    return null;
  }
}

function saveTunnel(url, pid) {
  try {
    const dataDir = path.dirname(TUNNEL_URL_PATH);
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(TUNNEL_URL_PATH, url, 'utf8');
    fs.writeFileSync(TUNNEL_PID_PATH, String(pid), 'utf8');
  } catch (e) {
    console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed saving tunnel.txt/pid: ${e.message}`));
  }
}

function clearSavedTunnel() {
  try { fs.unlinkSync(TUNNEL_URL_PATH); } catch (_) {}
  try { fs.unlinkSync(TUNNEL_PID_PATH); } catch (_) {}
}

async function pushTunnelUrlToGithub(url) {
  const token = process.env.GIT_CLASSIC_KEY;
  if (!token) return;

  const gitUser = process.env.GIT_USER;
  const gitRepo = process.env.GIT_REPO;
  if (!gitUser || !gitRepo) {
    console.warn(chalk.yellow('Tunnel') + chalk.gray(' GIT_USER/GIT_REPO belum diset di .env, skip push tunnel URL'));
    return;
  }

  try {
    const apiUrl = `https://api.github.com/repos/${gitUser}/${gitRepo}`;
    const patchRes = await fetch(apiUrl, {
      method: 'PATCH',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ homepage: url }),
    });

    if (!patchRes.ok) {
      const errText = await patchRes.text().catch(() => '');
      console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed to update repo homepage on GitHub (${patchRes.status}): ${errText}`));
    }
  } catch (e) {
    console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed to update repo homepage on Github: ${e.message}`));
  }
}

async function pushTunnelUrlToUptimeRobot(url) {
  const apiKey = process.env.UPTIMEROBOT_API_KEY;
  const monitorId = process.env.UPTIMEROBOT_MONITOR_ID;
  if (!apiKey || !monitorId) return;

  try {
    const res = await fetch('https://api.uptimerobot.com/v2/editMonitor', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cache-Control': 'no-cache',
      },
      body: new URLSearchParams({
        api_key: apiKey,
        id: monitorId,
        url: url.endsWith('/api/health') ? url : `${url}/api/health`,
      }),
    });

    const data = await res.json().catch(() => null);
    if (!res.ok || data?.stat !== 'ok') {
      console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed to update UptimeRobot monitor: ${data ? JSON.stringify(data) : res.status}`));
    } else {
      console.log(chalk.greenBright('Tunnel') + chalk.gray(' UptimeRobot monitor updated'));
    }
  } catch (e) {
    console.warn(chalk.yellow('Tunnel') + chalk.gray(` Failed to update UptimeRobot monitor: ${e.message}`));
  }
}

async function pingUrl(url, timeoutMs) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    return res.status < 500;
  } catch (e) {
    return false;
  }
}

let isTunnelRestarting = false;
async function restartTunnel() {
  if (typeof global.startTunnel !== 'function') return;
  if (isTunnelRestarting) return;
  if (global.tunnel != null) return;
  isTunnelRestarting = true;
  try {
    await global.startTunnel();
  } finally {
    setTimeout(() => { isTunnelRestarting = false; }, 5000);
  }
}
global.restartTunnel = restartTunnel;

function setupTunnel(opts) {
  let reconnectAttempts = 0;
  let isReconnecting = false;
  let tunnelRetryTimer = null;
  let lastTunnelStartAt = 0;

  async function spawnTunnel() {
    if (isReconnecting) return;

    if (PUBLIC_HOSTNAME) {
      const publicUrl = `http://${PUBLIC_HOSTNAME}`;
      if (global.tunnel == null) {
        global.tunnel = { proc: null, url: publicUrl, pid: null, reused: true, static: true };
        console.log(chalk.greenBright('Server ') + chalk.gray(`${PUBLIC_HOSTNAME}`));
        pushTunnelUrlToGithub(publicUrl).catch(() => {});
        pushTunnelUrlToUptimeRobot(publicUrl).catch(() => {});
      }
      return;
    }

    if (tunnelRetryTimer) {
      clearTimeout(tunnelRetryTimer);
      tunnelRetryTimer = null;
    }

    if (NAMED_TUNNEL_TOKEN) {
      return spawnNamedTunnel();
    }

    const saved = readSavedTunnel();
    if (saved && isPidAlive(saved.pid)) {
      global.tunnel = { proc: null, url: saved.url, pid: saved.pid, reused: true };
      opts['server'] = saved.url;
      global.websiteState.url = saved.url;
      lastTunnelStartAt = Date.now();
      console.log(chalk.greenBright('Tunnel ') + chalk.gray(saved.url.replace('https://', '')));
      pushTunnelUrlToGithub(saved.url).catch(() => {});
      pushTunnelUrlToUptimeRobot(saved.url).catch(() => {});
      return;
    }
    if (saved && !isPidAlive(saved.pid)) {
      clearSavedTunnel();
    }
    if (saved && isPidAlive(saved.pid)) {
      try { process.kill(saved.pid, 'SIGTERM'); } catch (e) {}
      clearSavedTunnel();
    }

    isReconnecting = true;

    try {
      if (global.tunnel?.proc) {
        try { global.tunnel.proc.kill(); } catch (e) {}
        global.tunnel = null;
      }

      const cloudflaredBin = await ensureCloudflaredBinary();
      const proc = spawn(cloudflaredBin, [
        'tunnel',
        '--url', `http://localhost:${PORT}`,
        '--no-autoupdate',
      ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let resolved = false;

      const urlPromise = new Promise((resolve, reject) => {
        const urlRegex = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
        const onData = (chunk) => {
          const text = chunk.toString();
          const match = text.match(urlRegex);
          if (match && !resolved) {
            resolved = true;
            resolve(match[0]);
          }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.once('error', reject);
        proc.once('exit', (code) => {
          if (!resolved) reject(new Error(`cloudflared exited early with code ${code}`));
        });
        setTimeout(() => {
          if (!resolved) reject(new Error('Timed out waiting for tunnel URL'));
        }, 25000);
      });

      const url = await urlPromise;
      global.tunnel = { proc, url, pid: proc.pid, reused: false };
      opts['server'] = url;
      global.websiteState.url = url;
      reconnectAttempts = 0;
      isReconnecting = false;
      lastTunnelStartAt = Date.now();
      saveTunnel(url, proc.pid);
      pushTunnelUrlToGithub(url).catch(() => {});
      pushTunnelUrlToUptimeRobot(url).catch(() => {});

      console.log(chalk.greenBright('Tunnel ') + chalk.gray(url.replace('https://', '')));

      proc.once('exit', (code) => {
        clearSavedTunnel();
        isReconnecting = false;
        tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), 5000);
      });

      proc.once('error', (err) => {
        console.error(chalk.red('Tunnel Error:'), err.message);
        clearSavedTunnel();
        isReconnecting = false;
        tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), 5000);
      });

    } catch (err) {
      console.error(chalk.red('Tunnel Failed to spawn:'), err.message || err);
      reconnectAttempts++;
      const delay = Math.min(30000, 5000 * reconnectAttempts);
      isReconnecting = false;
      tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), delay);
    }
  }

  async function spawnNamedTunnel() {
    if (tunnelRetryTimer) {
      clearTimeout(tunnelRetryTimer);
      tunnelRetryTimer = null;
    }

    isReconnecting = true;

    try {
      if (global.tunnel?.proc) {
        try { global.tunnel.proc.kill(); } catch (e) {}
        global.tunnel = null;
      }

      const cloudflaredBin = await ensureCloudflaredBinary();
      const proc = spawn(cloudflaredBin, [
        'tunnel',
        'run',
        '--token', NAMED_TUNNEL_TOKEN,
      ], { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });

      let resolved = false;

      const readyPromise = new Promise((resolve, reject) => {
        const readyRegex = /registered tunnel connection|connection [a-f0-9-]+ registered/i;
        const onData = (chunk) => {
          const text = chunk.toString();
          if (!resolved && readyRegex.test(text)) {
            resolved = true;
            resolve();
          }
        };
        proc.stdout.on('data', onData);
        proc.stderr.on('data', onData);
        proc.once('error', reject);
        proc.once('exit', (code) => {
          if (!resolved) reject(new Error(`cloudflared (named tunnel) exited early with code ${code}`));
        });
        setTimeout(() => {
          if (!resolved) reject(new Error('Timed out waiting for named tunnel to register'));
        }, 25000);
      });

      await readyPromise;

      const url = NAMED_TUNNEL_HOSTNAME ? `https://${NAMED_TUNNEL_HOSTNAME}` : null;
      global.tunnel = { proc, url, pid: proc.pid, reused: false, named: true };
      if (url) {
        opts['server'] = url;
        global.websiteState.url = url;
      }
      reconnectAttempts = 0;
      isReconnecting = false;
      lastTunnelStartAt = Date.now();

      console.log(
        chalk.greenBright('Tunnel (named) ') +
        chalk.gray(
          url
            ? url.replace('https://', '')
            : 'Connected (set CLOUDFLARE_TUNNEL_HOSTNAME di .env untuk menampilkan URL & aktifkan health check publik)'
        )
      );

      if (url) {
        pushTunnelUrlToGithub(url).catch(() => {});
        pushTunnelUrlToUptimeRobot(url).catch(() => {});
      }

      proc.once('exit', (code) => {
        isReconnecting = false;
        global.tunnel = null;
        tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), 5000);
      });

      proc.once('error', (err) => {
        console.error(chalk.red('Tunnel (named) Error:'), err.message);
        isReconnecting = false;
        global.tunnel = null;
        tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), 5000);
      });

    } catch (err) {
      console.error(chalk.red('Tunnel (named) Failed to spawn:'), err.message || err);
      reconnectAttempts++;
      const delay = Math.min(30000, 5000 * reconnectAttempts);
      isReconnecting = false;
      tunnelRetryTimer = setTimeout(() => spawnTunnel().catch(console.error), delay);
    }
  }

  global.startTunnel = spawnTunnel;

  async function checkTunnelHealth() {
    const url = global.tunnel?.url;
    const pid = global.tunnel?.pid;
    const isNamed = !!global.tunnel?.named;
    if (!pid) return;

    if (!isPidAlive(pid)) {
      console.warn(chalk.red('Tunnel') + chalk.gray(' Proses cloudflared sudah mati, spawn ulang...'));
      try { global.tunnel?.proc?.kill(); } catch (_) {}
      global.tunnel = null;
      clearSavedTunnel();
      spawnTunnel().catch(() => {});
      return;
    }

    const localOk = await pingUrl(`http://127.0.0.1:${PORT}/api/health`, TUNNEL_HEALTH_TIMEOUT_MS);
    if (!localOk) return;

    const now = Date.now();
    const dueForPreventiveRestart = lastTunnelStartAt && (now - lastTunnelStartAt >= TUNNEL_PREVENTIVE_RESTART_MS);

    if (isNamed && !url) {
      if (!dueForPreventiveRestart) return;
    } else if (url) {
      const publicOk = await pingUrl(url, TUNNEL_HEALTH_TIMEOUT_MS);
      if (publicOk && !dueForPreventiveRestart) return;
    }

    try { global.tunnel?.proc?.kill(); } catch (_) {}
    global.tunnel = null;
    clearSavedTunnel();
    spawnTunnel().catch(() => {});
  }

  registerInterval(setInterval(checkTunnelHealth, TUNNEL_HEALTH_INTERVAL_MS));

  return spawnTunnel();
}

async function checkBinarySupport() {
  const results = await Promise.all([
    spawn('ffmpeg'),
    spawn('ffprobe'),
    spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-filter_complex', 'color', '-frames:v', '1', '-f', 'webp', '-']),
    spawn('find', ['--version']),
  ].map(p => Promise.race([
    new Promise(resolve => p.on('close', code => resolve(code !== 127))),
    new Promise(resolve => p.on('error', () => resolve(false))),
  ])));

  const [ffmpeg, ffprobe, ffmpegWebp, convert, magick, gm, find] = results;
  global.support = Object.freeze({ ffmpeg, ffprobe, ffmpegWebp, find });

  if (!ffmpeg) console.warn(chalk.red('FFMPEG') + chalk.gray(' Not installed'));
  if (ffmpeg && !ffmpegWebp) console.warn(chalk.red('FFMPEG WEBP') + chalk.gray(' Not installed'));
}

async function startHttpServer(conn) {
  const { default: startServer } = await import('./package/website/server.js?update=' + Date.now());
  const httpServer = startServer(conn, PORT);
  if (httpServer?.on && !httpServer.listening) {
    await new Promise((resolve) => {
      httpServer.once('listening', resolve);
      httpServer.once('error', resolve);
    });
  } else {
    await new Promise(resolve => setTimeout(resolve, 500));
  }
}

async function main() {
  events.EventEmitter.defaultMaxListeners = 10;

  setupGlobalErrorHandlers();
  setupGracefulShutdown();
  startMemoryMonitor();

  protoType();
  serialize();

  const { opts: _rawOpts, prefix: _rawPrefix, prefixList: _rawPrefixList, runtimeOpts: _rawRuntimeOpts, ...HelperGlobals } = Helper;
  Object.assign(global, { ...HelperGlobals, timestamp: { start: Date.now() } });

  const conn = Object.defineProperty(Connection, 'conn', {
    value: await Connection.conn,
    enumerable: true,
    configurable: true,
    writable: true,
  }).conn;

  patchStoreWriteToFile();

  conn.ev.on('connection.update', async ({ connection }) => {
    if (connection === 'close' || connection === 'disconnecting') {
      cleanupConnectionIntervals();
      forceGC();
    }
  });

  const pluginLogger = P({ timestamp: () => `,"time":"${new Date().toJSON()}"` }).child({});
  await startReloadSystem({ logger: pluginLogger });

  if (process.env.DATABASE) startDbAutoSave();
  if (opts['autocleartmp'] || opts['cleartmp']) startTmpCleanup();
  startLimitRefill();

  const publicUrl = PUBLIC_HOSTNAME ? `http://${PUBLIC_HOSTNAME}` : null;
  global.websiteState = { mode: publicUrl ? 'public-hostname' : 'tunnel', url: publicUrl };
  global.getServerUrl = () => global.websiteState.url || 'https://not-loaded.yet';
  opts['server'] = publicUrl || true;

  await startHttpServer(conn);

  if (conn.authState.creds.registered) {
    await setupTunnel(opts);
  } else {
    const waitForOpen = new Promise(resolve => {
      const onUpdate = ({ connection }) => {
        if (connection === 'open') {
          conn.ev.off('connection.update', onUpdate);
          resolve();
        }
      };
      conn.ev.on('connection.update', onUpdate);
    });
    waitForOpen.then(() => setupTunnel(opts));
  }

  await checkBinarySupport();
}

if (!global.__mainStarted) {
  global.__mainStarted = true;
  main().catch(console.error);
}