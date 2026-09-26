import axios from 'axios'

const BASE_URL = "https://reaction-whatsapp.edgeone.dev"
const API_KEY = "9J88DPLJ"

const handler = async (m, { args }) => {
  const [link, emoji] = args

  if (!link || !emoji) {
    return m.reply("Penggunaan: .react <link> <emoji>")
  }

  try {
    m.reply("Sedang memproses reaksi...")
    const res = await axios.post(`${BASE_URL}/react`, {
      link,
      emoji
    }, {
      timeout: 60000,
      headers: {
        "Authorization": `Bearer ${API_KEY}`,
        "Content-Type": "application/json"
      }
    })

    if (res.status === 200) {
      m.reply(`Berhasil! Reaksi ${emoji} telah dikirim ke ${link}.`)
    } else {
      m.reply(`Gagal: ${JSON.stringify(res.data)}`)
    }
  } catch (error) {
    m.reply(`Error: ${error.message}`)
  }
}

handler.command = ['react']
handler.tags = ['tools']
handler.help = ['react <link> <emoji>']

export default handler
