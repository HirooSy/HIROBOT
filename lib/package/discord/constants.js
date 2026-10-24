export const GatewayIntentBits = Object.freeze({
  Guilds: 1 << 0,
  GuildMembers: 1 << 1,
  GuildModeration: 1 << 2,
  GuildExpressions: 1 << 3,
  GuildIntegrations: 1 << 4,
  GuildWebhooks: 1 << 5,
  GuildInvites: 1 << 6,
  GuildVoiceStates: 1 << 7,
  GuildPresences: 1 << 8,
  GuildMessages: 1 << 9,
  GuildMessageReactions: 1 << 10,
  GuildMessageTyping: 1 << 11,
  DirectMessages: 1 << 12,
  DirectMessageReactions: 1 << 13,
  DirectMessageTyping: 1 << 14,
  MessageContent: 1 << 15,
  GuildScheduledEvents: 1 << 16,
  AutoModerationConfiguration: 1 << 20,
  AutoModerationExecution: 1 << 21,
  GuildMessagePolls: 1 << 24,
  DirectMessagePolls: 1 << 25
})

export const Partials = Object.freeze({
  User: 0,
  Channel: 1,
  GuildMember: 2,
  Message: 3,
  Reaction: 4,
  GuildScheduledEvent: 5,
  ThreadMember: 6
})

export const ChannelType = Object.freeze({
  GuildText: 0,
  DM: 1,
  GuildVoice: 2,
  GroupDM: 3,
  GuildCategory: 4,
  GuildAnnouncement: 5,
  AnnouncementThread: 10,
  PublicThread: 11,
  PrivateThread: 12,
  GuildStageVoice: 13,
  GuildDirectory: 14,
  GuildForum: 15,
  GuildMedia: 16
})

export const InteractionType = Object.freeze({
  Ping: 1,
  ApplicationCommand: 2,
  MessageComponent: 3,
  ApplicationCommandAutocomplete: 4,
  ModalSubmit: 5
})

export const InteractionResponseType = Object.freeze({
  Pong: 1,
  ChannelMessageWithSource: 4,
  DeferredChannelMessageWithSource: 5,
  DeferredUpdateMessage: 6,
  UpdateMessage: 7,
  ApplicationCommandAutocompleteResult: 8,
  Modal: 9
})

export const ComponentType = Object.freeze({
  ActionRow: 1,
  Button: 2,
  StringSelect: 3,
  TextInput: 4,
  UserSelect: 5,
  RoleSelect: 6,
  MentionableSelect: 7,
  ChannelSelect: 8
})

export const ButtonStyle = Object.freeze({
  Primary: 1,
  Secondary: 2,
  Success: 3,
  Danger: 4,
  Link: 5
})

export const ApplicationCommandOptionType = Object.freeze({
  SubCommand: 1,
  SubCommandGroup: 2,
  String: 3,
  Integer: 4,
  Boolean: 5,
  User: 6,
  Channel: 7,
  Role: 8,
  Mentionable: 9,
  Number: 10,
  Attachment: 11
})

export const MessageFlags = Object.freeze({
  Crossposted: 1 << 0,
  IsCrosspost: 1 << 1,
  SuppressEmbeds: 1 << 2,
  SourceMessageDeleted: 1 << 3,
  Urgent: 1 << 4,
  HasThread: 1 << 5,
  Ephemeral: 1 << 6,
  Loading: 1 << 7,
  FailedToMentionSomeRolesInThread: 1 << 8,
  SuppressNotifications: 1 << 12,
  IsVoiceMessage: 1 << 13
})

export const ActivityType = Object.freeze({
  Playing: 0,
  Streaming: 1,
  Listening: 2,
  Watching: 3,
  Custom: 4,
  Competing: 5
})

export const PresenceUpdateStatus = Object.freeze({
  Online: 'online',
  DoNotDisturb: 'dnd',
  Idle: 'idle',
  Invisible: 'invisible',
  Offline: 'offline'
})

export const VoiceCloseCode = Object.freeze({
  UnknownOpcode: 4001,
  FailedToDecode: 4002,
  NotAuthenticated: 4003,
  AuthenticationFailed: 4004,
  AlreadyAuthenticated: 4005,
  SessionNoLongerValid: 4006,
  SessionTimeout: 4009,
  ServerNotFound: 4011,
  UnknownProtocol: 4012,
  Disconnected: 4014,
  VoiceServerCrashed: 4015,
  UnknownEncryptionMode: 4016
})
