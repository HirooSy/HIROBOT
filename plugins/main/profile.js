import { getDevice } from 'baileys';
import axios from 'axios';
import { canvas } from '../../lib/utils/canvas.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const toSimple = (n) => {
    n = n || 0;
    if (n >= 1e15) return (n / 1e15).toFixed(1).replace(/\.0$/, '') + 'Q';
    if (n >= 1e12) return (n / 1e12).toFixed(1).replace(/\.0$/, '') + 'T';
    if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
    return n.toString();
};

const ICON = {
    dev: `<svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="#3ddc84" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="8 6 2 12 8 18"/><polyline points="16 6 22 12 16 18"/><line x1="14" y1="4" x2="10" y2="20"/></svg>`,
    premium: `<svg width="30" height="30" viewBox="0 0 24 24" fill="#ffffff"><path d="M12 1 L14.6 9.4 L23 12 L14.6 14.6 L12 23 L9.4 14.6 L1 12 L9.4 9.4 Z"/></svg>`
};

const SIZE = 714;

const getAvatar = async (url) => {
    if (!url || typeof url !== 'string') return null;
    try {
        let res = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
        let buf = Buffer.from(res.data);
        let type = String(res.headers['content-type'] || 'image/jpeg').split(';')[0];
        return `data:${type};base64,${buf.toString('base64')}`;
    } catch {
        return null;
    }
};

const buildHtml = ({ name, avatar, badges }) => {
    let letter = esc((name || '?').trim().charAt(0).toUpperCase() || '?');
    let photo = avatar
        ? `<img src="${avatar}" style="width:100%;height:100%;object-fit:cover;display:block">`
        : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;font:700 120px Poppins,Inter,'DejaVu Sans',sans-serif;color:#fff;background:linear-gradient(135deg,#3a3f5c,#1b1d2b)">${letter}</div>`;
    let icons = badges.length
        ? badges.map((b) => `<div class="b">${ICON[b]}</div>`).join('')
        : `<div class="none">-</div>`;
    let size = name.length > 14 ? 24 : name.length > 10 ? 30 : 36;
    return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${SIZE}px;height:${SIZE}px;background:#0d0e14;font-family:Poppins,Inter,'DejaVu Sans',sans-serif}
.wrap{width:${SIZE}px;height:${SIZE}px;display:flex;align-items:center;background:#0d0e14}
.card{width:${SIZE}px;height:${Math.round(SIZE * 7 / 12)}px;display:flex;overflow:hidden;background:#0d0e14}
.photo{width:280px;height:100%;flex:none;background:#1b1d2b}
.panel{flex:1;height:100%;padding:28px;display:flex;flex-direction:column;align-items:center;justify-content:center;background:linear-gradient(160deg,#171923 0%,#0d0e14 70%)}
.name{width:100%;text-align:center;font-weight:700;font-size:${size}px;letter-spacing:2px;color:#fff;text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.line{width:100%;height:1px;margin:22px 0 24px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.22),transparent)}
.label{font-size:13px;font-weight:600;letter-spacing:7px;color:#8b90a3;padding-left:7px}
.row{display:flex;gap:14px;margin-top:20px;justify-content:center;flex-wrap:wrap}
.b{width:58px;height:58px;border-radius:16px;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.12)}
.none{font-size:22px;color:#555a6e;margin-top:10px}
</style></head><body><div class="wrap"><div class="card"><div class="photo">${photo}</div><div class="panel"><div class="name">${esc(name)}</div><div class="line"></div><div class="label">BADGE</div><div class="row">${icons}</div></div></div></div></body></html>`;
};

let handler = async (m, { conn, isPrems, isOwner }) => {
    let user = db.data.users[m.sender];
    if (!user) return m.reply('Profile not found.');

    let limit = isOwner || isPrems ? '♾ ' + user.limit : user.limit;
    let tier = global.settings.tier;
    let requiredExp = tier[user.level + 1]?.expRequired || user.exp;
    let tierUp = user.level >= Object.keys(tier).length + 1 ? 'MAX !' : user.exp > requiredExp ? 'UPGRADE !' : `${toSimple(user.exp)} / ${toSimple(requiredExp)}`;

    let badges = [];
    if (isOwner || user.badge?.developer) badges.push('dev');
    if (isPrems || user.badge?.premium?.active) badges.push('premium');

    let name = user.name || m.pushName || 'User';
    let avatar = await getAvatar(global.img?.profile?.sender);
    let cv = await canvas.html(buildHtml({ name, avatar, badges }), { width: SIZE, height: SIZE, scale: 1, transparent: false });
    let image = await cv.toBuffer();

    let caption = `- \`Name :\` ${name}
- \`Status :\` ${isOwner ? 'Owner' : isPrems ? 'Premium User' : 'User'}
- \`Registered :\` ${user.registered}
- \`Device :\` ${getDevice(m.id)}
- \`Tier :\` ${tier[user.level]?.name}
- \`Exp :\` ${tierUp}
- \`Gem :\` ${toSimple(user.gems || 0)}
- \`Limit :\` ${limit}`;

    await conn.sendButton(m.chat, {
        location: { buffer: image, name: '', address: '', url: `${getServerUrl()}` },
        text: caption,
        footer: '',
        nativeFlow: [{ text: 'More Info', url: `${getServerUrl()}`, useWebview: false }]
    }, m);
};

handler.help = handler.command = ['profile'];
handler.tags = ['main'];
handler.ai = { risk: 'low', summarize: false, description: 'Check profile user' };

export default handler;