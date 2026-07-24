let handler = async (m, { conn, text, command }) => {
  var alphabet = {
    'ᔑ': 'A', 'ʖ': 'B', 'ᓵ': 'C', '､̶': 'D', 'ᒷ': 'E', '⎓': 'F', '⊣': 'G', '⍑': 'H', '╎': 'I', '⋮': 'J',
    'ꖌ': 'K', 'ꖎ': 'L', 'ᒲ': 'M', '·ﾉ': 'N', '㇇': 'O', '!¡': 'P', 'ᑑ': 'Q', '∷': 'R', 'ᓭ': 'S', 'ℸ ̣': 'T',
    '⚍': 'U', '⍊': 'V', '∴': 'W', ' ̇/': 'X', 'II': 'Y', '⨅': 'Z', ' ': '    ',
  };
  async function translateTo(text) {
    return text.toUpperCase().split('').map((char) => {
      if (char === ' ') return '    ';
      return Object.keys(alphabet).find(key => alphabet[key] === char);
    }).join(' ');
  }
  if (!text) return conn.sendFooter(m.chat, `> *How To Use:*\n\`\/${command} <function>\``, `> *• Function List*\n- [ \`-alphabet\`  or  \`-dictionary\` ]\n- [ \`to|<your_text>\` ]`)
  let [ func, tex ] = text.split`|`
  if (text == "-alphabet" || text == "-dictionary") {
    var result = `> *\`ENCHANTMENT TABLE LANGUAGE\`*\n- \`ᔑ\`: A\n- \`ʖ\`: B\n- \`ᓵ\`: C\n- \`､̶\`: D\n- \`ᒷ\`: E\n- \`⎓\`: F\n- \`⊣\`: G\n- \`⍑\`: H\n- \`╎\`: I\n- \`⋮\`: J\n- \`ꖌ\`: K\n- \`ꖎ\`: L\n- \`ᒲ\`: M\n- \`·ﾉ\`: N\n- \`㇇\`: O\n- \`!¡\`: P\n- \`ᑑ\`: Q\n- \`∷\`: R\n- \`ᓭ\`: S\n- \`ℸ ̣\`: T\n- \`⚍\`: U\n- \`⍊\`: V\n- \`∴\`: W\n- \`·/\`: X\n- \`||\`: Y\n- \`⨅\`: Z`
    m.reply(result)
  }
  if (/to/.test(func)) {
    var result = await translateTo(tex)
    m.reply(result)
  }
}
handler.help = ['enchantmenttable']
handler.tags = ['tools']
handler.command = /^(enchantmenttable|et)$/i
export default handler
