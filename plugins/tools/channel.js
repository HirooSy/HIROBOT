import { getBinaryNodeChild, getBinaryNodeChildren, S_WHATSAPP_NET } from 'baileys'

const CHANNEL_LINK = /whatsapp\.com\/channel\/([A-Za-z0-9_-]+)/i
const NEWSLETTER_JID = /^\d+@newsletter$/
const POST_COUNT = 20
const QUERY = {
    FOLLOWERS: '27472091235714801',
    INSIGHTS: '9853618868050977',
}

const fmt = n => Number(n).toLocaleString('en-US')

function formatDate(seconds) {
    const t = Number(seconds)
    if (!t) return '-'
    return new Date(t * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'
}

async function resolveRole(conn, meta) {
    const read = m => String(m?.viewer_metadata?.role || '').toUpperCase()
    let role = read(meta)
    if (!role) role = read(await conn.newsletterMetadata('jid', meta.id).catch(() => null))
    return role
}

async function fetchMetadata(conn, input) {
    if (NEWSLETTER_JID.test(input)) return conn.newsletterMetadata('jid', input).catch(() => null)
    const code = input.match(CHANNEL_LINK)?.[1]
    if (!code) throw 'Invalid channel link. Example: https://whatsapp.com/channel/xxxxxxxx'
    return conn.newsletterMetadata('invite', code).catch(() => null)
}

const stringify = (value, space) => JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v), space)

function describeError(e) {
    const payload = getBinaryNodeChild(e?.data, 'result')?.content?.toString()
    const detail = payload || (e?.data ? stringify(e.data) : '')
    return `${e?.message || e}${detail ? `\n\n${detail.slice(0, 1500)}` : ''}`
}

async function sendChunked(m, text, limit = 3500) {
    let chunk = ''
    for (const line of text.split('\n')) {
        if (chunk && chunk.length + line.length + 1 > limit) {
            await m.reply(chunk)
            chunk = ''
        }
        chunk += (chunk ? '\n' : '') + line
    }
    if (chunk) await m.reply(chunk)
}

async function fetchFollowers(conn, jid, count) {
    const res = await conn.executeWMexQuery(
        { input: { newsletter_id: jid, count } },
        QUERY.FOLLOWERS,
        'xwa2_newsletter_followers',
    )
    return (res?.followers?.edges ?? []).map(edge => ({
        id: edge?.node?.id,
        phone: edge?.node?.pn,
        name: edge?.node?.display_name || edge?.admin_profile?.name || '',
        username: edge?.node?.username_info?.username,
        role: String(edge?.role || 'SUBSCRIBER').toUpperCase(),
    }))
}

function formatPerson(p) {
    const who = (p.phone || p.id || '-').split('@')[0]
    const extra = [p.username ? `@${p.username}` : '', p.role !== 'SUBSCRIBER' ? p.role : ''].filter(Boolean).join(', ')
    return `- ${p.name || '-'} (${who})${extra ? ` [${extra}]` : ''}`
}

async function fetchInsights(conn, jid) {
    return conn.executeWMexQuery(
        { input: { newsletter_id: jid, metrics: ['NET_FOLLOWS', 'UNFOLLOWS'] } },
        QUERY.INSIGHTS,
        'xwa2_newsletter_admin_insights',
    )
}

function buildPoll(q) {
    const values = (q.options || []).map(o => o.optionName).filter(Boolean)
    if (!q.name || values.length < 2) throw 'Invalid poll, cannot copy it.'

    const poll = {
        name: q.name,
        values,
        selectableCount: Math.min(Number(q.selectableOptionsCount) || 0, values.length),
    }
    if (q.hideParticipantName) poll.hideVoter = true

    if (q.pollType === 1 || q.pollType === 'QUIZ') {
        const answer = q.correctAnswer?.optionName
        if (!answer) throw 'This quiz has no correct answer to copy.'
        poll.pollType = 1
        poll.correctAnswer = answer
    }
    return poll
}

function questionText(q) {
    const inner = q.message || q
    return inner.extendedTextMessage?.text || inner.conversation || q.text || ''
}

function buildQuestion(text) {
    return {
        questionMessage: {
            message: {
                extendedTextMessage: {
                    text,
                    contextInfo: { isQuestion: true },
                },
            },
        },
    }
}

async function fetchPostStats(conn, jid) {
    const result = await conn.query({
        tag: 'iq',
        attrs: { id: conn.generateMessageTag?.() || String(Date.now()), type: 'get', xmlns: 'newsletter', to: S_WHATSAPP_NET },
        content: [{ tag: 'messages', attrs: { count: String(POST_COUNT), type: 'jid', jid } }],
    })

    const messagesNode = getBinaryNodeChild(result, 'messages')
    const posts = []
    for (const node of getBinaryNodeChildren(messagesNode, 'message')) {
        const viewsAttr = getBinaryNodeChild(node, 'views_count')?.attrs?.count
        const reactionNodes = getBinaryNodeChildren(getBinaryNodeChild(node, 'reactions'), 'reaction')
        posts.push({
            id: node.attrs.server_id || node.attrs.id,
            time: Number(node.attrs.t) || 0,
            views: viewsAttr === undefined ? null : Number(viewsAttr) || 0,
            reactions: reactionNodes.reduce((sum, r) => sum + (Number(r.attrs?.count) || 0), 0),
        })
    }
    return posts
}

function summarizePosts(posts, followers) {
    const withViews = posts.filter(p => p.views !== null)
    if (!withViews.length) return '- `Post stats:` not available (the server returned no view counts).'

    const totalViews = withViews.reduce((sum, p) => sum + p.views, 0)
    const totalReactions = posts.reduce((sum, p) => sum + p.reactions, 0)
    const avgViews = Math.round(totalViews / withViews.length)
    const best = withViews.reduce((a, b) => (b.views > a.views ? b : a))

    const lines = [
        `- \`Posts analyzed:\` ${posts.length}`,
        `- \`Total views:\` ${fmt(totalViews)}`,
        `- \`Average views/post:\` ${fmt(avgViews)}`,
    ]
    if (followers > 0) lines.push(`- \`Average reach:\` ${((avgViews / followers) * 100).toFixed(1)}% of followers`)
    lines.push(
        `- \`Total reactions:\` ${fmt(totalReactions)}`,
        `- \`Best post:\` ${fmt(best.views)} views (${formatDate(best.time)})`,
    )
    return lines.join('\n')
}

async function upChannel(m, { conn, args, usedPrefix, command }) {
    const input = args.find(a => CHANNEL_LINK.test(a) || NEWSLETTER_JID.test(a))
    if (!input) {
        throw `Usage: ${usedPrefix + command} <channel link> [question]\nReply to the message you want to send.`
    }
    if (!m.quoted) throw 'Reply to the message you want to send to the channel.'

    const flags = args.filter(a => a !== input).map(a => a.toLowerCase().replace(/^-+/, ''))
    const q = m.quoted
    const asQuestion = flags.includes('question') || flags.includes('q') || q.mtype === 'questionMessage'

    const meta = await fetchMetadata(conn, input)
    if (!meta?.id) throw 'Channel not found, or the link is invalid.'

    const role = String(meta.viewer_metadata?.role || '').toUpperCase()
    if (role && role !== 'OWNER' && role !== 'ADMIN') {
        throw 'The bot is not an owner/admin of that channel, so it cannot post there.'
    }

    const channel = { id: meta.id, name: meta.thread_metadata?.name?.text || meta.name || input }
    let label

    try {
        if (/^pollCreationMessage/.test(q.mtype)) {
            label = 'poll'
            await conn.sendMessage(channel.id, { poll: buildPoll(q) })
        } else if (asQuestion) {
            label = 'question'
            const text = questionText(q)
            if (!text) throw 'The question has no text.'
            await conn.relayMessage(channel.id, buildQuestion(text), {})
        } else if (q.mediaMessage && q.mediaType) {
            const media = q.mediaMessage[q.mediaType] || {}
            const buffer = await q.download()
            const ptt = q.mediaType === 'audioMessage' && !!media.ptt
            label = q.mediaType.replace(/Message$/, '')
            await conn.sendFile(
                channel.id,
                buffer,
                media.fileName || '',
                media.caption || '',
                null,
                ptt,
                q.mediaType === 'documentMessage' && media.mimetype ? { mimetype: media.mimetype } : {},
            )
        } else if (q.text) {
            label = 'text'
            await conn.sendMessage(channel.id, { text: q.text })
        } else {
            throw 'That message type is not supported.'
        }
    } catch (e) {
        if (typeof e === 'string') throw e
        console.error('[channel] failed to send:', e)
        throw `Failed to send to channel: ${e?.message || e}`
    }

    await m.reply(`Sent ${label} to ${channel.name}.`)
}

async function statusChannel(m, { conn, args, usedPrefix, command }) {
    const input = args.find(a => CHANNEL_LINK.test(a) || NEWSLETTER_JID.test(a))
    if (!input) throw `Usage: ${usedPrefix + command} <channel link> [followers|admins|insights]`

    const flags = args.filter(a => a !== input).map(a => a.toLowerCase().replace(/^-+/, ''))
    const meta = await fetchMetadata(conn, input)
    if (!meta?.id) throw 'Channel not found, or the link is invalid.'

    const thread = meta.thread_metadata || {}
    const followers = Number(thread.subscribers_count) || 0
    const role = await resolveRole(conn, meta)
    const canManage = role !== 'SUBSCRIBER' && role !== 'GUEST'
    const description = thread.description?.text || ''
    const handle = thread.handle ? `@${String(thread.handle).replace(/^@/, '')}` : '-'

    const info = [
        `- \`Name:\` ${thread.name?.text || '-'}`,
        `- \`Handle:\` ${handle}`,
        `- \`ID:\` ${meta.id}`,
        `- \`State:\` ${meta.state?.type || '-'}`,
        `- \`Verified:\` ${String(thread.verification || '').toUpperCase() === 'VERIFIED' ? 'yes' : 'no'}`,
        `- \`Created:\` ${formatDate(thread.creation_time)}`,
        `- \`Followers:\` ${fmt(followers)}`,
        `- \`Bot role:\` ${role || 'unknown'}`,
    ]

    if (canManage) {
        const admins = await conn.newsletterAdminCount(meta.id).catch(() => null)
        if (admins !== null && admins !== undefined) info.push(`- \`Admins:\` ${admins}`)
    }
    if (description) info.push(`- \`Description:\` ${description.length > 200 ? description.slice(0, 200) + '...' : description}`)

    let stats
    try {
        stats = summarizePosts(await fetchPostStats(conn, meta.id), followers)
    } catch (e) {
        console.error('[channel] failed to fetch post stats:', e)
        stats = '- `Post stats:` failed to fetch.'
    }

    await m.reply(`${info.join('\n')}\n\n${stats}`)

    const wantFollowers = flags.includes('followers')
    const wantAdmins = flags.includes('admins')

    if (wantFollowers || wantAdmins) {
        let people
        try {
            people = await fetchFollowers(conn, meta.id, Math.min(Math.max(followers, 50), 1000))
        } catch (e) {
            console.error('[channel] failed to fetch followers:', e)
            throw `Failed to fetch followers: ${describeError(e)}`
        }

        if (wantAdmins) {
            const admins = people.filter(p => p.role === 'OWNER' || p.role === 'ADMIN')
            await sendChunked(m, [`Admins (${admins.length}):`, ...admins.map(formatPerson)].join('\n') || 'No admins returned.')
        }
        if (wantFollowers) {
            await sendChunked(m, [`Followers returned: ${people.length} of ${fmt(followers)}`, ...people.map(formatPerson)].join('\n'))
        }
    }

    if (flags.includes('insights')) {
        try {
            await sendChunked(m, stringify(await fetchInsights(conn, meta.id), 2) || 'No insights data returned.')
        } catch (e) {
            console.error('[channel] failed to fetch insights:', e)
            throw `Failed to fetch insights: ${describeError(e)}`
        }
    }
}

let handler = async (m, ctx) => {
    if (/^up(ch|channel)$/i.test(ctx.command)) return upChannel(m, ctx)
    return statusChannel(m, ctx)
}

handler.help = ['upch|upchannel <link> [question] (reply)', 'statsch|statschannel|statusch|statuschannel <link> [followers|admins|insights]']
handler.tags = ['tools']
handler.command = /^(upch(annel)?|statsch(annel)?|statusch(annel)?)$/i
handler.owner = true
handler.ai = { risk: 'low', description: 'send a replied message (media, audio, poll, question) to a WhatsApp channel, or check channel stats (followers, views, reactions)' }

export default handler