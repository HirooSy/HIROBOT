import fetch from 'node-fetch';
import { getDevice } from 'baileys';

let handler = async (m, { conn, command, isPrems, isOwner }) => {
    let user = db.data.users[m.sender];
    let limit = isOwner ? "♾ " + user.limit : isPrems ? '♾ ' + user.limit : user.limit;
    let tierUp = user.level >= (global.tierAsset.name).length + 1 ? "MAX !" : user.exp > global.tierAsset.exp[user.level + 1] ? "UPGRADE !" : `${(user.exp).toSimpleNumber()} / ${(global.tierAsset.exp[user.level + 1]).toSimpleNumber()}`;
     
      let text = `- \`Name :\` ${user.name}
- \`Status :\` ${isOwner ? 'Owner' : isPrems ? 'Premium User' : 'User'}
- \`Registered :\` ${user.registered}
- \`Device :\` ${getDevice(m.id)}
- \`Limit :\` ${limit}
- \`Exp :\` ${(user.exp).toSimpleNumber()}
- \`Tier :\` ${global.tierAsset.name[user.level]}`

conn.sendUrlPreview(m.chat, await conn.resize(img.profile.sender, 500, 500), `${getServerUrl()}\n${text}`, 'P R O F I L E', '↓ More Info:', 4, m)
    
}

handler.dym = handler.help = handler.command = ["profile"]
handler.tags = ['main']
export default handler
