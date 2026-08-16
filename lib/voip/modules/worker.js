
import path from 'path'
import fs from 'fs'
import { DatabaseSync } from 'node:sqlite'
import loadVoip from '../voip.js'

const AUTH_DIR = process.env.VOIP_AUTH_DIR || 'data/sessions/caller.db'

function isAlreadyLinked(dbPath) {
  if (!fs.existsSync(dbPath)) return false
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const row = db.prepare('SELECT data FROM creds WHERE id = 1').get()
    db.close()
    if (!row) return false
    const creds = JSON.parse(row.data)
    return !!creds?.registered
  } catch {
    return false
  }
}

function send(msg) {
  if (process.send) process.send(msg)
}

process.on('uncaughtException', (err) => {
  send({ type: 'error', message: `uncaughtException: ${err?.message || err}` })
  process.exit(1)
})
process.on('unhandledRejection', (err) => {
  send({ type: 'error', message: `unhandledRejection: ${err?.message || err}` })
  process.exit(1)
})

async function runPairOnly({ pairingNumber, customPairingCode }) {
  let client
  try {
    const { VoipClient } = await loadVoip()
    const alreadyLinked = isAlreadyLinked(AUTH_DIR)

    if (alreadyLinked) {
      send({ type: 'already_linked' })
      process.exit(0)
    }

    client = new VoipClient({ authDir: AUTH_DIR, pairingCode: pairingNumber, customPairingCode })
    send({ type: 'pairing_needed', pairingNumber, customPairingCode })

    await client.connect()
    send({ type: 'paired' })
    try { client.disconnect() } catch {}
    process.exit(0)
  } catch (e) {
    send({ type: 'error', message: e?.message || String(e) })
    try { client?.disconnect() } catch {}
    process.exit(1)
  }
}

async function runCall({ phoneNumber, audioSource, videoSource, durationMs, isVideo }) {
  if (!phoneNumber) {
    send({ type: 'error', message: 'No phone number provided to worker.' })
    process.exit(1)
  }

  let client
  try {
    const { VoipClient } = await loadVoip()

    if (!isAlreadyLinked(AUTH_DIR)) {
      send({ type: 'error', message: 'VOIP device not linked yet. Run `.voippair` first.' })
      process.exit(1)
    }

    client = new VoipClient({ authDir: AUTH_DIR })

    await client.connect()
    send({ type: 'connected' })

    const call = await client.call(phoneNumber, {
      audioSource,
      ...(videoSource ? { videoSource } : {}),
      ...(durationMs ? { durationMs } : {}),
      ...(isVideo ? { isVideo: true } : {})
    })

    send({ type: 'call_created', callId: call.callId })

    call.on('ringing', () => send({ type: 'ringing' }))
    call.on('connected', () => {
      send({ type: 'call_connected' })

      global.__voipRescheduleSafetyTimer?.((durationMs ?? 120_000) + 30_000)
    })
    call.on('ended', (reason) => {
      send({ type: 'ended', reason })

      try { client.disconnect() } catch {}
      process.exit(0)
    })
    call.on('error', (err) => {
      send({ type: 'error', message: err?.message || String(err) })
      try { client.disconnect() } catch {}
      process.exit(1)
    })

    process.on('message', async (msg) => {
      if (msg?.type === 'hangup') {

        try {
          await Promise.race([
            call.end(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('call.end() timed out after 10s (connection likely unstable)')), 10_000)),
          ])
        } catch (e) {
          send({ type: 'error', message: `hangup failed: ${e?.message || e}` })
          try { client.disconnect() } catch {}
          process.exit(1)
        }
      }
    })
  } catch (e) {
    send({ type: 'error', message: e?.message || String(e) })
    try { client?.disconnect() } catch {}
    process.exit(1)
  }
}

async function main() {
  const params = JSON.parse(process.env.VOIP_CALL_PARAMS || '{}')

  const timeoutMs = params.mode === 'pair' ? 120_000 : 90_000
  let safetyTimer = setTimeout(() => {
    send({ type: 'error', message: `Worker safety timeout after ${timeoutMs / 1000}s — no terminal event fired.` })
    process.exit(1)
  }, timeoutMs)
  global.__voipRescheduleSafetyTimer = (ms) => {
    clearTimeout(safetyTimer)
    safetyTimer = setTimeout(() => {
      send({ type: 'error', message: `Worker safety timeout after ${ms / 1000}s post-connect — no terminal event fired.` })
      process.exit(1)
    }, ms)
  }

  if (params.mode === 'pair') {
    await runPairOnly(params)
  } else {
    await runCall(params)
  }
}

main()
