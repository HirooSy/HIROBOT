import fetch from 'node-fetch'

let handler = m => m
handler.all = async function (m) {
    
  global.img = {
    profile: {
      bot: await this.profilePictureUrl(this.user.jid, 'image').catch(_ => 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg'),
      sender: await this.profilePictureUrl(m.sender, 'image').catch(_ => 'https://telegra.ph/file/6193ccec6606cf0cc8b70.jpg'),
    }
  }

}

export default handler
