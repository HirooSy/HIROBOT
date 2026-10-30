function listOf(list) {
  const text = list.map(role => `<@&${role.id}>`).join(' ')
  return text.length > 3900 ? `${text.slice(0, 3900)}…` : text
}

function sortedRoles(list, everyoneId) {
  return list.filter(role => role.id !== everyoneId).sort((a, b) => b.position - a.position)
}

const fail = (m, content) => m.reply({ ephemeral: true, content })
const actor = m => m.member?.user?.username || 'bot'

async function pickRole(m, ctx) {
  const role = await ctx.conn.find.role(m.guild, ctx.args.role)
  if (!role) return { error: 'That role was not found in this server.' }
  const problem = await ctx.conn.roles.error(m.guild, m.member, role, ctx.isOwner)
  if (problem) return { error: problem }
  return { role }
}

async function pickMember(m, ctx) {
  const target = await ctx.conn.find.member(m.guild, ctx.args.user)
  if (!target) return { error: 'That user is not in this server.' }
  return { target }
}

const actions = {
  async roles(m, { args, conn }) {
    if (args.user) {
      const { target, error } = await pickMember(m, { args, conn })
      if (error) return fail(m, error)
      const list = sortedRoles(target.roleIds.map(id => m.guild.roles.cache.get(id)).filter(Boolean), m.guild.id)
      return m.reply({
        embeds: [conn.embed({
          title: `Roles of ${conn.find.displayName(target)}`,
          description: list.length ? listOf(list) : 'No roles.',
          footer: { text: `${list.length} role(s)` }
        })]
      })
    }
    await conn.roles.fetch(m.guild)
    const list = sortedRoles([...m.guild.roles.cache.values()], m.guild.id)
    return m.reply({
      embeds: [conn.embed({
        title: `${m.guild.name} roles`,
        description: list.length ? listOf(list) : 'No roles.',
        footer: { text: `${list.length} role(s)` }
      })]
    })
  },

  async roleinfo(m, { args, conn }) {
    const role = await conn.find.role(m.guild, args.role)
    if (!role) return fail(m, 'That role was not found in this server.')
    const perms = conn.roles.perms(role)
    return m.reply({
      ephemeral: true,
      embeds: [conn.embed({
        title: role.name,
        fields: [
          { name: 'Mention', value: `<@&${role.id}>`, inline: true },
          { name: 'ID', value: role.id, inline: true },
          { name: 'Color', value: role.color ? role.hexColor : 'Default', inline: true },
          { name: 'Position', value: String(role.position), inline: true },
          { name: 'Shown separately', value: role.hoist ? 'Yes' : 'No', inline: true },
          { name: 'Mentionable', value: role.mentionable ? 'Yes' : 'No', inline: true },
          { name: 'Managed', value: role.managed ? 'Yes, by an integration' : 'No', inline: true },
          { name: 'Created', value: `<t:${Math.floor(role.createdTimestamp / 1000)}:D>`, inline: true },
          { name: 'Key permissions', value: perms.length ? perms.map(conn.roles.label).join(', ') : 'None' }
        ]
      })]
    })
  },

  async addrole(m, ctx, add = true) {
    const { conn, isOwner } = ctx
    const picked = await pickMember(m, ctx)
    if (picked.error) return fail(m, picked.error)
    const found = await pickRole(m, ctx)
    if (found.error) return fail(m, found.error)
    const { target } = picked
    const { role } = found
    if (!isOwner) {
      const blocked = conn.roles.hierarchy(m.guild, m.member, target)
      if (blocked) return fail(m, blocked)
    }
    const has = target.roleIds.includes(role.id)
    if (add && has) return fail(m, `<@${target.id}> already has <@&${role.id}>.`)
    if (!add && !has) return fail(m, `<@${target.id}> does not have <@&${role.id}>.`)
    try {
      if (add) await conn.memberRole.add(m.guild, target.id, role.id, `Added by ${actor(m)}`)
      else await conn.memberRole.remove(m.guild, target.id, role.id, `Removed by ${actor(m)}`)
      return m.reply(add ? `Added <@&${role.id}> to <@${target.id}>.` : `Removed <@&${role.id}> from <@${target.id}>.`)
    } catch {
      return fail(m, `I could not ${add ? 'add' : 'remove'} that role, check my permissions and role position.`)
    }
  },

  removerole(m, ctx) {
    return actions.addrole(m, ctx, false)
  },

  async createrole(m, { args, usedPrefix }) {
    const name = String(args.name || '').trim().slice(0, 100)
    if (!name) return fail(m, 'Give the role a name.')
    try {
      const role = await m.guild.roles.create({ name, reason: `Created by ${actor(m)}` })
      return m.reply(`Created <@&${role.id}>. Set its color with \`${usedPrefix}colorrole\`.`)
    } catch {
      return fail(m, 'I could not create the role, check my Manage Roles permission.')
    }
  },

  async deleterole(m, ctx) {
    const { role, error } = await pickRole(m, ctx)
    if (error) return fail(m, error)
    const name = role.name
    try {
      await role.delete(`Deleted by ${actor(m)}`)
    } catch {
      return fail(m, 'I could not delete that role, check my Manage Roles permission.')
    }
    ctx.conn.cfg.forget(m.guild.id, role.id)
    return m.reply(`Deleted the role **${name}**.`)
  },

  async renamerole(m, ctx) {
    const { role, error } = await pickRole(m, ctx)
    if (error) return fail(m, error)
    const name = String(ctx.args.name || '').trim().slice(0, 100)
    if (!name) return fail(m, 'Give the role a new name.')
    try {
      await role.edit({ name }, `Renamed by ${actor(m)}`)
    } catch {
      return fail(m, 'I could not rename that role, check my Manage Roles permission.')
    }
    return m.reply(`Renamed <@&${role.id}> to **${name}**.`)
  },

  async colorrole(m, ctx) {
    const { role, error } = await pickRole(m, ctx)
    if (error) return fail(m, error)
    const color = ctx.conn.roles.color(ctx.args.color)
    if (color === null) return fail(m, 'Use a hex color like `#ff8800`, or `off` to remove the color.')
    try {
      await role.edit({ color }, `Recolored by ${actor(m)}`)
    } catch {
      return fail(m, 'I could not change that color, check my Manage Roles permission.')
    }
    if (color === 0) return m.reply(`Removed the color of <@&${role.id}>.`)
    return m.reply(`Changed the color of <@&${role.id}> to \`#${color.toString(16).padStart(6, '0')}\`.`)
  },

  async autorole(m, ctx, off = false) {
    const { args, conn } = ctx
    const turnOff = () => {
      if (!conn.cfg.get(m.guild.id)?.autoRole) return fail(m, 'Auto role is already off.')
      conn.cfg.set(m.guild.id, { autoRole: null })
      return m.reply('Auto role turned off.')
    }
    if (off || (typeof args.role === 'string' && args.role.toLowerCase() === 'off')) return turnOff()
    if (!args.role) {
      const current = conn.cfg.get(m.guild.id)?.autoRole
      return fail(m, current ? `New members get <@&${current}>.` : 'Auto role is off. Use `autorole @role` to turn it on.')
    }
    const { role, error } = await pickRole(m, ctx)
    if (error) return fail(m, error)
    conn.cfg.set(m.guild.id, { autoRole: role.id })
    return m.reply(`New members will get <@&${role.id}>.`)
  },

  autoroleoff(m, ctx) {
    return actions.autorole(m, ctx, true)
  },

  async reactrole(m, { args, isOwner, conn }) {
    let ref = conn.cfg.reactions.parseMessage(args.message, m.chat)
    let pairsText = args.pairs
    if (!ref && m.quoted?.id) {
      ref = { guildId: m.guild?.id ?? null, channelId: m.chat, messageId: m.quoted.id }
      pairsText = [args.message, args.pairs].filter(Boolean).join(' ')
    }
    if (!ref) return fail(m, 'Give the message ID or link, or reply to the message.')
    if (!m.guild || (ref.guildId && ref.guildId !== m.guild.id)) return fail(m, 'That message is in another server.')

    const resolved = await conn.cfg.reactions.resolve(m.guild, m.member, isOwner, pairsText)
    if (resolved.error) return fail(m, resolved.error)

    try {
      await conn.client.rest.get(`/channels/${ref.channelId}/messages/${ref.messageId}`)
    } catch {
      return fail(m, 'I could not find that message in this server.')
    }

    const added = []
    for (const pair of resolved.pairs) {
      try {
        await conn.client.rest.put(`/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(pair.emoji.path)}/@me`)
      } catch {
        return fail(m, `I could not add ${pair.emoji.display}. Check the emoji and my Add Reactions permission.`)
      }
      conn.cfg.reactions.add(m.guild.id, ref.messageId, ref.channelId, pair.emoji, pair.role.id)
      added.push(`${pair.emoji.display} → <@&${pair.role.id}>`)
    }
    return fail(m, `Added ${added.length} reaction role(s) to that message:\n${added.join('\n')}`)
  },

  async unreactrole(m, { args, conn }) {
    const emoji = conn.cfg.reactions.parseEmoji(args.emoji)
    if (!emoji) return fail(m, 'Give one emoji, for example 🎮 or a server emoji.')

    let ref = args.message ? conn.cfg.reactions.parseMessage(args.message, m.chat) : null
    if (!ref && m.quoted?.id) ref = { guildId: m.guild?.id ?? null, channelId: m.chat, messageId: m.quoted.id }
    if (!ref) return fail(m, 'Reply to the message, or give its ID or link.')
    if (!m.guild || (ref.guildId && ref.guildId !== m.guild.id)) return fail(m, 'That message is in another server.')

    const entry = conn.cfg.reactions.list(m.guild.id)[String(ref.messageId)]
    if (!entry?.emojis?.[emoji.key]) return fail(m, `No reaction role uses ${emoji.display} on that message.`)

    conn.cfg.reactions.remove(m.guild.id, ref.messageId, emoji.key)
    await conn.client.rest.delete(`/channels/${ref.channelId}/messages/${ref.messageId}/reactions/${encodeURIComponent(emoji.path)}/@me`).catch(() => {})
    return m.reply(`Removed the reaction role for ${emoji.display}.`)
  },

  async reactroles(m, { conn }) {
    const lines = []
    for (const [messageId, entry] of Object.entries(conn.cfg.reactions.list(m.guild.id))) {
      for (const value of Object.values(entry.emojis || {})) {
        lines.push(`${value.display} → <@&${value.roleId}> • https://discord.com/channels/${m.guild.id}/${entry.channelId}/${messageId}`)
      }
    }
    if (!lines.length) return fail(m, 'There are no reaction roles yet. Use `rolepanel` or `reactrole` to add some.')
    return m.reply({ ephemeral: true, embeds: [conn.embed({ title: 'Reaction roles', description: lines.join('\n').slice(0, 3900) })] })
  },

  async rolepanel(m, { args, isOwner, conn }) {
    const resolved = await conn.cfg.reactions.resolve(m.guild, m.member, isOwner, args.pairs)
    if (resolved.error) return fail(m, resolved.error)

    const lines = resolved.pairs.map(pair => `${pair.emoji.display}  →  <@&${pair.role.id}>`)
    const panel = await m.channel.send({
      embeds: [conn.embed({
        title: 'Choose your roles',
        description: `React to get a role, and remove your reaction to drop it.\n\n${lines.join('\n')}`
      })]
    })

    try {
      for (const pair of resolved.pairs) {
        await conn.client.rest.put(`/channels/${m.chat}/messages/${panel.id}/reactions/${encodeURIComponent(pair.emoji.path)}/@me`)
      }
    } catch {
      await panel.delete?.().catch(() => {})
      return fail(m, 'I could not add the reactions. Check the emojis and my Add Reactions permission.')
    }

    for (const pair of resolved.pairs) conn.cfg.reactions.add(m.guild.id, panel.id, m.chat, pair.emoji, pair.role.id)
    return fail(m, `Role panel created with ${resolved.pairs.length} role(s).`)
  }
}

const ALIASES = {
  giverole: 'addrole',
  takerole: 'removerole',
  newrole: 'createrole',
  delrole: 'deleterole'
}

let handler = async (m, ctx) => {
  const name = String(ctx.command || '').toLowerCase()
  const run = actions[ALIASES[name] || name]
  if (!run) return
  return run(m, ctx)
}

handler.command = [
  'roles', 'roleinfo',
  'addrole', 'giverole', 'removerole', 'takerole',
  'createrole', 'newrole', 'deleterole', 'delrole', 'renamerole', 'colorrole',
  'autorole', 'autoroleoff',
  'reactrole', 'unreactrole', 'reactroles', 'rolepanel'
]
handler.description = {
  roles: 'List server roles, or the roles of a member',
  roleinfo: 'Show details about a role',
  addrole: 'Give a role to a member',
  removerole: 'Remove a role from a member',
  createrole: 'Create a new role in this server',
  deleterole: 'Delete a role from this server',
  renamerole: 'Rename a role in this server',
  colorrole: 'Change the color of a role, or remove it with "off"',
  autorole: 'Set the role given to every new member',
  reactrole: 'Add reaction roles to an existing message',
  unreactrole: 'Stop giving a role for a reaction on a message',
  reactroles: 'List the reaction roles in this server',
  rolepanel: 'Post a message where members react to get roles'
}
handler.tags = ['Roles']
handler.group = true
handler.help = [
  { command: 'roles', name: 'user', description: 'Member to show roles for (leave empty for all server roles)', type: 'user' },
  { command: 'roleinfo', name: 'role', description: 'Role to inspect', type: 'role', required: true },
  { command: 'addrole', name: 'user', description: 'Member to give the role to', type: 'user', required: true },
  { command: 'addrole', name: 'role', description: 'Role to give', type: 'role', required: true },
  { command: 'removerole', name: 'user', description: 'Member to remove the role from', type: 'user', required: true },
  { command: 'removerole', name: 'role', description: 'Role to remove', type: 'role', required: true },
  { command: 'createrole', name: 'name', description: 'Name of the new role (up to 100 characters)', type: 'string', required: true },
  { command: 'deleterole', name: 'role', description: 'Role to delete', type: 'role', required: true },
  { command: 'renamerole', name: 'role', description: 'Role to rename', type: 'role', required: true },
  { command: 'renamerole', name: 'name', description: 'New name (up to 100 characters)', type: 'string', required: true },
  { command: 'colorrole', name: 'role', description: 'Role to recolor', type: 'role', required: true },
  { command: 'colorrole', name: 'color', description: 'Hex color like #ff8800, or "off"', type: 'string', required: true },
  { command: 'autorole', name: 'role', description: 'Role to give new members (or "off")', type: 'role' },
  { command: 'reactrole', name: 'message', description: 'Message ID or link (or reply to the message)', type: 'string', required: true },
  { command: 'reactrole', name: 'pairs', description: 'Emoji and role pairs, like 🎮 @Gamer, 🎵 @Music', type: 'string', required: true },
  { command: 'unreactrole', name: 'emoji', description: 'Emoji to remove', type: 'string', required: true },
  { command: 'unreactrole', name: 'message', description: 'Message ID or link (or reply to the message)', type: 'string' },
  { command: 'rolepanel', name: 'pairs', description: 'Emoji and role pairs, like 🎮 @Gamer, 🎵 @Music', type: 'string', required: true }
]

handler.platform = {
  whatsapp: false,
  discord: { permission: (args, name) => (['roles', 'roleinfo'].includes(name) ? null : ['manageRoles']) }
}

export default handler
