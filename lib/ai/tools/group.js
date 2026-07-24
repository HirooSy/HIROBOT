// ─── tools/group.js ─────────────────────────────────────────────────────────
// Kategori: get_group_info, group_member_action, group_settings, group_link, group_leave, group_join_requests
// Auto-extracted dari mcp.js. Semua helper privat (loadBrain, checkGroupAdminOrOwner,
// dst) TETAP didefinisikan & dieksekusi di mcp.js (biar gak dobel logic dgn
// core agent loop yang juga makainya) -- file ini cuma import + pakai.

import { ctx, getMcp } from '../context.js'

export default [
{
    name: 'get_group_info',
    description: 'Ambil informasi grup: nama, deskripsi, jumlah member, list admin, dan (opsional) daftar SEMUA member dengan nama yang dikenali dari database bot. Kalau user bilang "info grup ini"/"grup ini" TANPA kasih JID atau link spesifik, JANGAN isi group_jid/invite_link — kosongkan saja, tool ini otomatis pakai grup chat yang sedang aktif sekarang. Isi invite_link kalau user kasih link undangan grup (chat.whatsapp.com/...) untuk grup yang BELUM di-join bot. Set include_members=true kalau user minta lihat SEMUA anggota grup (bukan cuma admin), atau kalau kamu butuh tahu siapa saja yang ada di grup ini untuk menjawab pertanyaan lain.',
    parameters: {
        group_jid:        { type: 'string', description: 'JID grup (contoh: 120363...@g.us). Kosongkan untuk pakai grup chat yang sedang aktif. Kosongkan juga (tanpa isi apapun) untuk list semua grup yang bot ikuti.', required: false },
        invite_link:      { type: 'string', description: 'Link undangan grup (mis. "https://chat.whatsapp.com/ABC123..." atau cukup kode "ABC123..."-nya) — dipakai untuk lihat info grup yang belum di-join bot.', required: false },
        list_all:         { type: 'boolean', description: 'Set true untuk eksplisit minta daftar SEMUA grup yang bot ikuti, bukan grup chat aktif.', required: false },
        include_members:  { type: 'boolean', description: 'Set true untuk sertakan daftar SEMUA member grup (bukan cuma admin), lengkap dengan nama dari database bot kalau dikenali. Tidak berlaku untuk invite_link (grup yang belum di-join).', required: false }
    },
    execute: async ({ group_jid, invite_link, list_all, include_members } = {}) => {
        const { checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } = await getMcp()

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
                `- Link grup boleh diminta member biasa: ${readGroupSettings(meta.id).allowMemberLink ? 'ya' : 'tidak (cuma admin/owner)'}`
            ]
            if (withMembers && meta.participants?.length) {
                lines.push('', 'Daftar member:')
                for (const p of meta.participants) {
                    const jid = p.phoneNumber || p.id
                    let identity = null
                    try { identity = await getUserIdentity(jid, db, ctx().conn) } catch (_) {}
                    const role = p.admin === 'superadmin' ? ' [owner grup]' : p.admin === 'admin' ? ' [admin]' : ''
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
                return 'Chat ini bukan grup, jadi tidak ada info grup untuk "grup ini". Kasih JID atau link undangan grup yang dimaksud kalau mau lihat grup lain.'
            }


            const store = (await import('../connection/connection.js')).default?.store
            if (!store) return 'Store tidak tersedia'
            const chats = Object.keys(store.chats || {}).filter(jid => jid.endsWith('@g.us'))
            if (!chats.length) return 'Tidak ada grup'
            return `Grup bot (${chats.length}):\n` + chats.slice(0, 30).map(j => `- ${j}`).join('\n')
        } catch (e) {
            return `Error: ${e.message}`
        }
    }
},
{
    name: 'group_member_action',
    description: 'Tambah, kick, promote (jadi admin), atau demote (turunkan dari admin) member grup. HANYA ADMIN grup ini atau OWNER bot yang boleh minta ini -- kalau requester bukan admin/owner, tool ini otomatis menolak. Bot sendiri juga harus jadi admin di grup itu supaya aksi ini berhasil dieksekusi WhatsApp-nya (di luar kendali tool ini).',
    parameters: {
        action:    { type: 'string', description: 'Salah satu dari: "add", "kick" (alias "remove"), "promote", "demote".', required: true },
        targets:   { type: 'array', items: { type: 'string' }, description: 'Daftar nomor telepon atau JID target aksi. Contoh: ["628123456789", "628987654321@s.whatsapp.net"].', required: true },
        group_jid: { type: 'string', description: 'JID grup. Kosongkan untuk pakai grup chat yang sedang aktif.', required: false }
    },
    execute: async ({ action, targets, group_jid }) => {
        const { checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'Tidak ada grup yang dimaksud -- ini bukan chat grup dan group_jid tidak diisi.'
        if (!Array.isArray(targets) || !targets.length) return 'targets wajib diisi, minimal 1.'

        const actionMap = { add: 'add', kick: 'remove', remove: 'remove', promote: 'promote', demote: 'demote' }
        const waAction = actionMap[String(action).toLowerCase()]
        if (!waAction) return `Action "${action}" tidak dikenal. Pakai salah satu dari: add, kick, promote, demote.`

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `DITOLAK: ${perm.reason}`

        const jids = targets.map(t => t.includes('@') ? t : t.replace(/\D/g, '') + '@s.whatsapp.net')

        try {
            const result = await ctx().conn.groupParticipantsUpdate(groupJid, jids, waAction)
            const summary = (result || []).map(r => `${r.jid}: ${r.status === '200' ? 'berhasil' : `gagal (${r.status})`}`).join('\n')
            return `Aksi "${waAction}" selesai:\n${summary || '(tidak ada hasil dari WA)'}`
        } catch (e) {
            return `Gagal: ${e.message}`
        }
    }
},
{
    name: 'group_settings',
    description: 'Ubah pengaturan grup: nama, deskripsi, foto, mode chat (announcement/semua boleh chat), kunci info grup (cuma admin/semua boleh edit info), mode tambah member (admin only/semua boleh), pesan sementara (ephemeral), mode approval join, dan izin member biasa minta link undangan. HANYA ADMIN grup ini atau OWNER bot yang boleh minta ini.',
    parameters: {
        action: {
            type: 'string',
            description: 'Salah satu dari: "set_name", "set_description", "set_photo", "remove_photo", "announcement_on" (cuma admin yang bisa chat), "announcement_off" (semua boleh chat), "lock_info" (cuma admin edit info grup), "unlock_info" (semua boleh edit info grup), "member_add_admin_only", "member_add_all", "ephemeral" (perlu value = detik, 0 untuk matikan), "join_approval_on", "join_approval_off", "allow_member_link" (member biasa boleh minta link undangan), "disallow_member_link" (cuma admin/owner boleh).',
            required: true
        },
        value: { type: 'string', description: 'Nilai untuk action yang butuh (mis. nama grup baru untuk set_name, teks deskripsi untuk set_description, URL gambar untuk set_photo, jumlah detik untuk ephemeral -- 0 untuk matikan, 86400 = 24 jam).', required: false },
        group_jid: { type: 'string', description: 'JID grup. Kosongkan untuk pakai grup chat yang sedang aktif.', required: false }
    },
    execute: async ({ action, value, group_jid }) => {
        const { checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'Tidak ada grup yang dimaksud -- ini bukan chat grup dan group_jid tidak diisi.'

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `DITOLAK: ${perm.reason}`

        try {
            switch (action) {
                case 'set_name':
                    if (!value) return 'value (nama grup baru) wajib diisi.'
                    await ctx().conn.groupUpdateSubject(groupJid, value)
                    return `Nama grup diubah jadi "${value}".`
                case 'set_description':
                    if (value === undefined) return 'value (deskripsi baru) wajib diisi.'
                    await ctx().conn.groupUpdateDescription(groupJid, value)
                    return 'Deskripsi grup diperbarui.'
                case 'set_photo':
                    if (!value) return 'value (URL gambar) wajib diisi.'
                    await ctx().conn.updateProfilePicture(groupJid, { url: value })
                    return 'Foto grup diperbarui.'
                case 'remove_photo':
                    await ctx().conn.removeProfilePicture(groupJid)
                    return 'Foto grup dihapus.'
                case 'announcement_on':
                    await ctx().conn.groupSettingUpdate(groupJid, 'announcement')
                    return 'Grup diset jadi cuma admin yang bisa kirim pesan.'
                case 'announcement_off':
                    await ctx().conn.groupSettingUpdate(groupJid, 'not_announcement')
                    return 'Grup diset jadi semua member bisa kirim pesan.'
                case 'lock_info':
                    await ctx().conn.groupSettingUpdate(groupJid, 'locked')
                    return 'Cuma admin yang sekarang bisa edit info grup (nama/deskripsi/foto).'
                case 'unlock_info':
                    await ctx().conn.groupSettingUpdate(groupJid, 'unlocked')
                    return 'Semua member sekarang bisa edit info grup (nama/deskripsi/foto).'
                case 'member_add_admin_only':
                    await ctx().conn.groupMemberAddMode(groupJid, 'admin_add')
                    return 'Cuma admin yang sekarang bisa nambah member baru.'
                case 'member_add_all':
                    await ctx().conn.groupMemberAddMode(groupJid, 'all_member_add')
                    return 'Semua member sekarang bisa nambah member baru.'
                case 'ephemeral': {
                    const seconds = Number(value)
                    if (!Number.isFinite(seconds) || seconds < 0) return 'value (jumlah detik) wajib diisi angka >= 0.'
                    await ctx().conn.groupToggleEphemeral(groupJid, seconds)
                    return seconds === 0 ? 'Pesan sementara dimatikan.' : `Pesan sementara diset ${seconds} detik.`
                }
                case 'join_approval_on':
                    await ctx().conn.groupJoinApprovalMode(groupJid, 'on')
                    return 'Mode approval join diaktifkan -- member baru harus di-approve dulu.'
                case 'join_approval_off':
                    await ctx().conn.groupJoinApprovalMode(groupJid, 'off')
                    return 'Mode approval join dimatikan -- orang bisa langsung join lewat link.'
                case 'allow_member_link': {
                    const brain = loadBrain()
                    ensureBrainGroupSlot(brain, groupJid).settings.allowMemberLink = true
                    saveBrain(brain)
                    return 'Member biasa sekarang boleh minta link undangan grup ini lewat bot.'
                }
                case 'disallow_member_link': {
                    const brain = loadBrain()
                    ensureBrainGroupSlot(brain, groupJid).settings.allowMemberLink = false
                    saveBrain(brain)
                    return 'Cuma admin/owner yang sekarang boleh minta link undangan grup ini lewat bot.'
                }
                default:
                    return `Action "${action}" tidak dikenal.`
            }
        } catch (e) {
            return `Gagal: ${e.message}`
        }
    }
},
{
    name: 'group_link',
    description: 'Ambil atau reset (revoke) link undangan grup. Admin grup/owner bot SELALU boleh. Member biasa cuma boleh kalau admin sudah mengizinkan lewat group_settings (action allow_member_link) -- kalau belum diizinkan dan yang minta bukan admin/owner, tool ini otomatis menolak.',
    parameters: {
        action:    { type: 'string', description: '"get" untuk ambil link saat ini, "revoke" untuk reset link (link lama jadi tidak berlaku).', required: true },
        group_jid: { type: 'string', description: 'JID grup. Kosongkan untuk pakai grup chat yang sedang aktif.', required: false }
    },
    execute: async ({ action, group_jid }) => {
        const { checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'Tidak ada grup yang dimaksud -- ini bukan chat grup dan group_jid tidak diisi.'

        const allowedForMember = readGroupSettings(groupJid).allowMemberLink === true
        if (!allowedForMember) {
            const perm = await checkGroupAdminOrOwner(groupJid)
            if (!perm.allowed) return `DITOLAK: ${perm.reason} (admin belum mengizinkan member biasa minta link grup ini)`
        }

        try {
            if (action === 'revoke') {
                if (!allowedForMember) {
                    // revoke tetap harus admin/owner walau member diizinkan lihat link
                    const perm = await checkGroupAdminOrOwner(groupJid)
                    if (!perm.allowed) return `DITOLAK: ${perm.reason}`
                } else {
                    const perm = await checkGroupAdminOrOwner(groupJid)
                    if (!perm.allowed) return 'DITOLAK: revoke link cuma boleh admin/owner, walau lihat link boleh member biasa.'
                }
                const code = await ctx().conn.groupRevokeInvite(groupJid)
                return `Link lama direset. Link baru: https://chat.whatsapp.com/${code}`
            }
            const code = await ctx().conn.groupInviteCode(groupJid)
            return `https://chat.whatsapp.com/${code}`
        } catch (e) {
            return `Gagal: ${e.message}`
        }
    }
},
{
    name: 'group_leave',
    description: 'Bot keluar dari grup. HANYA ADMIN grup ini atau OWNER bot yang boleh minta ini.',
    parameters: {
        group_jid: { type: 'string', description: 'JID grup. Kosongkan untuk pakai grup chat yang sedang aktif.', required: false }
    },
    execute: async ({ group_jid }) => {
        const { checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'Tidak ada grup yang dimaksud -- ini bukan chat grup dan group_jid tidak diisi.'

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `DITOLAK: ${perm.reason}`

        try {
            if (ctx().conn && groupJid) {
                await ctx().conn.sendMessage(groupJid, { text: 'Baik, bot keluar dari grup ini ya. Bye! 👋' })
            }
            await ctx().conn.groupLeave(groupJid)
            return `Berhasil keluar dari grup ${groupJid}.`
        } catch (e) {
            return `Gagal: ${e.message}`
        }
    }
},
{
    name: 'group_join_requests',
    description: 'Lihat, approve, atau reject daftar orang yang minta join grup (kalau mode approval join lagi aktif). HANYA ADMIN grup ini atau OWNER bot yang boleh minta ini.',
    parameters: {
        action:    { type: 'string', description: '"list" untuk lihat daftar pending, "approve" atau "reject" untuk memproses target tertentu.', required: true },
        targets:   { type: 'array', items: { type: 'string' }, description: 'Daftar nomor/JID yang mau di-approve/reject. Wajib diisi kalau action bukan "list".', required: false },
        group_jid: { type: 'string', description: 'JID grup. Kosongkan untuk pakai grup chat yang sedang aktif.', required: false }
    },
    execute: async ({ action, targets, group_jid }) => {
        const { checkGroupAdminOrOwner, ensureBrainGroupSlot, getUserIdentity, loadBrain, readGroupSettings, saveBrain } = await getMcp()

        if (!ctx().conn) return 'WA connection not ready'
        const groupJid = group_jid || (ctx().currentJid?.endsWith('@g.us') ? ctx().currentJid : null)
        if (!groupJid) return 'Tidak ada grup yang dimaksud -- ini bukan chat grup dan group_jid tidak diisi.'

        const perm = await checkGroupAdminOrOwner(groupJid)
        if (!perm.allowed) return `DITOLAK: ${perm.reason}`

        try {
            if (action === 'list') {
                const requests = await ctx().conn.groupRequestParticipantsList(groupJid)
                if (!requests?.length) return 'Tidak ada permintaan join yang pending.'
                return requests.map(r => `- ${r.jid}`).join('\n')
            }
            if (action !== 'approve' && action !== 'reject') return `Action "${action}" tidak dikenal. Pakai: list, approve, reject.`
            if (!Array.isArray(targets) || !targets.length) return 'targets wajib diisi untuk approve/reject.'
            const jids = targets.map(t => t.includes('@') ? t : t.replace(/\D/g, '') + '@s.whatsapp.net')
            await ctx().conn.groupRequestParticipantsUpdate(groupJid, jids, action)
            return `Berhasil ${action === 'approve' ? 'menerima' : 'menolak'} ${jids.length} permintaan join.`
        } catch (e) {
            return `Gagal: ${e.message}`
        }
    }
}
]
