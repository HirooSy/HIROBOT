// VoIP call worker — runs in its own child process (spawned via fork()).
//
// Why a separate process: the WASM engine + @roamhq/wrtc native binding
// leave a large RSS footprint (native memory, WASM linear memory, worker
// thread stacks) that Node's GC cannot reclaim even after VoipClient is
// fully disconnected. Running the call in an isolated child process means
// the parent bot process just kill()s this process when the call ends —
// the OS then force-reclaims 100% of that memory, no matter what layer
// (JS heap, native C++, or WASM) it lives in.
//
// This process uses its own linked device (separate session folder), since
// a single WhatsApp WebSocket + Noise Protocol session cannot be shared
// across OS processes.

import path from 'path'
import fs from 'fs'
import loadVoip from './voip.js'

const AUTH_DIR = process.env.VOIP_AUTH_DIR || 'data/sessions/caller'

function send(msg) {
  if (process.send) process.send(msg)
}

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
      // Exiting the process is what actually releases the native/WASM
      // memory — disconnect() alone (still called for protocol cleanliness)
      // is not enough, per earlier diagnostics.
      try { client.disconnect() } catch {}
      process.exit(0)
    })
    call.on('error', (err) => {
      send({ type: 'error', message: err?.message || String(err) })
      try { client.disconnect() } catch {}
      process.exit(1)
    })

    // Listen for a hangup request from the parent (.voipend).
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

  // Pairing gets a longer window (2 min) since the person needs time to
  // read the console and type the code by hand. Calls keep the shorter cap.
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
