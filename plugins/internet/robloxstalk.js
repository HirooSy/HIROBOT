function descriptionOf(text) {
    const clean = String(text || '').trim();
    if (!clean) return '-';
    return clean.length > 200 ? `${clean.slice(0, 197)}...` : clean;
}

function presenceOf(presence) {
    if (!presence) return '-';
    return `${presence.userPresenceText}${presence.lastLocation ? ` (${presence.lastLocation})` : ''}`;
}

function buildCaption(data) {
    return `*${data.basic?.name || data.userId}*${data.basic?.hasVerifiedBadge ? ' (verified)' : ''}
- *Display name:* ${data.basic?.displayName || '-'}
- *User ID:* ${data.userId}
- *Created:* ${data.basic?.created ? data.basic.created.split('T')[0] : '-'}
- *Status:* ${data.status || '-'}
- *Presence:* ${presenceOf(data.presence)}
- *Friends:* ${data.social.friends} | *Followers:* ${data.social.followers} | *Following:* ${data.social.following}
- *Groups:* ${data.groups.total}${data.groups.primary ? ` (primary: ${data.groups.primary.group.name} - ${data.groups.primary.role.name})` : ''}
- *Description:* ${descriptionOf(data.basic?.description)}
- *Profile:* ${data.profileUrl}`;
}

let handler = async (m, { conn, text, args, usedPrefix, command, platform }) => {
    const input = String((platform === 'discord' ? args.username || text : text) || '').trim();
    if (!input) return m.reply(`Enter a Roblox username.\nExample: ${usedPrefix}${command} Roblox`);

    const result = await global.scraper.roblox.robloxStalk(input);
    if (!result?.status) return m.reply(result?.message || `Roblox user "${input}" not found.`);

    const headshot = result.data.avatar?.headshot || null;
    const caption = buildCaption(result.data);
    const title = `Roblox: ${result.data.basic?.displayName || result.data.basic?.name || result.data.userId}`;
    const description = `@${result.data.basic?.name || result.data.userId} · ${result.data.social.followers} followers`;

    if (platform === 'discord') {
        return m.reply({
            content: caption,
            embeds: headshot ? [conn.embed({ title, url: result.data.profileUrl, description, image: { url: headshot } })] : []
        });
    }

    if (!headshot) return m.reply(caption);
    try {
        return await conn.sendUrlPreview(m.chat, headshot, caption, title, description, ['IMAGE', true], m, { matchedText: result.data.profileUrl });
    } catch {
        return m.reply(caption);
    }
};

handler.help = [
    ...['robloxstalk', 'robstalk'].map(name => `${name} <username>`),
    { command: 'robloxstalk', name: 'username', description: 'Roblox username', type: 'string', required: true }
];
handler.tags = ['internet'];
handler.command = ['robloxstalk', 'robstalk'];
handler.description = 'Look up a Roblox user by username with profile, presence, social counts and groups';
handler.ai = { risk: 'low', description: 'look up a Roblox user profile by username' };

handler.platform = { whatsapp: true, discord: true };

export default handler;