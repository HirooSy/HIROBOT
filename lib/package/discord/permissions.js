export const FLAGS = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTTSMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ViewGuildInsights: 1n << 19n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageEmojisAndStickers: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
  ViewCreatorMonetizationAnalytics: 1n << 41n,
  UseSoundboard: 1n << 42n,
  CreateGuildExpressions: 1n << 43n,
  CreateEvents: 1n << 44n,
  UseExternalSounds: 1n << 45n,
  SendVoiceMessages: 1n << 46n,
  SendPolls: 1n << 49n,
  UseExternalApps: 1n << 50n
}

export const ALL = Object.values(FLAGS).reduce((a, b) => a | b, 0n)

export class Permissions {
  constructor(bits = 0n) {
    this.bits = BigInt(bits)
  }

  has(...names) {
    if (this.bits & FLAGS.Administrator) return true
    const list = names.flat()
    if (!list.length) return false
    return list.every(name => {
      const flag = FLAGS[name]
      return flag !== undefined && (this.bits & flag) === flag
    })
  }

  any(...names) {
    if (this.bits & FLAGS.Administrator) return true
    return names.flat().some(name => this.has(name))
  }

  missing(...names) {
    if (this.bits & FLAGS.Administrator) return []
    return names.flat().filter(name => !this.has(name))
  }

  toArray() {
    if (this.bits & FLAGS.Administrator) return Object.keys(FLAGS)
    return Object.keys(FLAGS).filter(name => (this.bits & FLAGS[name]) === FLAGS[name])
  }
}

export function computePermissions(guild, roleIds, userId, ownerId, overwrites = []) {
  if (userId === ownerId) return ALL
  const everyone = guild.roles.everyone
  let base = everyone ? everyone.bits : 0n
  for (const id of roleIds) {
    const role = guild.roles.cache.get(id)
    if (role) base |= role.bits
  }
  if (base & FLAGS.Administrator) return ALL
  const every = overwrites.find(o => o.id === guild.id)
  if (every) base = (base & ~BigInt(every.deny)) | BigInt(every.allow)
  const roleSet = new Set(roleIds)
  let allow = 0n
  let deny = 0n
  for (const o of overwrites) {
    if (o.type === 0 && roleSet.has(o.id)) {
      allow |= BigInt(o.allow)
      deny |= BigInt(o.deny)
    }
  }
  base = (base & ~deny) | allow
  const mine = overwrites.find(o => o.type === 1 && o.id === userId)
  if (mine) base = (base & ~BigInt(mine.deny)) | BigInt(mine.allow)
  return base
}
