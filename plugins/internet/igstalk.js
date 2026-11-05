const { igStalk } = global.scraper.igstalk

const maxSelectRows = 10
const captionPreviewLength = 72

const valueOrDash = value => (value === null || value === undefined || value === '' ? '-' : value)

const shorten = (text, length) => (text.length > length ? `${text.slice(0, length - 3)}...` : text)

const previewOf = post => (post.caption
    ? shorten(post.caption.replace(/\s+/g, ' ').trim(), captionPreviewLength)
    : '(no caption)')

const visiblePosts = recentPosts => recentPosts.items.slice(0, maxSelectRows)

const recentSection = (user, recentPosts) => {
    if (user.is_private) return '\n\nThis account is private, recent posts are hidden.'
    if (!recentPosts.items.length) return ''
    return visiblePosts(recentPosts).reduce(
        (section, post, index) => `${section}\n${index + 1}. ${post.type} - ${previewOf(post)}`,
        '\n\n*Recent posts:*'
    )
}

const buildCaption = (user, recentPosts) => `*@${user.username}*
- *Name:* ${valueOrDash(user.full_name)}
- *Verified:* ${user.is_verified ? 'Yes' : 'No'}
- *Private:* ${user.is_private ? 'Yes' : 'No'}

- *Followers:* ${valueOrDash(user.stats.followers)}
- *Following:* ${valueOrDash(user.stats.following)}
- *Posts:* ${valueOrDash(user.stats.posts)}

- *Bio:* ${valueOrDash(user.biography)}
- *Link:* ${valueOrDash(user.external_url)}${recentSection(user, recentPosts)}`

const buildRows = (usedPrefix, recentPosts) => visiblePosts(recentPosts).map((post, index) => ({
    id: `${usedPrefix}ig ${post.url}`,
    title: `${index + 1}. ${post.type}`,
    description: previewOf(post)
}))

const fetchPicture = async url => {
    if (!url) return null
    try {
        const response = await fetch(url)
        if (!response.ok) return null
        return Buffer.from(await response.arrayBuffer())
    } catch {
        return null
    }
}

let handler = async (ctx, { conn, text, args, usedPrefix, command, platform }) => {
    const input = String((platform === 'discord' ? args.username || text : text) || '').trim()
    if (!input) return ctx.reply(`Enter an Instagram username or profile link.\nExample: ${usedPrefix}${command} jokowi`)

    const result = await igStalk(input)
    if (!result.status) return ctx.reply(result.message)

    const { user, recent_posts: recentPosts } = result.data
    const picture = await fetchPicture(user.profile_pic_url)
    if (!picture) return ctx.reply(`Failed to load the profile picture of @${user.username}.`)

    const fileName = `${user.username}`
    const rows = user.is_private ? [] : buildRows(usedPrefix, recentPosts)

    if (platform === 'discord') {
        return conn.discord(ctx.chat, {
            embed: conn.embed({
                title: `@${user.username}`,
                url: `https://www.instagram.com/${user.username}/`,
                image: { url: `attachment://${fileName}` },
                fields: [
                    { name: 'Name', value: shorten(valueOrDash(user.full_name), 1024), inline: true },
                    { name: 'Verified', value: user.is_verified ? 'Yes' : 'No', inline: true },
                    { name: 'Private', value: user.is_private ? 'Yes' : 'No', inline: true },
                    { name: 'Followers', value: valueOrDash(user.stats.followers), inline: true },
                    { name: 'Following', value: valueOrDash(user.stats.following), inline: true },
                    { name: 'Posts', value: valueOrDash(user.stats.posts), inline: true },
                    { name: 'Bio', value: shorten(valueOrDash(user.biography), 1024) },
                    { name: 'Link', value: shorten(valueOrDash(user.external_url), 1024) }
                ]
            }),
            files: [{ attachment: picture, name: fileName }],
            select: {
                placeholder: 'Select a post to download',
                options: rows.map(row => ({ label: row.title, description: row.description, action: row.id }))
            }
        })
    }

    const header = {
        document: user.profile_pic_url,
        mimetype: 'image/jpeg',
        fileName,
        jpegThumbnail: await conn.resize(picture, 100, 100).catch(() => undefined)
    }
    const caption = buildCaption(user, recentPosts)

    if (rows.length) {
        return conn.sendButton(ctx.chat, {
            ...header,
            text: caption,
            footer: 'Select a post to download it',
            nativeFlow: [{ text: 'Select post', sections: [{ title: 'Recent posts', rows }] }]
        }, ctx)
    }
    return conn.sendButton(ctx.chat, { ...header, text: caption }, ctx)
}

handler.help = [
    ...['igstalk', 'stalkig'].map(name => `${name} <username>`),
    { command: 'igstalk', name: 'username', description: 'Instagram username or profile link', type: 'string', required: true }
]
handler.tags = ['internet']
handler.command = ['igstalk', 'stalkig']
handler.description = 'Look up an Instagram profile and download its recent posts'
handler.ai = { risk: "low", description: "look up an Instagram profile and download its recent posts" }

handler.platform = { whatsapp: true, discord: true }

export default handler