import { getUnlockedToken } from '../auth/vault'

const API_BASE = 'https://discord.com/api/v10'
const CDN_BASE = 'https://cdn.discordapp.com'

export class DiscordApiError extends Error {
  status: number
  body: unknown

  constructor(status: number, body: unknown) {
    super(`Discord API error ${status}: ${JSON.stringify(body)}`)
    this.status = status
    this.body = body
  }
}

const MAX_RATE_LIMIT_RETRIES = 3

async function request<T>(method: string, path: string, body?: unknown, retries = 0): Promise<T> {
  const token = getUnlockedToken()
  if (!token) throw new Error('Vault is locked: no token in memory')

  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      // User tokens are sent raw, unlike bot tokens which use the "Bot " prefix.
      Authorization: token,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })

  if (res.status === 429) {
    if (retries >= MAX_RATE_LIMIT_RETRIES) {
      throw new DiscordApiError(429, await res.json().catch(() => null))
    }
    const { retry_after } = await res.json()
    await new Promise((r) => setTimeout(r, retry_after * 1000))
    return request<T>(method, path, body, retries + 1)
  }

  if (!res.ok) {
    throw new DiscordApiError(res.status, await res.json().catch(() => null))
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

async function requestMultipart<T>(path: string, formData: FormData, retries = 0): Promise<T> {
  const token = getUnlockedToken()
  if (!token) throw new Error('Vault is locked: no token in memory')

  // No Content-Type header here: the browser sets multipart/form-data with
  // the correct boundary itself when the body is a FormData instance.
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { Authorization: token },
    body: formData,
  })

  if (res.status === 429) {
    if (retries >= MAX_RATE_LIMIT_RETRIES) {
      throw new DiscordApiError(429, await res.json().catch(() => null))
    }
    const { retry_after } = await res.json()
    await new Promise((r) => setTimeout(r, retry_after * 1000))
    return requestMultipart<T>(path, formData, retries + 1)
  }

  if (!res.ok) {
    throw new DiscordApiError(res.status, await res.json().catch(() => null))
  }

  return res.json() as Promise<T>
}

export const discordApi = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body),
  delete: <T>(path: string) => request<T>('DELETE', path),
}

export interface Guild {
  id: string
  name: string
  icon: string | null
  owner?: boolean
}

export interface Role {
  id: string
  permissions: string
}

export interface PermissionOverwrite {
  id: string
  /** 0 = role, 1 = member */
  type: number
  allow: string
  deny: string
}

export interface User {
  id: string
  username: string
  avatar: string | null
  global_name?: string | null
  /** The small server-tag badge some users display next to their name everywhere. */
  primary_guild?: {
    identity_guild_id: string
    identity_enabled: boolean
    tag: string
    badge: string | null
  } | null
}

export type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline'

export interface GuildMember {
  nick?: string | null
  roles?: string[]
}

export interface UserProfile {
  user: User & { banner: string | null; accent_color: number | null; bio?: string }
  premium_since?: string | null
  connected_accounts?: { type: string; name: string }[]
}

export const CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GUILD_VOICE: 2,
  GROUP_DM: 3,
  GUILD_CATEGORY: 4,
} as const

export interface Channel {
  id: string
  guild_id?: string
  name?: string
  type: number
  recipients?: User[]
  last_message_id?: string | null
  position?: number
  parent_id?: string | null
  icon?: string | null
  permission_overwrites?: PermissionOverwrite[]
}

export interface ChannelGroup {
  category: Channel | null
  channels: Channel[]
}

export interface Attachment {
  id: string
  url: string
  filename: string
  content_type?: string
  width?: number
  height?: number
  size: number
}

export interface Embed {
  title?: string
  description?: string
  url?: string
  thumbnail?: { url: string }
  image?: { url: string }
}

export interface Message {
  id: string
  channel_id: string
  author: User
  member?: GuildMember
  content: string
  timestamp: string
  attachments: Attachment[]
  embeds: Embed[]
}

export const avatarUrl = (userId: string, avatarHash: string | null, size = 64) =>
  avatarHash
    ? `${CDN_BASE}/avatars/${userId}/${avatarHash}.png?size=${size}`
    : `${CDN_BASE}/embed/avatars/${Number(BigInt(userId) % 5n)}.png`

export const guildIconUrl = (guildId: string, iconHash: string | null, size = 64) =>
  iconHash ? `${CDN_BASE}/icons/${guildId}/${iconHash}.png?size=${size}` : null

export const bannerUrl = (userId: string, bannerHash: string | null, size = 480) =>
  bannerHash ? `${CDN_BASE}/banners/${userId}/${bannerHash}.png?size=${size}` : null

export const channelIconUrl = (channelId: string, iconHash: string | null | undefined, size = 64) =>
  iconHash ? `${CDN_BASE}/channel-icons/${channelId}/${iconHash}.png?size=${size}` : null

export const primaryGuildBadgeUrl = (guildId: string, badgeHash: string | null | undefined) =>
  badgeHash ? `${CDN_BASE}/clan-badges/${guildId}/${badgeHash}.png?size=16` : null

/** Guild nickname wins, then the account's global display name, then username. */
export const displayName = (user: User, member?: GuildMember) =>
  member?.nick || user.global_name || user.username

export const dmChannelName = (channel: Channel) =>
  channel.name ||
  channel.recipients?.map((r) => displayName(r)).join(', ') ||
  'Unknown'

export const formatFileSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** Snowflake IDs are chronological, so plain BigInt comparison sorts by recency. */
export const sortByRecency = (channels: Channel[]): Channel[] =>
  [...channels].sort((a, b) => {
    const aId = a.last_message_id ? BigInt(a.last_message_id) : -1n
    const bId = b.last_message_id ? BigInt(b.last_message_id) : -1n
    return aId === bId ? 0 : aId > bId ? -1 : 1
  })

export const sortByPosition = (channels: Channel[]): Channel[] =>
  [...channels].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))

/** Groups a guild's text/voice channels under their categories, in sidebar order. Uncategorized channels come first, unlabeled. */
export const groupChannelsByCategory = (channels: Channel[]): ChannelGroup[] => {
  const categories = sortByPosition(channels.filter((c) => c.type === CHANNEL_TYPE.GUILD_CATEGORY))
  const relevant = sortByPosition(
    channels.filter((c) => c.type === CHANNEL_TYPE.GUILD_TEXT || c.type === CHANNEL_TYPE.GUILD_VOICE),
  )

  const byParent = new Map<string, Channel[]>()
  const uncategorized: Channel[] = []
  for (const channel of relevant) {
    if (channel.parent_id) {
      if (!byParent.has(channel.parent_id)) byParent.set(channel.parent_id, [])
      byParent.get(channel.parent_id)!.push(channel)
    } else {
      uncategorized.push(channel)
    }
  }

  const groups: ChannelGroup[] = []
  if (uncategorized.length > 0) groups.push({ category: null, channels: uncategorized })
  for (const category of categories) {
    const inCategory = byParent.get(category.id) ?? []
    if (inCategory.length > 0) groups.push({ category, channels: inCategory })
  }
  return groups
}

/**
 * The sidebar order of servers is per-account UI state, not something
 * /users/@me/guilds exposes — it lives in the (legacy, but still populated)
 * user settings blob as `guild_positions`. Falls back to API order if the
 * account has none set or the endpoint is unavailable.
 */
export const sortGuildsByPosition = (guilds: Guild[], positions: string[]): Guild[] => {
  if (positions.length === 0) return guilds
  const rank = new Map(positions.map((id, i) => [id, i]))
  return [...guilds].sort((a, b) => {
    const ai = rank.has(a.id) ? rank.get(a.id)! : Number.MAX_SAFE_INTEGER
    const bi = rank.has(b.id) ? rank.get(b.id)! : Number.MAX_SAFE_INTEGER
    return ai - bi
  })
}

export const PERMISSION = {
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  CONNECT: 1n << 20n,
} as const

/**
 * Discord's documented permission-overwrite algorithm: base role permissions,
 * then the @everyone overwrite, then combined role overwrites, in that order.
 * Guild owners and ADMINISTRATOR holders bypass overwrites entirely.
 */
export function computeChannelPermissions(
  guildId: string,
  channel: Channel,
  roles: Role[],
  memberRoleIds: string[],
  isOwner: boolean,
): bigint {
  if (isOwner) return PERMISSION.ADMINISTRATOR

  const roleMap = new Map(roles.map((r) => [r.id, BigInt(r.permissions)]))
  let base = roleMap.get(guildId) ?? 0n
  for (const roleId of memberRoleIds) base |= roleMap.get(roleId) ?? 0n
  if (base & PERMISSION.ADMINISTRATOR) return base

  const overwrites = channel.permission_overwrites ?? []
  let perms = base

  const everyoneOverwrite = overwrites.find((o) => o.id === guildId)
  if (everyoneOverwrite) {
    perms &= ~BigInt(everyoneOverwrite.deny)
    perms |= BigInt(everyoneOverwrite.allow)
  }

  let allow = 0n
  let deny = 0n
  for (const roleId of memberRoleIds) {
    const overwrite = overwrites.find((o) => o.id === roleId && o.type === 0)
    if (overwrite) {
      allow |= BigInt(overwrite.allow)
      deny |= BigInt(overwrite.deny)
    }
  }
  perms &= ~deny
  perms |= allow

  return perms
}

// ADMINISTRATOR implicitly grants every permission and bypasses overwrites
// entirely, but it's only ever represented as its own single bit (Discord
// doesn't literally set every other permission bit alongside it) — so it
// needs an explicit bypass here rather than relying on the bitmask checks.
export const canSendMessages = (permissions: bigint) =>
  (permissions & PERMISSION.ADMINISTRATOR) !== 0n ||
  ((permissions & PERMISSION.VIEW_CHANNEL) !== 0n && (permissions & PERMISSION.SEND_MESSAGES) !== 0n)

export const canConnect = (permissions: bigint) =>
  (permissions & PERMISSION.ADMINISTRATOR) !== 0n ||
  ((permissions & PERMISSION.VIEW_CHANNEL) !== 0n && (permissions & PERMISSION.CONNECT) !== 0n)

export const getCurrentUser = () => discordApi.get<User>('/users/@me')
export const getGuilds = () => discordApi.get<Guild[]>('/users/@me/guilds')
export const getGuildChannels = (guildId: string) => discordApi.get<Channel[]>(`/guilds/${guildId}/channels`)
export const getGuildRoles = (guildId: string) => discordApi.get<Role[]>(`/guilds/${guildId}/roles`)
export const getOwnGuildMember = (guildId: string) =>
  discordApi.get<{ roles: string[] }>(`/users/@me/guilds/${guildId}/member`)
export const getDMChannels = () => discordApi.get<Channel[]>('/users/@me/channels')

export async function getGuildPositions(): Promise<string[]> {
  try {
    const settings = await discordApi.get<{ guild_positions?: string[] }>('/users/@me/settings')
    return settings.guild_positions ?? []
  } catch {
    // Discord has been migrating this to a protobuf-encoded endpoint; if the
    // legacy one 401s/404s for this account, just skip reordering.
    return []
  }
}

export const getChannelMessages = (channelId: string, options: { before?: string; limit?: number } = {}) => {
  const params = new URLSearchParams({ limit: String(options.limit ?? 50) })
  if (options.before) params.set('before', options.before)
  return discordApi.get<Message[]>(`/channels/${channelId}/messages?${params}`)
}

export const sendMessage = (channelId: string, content: string) =>
  discordApi.post<Message>(`/channels/${channelId}/messages`, { content })

export const sendMessageWithFiles = (channelId: string, content: string, files: File[]) => {
  const formData = new FormData()
  formData.append('payload_json', JSON.stringify({ content }))
  files.forEach((file, i) => formData.append(`files[${i}]`, file, file.name))
  return requestMultipart<Message>(`/channels/${channelId}/messages`, formData)
}

export const sendTyping = (channelId: string) => discordApi.post<void>(`/channels/${channelId}/typing`)

export const getUserProfile = (userId: string) => discordApi.get<UserProfile>(`/users/${userId}/profile`)

/** Rings the other participant(s) of a DM/group DM on their real Discord client — no in-browser audio. */
export const ringCall = (channelId: string) => discordApi.post<void>(`/channels/${channelId}/call/ring`, {})
