let handler = async (m, { conn, text, command, usedPrefix }) => {
  function formatDate(n, locale = 'id') {
    let d = new Date(n)
    return d.toLocaleDateString(locale, { timeZone: 'Asia/Jakarta' }) 
  }
  var regex = /x/g
  if (!text) throw 'Masukkan nomor\nContoh .nowa 62856433540xx'
  if (!text.match(regex)) throw `Contoh: ${usedPrefix + command} ${m.sender.split('@')[0]}x`
  m.reply('> Process within 2 minutes')
  var random = text.match(regex).length, total = Math.pow(10, random), array = []
  for (var i = 0; i < total; i++) {
    var list = [...i.toString().padStart(random, '0')]
    var result = text.replace(regex, () => list.shift()) + '@s.whatsapp.net'
    if (await conn.onWhatsApp(result).then(v => (v[0] || {}).exists)) {
      var info = await conn.fetchStatus(result).catch(_ => {})
      array.push({ exists: true, jid: result, ...info })
    } else { array.push({ exists: false, jid: result }) }
  }
  var txt = '─────• Registered •─────\n\n' + array.filter(v => v.exists).map(v => `┍ *No:* wa.me/${v.jid.split('@')[0]}\n  | *Bio:* ${v.status || 'tidak ada bio'}\n┕ *Date:* ${formatDate(v.setAt) || ''}`).join('\n\n') + '\n\n─────• Unregister •─────\n' + array.filter(v => !v.exists).map(v => '· ' + v.jid.split('@')[0]).join('\n')
  m.reply(txt)
}
handler.help = ['nowhatsapp <number>']
handler.tags = ['tools']
handler.command = /^(now(a|hatsapp))$/i
export default handler
