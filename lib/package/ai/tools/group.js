import { ctx, checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } from '../mcp.js';
export default [
{
    name: 'get_group_info',
    description: 'Get group information: name, description, member count, admin list, and (optionally) the list of ALL members with names recognized from the bot database. If the user says "info about this group"/"this group" WITHOUT giving a specific JID or link, do NOT fill group_jid/invite_link — leave them empty, this tool automatically uses the currently active chat group. Fill invite_link if the user gives a group invite link (chat.whatsapp.com/...) for a group the bot has NOT joined yet. Set include_members=true if the user asks to see ALL group members (not just admins), or if you need to know who is in this group to answer another question.',
    parameters: {
        group_jid: { type: 'string', description: 'Group JID (example: 120363...@g.us). Leave empty to use the currently active chat group. Also leave it empty (with nothing filled in) to list all groups the bot is in.', required: false },
        invite_link: { type: 'string', description: 'Group invite link (e.g. "https://chat.whatsapp.com/ABC123..." or just the code "ABC123...") — used to see info of a group the bot has not joined.', required: false },
        list_all: { type: 'boolean', description: 'Set true to explicitly ask for the list of ALL groups the bot is in, instead of the active chat group.', required: false },
        include_members: { type: 'boolean', description: 'Set true to include the list of ALL group members (not just admins), with names from the bot database if recognized. Does not apply to invite_link (a group not joined yet).', required: false }
    },
    execute: async ({ group_jid, invite_link, list_all, include_members } = {}) => {
        if (!ctx().conn) return 'WA connection not ready'

        const toPn = (p) => {
            const raw = p.phoneNumber || p.id || ''
            return String(raw).replace(/@.*/, '')
        }

        const formatGroup = async (meta, { withMembers = false } = {}) => {
            const admins = (meta.participants || []).filter(p => p.admin).map(toPn)
            const lines = [
                meta.subject || '(no name)',
                `- Id: ${meta.id}`,
                `- Member: ${meta.participants?.length ?? meta.size ?? '?'}`,
                `- Admin: ${admins.length ? admins.join(', ') : '-'}`,
                `- Description: ${meta.desc || '-'}`,
                `- Regular members may request the group link: ${readGroupSettings(meta.id).allowMemberLink ? 'yes' : 'no (admin/owner only)'}`
            ]
            if (withMembers && meta.participants?.length) {
                lines.push('', 'Member list:')
                for (const p of meta.participants) {
                    const jid = p.phoneNumber || p.id
                    let identity = null
                    try { identity = await getUserIdentity(jid, db, ctx().conn) } catch (_) {}
                    const role = p.admin === 'superadmin' ? ' [group owner]' : p.admin === 'admin' ? ' [admin]' : ''
                    const nameLabel = identity?.name && identity.name !== identity.number ? ` (${identity.name})` : ''
                    lines.push(`- ${identity?.number || toPn(p)}${nameLabel}${role}`)
                }
            }
            return lines.join('\n')
        }

        try {
            if (invite_link) {
                const code = String(invite_link).split('chat.whatsapp.com/').pop().split('?')[0].trim()
                const meta = await ctx().conn.groupGetInviteInfo(code)
                return await formatGroup(meta)
            }

            const targetJid = group_jid || (!list_all && ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)

            if (targetJid) {
                const meta = await ctx().conn.groupMetadata(targetJid)
                return await formatGroup(meta, { withMembers: !!include_members })
            }

            if (!list_all && ctx().currentJid && !ctx().currentJid.endsWith('@g.us')) {
                return 'This chat is not a group, so there is no group info for "this group". Give the JID or invite link of the group you mean if you want to see another group.'
            }

            const store = (await import('../../../utils/connection.js')).default?.store
            if (!store) return 'Store is not available'
            const chats = Object.keys(store.chats || {}).filter(jid => jid.endsWith('@g.us'))
            if (!chats.length) return 'No groups'
            return `Bot groups (${chats.length}):\n` + chats.slice(0, 30).map(j => `- ${j}`).join('\n')
        } catch (e) {
            return `Error: ${e.message}`
        }
    }
},
{
    name: 'group_member_action',
    description: 'Add, kick, promote (make admin), or demote (remove admin status from) group members. ONLY an ADMIN of this group or the bot OWNER may request this -- if the requester is not an admin/owner, this tool refuses automatically. The bot itself must also be an admin in that group for this action to be executed by WhatsApp (outside this tool\'s control).',
    parameters: {
        action: { type: 'string', description: 'One of: "add", "kick" (alias "remove"), "promote", "demote".', required: true },
        targets: { type: 'array', items: { type: 'string' }, description: 'List of phone numbers or JIDs targeted by the action. Example: ["628123456789", "628987654321@s.whatsapp.net"].', required: true },
        group_jid: { type: 'string', description: 'Group JID. Leave empty to use the currently active chat group.', required: false }
    },
    execute: async ({ action, targets, group_jid }) => {
        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'No group specified -- this is not a group chat and group_jid was not filled in.'
        if (!Array.isArray(targets) || !targets.length) return 'targets is required, at least 1.'

        const actionMap = { add: 'add', kick: 'remove', remove: 'remove', promote: 'promote', demote: 'demote' }
        const waAction = actionMap[String(action).toLowerCase()]
        if (!waAction) return `Action "${action}" is not recognized. Use one of: add, kick, promote, demote.`

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `REJECTED: ${perm.reason}`

        const jids = targets.map(t => t.includes('@') ? t : t.replace(/\D/g, '') + '@s.whatsapp.net')

        try {
            const result = await ctx().conn.groupParticipantsUpdate(groupJid, jids, waAction)
            const summary = (result || []).map(r => `${r.jid}: ${r.status === '200' ? 'success' : `failed (${r.status})`}`).join('\n')
            return `Action "${waAction}" finished:\n${summary || '(no result from WA)'}`
        } catch (e) {
            return `Failed: ${e.message}`
        }
    }
},
{
    name: 'group_settings',
    description: 'Change group settings: name, description, photo, chat mode (announcement/everyone can chat), group info lock (admin only/everyone can edit info), member-add mode (admin only/everyone), ephemeral messages, join approval mode, and permission for regular members to request the invite link. ONLY an ADMIN of this group or the bot OWNER may request this.',
    parameters: {
        action: {
            type: 'string',
            description: 'One of: "set_name", "set_description", "set_photo", "remove_photo", "announcement_on" (only admins can chat), "announcement_off" (everyone can chat), "lock_info" (only admins edit group info), "unlock_info" (everyone can edit group info), "member_add_admin_only", "member_add_all", "ephemeral" (needs value = seconds, 0 to turn off), "join_approval_on", "join_approval_off", "allow_member_link" (regular members may request the invite link), "disallow_member_link" (only admin/owner may).',
            required: true
        },
        value: { type: 'string', description: 'The value for actions that need one (e.g. the new group name for set_name, description text for set_description, image URL for set_photo, number of seconds for ephemeral -- 0 to turn off, 86400 = 24 hours).', required: false },
        group_jid: { type: 'string', description: 'Group JID. Leave empty to use the currently active chat group.', required: false }
    },
    execute: async ({ action, value, group_jid }) => {
        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'No group specified -- this is not a group chat and group_jid was not filled in.'

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `REJECTED: ${perm.reason}`

        try {
            switch (action) {
                case 'set_name':
                    if (!value) return 'value (the new group name) is required.'
                    await ctx().conn.groupUpdateSubject(groupJid, value)
                    return `Group name changed to "${value}".`
                case 'set_description':
                    if (value === undefined) return 'value (the new description) is required.'
                    await ctx().conn.groupUpdateDescription(groupJid, value)
                    return 'Group description updated.'
                case 'set_photo':
                    if (!value) return 'value (image URL) is required.'
                    await ctx().conn.updateProfilePicture(groupJid, { url: value })
                    return 'Group photo updated.'
                case 'remove_photo':
                    await ctx().conn.removeProfilePicture(groupJid)
                    return 'Group photo removed.'
                case 'announcement_on':
                    await ctx().conn.groupSettingUpdate(groupJid, 'announcement')
                    return 'The group is now set so only admins can send messages.'
                case 'announcement_off':
                    await ctx().conn.groupSettingUpdate(groupJid, 'not_announcement')
                    return 'The group is now set so all members can send messages.'
                case 'lock_info':
                    await ctx().conn.groupSettingUpdate(groupJid, 'locked')
                    return 'Only admins can now edit the group info (name/description/photo).'
                case 'unlock_info':
                    await ctx().conn.groupSettingUpdate(groupJid, 'unlocked')
                    return 'All members can now edit the group info (name/description/photo).'
                case 'member_add_admin_only':
                    await ctx().conn.groupMemberAddMode(groupJid, 'admin_add')
                    return 'Only admins can now add new members.'
                case 'member_add_all':
                    await ctx().conn.groupMemberAddMode(groupJid, 'all_member_add')
                    return 'All members can now add new members.'
                case 'ephemeral': {
                    const seconds = Number(value)
                    if (!Number.isFinite(seconds) || seconds < 0) return 'value (number of seconds) must be a number >= 0.'
                    await ctx().conn.groupToggleEphemeral(groupJid, seconds)
                    return seconds === 0 ? 'Pesan sementara dimatikan.' : `Pesan sementara diset ${seconds} detik.`
                }
                case 'join_approval_on':
                    await ctx().conn.groupJoinApprovalMode(groupJid, 'on')
                    return 'Join approval mode is on -- new members must be approved first.'
                case 'join_approval_off':
                    await ctx().conn.groupJoinApprovalMode(groupJid, 'off')
                    return 'Join approval mode is off -- people can join directly through the link.'
                case 'allow_member_link': {
                    const brain = loadBrain()
                    ensureBrainGroupSlot(brain, groupJid).settings.allowMemberLink = true
                    saveBrain(brain)
                    return 'Regular members may now request this group\'s invite link through the bot.'
                }
                case 'disallow_member_link': {
                    const brain = loadBrain()
                    ensureBrainGroupSlot(brain, groupJid).settings.allowMemberLink = false
                    saveBrain(brain)
                    return 'Only admins/owner may now request this group\'s invite link through the bot.'
                }
                default:
                    return `Action "${action}" is not recognized.`
            }
        } catch (e) {
            return `Failed: ${e.message}`
        }
    }
},
{
    name: 'group_link',
    description: 'Get or reset (revoke) the group invite link. Group admins/bot owner are ALWAYS allowed. Regular members are only allowed if an admin has permitted it through group_settings (action allow_member_link) -- if it has not been permitted and the requester is not an admin/owner, this tool refuses automatically.',
    parameters: {
        action: { type: 'string', description: '"get" to fetch the current link, "revoke" to reset the link (the old link becomes invalid).', required: true },
        group_jid: { type: 'string', description: 'Group JID. Leave empty to use the currently active chat group.', required: false }
    },
    execute: async ({ action, group_jid }) => {
        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'No group specified -- this is not a group chat and group_jid was not filled in.'

        const allowedForMember = readGroupSettings(groupJid).allowMemberLink === true
        if (!allowedForMember) {
            const perm = await checkGroupAdminOrOwner(groupJid)
            if (!perm.allowed) return `REJECTED: ${perm.reason} (an admin has not allowed regular members to request this group link)`
        }

        try {
            if (action === 'revoke') {
                if (!allowedForMember) {
                    
                    const perm = await checkGroupAdminOrOwner(groupJid)
                    if (!perm.allowed) return `REJECTED: ${perm.reason}`
                } else {
                    const perm = await checkGroupAdminOrOwner(groupJid)
                    if (!perm.allowed) return 'REJECTED: revoking the link is for admins/owner only, even though regular members may view the link.'
                }
                const code = await ctx().conn.groupRevokeInvite(groupJid)
                return `Old link reset. New link: https://chat.whatsapp.com/${code}`
            }
            const code = await ctx().conn.groupInviteCode(groupJid)
            return `https://chat.whatsapp.com/${code}`
        } catch (e) {
            return `Failed: ${e.message}`
        }
    }
},
{
    name: 'group_leave',
    description: 'The bot leaves the group. ONLY an ADMIN of this group or the bot OWNER may request this.',
    parameters: {
        group_jid: { type: 'string', description: 'Group JID. Leave empty to use the currently active chat group.', required: false }
    },
    execute: async ({ group_jid }) => {
        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'No group specified -- this is not a group chat and group_jid was not filled in.'

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `REJECTED: ${perm.reason}`

        try {
            if (ctx().conn && groupJid) {
                await ctx().conn.sendMessage(groupJid, { text: 'Baik, bot keluar dari grup ini ya. Bye! 👋' })
            }
            await ctx().conn.groupLeave(groupJid)
            return `Successfully left the group ${groupJid}.`
        } catch (e) {
            return `Failed: ${e.message}`
        }
    }
},
{
    name: 'group_join_requests',
    description: 'View, approve, or reject the list of people requesting to join the group (when join approval mode is on). ONLY an ADMIN of this group or the bot OWNER may request this.',
    parameters: {
        action: { type: 'string', description: '"list" to see the pending list, "approve" or "reject" to process specific targets.', required: true },
        targets: { type: 'array', items: { type: 'string' }, description: 'List of numbers/JIDs to approve/reject. Required when action is not "list".', required: false },
        group_jid: { type: 'string', description: 'Group JID. Leave empty to use the currently active chat group.', required: false }
    },
    execute: async ({ action, targets, group_jid }) => {
        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'No group specified -- this is not a group chat and group_jid was not filled in.'

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `REJECTED: ${perm.reason}`

        try {
            if (action === 'list') {
                const requests = await ctx().conn.groupRequestParticipantsList(groupJid)
                if (!requests?.length) return 'There are no pending join requests.'
                return requests.map(r => `- ${r.jid}`).join('\n')
            }
            if (action !== 'approve' && action !== 'reject') return `Action "${action}" is not recognized. Use: list, approve, reject.`
            if (!Array.isArray(targets) || !targets.length) return 'targets is required for approve/reject.'
            const jids = targets.map(t => t.includes('@') ? t : t.replace(/\D/g, '') + '@s.whatsapp.net')
            await ctx().conn.groupRequestParticipantsUpdate(groupJid, jids, action)
            return `Successfully ${action === 'approve' ? 'approved' : 'rejected'} ${jids.length} join requests.`
        } catch (e) {
            return `Failed: ${e.message}`
        }
    }
}
]
