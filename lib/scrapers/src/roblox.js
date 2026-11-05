import axios from 'hiro/axios'

async function request(url, method = 'GET', body = null) {
    try {
        return (await axios({
            method,
            url,
            timeout: 10000,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                'Accept': 'application/json'
            },
            ...(body ? { data: body } : {})
        })).data
    } catch {
        return null
    }
}

function formatPresence(type) {
    return ({ 0: 'Offline', 1: 'Online', 2: 'In Game', 3: 'In Studio' })[type] || 'Unknown'
}

async function usernameToId(username) {
    return (await request('https://users.roblox.com/v1/usernames/users', 'POST', { usernames: [String(username || '').trim().replace(/^@+/, '')], excludeBannedUsers: false }))?.data?.[0]?.id || null
}

function userInfo(userId) {
    return request(`https://users.roblox.com/v1/users/${userId}`)
}

async function userStatus(userId) {
    return (await request(`https://users.roblox.com/v1/users/${userId}/status`))?.status || null
}

async function userPresence(userId) {
    const presence = (await request('https://presence.roblox.com/v1/presence/users', 'POST', { userIds: [userId] }))?.userPresences?.[0]
    if (!presence) return null
    return { ...presence, userPresenceText: formatPresence(presence.userPresenceType) }
}

async function countOf(url) {
    return (await request(url))?.count || 0
}

async function thumbnailOf(kind, userId, size) {
    return (await request(`https://thumbnails.roblox.com/v1/users/${kind}?userIds=${userId}&size=${size}&format=Png&isCircular=false`))?.data?.[0]?.imageUrl || null
}

async function userGroups(userId) {
    return (await request(`https://groups.roblox.com/v1/users/${userId}/groups/roles`))?.data || []
}

function primaryGroup(userId) {
    return request(`https://groups.roblox.com/v1/users/${userId}/groups/primary/role`)
}

function resultOf(userId, [basic, status, presence, friends, followers, following, groups, primary, headshot, fullBody, bust]) {
    return {
        userId,
        basic,
        status,
        presence,
        social: { friends, followers, following },
        avatar: { headshot, fullBody, bust },
        groups: { primary, total: groups.length, list: groups },
        profileUrl: `https://www.roblox.com/users/${userId}/profile`
    }
}

export async function robloxStalk(username) {
    const userId = await usernameToId(username)
    if (!userId) return { status: false, message: `Roblox user "${username}" not found.` }
    return {
        status: true,
        data: resultOf(userId, await Promise.all([
            userInfo(userId),
            userStatus(userId),
            userPresence(userId),
            countOf(`https://friends.roblox.com/v1/users/${userId}/friends/count`),
            countOf(`https://friends.roblox.com/v1/users/${userId}/followers/count`),
            countOf(`https://friends.roblox.com/v1/users/${userId}/followings/count`),
            userGroups(userId),
            primaryGroup(userId),
            thumbnailOf('avatar-headshot', userId, '420x420'),
            thumbnailOf('avatar', userId, '720x720'),
            thumbnailOf('avatar-bust', userId, '420x420')
        ]))
    }
}

export default robloxStalk
