import { readFileSync } from 'node:fs'
import { Collection } from './collection.js'
import { FLAGS, Permissions, computePermissions } from './permissions.js'
import { ActivityType, InteractionResponseType, InteractionType, MessageFlags } from './constants.js'

export const CDN = 'https://cdn.discordapp.com'

const MESSAGE_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000
const BULK_DELETE_LIMIT = 100
const MAX_SLOWMODE = 21600
const MAX_BAN_DELETE_SECONDS = 604800
const TEXT_CHANNEL_TYPES = [0, 5, 10, 11, 12]
const THREAD_CHANNEL_TYPES = [10, 11, 12]
const SYSTEM_MESSAGE_TYPES = [0, 19, 20]

export const snowflakeTime = id => {
  try {
    return Number((BigInt(id) >> 22n) + 1420070400000n)
  } catch {
    return 0
  }
}

const idOf = input => (input && typeof input === 'object' ? String(input.id) : String(input))
const listOf = input => {
  if (input === undefined || input === null) return []
  if (input instanceof Map) return [...input.values()]
  return Array.isArray(input) ? input : [input]
}
const pick = (source, keys) => {
  const out = {}
  for (const key of keys) if (source[key] !== undefined) out[key] = source[key]
  return out
}

export function toRequest(input) {
  const src = typeof input === 'string' ? { content: input } : { ...(input || {}) }
  const rawFiles = Array.isArray(src.files) ? src.files : []
  delete src.files
  delete src.ephemeral
  delete src.failIfNotExists
  if (src.allowedMentions !== undefined) {
    src.allowed_mentions = src.allowedMentions
    delete src.allowedMentions
  }
  const body = {}
  for (const [key, value] of Object.entries(src)) if (value !== undefined) body[key] = value
  if (!rawFiles.length) return { body, files: [] }
  const files = rawFiles.map((file, id) => {
    const data = Buffer.isBuffer(file.attachment) || file.attachment instanceof Uint8Array
      ? Buffer.from(file.attachment)
      : readFileSync(file.attachment)
    return { id, name: file.name || `file${id}`, data }
  })
  body.attachments = files.map(file => ({ id: file.id, filename: file.name }))
  return { body, files }
}

export function withEphemeral(input) {
  const src = typeof input === 'string' ? { content: input } : { ...(input || {}) }
  if (src.ephemeral) src.flags = (src.flags ?? 0) | MessageFlags.Ephemeral
  return src
}

export function toAttachment(a) {
  if (!a) return null
  return { id: a.id, url: a.url, name: a.filename, contentType: a.content_type ?? '', size: a.size ?? 0 }
}

export class User {
  constructor(client, d) {
    this.client = client
    this.id = d.id
    this.username = ''
    this.globalName = null
    this.discriminator = '0'
    this.bot = false
    this.avatar = null
    this.update(d)
  }

  update(d) {
    if (d.username !== undefined) this.username = d.username ?? ''
    if (d.global_name !== undefined) this.globalName = d.global_name ?? null
    if (d.discriminator !== undefined) this.discriminator = d.discriminator ?? '0'
    if (d.avatar !== undefined) this.avatar = d.avatar ?? null
    if (d.bot !== undefined) this.bot = !!d.bot
    return this
  }

  get tag() {
    return this.discriminator && this.discriminator !== '0' ? `${this.username}#${this.discriminator}` : this.username
  }

  get createdTimestamp() {
    return snowflakeTime(this.id)
  }

  get createdAt() {
    return new Date(this.createdTimestamp)
  }

  displayAvatarURL({ size = 128 } = {}) {
    if (!this.avatar) return `${CDN}/embed/avatars/${Number((BigInt(this.id) >> 22n) % 6n)}.png`
    const ext = this.avatar.startsWith('a_') ? 'gif' : 'png'
    return `${CDN}/avatars/${this.id}/${this.avatar}.${ext}?size=${size}`
  }

  async createDM() {
    const cached = this.client.dmChannels.get(this.id)
    if (cached) return cached
    const d = await this.client.rest.post('/users/@me/channels', { body: { recipient_id: this.id } })
    const channel = this.client.resolveChannel(d)
    this.client.dmChannels.set(this.id, channel)
    return channel
  }

  async send(payload) {
    const channel = await this.createDM()
    return channel.send(payload)
  }

  toString() {
    return `<@${this.id}>`
  }
}

export class ClientUser extends User {
  setPresence(options = {}) {
    this.client.setPresence(options)
    return this
  }

  setActivity(name, { type = ActivityType.Playing, url, status } = {}) {
    const current = this.client.presence || {}
    return this.setPresence({
      status: status ?? current.status ?? 'online',
      activities: name ? [{ name, type, ...(url ? { url } : {}) }] : []
    })
  }

  setStatus(status) {
    const current = this.client.presence || {}
    return this.setPresence({ status, activities: current.activities ?? [] })
  }
}

export class Role {
  constructor(guild, d) {
    this.guild = guild
    this.client = guild.client
    this.id = d.id
    this.name = ''
    this.position = 0
    this.bits = 0n
    this.color = 0
    this.hoist = false
    this.mentionable = false
    this.managed = false
    this.update(d)
  }

  update(d) {
    if (d.name !== undefined) this.name = d.name ?? ''
    if (d.position !== undefined) this.position = d.position ?? 0
    if (d.permissions !== undefined) this.bits = BigInt(d.permissions ?? 0)
    if (d.color !== undefined) this.color = d.color ?? 0
    if (d.hoist !== undefined) this.hoist = !!d.hoist
    if (d.mentionable !== undefined) this.mentionable = !!d.mentionable
    if (d.managed !== undefined) this.managed = !!d.managed
    return this
  }

  get permissions() {
    return new Permissions(this.bits)
  }

  get hexColor() {
    return `#${this.color.toString(16).padStart(6, '0')}`
  }

  get createdTimestamp() {
    return snowflakeTime(this.id)
  }

  get createdAt() {
    return new Date(this.createdTimestamp)
  }

  get isEveryone() {
    return this.id === this.guild.id
  }

  async edit(data = {}, reason) {
    const body = pick(data, ['name', 'color', 'hoist', 'mentionable'])
    if (data.permissions !== undefined) body.permissions = String(BigInt(data.permissions))
    const d = await this.client.rest.patch(`/guilds/${this.guild.id}/roles/${this.id}`, { body, reason })
    return this.update(d)
  }

  async delete(reason) {
    await this.client.rest.delete(`/guilds/${this.guild.id}/roles/${this.id}`, { reason })
    this.guild.roles.cache.delete(this.id)
  }

  toString() {
    return `<@&${this.id}>`
  }
}

class RoleManager {
  constructor(guild) {
    this.guild = guild
    this.cache = new Collection()
  }

  get everyone() {
    return this.cache.get(this.guild.id) ?? null
  }

  async fetch(id) {
    const list = await this.guild.client.rest.get(`/guilds/${this.guild.id}/roles`)
    this.cache.clear()
    for (const d of list || []) this.cache.set(d.id, new Role(this.guild, d))
    if (id === undefined) return this.cache
    return this.cache.get(idOf(id)) ?? null
  }

  async create({ name, color, hoist, mentionable, permissions, reason } = {}) {
    const body = pick({ name, color, hoist, mentionable }, ['name', 'color', 'hoist', 'mentionable'])
    if (permissions !== undefined) body.permissions = String(BigInt(permissions))
    const d = await this.guild.client.rest.post(`/guilds/${this.guild.id}/roles`, { body, reason })
    const role = new Role(this.guild, d)
    this.cache.set(role.id, role)
    return role
  }
}

class MemberManager {
  constructor(guild) {
    this.guild = guild
    this.cache = new Collection()
  }

  get me() {
    return this.cache.get(this.guild.client.user?.id) ?? null
  }

  async fetch(id) {
    if (id === undefined) return this.list()
    const d = await this.guild.client.rest.get(`/guilds/${this.guild.id}/members/${idOf(id)}`)
    return this.guild.upsertMember(d)
  }

  async list({ limit = 1000 } = {}) {
    const out = new Collection()
    let after = '0'
    while (out.size < limit) {
      const pageSize = Math.min(1000, limit - out.size)
      const batch = await this.guild.client.rest.get(`/guilds/${this.guild.id}/members`, { query: { limit: pageSize, after } })
      if (!Array.isArray(batch) || !batch.length) break
      for (const d of batch) {
        const member = this.guild.upsertMember(d)
        if (member) out.set(member.id, member)
        after = d.user?.id ?? after
      }
      if (batch.length < pageSize) break
    }
    return out
  }

  async search({ query = '', limit = 10 } = {}) {
    const list = await this.guild.client.rest.get(`/guilds/${this.guild.id}/members/search`, {
      query: { query: String(query), limit: Math.min(Math.max(Number(limit) || 10, 1), 100) }
    })
    const out = new Collection()
    for (const d of list || []) {
      const member = this.guild.upsertMember(d)
      if (member) out.set(member.id, member)
    }
    return out
  }

  remove(id) {
    return this.cache.delete(idOf(id))
  }
}

class ChannelManager {
  constructor(guild) {
    this.guild = guild
    this.cache = new Collection()
  }

  upsert(d) {
    const existing = this.cache.get(d.id)
    if (existing) return existing.update(d)
    const channel = new Channel(this.guild.client, d, this.guild)
    this.cache.set(channel.id, channel)
    return channel
  }

  async fetch(id) {
    const list = await this.guild.client.rest.get(`/guilds/${this.guild.id}/channels`)
    const seen = new Set()
    for (const d of list || []) {
      seen.add(d.id)
      this.upsert(d)
    }
    for (const key of [...this.cache.keys()]) if (!seen.has(key)) this.cache.delete(key)
    if (id === undefined) return this.cache
    return this.cache.get(idOf(id)) ?? null
  }

  async create({ name, type = 0, parent, topic, nsfw, rateLimitPerUser, bitrate, userLimit, position, reason } = {}) {
    const body = pick({ name, type, topic, nsfw, bitrate, position }, ['name', 'type', 'topic', 'nsfw', 'bitrate', 'position'])
    if (rateLimitPerUser !== undefined) body.rate_limit_per_user = rateLimitPerUser
    if (userLimit !== undefined) body.user_limit = userLimit
    if (parent !== undefined) body.parent_id = parent === null ? null : idOf(parent)
    const d = await this.guild.client.rest.post(`/guilds/${this.guild.id}/channels`, { body, reason })
    return this.upsert(d)
  }

  async delete(channel, reason) {
    const id = idOf(channel)
    await this.guild.client.rest.delete(`/channels/${id}`, { reason })
    this.cache.delete(id)
    this.guild.client.channels.delete(id)
  }
}

class BanManager {
  constructor(guild) {
    this.guild = guild
    this.cache = new Collection()
  }

  add(d) {
    const user = this.guild.client.upsertUser(d.user)
    const ban = { user, id: user.id, reason: d.reason ?? null }
    this.cache.set(user.id, ban)
    return ban
  }

  async fetch(id) {
    if (id === undefined) {
      const list = await this.guild.client.rest.get(`/guilds/${this.guild.id}/bans`, { query: { limit: 1000 } })
      this.cache.clear()
      for (const d of list || []) this.add(d)
      return this.cache
    }
    const d = await this.guild.client.rest.get(`/guilds/${this.guild.id}/bans/${idOf(id)}`)
    return this.add(d)
  }

  async create(id, { reason, deleteMessageSeconds = 0 } = {}) {
    const userId = idOf(id)
    const seconds = Math.min(Math.max(Math.trunc(Number(deleteMessageSeconds)) || 0, 0), MAX_BAN_DELETE_SECONDS)
    await this.guild.client.rest.put(`/guilds/${this.guild.id}/bans/${userId}`, {
      body: { delete_message_seconds: seconds },
      reason
    })
    return userId
  }

  async remove(id, reason) {
    const userId = idOf(id)
    await this.guild.client.rest.delete(`/guilds/${this.guild.id}/bans/${userId}`, { reason })
    this.cache.delete(userId)
    return userId
  }
}

export class Member {
  constructor(guild, d, user) {
    this.guild = guild
    this.client = guild.client
    this.user = user
    this.id = user.id
    this.nick = null
    this.roleIds = []
    this.joinedAt = null
    this.timeoutUntil = null
    this.update(d)
  }

  update(d) {
    if (d.nick !== undefined) this.nick = d.nick ?? null
    if (d.roles !== undefined) this.roleIds = [...(d.roles ?? [])]
    if (d.joined_at !== undefined) this.joinedAt = d.joined_at ? new Date(d.joined_at) : null
    if (d.communication_disabled_until !== undefined) {
      this.timeoutUntil = d.communication_disabled_until ? new Date(d.communication_disabled_until) : null
    }
    return this
  }

  get displayName() {
    return this.nick || this.user.globalName || this.user.username
  }

  get joinedTimestamp() {
    return this.joinedAt ? this.joinedAt.getTime() : null
  }

  get roles() {
    const cache = new Collection()
    for (const id of this.roleIds) {
      const role = this.guild.roles.cache.get(id)
      if (role) cache.set(id, role)
    }
    const everyone = this.guild.roles.everyone
    if (everyone) cache.set(everyone.id, everyone)
    return {
      cache,
      everyone,
      length: cache.size,
      add: (input, reason) => this.addRoles(input, reason),
      remove: (input, reason) => this.removeRoles(input, reason)
    }
  }

  get permissions() {
    return new Permissions(computePermissions(this.guild, this.roleIds, this.user.id, this.guild.ownerId))
  }

  get voice() {
    return this.guild.voiceStates.get(this.id) ?? null
  }

  get manageable() {
    return this.guild.canManage(this)
  }

  get kickable() {
    return this.guild.canManage(this) && this.guild.botHas('KickMembers')
  }

  get bannable() {
    return this.guild.canManage(this) && this.guild.botHas('BanMembers')
  }

  get moderatable() {
    return this.guild.canManage(this) && this.guild.botHas('ModerateMembers')
  }

  isCommunicationDisabled() {
    return !!this.timeoutUntil && this.timeoutUntil.getTime() > Date.now()
  }

  async addRoles(input, reason) {
    for (const id of listOf(input).map(idOf)) {
      await this.client.rest.put(`/guilds/${this.guild.id}/members/${this.id}/roles/${id}`, { reason })
      if (!this.roleIds.includes(id)) this.roleIds.push(id)
    }
    return this
  }

  async removeRoles(input, reason) {
    for (const id of listOf(input).map(idOf)) {
      await this.client.rest.delete(`/guilds/${this.guild.id}/members/${this.id}/roles/${id}`, { reason })
      this.roleIds = this.roleIds.filter(roleId => roleId !== id)
    }
    return this
  }

  async kick(reason) {
    await this.client.rest.delete(`/guilds/${this.guild.id}/members/${this.id}`, { reason })
    this.guild.members.cache.delete(this.id)
    return this
  }

  async ban({ reason, deleteMessageSeconds = 0 } = {}) {
    await this.guild.bans.create(this.id, { reason, deleteMessageSeconds })
    this.guild.members.cache.delete(this.id)
    return this
  }

  async setNickname(nick, reason) {
    const value = nick === undefined || nick === null || String(nick).trim() === '' ? null : String(nick)
    await this.client.rest.patch(`/guilds/${this.guild.id}/members/${this.id}`, { body: { nick: value }, reason })
    this.nick = value
    return this
  }

  async timeout(ms, reason) {
    const until = ms == null ? null : new Date(Date.now() + ms).toISOString()
    await this.client.rest.patch(`/guilds/${this.guild.id}/members/${this.id}`, {
      body: { communication_disabled_until: until },
      reason
    })
    this.timeoutUntil = until ? new Date(until) : null
    return this
  }

  async send(payload) {
    return this.user.send(payload)
  }

  toString() {
    return `<@${this.id}>`
  }
}

export class VoiceState {
  constructor(guild, d) {
    this.guild = guild
    this.client = guild.client
    this.id = d.user_id ?? d.id
    this.channelId = d.channel_id ?? null
    this.sessionId = d.session_id ?? null
    this.memberData = d.member ?? null
  }

  get channel() {
    return this.channelId ? this.guild.channels.cache.get(this.channelId) ?? null : null
  }

  get member() {
    return this.guild.memberFromVoice(this)
  }
}

export class Channel {
  constructor(client, d, guild = null) {
    this.client = client
    this.guild = guild
    this.id = d.id
    this.guildId = d.guild_id ?? guild?.id ?? null
    this.name = null
    this.type = 0
    this.overwrites = []
    this.topic = null
    this.nsfw = false
    this.position = 0
    this.parentId = null
    this.rateLimitPerUser = 0
    this.bitrate = null
    this.userLimit = null
    this.messages = new MessageManager(this)
    this.permissionOverwrites = {
      edit: (target, perms, reason) => this.editOverwrite(target, perms, reason),
      delete: (target, reason) => this.deleteOverwrite(target, reason)
    }
    this.update(d)
  }

  update(d) {
    if (d.guild_id !== undefined) this.guildId = d.guild_id ?? this.guildId
    if (d.name !== undefined) this.name = d.name ?? null
    if (d.type !== undefined) this.type = d.type
    if (d.permission_overwrites !== undefined) this.overwrites = d.permission_overwrites ?? []
    if (d.topic !== undefined) this.topic = d.topic ?? null
    if (d.nsfw !== undefined) this.nsfw = !!d.nsfw
    if (d.position !== undefined) this.position = d.position ?? 0
    if (d.parent_id !== undefined) this.parentId = d.parent_id ?? null
    if (d.rate_limit_per_user !== undefined) this.rateLimitPerUser = d.rate_limit_per_user ?? 0
    if (d.bitrate !== undefined) this.bitrate = d.bitrate ?? null
    if (d.user_limit !== undefined) this.userLimit = d.user_limit ?? null
    return this
  }

  get isVoice() {
    return this.type === 2 || this.type === 13
  }

  get isText() {
    return TEXT_CHANNEL_TYPES.includes(this.type)
  }

  get isThread() {
    return THREAD_CHANNEL_TYPES.includes(this.type)
  }

  get isDM() {
    return this.type === 1 || this.type === 3
  }

  get isCategory() {
    return this.type === 4
  }

  get members() {
    const out = new Collection()
    if (!this.guild) return out
    for (const state of this.guild.voiceStates.values()) {
      if (state.channelId !== this.id) continue
      const member = this.guild.memberFromVoice(state)
      if (member) out.set(member.id, member)
    }
    return out
  }

  permissionsFor(member) {
    if (!member || !this.guild) return null
    return new Permissions(computePermissions(this.guild, member.roleIds, member.user.id, this.guild.ownerId, this.overwrites))
  }

  async editOverwrite(target, perms = {}, reason) {
    const id = idOf(target)
    const type = target instanceof Member ? 1 : 0
    const current = this.overwrites.find(o => o.id === id)
    let allow = current ? BigInt(current.allow) : 0n
    let deny = current ? BigInt(current.deny) : 0n
    for (const [name, value] of Object.entries(perms)) {
      const bit = FLAGS[name]
      if (bit === undefined) continue
      if (value === true) {
        allow |= bit
        deny &= ~bit
      } else if (value === false) {
        deny |= bit
        allow &= ~bit
      } else {
        allow &= ~bit
        deny &= ~bit
      }
    }
    const next = { id, type, allow: allow.toString(), deny: deny.toString() }
    await this.client.rest.put(`/channels/${this.id}/permissions/${id}`, { body: next, reason })
    this.overwrites = this.overwrites.filter(o => o.id !== id).concat(next)
    return this
  }

  async deleteOverwrite(target, reason) {
    const id = idOf(target)
    await this.client.rest.delete(`/channels/${this.id}/permissions/${id}`, { reason })
    this.overwrites = this.overwrites.filter(o => o.id !== id)
    return this
  }

  async edit(data = {}, reason) {
    const body = {}
    if (data.name !== undefined) body.name = data.name
    if (data.topic !== undefined) body.topic = data.topic
    if (data.nsfw !== undefined) body.nsfw = !!data.nsfw
    if (data.rateLimitPerUser !== undefined) body.rate_limit_per_user = Math.min(Math.max(Math.trunc(Number(data.rateLimitPerUser)) || 0, 0), MAX_SLOWMODE)
    if (data.bitrate !== undefined) body.bitrate = data.bitrate
    if (data.userLimit !== undefined) body.user_limit = data.userLimit
    if (data.parentId !== undefined) body.parent_id = data.parentId
    if (data.position !== undefined) body.position = data.position
    const d = await this.client.rest.patch(`/channels/${this.id}`, { body, reason })
    return this.update(d)
  }

  setRateLimitPerUser(seconds, reason) {
    return this.edit({ rateLimitPerUser: seconds }, reason)
  }

  async delete(reason) {
    await this.client.rest.delete(`/channels/${this.id}`, { reason })
    this.guild?.channels.cache.delete(this.id)
    this.client.channels.delete(this.id)
  }

  async send(payload) {
    const { body, files } = toRequest(payload)
    const d = await this.client.rest.post(`/channels/${this.id}/messages`, { body, files })
    return this.messages.add(d)
  }

  async sendTyping() {
    await this.client.rest.post(`/channels/${this.id}/typing`)
  }

  bulkDelete(messages, reason) {
    return this.messages.bulkDelete(messages, reason)
  }

  async createInvite(opts = {}) {
    const d = await this.client.rest.post(`/channels/${this.id}/invites`, {
      body: { max_age: opts.maxAge, max_uses: opts.maxUses, unique: opts.unique, temporary: opts.temporary }
    })
    return { code: d.code, url: `https://discord.gg/${d.code}` }
  }

  toString() {
    return `<#${this.id}>`
  }
}

class MessageManager {
  constructor(channel) {
    this.channel = channel
    this.cache = new Collection()
  }

  add(d) {
    const existing = this.cache.get(d.id)
    if (existing) return existing.update(d)
    const message = new Message(this.channel.client, d, this.channel)
    this.cache.set(message.id, message)
    if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value)
    return message
  }

  async fetch(id) {
    const d = await this.channel.client.rest.get(`/channels/${this.channel.id}/messages/${idOf(id)}`)
    return this.add(d)
  }

  async list({ limit = 50, before, after, around } = {}) {
    const query = { limit: Math.min(Math.max(Number(limit) || 50, 1), 100) }
    if (before) query.before = idOf(before)
    if (after) query.after = idOf(after)
    if (around) query.around = idOf(around)
    const list = await this.channel.client.rest.get(`/channels/${this.channel.id}/messages`, { query })
    const out = new Collection()
    for (const d of list || []) out.set(d.id, this.add(d))
    return out
  }

  async bulkDelete(messages, reason) {
    const cutoff = Date.now() - MESSAGE_MAX_AGE_MS
    const ids = [...new Set(listOf(messages).map(idOf))].filter(id => snowflakeTime(id) > cutoff)
    const rest = this.channel.client.rest
    const base = `/channels/${this.channel.id}/messages`
    let deleted = 0
    for (let i = 0; i < ids.length; i += BULK_DELETE_LIMIT) {
      const chunk = ids.slice(i, i + BULK_DELETE_LIMIT)
      if (chunk.length === 1) await rest.delete(`${base}/${chunk[0]}`, { reason })
      else await rest.post(`${base}/bulk-delete`, { body: { messages: chunk }, reason })
      for (const id of chunk) this.cache.delete(id)
      deleted += chunk.length
    }
    return deleted
  }
}

export class Message {
  constructor(client, d, channel = null) {
    this.client = client
    this.id = d.id
    this.channel = channel
    this.channelId = d.channel_id ?? channel?.id ?? null
    this.guild = channel?.guild ?? null
    this.author = null
    this.member = null
    this.content = ''
    this.type = 0
    this.system = false
    this.pinned = false
    this.editedTimestamp = null
    this.attachments = new Collection()
    this.embeds = []
    this.components = []
    this.mentions = { users: new Collection() }
    this.reference = null
    this.reactions = {
      cache: {
        get: emoji => ({ users: { remove: userId => this.removeReaction(emoji, userId) } })
      },
      removeAll: emoji => this.clearReactions(emoji)
    }
    this.update(d)
  }

  update(d) {
    if (d.channel_id !== undefined) this.channelId = d.channel_id
    if (d.content !== undefined) this.content = d.content ?? ''
    if (d.author) this.author = this.client.upsertUser(d.author)
    if (d.type !== undefined) {
      this.type = d.type
      this.system = !!d.type && !SYSTEM_MESSAGE_TYPES.includes(d.type)
    }
    if (d.pinned !== undefined) this.pinned = !!d.pinned
    if (d.edited_timestamp !== undefined) this.editedTimestamp = d.edited_timestamp ? Date.parse(d.edited_timestamp) : null
    if (d.attachments !== undefined) {
      this.attachments = new Collection()
      for (const a of d.attachments ?? []) this.attachments.set(a.id, toAttachment(a))
    }
    if (d.embeds !== undefined) this.embeds = d.embeds ?? []
    if (d.components !== undefined) this.components = d.components ?? []
    if (d.mentions !== undefined) {
      this.mentions = { users: new Collection((d.mentions ?? []).map(u => [u.id, this.client.upsertUser(u)])) }
    }
    if (d.message_reference !== undefined) {
      this.reference = d.message_reference?.message_id
        ? { messageId: d.message_reference.message_id, channelId: d.message_reference.channel_id ?? null }
        : null
    }
    if (this.guild && d.member && d.author) {
      this.member = this.guild.upsertMember({ ...d.member, user: d.author })
    } else if (this.guild && this.author) {
      this.member = this.guild.members.cache.get(this.author.id) ?? this.member
    }
    return this
  }

  get createdTimestamp() {
    return snowflakeTime(this.id)
  }

  get createdAt() {
    return new Date(this.createdTimestamp)
  }

  get url() {
    return `https://discord.com/channels/${this.guild?.id ?? '@me'}/${this.channelId}/${this.id}`
  }

  async fetch() {
    const d = await this.client.rest.get(`/channels/${this.channelId}/messages/${this.id}`)
    return this.update(d)
  }

  async reply(payload) {
    const opts = typeof payload === 'string' ? { content: payload } : { ...(payload || {}) }
    const failIfNotExists = opts.failIfNotExists
    const { body, files } = toRequest(opts)
    body.message_reference = {
      message_id: this.id,
      channel_id: this.channelId,
      ...(this.guild ? { guild_id: this.guild.id } : {}),
      fail_if_not_exists: failIfNotExists !== false
    }
    const d = await this.client.rest.post(`/channels/${this.channelId}/messages`, { body, files })
    return this.channel ? this.channel.messages.add(d) : new Message(this.client, d, null)
  }

  async edit(payload) {
    const { body, files } = toRequest(payload)
    const d = await this.client.rest.patch(`/channels/${this.channelId}/messages/${this.id}`, { body, files })
    return this.update(d)
  }

  async delete(reason) {
    await this.client.rest.delete(`/channels/${this.channelId}/messages/${this.id}`, { reason })
    this.channel?.messages.cache.delete(this.id)
  }

  async react(emoji) {
    await this.client.rest.put(`/channels/${this.channelId}/messages/${this.id}/reactions/${encodeURIComponent(emoji)}/@me`)
  }

  async removeReaction(emoji, userId = '@me') {
    await this.client.rest.delete(`/channels/${this.channelId}/messages/${this.id}/reactions/${encodeURIComponent(emoji)}/${idOf(userId)}`)
  }

  async clearReactions(emoji) {
    const base = `/channels/${this.channelId}/messages/${this.id}/reactions`
    await this.client.rest.delete(emoji === undefined ? base : `${base}/${encodeURIComponent(emoji)}`)
  }

  async pin(reason) {
    await this.client.rest.put(`/channels/${this.channelId}/pins/${this.id}`, { reason })
    this.pinned = true
    return this
  }

  async unpin(reason) {
    await this.client.rest.delete(`/channels/${this.channelId}/pins/${this.id}`, { reason })
    this.pinned = false
    return this
  }
}

function parseOptions(client, options = [], resolved = {}, guild = null) {
  return options.map(opt => {
    const out = { name: opt.name, type: opt.type, value: opt.value, focused: !!opt.focused }
    if (opt.options) out.options = parseOptions(client, opt.options, resolved, guild)
    if (opt.type === 6) out.user = resolved.users?.[opt.value] ? client.upsertUser(resolved.users[opt.value]) : null
    if (opt.type === 7) {
      const data = resolved.channels?.[opt.value]
      out.channel = data ? client.resolveChannel({ ...data, guild_id: guild?.id ?? data.guild_id }, guild) : null
    }
    if (opt.type === 8) out.role = guild?.roles.cache.get(opt.value) ?? null
    if (opt.type === 11) out.attachment = toAttachment(resolved.attachments?.[opt.value])
    return out
  })
}

class CommandOptions {
  constructor(client, guild, data) {
    this.client = client
    this.guild = guild
    this.data = data
  }

  flat(list = this.data, out = []) {
    for (const opt of list || []) {
      out.push(opt)
      if (opt.options) this.flat(opt.options, out)
    }
    return out
  }

  find(name) {
    return this.flat().find(opt => opt.name === name) ?? null
  }

  raw(name, required) {
    const opt = this.find(name)
    if (!opt || opt.type === 1 || opt.type === 2) {
      if (required) throw new TypeError(`Missing required option: ${name}`)
      return null
    }
    return opt
  }

  getString(name, required = false) {
    return this.raw(name, required)?.value ?? null
  }

  getInteger(name, required = false) {
    return this.raw(name, required)?.value ?? null
  }

  getNumber(name, required = false) {
    return this.raw(name, required)?.value ?? null
  }

  getBoolean(name, required = false) {
    const value = this.raw(name, required)?.value
    return value === undefined ? null : !!value
  }

  getUser(name, required = false) {
    return this.raw(name, required)?.user ?? null
  }

  getMember(name, required = false) {
    const user = this.getUser(name, required)
    return user && this.guild ? this.guild.members.cache.get(user.id) ?? null : null
  }

  getChannel(name, required = false) {
    return this.raw(name, required)?.channel ?? null
  }

  getRole(name, required = false) {
    return this.raw(name, required)?.role ?? null
  }

  getAttachment(name, required = false) {
    return this.raw(name, required)?.attachment ?? null
  }

  getSubcommand(required = false) {
    const opt = this.flat().find(o => o.type === 1)
    if (!opt && required) throw new TypeError('No subcommand was provided')
    return opt?.name ?? null
  }

  getSubcommandGroup(required = false) {
    const opt = this.flat().find(o => o.type === 2)
    if (!opt && required) throw new TypeError('No subcommand group was provided')
    return opt?.name ?? null
  }

  getFocused() {
    return this.flat().find(o => o.focused) ?? null
  }
}

export class Interaction {
  constructor(client, d) {
    this.client = client
    this.id = d.id
    this.token = d.token
    this.type = d.type
    this.applicationId = d.application_id ?? client.application?.id ?? null
    this.guildId = d.guild_id ?? null
    this.guild = this.guildId ? client.guilds.cache.get(this.guildId) ?? null : null
    this.channelId = d.channel_id ?? null
    this.channel = d.channel_id ? client.resolveChannel({ id: d.channel_id, guild_id: this.guildId }, this.guild) : null
    const userData = d.member?.user ?? d.user
    this.user = client.upsertUser(userData)
    this.member = this.guild && d.member ? this.guild.upsertMember({ ...d.member, user: d.member.user ?? d.user }) : null
    this.locale = d.locale ?? null
    this.data = d.data ?? {}
    this.commandName = this.data.name ?? null
    this.customId = this.data.custom_id ?? null
    this.componentType = this.data.component_type ?? null
    this.values = this.data.values ?? []
    this.options = new CommandOptions(client, this.guild, parseOptions(client, this.data.options ?? [], this.data.resolved ?? {}, this.guild))
    this.deferred = false
    this.replied = false
  }

  get callbackPath() {
    return `/interactions/${this.id}/${this.token}/callback`
  }

  isChatInputCommand() {
    return this.type === InteractionType.ApplicationCommand && (this.data.type ?? 1) === 1
  }

  isContextMenuCommand() {
    return this.type === InteractionType.ApplicationCommand && [2, 3].includes(this.data.type)
  }

  isAutocomplete() {
    return this.type === InteractionType.ApplicationCommandAutocomplete
  }

  isMessageComponent() {
    return this.type === InteractionType.MessageComponent
  }

  isButton() {
    return this.isMessageComponent() && this.componentType === 2
  }

  isStringSelectMenu() {
    return this.isMessageComponent() && this.componentType === 3
  }

  isModalSubmit() {
    return this.type === InteractionType.ModalSubmit
  }

  inGuild() {
    return !!this.guildId
  }

  toString() {
    return `/${this.commandName ?? ''}`
  }

  toMessage(d) {
    if (!d) return null
    return this.channel ? this.channel.messages.add(d) : new Message(this.client, d, null)
  }

  getTextInputValue(customId) {
    const find = list => {
      for (const item of list || []) {
        if (item.custom_id === customId && item.value !== undefined) return item.value
        const nested = find(item.components)
        if (nested !== null) return nested
      }
      return null
    }
    return find(this.data.components)
  }

  webhookBase() {
    return `/webhooks/${this.applicationId}/${this.token}`
  }

  async reply(payload) {
    this.replied = true
    const { body, files } = toRequest(withEphemeral(payload))
    await this.client.rest.post(this.callbackPath, {
      body: { type: InteractionResponseType.ChannelMessageWithSource, data: body },
      files
    })
  }

  async deferReply({ ephemeral = false, flags = 0 } = {}) {
    this.deferred = true
    const value = (flags || 0) | (ephemeral ? MessageFlags.Ephemeral : 0)
    await this.client.rest.post(this.callbackPath, {
      body: { type: InteractionResponseType.DeferredChannelMessageWithSource, data: value ? { flags: value } : undefined }
    })
  }

  async deferUpdate() {
    this.deferred = true
    await this.client.rest.post(this.callbackPath, { body: { type: InteractionResponseType.DeferredUpdateMessage } })
  }

  async update(payload) {
    if (this.deferred && !this.replied) return this.editReply(payload)
    this.replied = true
    const { body, files } = toRequest(withEphemeral(payload))
    await this.client.rest.post(this.callbackPath, {
      body: { type: InteractionResponseType.UpdateMessage, data: body },
      files
    })
    return null
  }

  async showModal(modal) {
    this.replied = true
    await this.client.rest.post(this.callbackPath, { body: { type: InteractionResponseType.Modal, data: modal } })
  }

  async respond(choices) {
    await this.client.rest.post(this.callbackPath, {
      body: { type: InteractionResponseType.ApplicationCommandAutocompleteResult, data: { choices } }
    })
  }

  async editReply(payload) {
    const { body, files } = toRequest(payload)
    const d = await this.client.rest.patch(`${this.webhookBase()}/messages/@original`, { body, files })
    return this.toMessage(d)
  }

  async followUp(payload) {
    const { body, files } = toRequest(withEphemeral(payload))
    const d = await this.client.rest.post(`${this.webhookBase()}?wait=true`, { body, files })
    return this.toMessage(d)
  }

  async fetchReply() {
    const d = await this.client.rest.get(`${this.webhookBase()}/messages/@original`)
    return this.toMessage(d)
  }

  async deleteReply() {
    await this.client.rest.delete(`${this.webhookBase()}/messages/@original`)
  }

  get webhook() {
    return {
      editMessage: async (id, payload) => {
        const { body, files } = toRequest(payload)
        const d = await this.client.rest.patch(`${this.webhookBase()}/messages/${idOf(id)}`, { body, files })
        return this.toMessage(d)
      },
      deleteMessage: id => this.client.rest.delete(`${this.webhookBase()}/messages/${idOf(id)}`)
    }
  }
}

export class Guild {
  constructor(client, d) {
    this.client = client
    this.id = d.id
    this.name = ''
    this.icon = null
    this.description = null
    this.ownerId = null
    this.premiumTier = 0
    this.premiumSubscriptionCount = 0
    this.memberCount = 0
    this.available = true
    this.joinedAt = null
    this.roles = new RoleManager(this)
    this.members = new MemberManager(this)
    this.channels = new ChannelManager(this)
    this.bans = new BanManager(this)
    this.voiceStates = new Collection()
    this.commands = {
      set: body => client.rest.put(`/applications/${client.application.id}/guilds/${this.id}/commands`, { body })
    }
    this.createdTimestamp = snowflakeTime(this.id)
    this.update(d)
  }

  update(d) {
    if (d.name !== undefined) this.name = d.name
    if (d.icon !== undefined) this.icon = d.icon
    if (d.owner_id !== undefined) this.ownerId = d.owner_id
    if (d.description !== undefined) this.description = d.description
    if (d.premium_tier !== undefined) this.premiumTier = d.premium_tier
    if (d.premium_subscription_count !== undefined) this.premiumSubscriptionCount = d.premium_subscription_count
    const count = d.member_count ?? d.approximate_member_count
    if (count !== undefined) this.memberCount = count
    if (d.joined_at !== undefined) this.joinedAt = d.joined_at ? new Date(d.joined_at) : null
    if (d.unavailable !== undefined) this.available = !d.unavailable
    if (d.roles) {
      const seen = new Set()
      for (const r of d.roles) {
        seen.add(r.id)
        const existing = this.roles.cache.get(r.id)
        if (existing) existing.update(r)
        else this.roles.cache.set(r.id, new Role(this, r))
      }
      for (const id of [...this.roles.cache.keys()]) if (!seen.has(id)) this.roles.cache.delete(id)
    }
    if (d.channels) {
      const seen = new Set()
      for (const c of d.channels) {
        seen.add(c.id)
        this.channels.upsert(c)
      }
      for (const id of [...this.channels.cache.keys()]) if (!seen.has(id)) this.channels.cache.delete(id)
    }
    if (d.members) for (const m of d.members) this.upsertMember(m)
    if (d.voice_states) {
      this.voiceStates.clear()
      for (const vs of d.voice_states) {
        const state = new VoiceState(this, vs)
        if (state.channelId) this.voiceStates.set(state.id, state)
      }
    }
    return this
  }

  get me() {
    return this.members.me
  }

  upsertMember(d) {
    const user = d.user ? this.client.upsertUser(d.user) : null
    if (!user) return null
    const existing = this.members.cache.get(user.id)
    if (existing) return existing.update(d)
    const member = new Member(this, d, user)
    this.members.cache.set(user.id, member)
    return member
  }

  memberFromVoice(state) {
    if (state.memberData?.user) return this.upsertMember(state.memberData)
    const cached = this.members.cache.get(state.id)
    if (cached) return cached
    const stub = state.id === this.client.user?.id ? { id: state.id, bot: true } : { id: state.id }
    return new Member(this, {}, this.client.upsertUser(stub))
  }

  topRolePosition(member) {
    let top = 0
    for (const id of member.roleIds || []) {
      const role = this.roles.cache.get(id)
      if (role && role.position > top) top = role.position
    }
    return top
  }

  canManage(member) {
    const me = this.members.me
    if (!me || member.id === this.ownerId || member.id === this.client.user?.id) return false
    return this.topRolePosition(me) > this.topRolePosition(member)
  }

  botHas(name) {
    const me = this.members.me
    return !!me && me.permissions.has(name)
  }

  async fetchOwner() {
    return this.members.fetch(this.ownerId)
  }

  async leave() {
    await this.client.rest.delete(`/users/@me/guilds/${this.id}`)
    this.client.guilds.cache.delete(this.id)
  }

  async edit(data = {}, reason) {
    const body = pick(data, ['name', 'description'])
    const d = await this.client.rest.patch(`/guilds/${this.id}`, { body, reason })
    return this.update(d)
  }

  iconURL({ size = 128 } = {}) {
    if (!this.icon) return null
    const ext = this.icon.startsWith('a_') ? 'gif' : 'png'
    return `${CDN}/icons/${this.id}/${this.icon}.${ext}?size=${size}`
  }

  toString() {
    return this.name ?? this.id
  }
}
