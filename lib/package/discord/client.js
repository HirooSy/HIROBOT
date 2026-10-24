import { EventEmitter } from 'node:events'
import { Collection } from './collection.js'
import { Gateway } from './gateway.js'
import { Rest } from './rest.js'
import { VoiceManager } from './voice.js'
import { Channel, ClientUser, Guild, Interaction, Role, User, VoiceState } from './structures.js'

class GuildManager {
  constructor(client) {
    this.client = client
    this.cache = new Collection()
  }

  async fetch(id) {
    const d = await this.client.rest.get(`/guilds/${id}`, { query: { with_counts: true } })
    const existing = this.cache.get(d.id)
    if (existing) return existing.update(d)
    const guild = new Guild(this.client, d)
    this.cache.set(guild.id, guild)
    return guild
  }
}

export class Client extends EventEmitter {
  constructor({ intents = [], presence = null } = {}) {
    super()
    this.intents = intents.reduce((acc, bit) => acc | bit, 0)
    this.rest = new Rest()
    this.gateway = null
    this.user = null
    this.application = null
    this.presence = presence
    this.voice = new VoiceManager(this)
    this.guilds = new GuildManager(this)
    this.channels = new Collection()
    this.userCache = new Collection()
    this.dmChannels = new Collection()
    this.users = {
      cache: this.userCache,
      fetch: async id => this.upsertUser(await this.rest.get(`/users/${id}`))
    }
    this.loginHandles = null
    this.ready = false
  }

  get ws() {
    return { ping: this.gateway?.ping ?? -1 }
  }

  upsertUser(d) {
    let user = this.userCache.get(d.id)
    if (!user) {
      user = new User(this, d)
      this.userCache.set(d.id, user)
      return user
    }
    return user.update(d)
  }

  resolveChannel(d, guild = null) {
    if (!d?.id) return null
    if (guild?.channels.cache.has(d.id)) return guild.channels.cache.get(d.id)
    let channel = this.channels.get(d.id)
    if (!channel) {
      channel = new Channel(this, d, guild)
      this.channels.set(d.id, channel)
    }
    return channel
  }

  async fetchChannel(id) {
    const d = await this.rest.get(`/channels/${id}`)
    return this.resolveChannel(d, d.guild_id ? this.guilds.cache.get(d.guild_id) ?? null : null)
  }

  setPresence({ status = 'online', activities = [], afk = false } = {}) {
    this.presence = { since: null, status, activities, afk }
    this.gateway?.updatePresence(this.presence)
    return this.presence
  }

  login(token) {
    this.rest.token = token
    this.gateway = new Gateway(this.rest, token, this.intents, this.presence)
    this.gateway.on('dispatch', (type, data) => {
      try {
        this.handleDispatch(type, data)
      } catch (err) {
        if (this.listenerCount('error')) this.emit('error', err)
        else console.error('Discord dispatch error:', err)
      }
    })
    return new Promise((resolve, reject) => {
      this.loginHandles = { resolve, reject }
      this.gateway.once('fatal', err => this.rejectLogin(err))
      this.gateway.connect().catch(err => this.rejectLogin(err))
    })
  }

  rejectLogin(err) {
    const handles = this.loginHandles
    this.loginHandles = null
    this.gateway?.close()
    handles?.reject(err)
  }

  channelFor(d) {
    const guild = d.guild_id ? this.guilds.cache.get(d.guild_id) ?? null : null
    return this.resolveChannel({ id: d.channel_id, guild_id: d.guild_id }, guild)
  }

  handleDispatch(type, d) {
    switch (type) {
      case 'READY': {
        this.onReady(d)
        this.ready = true
        const handles = this.loginHandles
        this.loginHandles = null
        handles?.resolve(this)
        this.emit('clientReady', this)
        this.emit('ready', this)
        break
      }
      case 'RESUMED':
        this.emit('resumed', this)
        break
      case 'GUILD_CREATE': {
        const existing = this.guilds.cache.get(d.id)
        const guild = existing ? existing.update(d) : new Guild(this, d)
        if (!existing) this.guilds.cache.set(guild.id, guild)
        this.emit('guildCreate', guild)
        break
      }
      case 'GUILD_UPDATE': {
        const guild = this.guilds.cache.get(d.id)
        if (guild) this.emit('guildUpdate', guild.update(d))
        break
      }
      case 'GUILD_DELETE': {
        const guild = this.guilds.cache.get(d.id)
        if (d.unavailable) {
          if (guild) guild.available = false
          break
        }
        this.voice.leave(d.id)
        this.guilds.cache.delete(d.id)
        if (guild) this.emit('guildDelete', guild)
        break
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const guild = this.guilds.cache.get(d.guild_id)
        if (!guild) break
        const channel = guild.channels.upsert(d)
        this.emit(type === 'CHANNEL_CREATE' ? 'channelCreate' : 'channelUpdate', channel)
        break
      }
      case 'CHANNEL_DELETE': {
        const guild = this.guilds.cache.get(d.guild_id)
        const channel = guild?.channels.cache.get(d.id) ?? this.channels.get(d.id) ?? null
        guild?.channels.cache.delete(d.id)
        this.channels.delete(d.id)
        if (channel) this.emit('channelDelete', channel)
        break
      }
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const guild = this.guilds.cache.get(d.guild_id)
        if (!guild) break
        const existing = guild.roles.cache.get(d.role.id)
        const role = existing ? existing.update(d.role) : new Role(guild, d.role)
        guild.roles.cache.set(role.id, role)
        this.emit(type === 'GUILD_ROLE_CREATE' ? 'roleCreate' : 'roleUpdate', role)
        break
      }
      case 'GUILD_ROLE_DELETE': {
        const guild = this.guilds.cache.get(d.guild_id)
        const role = guild?.roles.cache.get(d.role_id) ?? null
        guild?.roles.cache.delete(d.role_id)
        if (role) this.emit('roleDelete', role)
        break
      }
      case 'GUILD_MEMBER_ADD': {
        const guild = this.guilds.cache.get(d.guild_id)
        if (!guild) break
        const member = guild.upsertMember(d)
        guild.memberCount += 1
        if (member) this.emit('guildMemberAdd', member)
        break
      }
      case 'GUILD_MEMBER_UPDATE': {
        const guild = this.guilds.cache.get(d.guild_id)
        if (!guild) break
        const member = guild.upsertMember(d)
        if (member) this.emit('guildMemberUpdate', member)
        break
      }
      case 'GUILD_MEMBER_REMOVE': {
        const guild = this.guilds.cache.get(d.guild_id)
        if (!guild || !d.user) break
        const user = this.upsertUser(d.user)
        const member = guild.members.cache.get(user.id) ?? null
        guild.members.cache.delete(user.id)
        guild.memberCount = Math.max(0, guild.memberCount - 1)
        this.emit('guildMemberRemove', member, user, guild)
        break
      }
      case 'GUILD_BAN_ADD':
      case 'GUILD_BAN_REMOVE': {
        const guild = this.guilds.cache.get(d.guild_id)
        if (!guild || !d.user) break
        const user = this.upsertUser(d.user)
        if (type === 'GUILD_BAN_ADD') guild.bans.cache.set(user.id, { user, id: user.id, reason: null })
        else guild.bans.cache.delete(user.id)
        this.emit(type === 'GUILD_BAN_ADD' ? 'guildBanAdd' : 'guildBanRemove', guild, user)
        break
      }
      case 'VOICE_STATE_UPDATE':
        this.onVoiceState(d)
        break
      case 'VOICE_SERVER_UPDATE':
        this.voice.onVoiceServer(d)
        break
      case 'MESSAGE_CREATE': {
        const message = this.channelFor(d).messages.add(d)
        this.emit('messageCreate', message)
        break
      }
      case 'MESSAGE_UPDATE': {
        const channel = this.channelFor(d)
        const cached = channel.messages.cache.get(d.id)
        if (cached) this.emit('messageUpdate', cached.update(d))
        else if (d.author) this.emit('messageUpdate', channel.messages.add(d))
        break
      }
      case 'MESSAGE_DELETE': {
        const channel = this.channelFor(d)
        const cached = channel.messages.cache.get(d.id)
        channel.messages.cache.delete(d.id)
        this.emit('messageDelete', cached ?? { id: d.id, channelId: d.channel_id, guildId: d.guild_id ?? null })
        break
      }
      case 'MESSAGE_DELETE_BULK': {
        const channel = this.channelFor(d)
        const ids = d.ids ?? []
        for (const id of ids) channel.messages.cache.delete(id)
        this.emit('messageDeleteBulk', ids, channel)
        break
      }
      case 'MESSAGE_REACTION_ADD':
      case 'MESSAGE_REACTION_REMOVE': {
        const guild = d.guild_id ? this.guilds.cache.get(d.guild_id) ?? null : null
        const reaction = {
          messageId: d.message_id,
          channelId: d.channel_id,
          guildId: d.guild_id ?? null,
          emoji: d.emoji,
          userId: d.user_id,
          member: guild && d.member ? guild.upsertMember(d.member) : null
        }
        this.emit(type === 'MESSAGE_REACTION_ADD' ? 'messageReactionAdd' : 'messageReactionRemove', reaction)
        break
      }
      case 'MESSAGE_REACTION_REMOVE_ALL':
      case 'MESSAGE_REACTION_REMOVE_EMOJI':
        this.emit(type === 'MESSAGE_REACTION_REMOVE_ALL' ? 'messageReactionRemoveAll' : 'messageReactionRemoveEmoji', {
          messageId: d.message_id,
          channelId: d.channel_id,
          guildId: d.guild_id ?? null,
          emoji: d.emoji ?? null
        })
        break
      case 'TYPING_START':
        this.emit('typingStart', {
          channelId: d.channel_id,
          guildId: d.guild_id ?? null,
          userId: d.user_id,
          timestamp: d.timestamp
        })
        break
      case 'INTERACTION_CREATE':
        this.emit('interactionCreate', new Interaction(this, d))
        break
    }
  }

  onReady(d) {
    this.user = new ClientUser(this, d.user)
    this.userCache.set(this.user.id, this.user)
    const appId = d.application.id
    this.application = {
      id: appId,
      commands: {
        set: body => this.rest.put(`/applications/${appId}/commands`, { body }),
        fetch: () => this.rest.get(`/applications/${appId}/commands`)
      }
    }
  }

  onVoiceState(d) {
    this.voice.onVoiceState(d)
    const guild = this.guilds.cache.get(d.guild_id)
    if (!guild) return
    const before = guild.voiceStates.get(d.user_id) ?? new VoiceState(guild, { user_id: d.user_id, channel_id: null })
    const after = new VoiceState(guild, d)
    if (after.channelId) guild.voiceStates.set(d.user_id, after)
    else guild.voiceStates.delete(d.user_id)
    this.emit('voiceStateUpdate', before, after)
  }

  async destroy() {
    this.voice.destroyAll()
    this.gateway?.close()
    this.gateway = null
    this.ready = false
  }
}
