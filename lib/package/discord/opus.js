import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'

const RELAY_MAX_BYTES = 80 * 1024 * 1024
const RELAY_IDLE_MS = 20000
const RELAY_CONNECT_MS = 15000
const RELAY_RETRIES = 3
const DEFAULT_BITRATE = 128000
const VBR_MODES = ['on', 'constrained', 'off']

let limiterSupported = null

function enabled(name) {
  return /^(1|true|on|yes)$/i.test(String(process.env[name] || ''))
}

function hasLimiter() {
  if (limiterSupported === null) {
    try {
      const probe = spawnSync('ffmpeg', ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 5000 })
      limiterSupported = /\balimiter\b/.test(probe.stdout || '')
    } catch {
      limiterSupported = false
    }
  }
  return limiterSupported
}

function buildFilter(volume) {
  const gain = Number(volume)
  const chain = [`volume=${gain.toFixed(3)}`]
  if (gain > 1 && hasLimiter()) chain.push('alimiter=limit=0.97:attack=5:release=80:level=0')
  return chain.join(',')
}

function resolveProfile(channelRate) {
  const raw = String(process.env.VOICE_BITRATE || '').trim().toLowerCase()
  const forced = String(process.env.VOICE_VBR || '').trim().toLowerCase()
  let bitrate = DEFAULT_BITRATE
  let vbr = null
  if (raw === 'auto') {
    const rate = Number(channelRate)
    if (Number.isFinite(rate) && rate > 0) {
      bitrate = Math.min(128000, Math.max(32000, Math.round(rate)))
      vbr = 'off'
    }
  } else {
    const rate = Number(raw)
    if (raw && Number.isFinite(rate) && rate > 0) bitrate = Math.min(510000, Math.max(16000, Math.round(rate < 1000 ? rate * 1000 : rate)))
  }
  if (VBR_MODES.includes(forced)) vbr = forced
  return { bitrate, vbr }
}

function useRelay() {
  return enabled('VOICE_RELAY')
}

function buildArgs({ input, relay, remote, userAgent, seekMs, volume, bitrate }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1']
  if (!relay) {
    if (remote && userAgent) args.push('-user_agent', String(userAgent))
    if (remote) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5')
    if (seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3))
  }
  args.push('-i', relay ? 'pipe:0' : input)
  if (relay && seekMs > 0) args.push('-ss', (seekMs / 1000).toFixed(3))
  args.push('-vn', '-map', '0:a:0')
  if (volume !== 1) args.push('-af', buildFilter(volume))
  const profile = resolveProfile(bitrate)
  args.push('-c:a', 'libopus', '-b:a', String(profile.bitrate))
  if (profile.vbr) args.push('-vbr', profile.vbr)
  args.push('-application', 'audio', '-frame_duration', '20', '-ar', '48000', '-ac', '2', '-page_duration', '20000', '-flush_packets', '1', '-f', 'ogg', 'pipe:1')
  return args
}

function fetchSource(url, userAgent, signal, from) {
  const headers = { Accept: '*/*' }
  if (userAgent) headers['User-Agent'] = String(userAgent)
  if (from > 0) headers.Range = `bytes=${from}-`
  return fetch(url, { headers, redirect: 'follow', signal })
}

function isMp3(response, url) {
  const type = String(response.headers.get('content-type') || '').toLowerCase()
  if (/audio\/(mpeg|mp3|x-mpeg)/.test(type)) return true
  if (!type.includes('octet-stream')) return false
  try {
    return /\.mp3$/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}

async function openRelay(url, userAgent, state) {
  const abort = new AbortController()
  state.abort = abort
  const timer = setTimeout(() => abort.abort(), RELAY_CONNECT_MS)
  try {
    const response = await fetchSource(url, userAgent, abort.signal, 0)
    clearTimeout(timer)
    if (!state.stopped && response.ok && response.body && isMp3(response, url)) return response
    try {
      await response.body?.cancel()
    } catch {}
    return null
  } catch {
    clearTimeout(timer)
    return null
  }
}

function feedRelay(first, proc, state, url, userAgent) {
  const queue = []
  const total = Number(first.headers.get('content-length')) || 0
  let finished = false
  let signalled = false

  const notify = () => {
    signalled = true
    const wake = state.wake
    state.wake = null
    wake?.()
  }

  const download = async () => {
    let response = first
    let received = 0
    let attempts = 0
    for (;;) {
      let idle = null
      const arm = () => {
        clearTimeout(idle)
        idle = setTimeout(() => state.abort.abort(), RELAY_IDLE_MS)
      }
      try {
        arm()
        for await (const chunk of response.body) {
          arm()
          received += chunk.length
          if (received > RELAY_MAX_BYTES) {
            const err = new Error('Track is too large')
            err.fatal = true
            throw err
          }
          const data = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          queue.push(data)
          notify()
        }
        clearTimeout(idle)
        if (total && received < total) throw new Error('Audio source ended early')
        return
      } catch (err) {
        clearTimeout(idle)
        if (state.stopped) return
        attempts += 1
        if (err.fatal || attempts > RELAY_RETRIES) throw err
        state.abort = new AbortController()
        response = await fetchSource(url, userAgent, state.abort.signal, received)
        if (response.status !== 206 || !response.body) throw err
      }
    }
  }

  const write = async () => {
    const stdin = proc.stdin
    stdin.on('error', () => {})
    for (;;) {
      signalled = false
      while (queue.length) {
        if (state.stopped || stdin.destroyed) return
        if (!stdin.write(queue.shift())) {
          await new Promise(resolve => {
            const done = () => {
              stdin.off('drain', done)
              stdin.off('close', done)
              resolve()
            }
            stdin.once('drain', done)
            stdin.once('close', done)
          })
        }
      }
      if (finished && !queue.length) break
      if (!signalled && !queue.length) {
        await new Promise(resolve => {
          state.wake = resolve
        })
      }
    }
    try {
      stdin.end()
    } catch {}
  }

  download()
    .catch(err => {
      state.relayFailure = err
    })
    .finally(() => {
      finished = true
      notify()
    })
  write().catch(() => {})
}

export function openOpus(input, { volume = 1, seekMs = 0, userAgent = null, bitrate = null } = {}) {
  const remote = /^https?:\/\//i.test(input)
  const state = { stopped: false, proc: null, abort: null, wake: null, relayFailure: null, failure: null, stderr: '' }
  let markClosed = null
  const closed = new Promise(resolve => {
    markClosed = resolve
  })

  const launch = relay => {
    const args = buildArgs({ input, relay: !!relay, remote, userAgent, seekMs, volume, bitrate })
    const proc = spawn('ffmpeg', args, { stdio: [relay ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    state.proc = proc
    try {
      if (proc.pid) os.setPriority(proc.pid, 5)
    } catch {}
    proc.stderr.on('data', chunk => {
      state.stderr = (state.stderr + chunk).slice(-1500)
    })
    proc.once('close', code => markClosed(code))
    proc.once('error', err => {
      state.failure = err
      markClosed(-1)
    })
    if (relay) feedRelay(relay, proc, state, input, userAgent)
  }

  async function* packets() {
    const relay = remote && userAgent && useRelay() ? await openRelay(input, userAgent, state) : null
    if (state.stopped) {
      markClosed(0)
      return
    }
    launch(relay)
    yield* demux(state.proc.stdout, closed, () => state.failure, () => state.stderr)
    if (state.relayFailure && !state.stopped) throw state.relayFailure
  }

  return {
    packets: packets(),
    kill() {
      state.stopped = true
      try {
        state.abort?.abort()
      } catch {}
      const wake = state.wake
      state.wake = null
      wake?.()
      const proc = state.proc
      if (proc && proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL')
    }
  }
}

async function* demux(stream, closed, failure, stderr) {
  let buf = Buffer.alloc(0)
  let parts = []
  let index = 0
  for await (const chunk of stream) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk
    while (buf.length >= 27) {
      if (buf.toString('latin1', 0, 4) !== 'OggS') throw new Error('Invalid Ogg data from ffmpeg')
      const segments = buf[26]
      if (buf.length < 27 + segments) break
      let size = 0
      for (let i = 0; i < segments; i++) size += buf[27 + i]
      const total = 27 + segments + size
      if (buf.length < total) break
      let pos = 27 + segments
      for (let i = 0; i < segments; i++) {
        const len = buf[27 + i]
        parts.push(buf.subarray(pos, pos + len))
        pos += len
        if (len < 255) {
          const packet = parts.length === 1 ? parts[0] : Buffer.concat(parts)
          parts = []
          if (index++ >= 2) yield packet
        }
      }
      buf = buf.subarray(total)
    }
  }
  const code = await closed
  if (failure()) throw failure()
  if (code) throw new Error(stderr().trim() || `ffmpeg exited with code ${code}`)
}
