import { canvas } from 'hiro/canvas';
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function listOf(items) {
    return items.reduce((text, item, index) => (index ? `${text}, ${item}` : item), '') || '-';
}

function typeNameOf(item) {
    return item.type ? item.type.charAt(0).toUpperCase() + item.type.slice(1) : 'Account';
}

function buildInfo(user, source) {
    return {
        id: user.id,
        name: user.name,
        username: user.username,
        bot: user.bot,
        created: new Date(Number((BigInt(user.id) >> 22n) + 1420070400000n)).toISOString().split('T')[0],
        source,
        badges: global.scraper.discordstalk.badgesOf(user.publicFlags, user.bot, user.premiumType, user.primaryGuild, user.profileBadges),
        pronouns: user.pronouns,
        bio: user.bio,
        connections: user.connections,
        bannerColor: user.bannerColor,
        avatarUrl: user.avatar ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=512` : `https://cdn.discordapp.com/embed/avatars/${user.discriminator && user.discriminator !== '0' ? Number(user.discriminator) % 5 : Number((BigInt(user.id) >> 22n) % 6n)}.png`,
        bannerUrl: user.banner ? `https://cdn.discordapp.com/banners/${user.id}/${user.banner}.png?size=600` : null,
        decorationUrl: user.decoration ? `https://cdn.discordapp.com/avatar-decoration-presets/${user.decoration}.png?size=512` : null
    };
}

function buildCaption(info) {
    return `${info.username ? `*@${info.username}*` : `*${info.name}*`}${info.bot ? ' (bot)' : ''}
- *Name:* ${info.name}${info.pronouns ? `
- *Pronouns:* ${info.pronouns}` : ''}
- *ID:* ${info.id}
- *Created:* ${info.created}
- *Badges:* ${listOf(info.badges.map(badge => badge.label))}
- *Connections:* ${listOf(info.connections.map(item => `${typeNameOf(item)}: ${item.name}`))}
- *Bio:* ${info.bio || '-'}${info.source === 'none' ? '\nNo data available' : ''}`;
}

function buildCardHtml(info, images) {
    return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
html,body{width:800px;height:480px;background:#0d0e14;font-family:'DejaVu Sans',sans-serif;color:#fff}
.card{position:relative;width:800px;height:480px;overflow:hidden;background:#0d0e14}
.banner{position:absolute;left:0;top:0;width:800px;height:210px;object-fit:cover}
.bannerFill{position:absolute;left:0;top:0;width:800px;height:210px;background:linear-gradient(120deg,#3a3f5c,#1b1d2b)}
.head{position:absolute;left:40px;top:124px;width:720px;height:170px;display:flex;align-items:flex-end}
.avatarBox{position:relative;width:170px;height:170px;flex:none}
.avatar{width:170px;height:170px;border-radius:50%;object-fit:cover;border:6px solid #0d0e14;background:#2b2f40}
.initial{display:flex;align-items:center;justify-content:center;font-size:80px;font-weight:700}
.deco{position:absolute;left:-35px;top:-35px;width:240px;height:240px}
.names{margin-left:48px;padding-bottom:10px;min-width:0}
.name{font-size:38px;font-weight:700;white-space:nowrap;overflow:hidden}
.user{font-size:20px;color:#a0a6b8;margin-top:4px}
.body{position:absolute;left:40px;top:326px;width:720px;height:152px;display:flex}
.colA{width:380px;height:152px;overflow:hidden;display:flex;flex-direction:column}
.colB{flex:1;height:152px;overflow:hidden;margin-left:30px;display:flex;flex-direction:column}
.pills{display:flex;flex-wrap:wrap;gap:6px}
.icons{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.chip{width:32px;height:32px;display:flex;align-items:center;justify-content:center;border-radius:8px;background:rgba(255,255,255,.08)}
.chip img{width:22px;height:22px;object-fit:contain}
.chip.wide{width:auto;padding:0 8px;gap:6px}
.tag{font-size:14px;color:#e5e7ef;white-space:nowrap}
.pill{display:flex;align-items:center;gap:6px;font-size:13px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.14);white-space:nowrap;overflow:hidden}
.label{font-size:12px;letter-spacing:3px;color:#8b90a3;margin-top:4px;margin-bottom:4px}
.bio{font-size:16px;color:#c4c9d6;margin-top:8px;max-height:60px;overflow:hidden}
.muted{font-size:14px;color:#8b90a3}
.meta{position:absolute;right:14px;top:14px;padding:4px 10px;border-radius:8px;background:rgba(0,0,0,.5);font-size:13px;color:#e5e7ef}
</style></head><body><div class="card">
${images.banner ? `<img class="banner" src="${images.banner}">` : `<div class="bannerFill" style="background:${info.bannerColor || '#2a2d3d'}"></div>`}
<div class="head">
<div class="avatarBox">
${images.avatar ? `<img class="avatar" src="${images.avatar}">` : `<div class="avatar initial">${esc(info.name.charAt(0).toUpperCase())}</div>`}
${images.decoration ? `<img class="deco" src="${images.decoration}">` : ''}
</div>
<div class="names"><div class="name">${esc(info.name)}</div><div class="user">${info.username ? `@${esc(info.username)}` : ''}${info.pronouns ? ` · ${esc(info.pronouns)}` : ''}${info.bot ? ' · BOT' : ''}</div></div>
</div>
<div class="body">
<div class="colA">
<div class="label">BADGES</div>
<div class="icons">${info.badges.reduce((html, badge, index) => (images.badges[index] || badge.tag ? `${html}<span class="chip${badge.tag ? ' wide' : ''}">${images.badges[index] ? `<img src="${images.badges[index]}">` : ''}${badge.tag ? `<span class="tag">${esc(badge.tag)}</span>` : ''}</span>` : html), '') || '<span class="muted">-</span>'}</div>
</div>
<div class="colB">
<div class="label">CONNECTIONS</div>
<div class="pills">${info.connections.slice(0, 4).reduce((html, item) => `${html}<span class="pill">${esc(typeNameOf(item))}: ${esc(item.name)}</span>`, '') || '<span class="muted">-</span>'}${info.connections.length > 4 ? `<span class="pill">+${info.connections.length - 4}</span>` : ''}</div>
${info.bio ? `<div class="bio">${esc(info.bio)}</div>` : ''}
${info.source === 'none' ? '<div class="muted">No data available</div>' : ''}
</div>
</div>
<div class="meta">ID ${esc(info.id)} · Created ${info.created}</div>
</div></body></html>`;
}

async function renderCard(info) {
    return (await canvas.html(buildCardHtml(info, { banner: await global.scraper.discordstalk.imageDataUri(info.bannerUrl), avatar: await global.scraper.discordstalk.imageDataUri(info.avatarUrl), decoration: await global.scraper.discordstalk.imageDataUri(info.decorationUrl), badges: await Promise.all(info.badges.map(badge => global.scraper.discordstalk.imageDataUri(badge.url))) }), { width: 800, height: 480, scale: 1, transparent: false, background: '#0d0e14', allowNetwork: false })).toBuffer('image/png');
}

let handler = async (m, { conn, text, args, usedPrefix, command, platform }) => {
    const input = String((platform === 'discord' ? args.id || text : text) || '').trim();
    if (!input) return m.reply(`Enter a Discord User ID or mention.\nExample: ${usedPrefix}${command} 123456789012345678`);

    const id = global.scraper.discordstalk.idFrom(input) || await global.scraper.discordstalk.lookupUsername(input);
    if (!id) return m.reply(`User "${input}" not found.`);

    const resolved = await global.scraper.discordstalk.resolveProfile(id);
    const info = buildInfo(global.scraper.discordstalk.userOf(resolved.raw), resolved.source);
    const image = await renderCard(info).catch(() => null);
    if (!image) return m.reply('Failed to render the profile card.');

    const caption = buildCaption(info);
    if (platform === 'discord') return m.reply({ content: caption, files: [{ attachment: image, name: `discord-${id}.png` }] });
    return conn.sendMessage(m.chat, { image, caption }, { quoted: m });
};

handler.help = [
    ...['discordstalk', 'dcstalk'].map(name => `${name} <id>`),
    { command: 'discordstalk', name: 'id', description: 'Discord User ID, mention, or username', type: 'string', required: true }
]
handler.tags = ['internet'];
handler.command = ['discordstalk', 'dcstalk'];
handler.description = 'Look up a Discord user by ID or username with profile card, banner, badges and connections';
handler.ai = { risk: 'low', description: 'look up a Discord user profile by user ID' };

handler.platform = { whatsapp: true, discord: true };

export default handler;
