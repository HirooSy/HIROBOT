import axios from 'hiro/axios';
import { Rest } from '../../package/discord/rest.js';

function idFrom(input) {
    const text = String(input || '').trim();
    const match = text.match(/^<@!?(\d{17,20})>$/) || text.match(/discord\.com\/users\/(\d{17,20})/) || text.match(/^(\d{17,20})$/);
    return match ? match[1] : null;
}

function usernameFrom(input) {
    const name = String(input || '').trim().replace(/^@/, '').replace(/#\d{4}$/, '').toLowerCase();
    return /^[a-z0-9._]{2,32}$/.test(name) ? name : null;
}

function pickUser(users, username) {
    return users.find(user => String(user?.username || '').toLowerCase() === username)
        || users.find(user => String(user?.global_name || '').toLowerCase() === username)
        || null;
}

async function fetchBotUser(id) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    try {
        const rest = new Rest();
        rest.token = token;
        const user = await rest.get(`/users/${id}`);
        return user?.id ? user : null;
    } catch {
        return null;
    }
}

async function fetchBotProfile(id) {
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    try {
        const rest = new Rest();
        rest.token = token;
        return await rest.get(`/users/${id}/profile`);
    } catch {
        return null;
    }
}

function profileFieldsOf(profile) {
    if (!profile?.user?.id) return {};
    return {
        bio: profile.user_profile?.bio || null,
        pronouns: profile.user_profile?.pronouns || null,
        connections: Array.isArray(profile.connected_accounts) ? profile.connected_accounts : [],
        profileBadges: Array.isArray(profile.badges) ? profile.badges : null
    };
}

async function searchGuild(rest, guildId, username) {
    try {
        return pickUser(((await rest.get(`/guilds/${guildId}/members/search`, { query: { query: username, limit: 25 } })) || []).map(member => member.user), username)?.id || null;
    } catch {
        return null;
    }
}

async function lookupUsername(input) {
    const username = usernameFrom(input);
    if (!username) return null;
    const login = pickUser(Object.values(global.db?.data?.discordProfiles || {}), username);
    if (login) return login.id;
    const token = process.env.DISCORD_TOKEN;
    if (!token) return null;
    try {
        const rest = new Rest();
        rest.token = token;
        for (const guild of (((await rest.get('/users/@me/guilds', { query: { limit: 200 } })) || []).slice(0, 25))) {
            const found = await searchGuild(rest, guild.id, username);
            if (found) return found;
        }
    } catch {
        return null;
    }
    return null;
}

async function resolveProfile(id) {
    const login = global.db?.data?.discordProfiles?.[id];
    if (login) return { source: 'login', raw: login };
    const bot = await fetchBotUser(id);
    if (bot) return { source: 'token', raw: { ...bot, ...profileFieldsOf(await fetchBotProfile(id)) } };
    return { source: 'none', raw: { id } };
}

async function imageDataUri(url) {
    if (!url) return null;
    try {
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 8000 });
        return `data:${String(response.headers['content-type'] || 'image/png').split(';')[0]};base64,${Buffer.from(response.data).toString('base64')}`;
    } catch {
        return null;
    }
}

function userOf(raw) {
    return {
        id: String(raw.id),
        username: raw.username || '',
        discriminator: raw.discriminator || '0',
        name: raw.global_name || raw.username || 'Unknown user',
        bot: !!raw.bot,
        avatar: raw.avatar || null,
        banner: raw.banner || null,
        bannerColor: raw.banner_color || null,
        decoration: raw.avatar_decoration_data?.asset || null,
        publicFlags: Number(raw.public_flags) || 0,
        premiumType: Number(raw.premium_type) || 0,
        primaryGuild: raw.primary_guild?.identity_enabled === false || !raw.primary_guild?.tag ? null : { tag: raw.primary_guild.tag, badge: raw.primary_guild.badge || null, guildId: raw.primary_guild.identity_guild_id || null },
        bio: raw.bio || null,
        pronouns: raw.pronouns || null,
        profileBadges: Array.isArray(raw.profileBadges) ? raw.profileBadges : null,
        connections: Array.isArray(raw.connections) ? raw.connections : []
    };
}

function badgeHashOf(key) {
    return ({ STAFF: '5e74e9b61934fc1f67c65515d1f7e60d', PARTNER: '3f9748e53446a137a052f3454e2de41e', CERTIFIED_MODERATOR: 'fee1624003e2fee35cb398e125dc479b', HYPESQUAD_EVENTS: 'bf01d1073931f921909045f3a39fd264', HYPESQUAD_HOUSE_BRAVERY: '8a88d63823d8a71cd5e390baa45efa02', HYPESQUAD_HOUSE_BRILLIANCE: '011940fd013da3f7fb926e4a1cd2e618', HYPESQUAD_HOUSE_BALANCE: '3aa41de486fa12454c3761e8e223442e', BUG_HUNTER_LVL1: '2717692c7dca7289b35297368a940dd0', BUG_HUNTER_LVL2: '848f79194d4be5ff5f81505cbd0ce1e6', ACTIVE_DEVELOPER: '6bdc42827a38498929a4920da12695d9', VERIFIED_DEVELOPER: '6df5892e0f35b051f8b61eace34f4967', EARLY_SUPPORTER: '7060786766c9c840eb3019e725d2b358', PREMIUM: '2ba85e8026a8614b640c2837bcdfe21b', USES_AUTO_MOD: 'f2459b691ac7453ed6039bbcfaccbfcd', SUPPORTS_SLASH_COMMANDS: '6f9e37f9029ff57aef81db857890005e' })[key];
}

function iconUrlOf(key) {
    return `https://cdn.discordapp.com/badge-icons/${badgeHashOf(key)}.png`;
}

function badgesOf(flags, bot, premiumType, clan, profileBadges) {
    const list = profileBadges?.length
        ? profileBadges.map(badge => ({ key: badge.id, label: badge.description || badge.id, url: badge.icon ? `https://cdn.discordapp.com/badge-icons/${badge.icon}.png` : null }))
        : (bot
            ? [[1 << 23, 'SUPPORTS_SLASH_COMMANDS', 'Supports Slash Commands'], [1 << 6, 'USES_AUTO_MOD', 'Uses AutoMod']]
            : [[1 << 0, 'STAFF', 'Staff'], [1 << 1, 'PARTNER', 'Partner'], [1 << 18, 'CERTIFIED_MODERATOR', 'Certified Moderator'], [1 << 2, 'HYPESQUAD_EVENTS', 'HypeSquad Events'], [1 << 6, 'HYPESQUAD_HOUSE_BRAVERY', 'HypeSquad Bravery'], [1 << 7, 'HYPESQUAD_HOUSE_BRILLIANCE', 'HypeSquad Brilliance'], [1 << 8, 'HYPESQUAD_HOUSE_BALANCE', 'HypeSquad Balance'], [1 << 3, 'BUG_HUNTER_LVL1', 'Bug Hunter'], [1 << 14, 'BUG_HUNTER_LVL2', 'Bug Hunter Level 2'], [1 << 22, 'ACTIVE_DEVELOPER', 'Active Developer'], [1 << 17, 'VERIFIED_DEVELOPER', 'Early Verified Developer'], [1 << 9, 'EARLY_SUPPORTER', 'Early Supporter']])
            .filter(([bit]) => flags & bit)
            .map(([, key, label]) => ({ key, label, url: iconUrlOf(key) }));
    if (premiumType && !profileBadges?.length) list.push({ key: 'PREMIUM', label: 'Nitro', url: iconUrlOf('PREMIUM') });
    if (clan) list.push({ key: 'CLAN', label: `Clan ${clan.tag}`, tag: clan.tag, url: clan.badge ? `https://cdn.discordapp.com/clan-badges/${clan.guildId}/${clan.badge}.png` : null });
    return list;
}

export { idFrom, lookupUsername, resolveProfile, imageDataUri, userOf, badgesOf }
