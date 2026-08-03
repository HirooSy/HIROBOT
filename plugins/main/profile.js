import { getDevice } from 'baileys';

let handler = async (m, { conn, command, isPrems, isOwner }) => {
    let user = db.data.users[m.sender];
    if (!user) return m.reply("Profil tidak ditemukan.");
    
    // Helper untuk format angka (k, M, B, T, Q)
    let toSimple = (n) => {
        n = n || 0;
        if (n >= 1e15) return (n / 1e15).toFixed(1).replace(/\.0$/, '') + 'Q';
        if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
        if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
        if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
        if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
        return n.toString();
    };

    let limit = isOwner ? "♾ " + user.limit : isPrems ? '♾ ' + user.limit : user.limit;
    
    let requiredExp = global.settings.tier.exp_required[user.level + 1] || user.exp;
    let tierUp = user.level >= (global.settings.tier.name).length + 1 ? "MAX !" : user.exp > requiredExp ? "UPGRADE !" : `${toSimple(user.exp)} / ${toSimple(requiredExp)}`;

      let text = `- \`Name :\` ${user.name}
- \`Status :\` ${isOwner ? 'Owner' : isPrems ? 'Premium User' : 'User'}
- \`Registered :\` ${user.registered}
- \`Device :\` ${getDevice(m.id)}
- \`Limit :\` ${limit}
- \`Exp :\` ${toSimple(user.exp)}
- \`Tier :\` ${global.settings.tier.name[user.level]}`

conn.sendButton(m.chat, {
    location: {
        buffer: img.profile.sender,
        name: 'P R O F I L E',
        address: '',
        url: `${getServerUrl()}`,
    },
    text,
    footer: '',
    nativeFlow: [
        { text: 'More Info', url: `${getServerUrl()}`, useWebview: false },
    ],
}, m)

}

handler.help = handler.command = ["profile"]
handler.tags = ['main']
handler.ai = { risk: 'low', summarize: false, description: "Check profile user" }
export default handler