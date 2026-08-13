/**
 * .testvideo <number> — quick diagnostic to check whether isVideo:true can
 * even negotiate a call at all. This does NOT send video frames — it only
 * tests whether the WASM signaling accepts/survives a video call offer.
 *
 * Three possible outcomes, all useful information:
 *   1. Call fails immediately at setup (isVideo rejected outright)
 *   2. Call connects but WhatsApp/WASM silently downgrades to audio-only
 *   3. Call connects, receiver sees "incoming video call" (blank/frozen —
 *      expected, since no frame sending exists yet)
 */

let handler = async (m, { conn, args, usedPrefix, command }) => {
  if (!args[0]) throw `Usage: ${usedPrefix + command} <phone_number>`

  const phoneNumber = args[0].replace(/\D/g, '')
  if (!phoneNumber) throw 'Invalid phone number.'

  const { key } = await m.reply(`✦ Testing video call signaling to ${phoneNumber}... (audio-only fallback, no video frames will be sent — check server console for details)`)

  try {
    const call = await conn.call(phoneNumber, 'silence', { isVideo: true })

    call.on('ringing', () => conn.sendMessage(m.chat, { text: '✦ Ringing (video offer sent)...', edit: key }))
    call.on('connected', () => conn.sendMessage(m.chat, { text: '✦ Connected! Check the receiving device: does it show a video call or audio call? Check server console for [ VOIP ] logs.', edit: key }))
    call.on('ended', (reason) => conn.sendMessage(m.chat, { text: `✦ Test call ended: ${reason}`, edit: key }))
    call.on('error', (err) => conn.reply(m.chat, `Test call error: ${err?.message || err}`, m))
  } catch (e) {
    console.error('[ TESTVIDEO ] call() threw:', e)
    throw `Video call test failed immediately: ${e?.message || e}`
  }
}

handler.help = ['testvideo <number> (diagnostic, no real video)']
handler.tags = ['owner']
handler.command = /^testvideo$/i
handler.rowner = true

export default handler
