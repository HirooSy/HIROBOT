function summaryOf(cmd, guildId, cfg, roles) {
  const ids = cfg.access.roles(guildId, cmd.name)
  if (ids.length) {
    return `Only members with one of these roles can use it: ${ids.map(id => `<@&${id}>`).join(' ')}. Server admins and bot owners can always use it.`
  }
  if (cfg.access.locked.has(cmd.name)) return 'Needs the Manage Server permission. Role access cannot change this.'
  if (cmd.owner) return 'Bot owners only.'
  if (typeof cmd.permission === 'function') return 'Everyone can use it, but some options need a permission.'
  if (cmd.permission) return `Needs the ${[].concat(cmd.permission).map(roles.label).join(' and ')} permission.`
  return 'Everyone can use it.'
}

let handler = async (m, { args, conn, usedPrefix, command }) => {
  if (command == 'access') {
    const query = String(args.command ?? '').trim()
    if (query) {
      const cmd = conn.find.command(query)
      if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${conn.find.commandName(query)}\` was not found.` })
      return m.reply({ ephemeral: true, embeds: [conn.embed({ title: `Access: ${cmd.name}`, description: summaryOf(cmd, m.guild.id, conn.cfg, conn.roles) })] })
    }

    const names = Object.keys(conn.cfg.access.rules(m.guild.id)).sort()
    const lines = names.map(name => `\`${name}\` → ${conn.cfg.access.roles(m.guild.id, name).map(id => `<@&${id}>`).join(' ')}`)
    const body = lines.length ? lines.join('\n') : 'No command is restricted. Every command uses its default permission.'
    return m.reply({
      ephemeral: true,
      embeds: [conn.embed({
        title: 'Command access',
        description: `${body.slice(0, 3400)}\n\nUse \`${usedPrefix}allow <role> <command>\` to restrict a command, \`${usedPrefix}disallow <role> <command>\` to remove a role, and \`${usedPrefix}resetaccess <command>\` to clear it.`
      })]
    })
  } else if (command == 'allow') {
    const role = await conn.find.role(m.guild, args.role)
    if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })
    if (role.id === m.guild.id) {
      return m.reply({ ephemeral: true, content: 'Pick a role other than @everyone. Commands with no roles are already open to everyone.' })
    }

    const query = conn.find.commandName(args.command)
    const cmd = conn.find.command(query)
    if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
    if (conn.cfg.access.locked.has(cmd.name)) {
      return m.reply({ ephemeral: true, content: `\`${cmd.name}\` always needs the Manage Server permission, so its access cannot be changed.` })
    }

    const current = conn.cfg.access.roles(m.guild.id, cmd.name)
    if (current.includes(role.id)) return m.reply({ ephemeral: true, content: `<@&${role.id}> can already use \`${cmd.name}\`.` })

    conn.cfg.access.set(m.guild.id, cmd.name, [...current, role.id])
    return m.reply(`<@&${role.id}> can now use \`${cmd.name}\`. Only the roles on its list and server admins can use it. Check it with \`${usedPrefix}access ${cmd.name}\`.`)
  } else if (command == 'disallow') {
    const role = await conn.find.role(m.guild, args.role)
    if (!role) return m.reply({ ephemeral: true, content: 'That role was not found in this server.' })

    const query = conn.find.commandName(args.command)
    const cmd = conn.find.command(query)
    if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
    if (conn.cfg.access.locked.has(cmd.name)) {
      return m.reply({ ephemeral: true, content: `\`${cmd.name}\` always needs the Manage Server permission, so its access cannot be changed.` })
    }

    const current = conn.cfg.access.roles(m.guild.id, cmd.name)
    if (!current.includes(role.id)) {
      return m.reply({ ephemeral: true, content: `<@&${role.id}> is not on the list for \`${cmd.name}\`.` })
    }

    const next = current.filter(id => id !== role.id)
    conn.cfg.access.set(m.guild.id, cmd.name, next)
    if (next.length) return m.reply(`<@&${role.id}> can no longer use \`${cmd.name}\`.`)
    return m.reply(`\`${cmd.name}\` has no role restrictions anymore, so it uses its default permission again.`)
  } else {
    const query = conn.find.commandName(args.command)
    const cmd = conn.find.command(query)
    if (!cmd) return m.reply({ ephemeral: true, content: `Command \`${query}\` was not found.` })
    if (conn.cfg.access.locked.has(cmd.name)) {
      return m.reply({ ephemeral: true, content: `\`${cmd.name}\` always needs the Manage Server permission, so there is nothing to reset.` })
    }
    if (!conn.cfg.access.roles(m.guild.id, cmd.name).length) {
      return m.reply({ ephemeral: true, content: `\`${cmd.name}\` has no role restrictions.` })
    }
    conn.cfg.access.set(m.guild.id, cmd.name, [])
    return m.reply(`\`${cmd.name}\` is open again to its default permission.`)
  }
}

handler.command = ['access', 'allow', 'disallow', 'resetaccess']
handler.description = {
  access: 'Show which roles can use each command in this server',
  allow: 'Let a role use a command, which limits it to the roles you add',
  disallow: 'Remove a role from the list of roles that can use a command',
  resetaccess: 'Clear the role restrictions of a command'
}
handler.tags = ['Settings']
handler.help = [
  { command: 'access', name: 'command', description: 'Command to check, leave empty to list every restriction', type: 'string' },
  { command: 'allow', name: 'role', description: 'Role that can use the command', type: 'role', required: true },
  { command: 'allow', name: 'command', description: 'Command name, for example ban or createrole', type: 'string', required: true },
  { command: 'disallow', name: 'role', description: 'Role to remove from the command', type: 'role', required: true },
  { command: 'disallow', name: 'command', description: 'Command name, for example ban', type: 'string', required: true },
  { command: 'resetaccess', name: 'command', description: 'Command to reset, for example ban', type: 'string', required: true }
]
handler.group = true
handler.platform = { whatsapp: false, discord: { permission: ['manageServer'] } }

export default handler
