

import path from 'path'
import fs from 'fs'
import loadVoip from './voip.js'

const AUTH_DIR = process.env.VOIP_AUTH_DIR || 'data/sessions/caller'

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
    const alreadyLinked = fs.existsSync(path.join(AUTH_DIR, 'creds.json'))

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

async function runCall({ phoneNumber, audioSource, durationMs }) {
  if (!phoneNumber) {
    send({ type: 'error', message: 'No phone number provided to worker.' })
    process.exit(1)
  }

  let client
  try {
    const { VoipClient } = await loadVoip()

    if (!fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
      send({ type: 'error', message: 'VOIP device not linked yet. Run `.voippair` first.' })
      process.exit(1)
    }

    client = new VoipClient({ authDir: AUTH_DIR })

    await client.connect()
    send({ type: 'connected' })

    const call = await client.call(phoneNumber, {
      audioSource,
      ...(durationMs ? { durationMs } : {})
    })

    send({ type: 'call_created', callId: call.callId })

    call.on('ringing', () => send({ type: 'ringing' }))
    call.on('connected', () => send({ type: 'call_connected' }))
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
        try { await call.end() } catch (e) {
          send({ type: 'error', message: `hangup failed: ${e?.message || e}` })
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
  setTimeout(() => {
    send({ type: 'error', message: `Worker safety timeout after ${timeoutMs / 1000}s — no terminal event fired.` })
    process.exit(1)
  }, timeoutMs)

  if (params.mode === 'pair') {
    await runPairOnly(params)
  } else {
    await runCall(params)
  }
}

main()
