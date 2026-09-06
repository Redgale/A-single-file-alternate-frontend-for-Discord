import { useEffect, useRef, useState } from 'preact/hooks'
import { GatewayClient } from '../discord/gateway'
import { VoiceConnection, type VoiceReadyData } from '../discord/voice'
import {
  CHANNEL_TYPE,
  type Channel,
  type ChannelGroup,
  type Guild,
  type GuildMember,
  type Message,
  type PresenceStatus,
  type User,
  avatarUrl,
  canConnect,
  canSendMessages,
  channelIconUrl,
  computeChannelPermissions,
  displayName,
  dmChannelName,
  formatFileSize,
  getChannelMessages,
  getCurrentUser,
  getDMChannels,
  getGuildChannels,
  getGuildPositions,
  getGuildRoles,
  getGuilds,
  getOwnGuildMember,
  groupChannelsByCategory,
  guildIconUrl,
  primaryGuildBadgeUrl,
  ringCall,
  sendMessage,
  sendMessageWithFiles,
  sendTyping,
  sortByRecency,
  sortGuildsByPosition,
} from '../discord/rest'
import { lock } from '../auth/vault'
import { UserProfileCard } from './UserProfileCard'

const TYPING_TIMEOUT_MS = 10_000
const TYPING_THROTTLE_MS = 8_000
const PAGINATE_THRESHOLD_PX = 60
const STICK_TO_BOTTOM_THRESHOLD_PX = 80

function GuildTag({ user }: { user: User }) {
  const tag = user.primary_guild
  if (!tag?.identity_enabled) return null
  const badge = primaryGuildBadgeUrl(tag.identity_guild_id, tag.badge)
  return (
    <span class="guild-tag">
      {badge && <img src={badge} alt="" onError={(e) => ((e.currentTarget as HTMLElement).style.display = 'none')} />}
      {tag.tag}
    </span>
  )
}

function StatusDot({ status }: { status: PresenceStatus | undefined }) {
  return <span class={`status-dot status-${status ?? 'offline'}`} />
}

interface VoiceStateLite {
  user_id: string
  channel_id: string | null
  member?: (GuildMember & { user: User }) | null
}

interface Props {
  token: string
  onLock: () => void
}

export function ChatApp({ token, onLock }: Props) {
  const [guilds, setGuilds] = useState<Guild[]>([])
  const [dmChannels, setDmChannels] = useState<Channel[]>([])
  const [view, setView] = useState<'guild' | 'dm'>('guild')
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>([])
  const [presences, setPresences] = useState<Map<string, PresenceStatus>>(new Map())
  const [activeGuild, setActiveGuild] = useState<string | null>(null)
  const [activeChannel, setActiveChannel] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [hasMore, setHasMore] = useState(true)
  const [typingUsers, setTypingUsers] = useState<Map<string, string>>(new Map())
  const [draft, setDraft] = useState('')
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [sending, setSending] = useState(false)
  const [profileCard, setProfileCard] = useState<{ userId: string; x: number; y: number } | null>(null)
  const [ringSent, setRingSent] = useState(false)
  const [voiceChannelId, setVoiceChannelId] = useState<string | null>(null)
  const [voiceStatus, setVoiceStatus] = useState<'idle' | 'connecting' | 'ready'>('idle')
  const [voiceReadyInfo, setVoiceReadyInfo] = useState<VoiceReadyData | null>(null)
  const [isSharingScreen, setIsSharingScreen] = useState(false)
  const [remoteVideoStream, setRemoteVideoStream] = useState<MediaStream | null>(null)
  const [voiceStates, setVoiceStates] = useState<Map<string, VoiceStateLite>>(new Map())
  const [speakingUserIds, setSpeakingUserIds] = useState<Set<string>>(new Set())
  // DM/group-DM calls the user can see (ringing or already in progress),
  // keyed by channel id — used to drive the incoming-call banner and the
  // DM header's call button (Start / Join / Leave).
  const [activeCalls, setActiveCalls] = useState<Map<string, { ringing: string[] }>>(new Map())
  const [dismissedCalls, setDismissedCalls] = useState<Set<string>>(new Set())
  const [currentUser, setCurrentUser] = useState<User | null>(null)

  const gatewayRef = useRef<GatewayClient | null>(null)
  const activeChannelRef = useRef(activeChannel)
  const currentUserIdRef = useRef<string | null>(null)
  const typingTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  const lastTypingSentRef = useRef(0)
  const loadingMoreRef = useRef(false)
  const stickToBottomRef = useRef(true)
  const messagesElRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const voiceSessionIdRef = useRef<string | null>(null)
  const voiceChannelIdRef = useRef<string | null>(null)
  const voiceGuildIdRef = useRef<string | null>(null)
  const voiceRetryCountRef = useRef(0)
  const lastVoiceAttemptRef = useRef(0)
  const voiceConnectionRef = useRef<VoiceConnection | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement>(null)
  const remoteVideoRef = useRef<HTMLVideoElement>(null)
  const openGuildRequestIdRef = useRef<string | null>(null)
  const guildsPromiseRef = useRef<Promise<Guild[]> | null>(null)

  activeChannelRef.current = activeChannel

  useEffect(() => {
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = remoteVideoStream
  }, [remoteVideoStream])

  useEffect(() => {
    getCurrentUser().then((user) => {
      currentUserIdRef.current = user.id
      setCurrentUser(user)
    })
    const guildsPromise = getGuilds()
    guildsPromiseRef.current = guildsPromise
    Promise.all([guildsPromise, getGuildPositions()]).then(([guildList, positions]) => {
      setGuilds(sortGuildsByPosition(guildList, positions))
    })
    // Fetched eagerly (not just when opening the DM tab) so an incoming call
    // banner can show the caller's name/avatar right away.
    getDMChannels().then((channels) => setDmChannels(sortByRecency(channels)))

    const gateway = new GatewayClient(token)
    gateway.connect()

    gateway.on('MESSAGE_CREATE', (data) => {
      const message = data as Message
      if (message.channel_id === activeChannelRef.current) {
        setMessages((prev) => [...prev, message])
        if (stickToBottomRef.current) {
          requestAnimationFrame(scrollToBottom)
        }
      }
    })

    // A user (self-bot) READY payload eagerly embeds each guild's full state
    // (channels, roles, members, voice_states) inline — unlike bot accounts,
    // Discord does NOT follow up with a separate GUILD_CREATE dispatch for
    // guilds that are already available, only for guilds that were
    // unavailable at connect time or newly joined afterward. So the initial
    // voice channel roster has to be seeded here, not from GUILD_CREATE.
    function seedVoiceStates(guild: {
      voice_states?: (VoiceStateLite & { member?: unknown })[]
      members?: { user: User; nick?: string | null }[]
    }) {
      if (!guild.voice_states?.length) return
      const memberByUserId = new Map((guild.members ?? []).map((m) => [m.user.id, m]))
      setVoiceStates((prev) => {
        const next = new Map(prev)
        for (const vs of guild.voice_states!) {
          const member = (vs.member as VoiceStateLite['member']) ?? memberByUserId.get(vs.user_id) ?? null
          next.set(vs.user_id, { ...vs, member })
        }
        return next
      })
    }

    gateway.on('READY', (data) => {
      const ready = data as {
        presences?: { user: { id: string }; status: PresenceStatus }[]
        guilds?: Parameters<typeof seedVoiceStates>[0][]
      }
      ready.guilds?.forEach(seedVoiceStates)
      if (ready.presences) {
        setPresences((prev) => {
          const next = new Map(prev)
          for (const p of ready.presences!) next.set(p.user.id, p.status)
          return next
        })
      }
    })

    gateway.on('PRESENCE_UPDATE', (data) => {
      const presence = data as { user: { id: string }; status: PresenceStatus }
      setPresences((prev) => new Map(prev).set(presence.user.id, presence.status))
    })

    gateway.on('GUILD_CREATE', (data) => {
      seedVoiceStates(data as Parameters<typeof seedVoiceStates>[0])
    })

    // DM/group-DM calls aren't tied to a persistent voice channel like guild
    // voice — Discord announces/updates/tears them down via these dispatches
    // instead, including who's currently being rung.
    gateway.on('CALL_CREATE', (data) => {
      const call = data as { channel_id: string; ringing?: string[]; voice_states?: VoiceStateLite[] }
      setActiveCalls((prev) => new Map(prev).set(call.channel_id, { ringing: call.ringing ?? [] }))
      if (call.voice_states?.length) {
        setVoiceStates((prev) => {
          const next = new Map(prev)
          for (const vs of call.voice_states!) next.set(vs.user_id, vs)
          return next
        })
      }
    })

    gateway.on('CALL_UPDATE', (data) => {
      const call = data as { channel_id: string; ringing?: string[] }
      setActiveCalls((prev) => new Map(prev).set(call.channel_id, { ringing: call.ringing ?? [] }))
    })

    gateway.on('CALL_DELETE', (data) => {
      const call = data as { channel_id: string }
      setActiveCalls((prev) => {
        if (!prev.has(call.channel_id)) return prev
        const next = new Map(prev)
        next.delete(call.channel_id)
        return next
      })
      setDismissedCalls((prev) => {
        if (!prev.has(call.channel_id)) return prev
        const next = new Set(prev)
        next.delete(call.channel_id)
        return next
      })
    })

    gateway.on('VOICE_STATE_UPDATE', (data) => {
      const state = data as VoiceStateLite & { session_id: string }
      setVoiceStates((prev) => {
        const next = new Map(prev)
        if (state.channel_id === null) next.delete(state.user_id)
        else next.set(state.user_id, state)
        return next
      })

      if (state.user_id !== currentUserIdRef.current) return
      // eslint-disable-next-line no-console
      console.log('[voice] own VOICE_STATE_UPDATE', state)
      voiceSessionIdRef.current = state.session_id
      if (state.channel_id === null) {
        voiceConnectionRef.current?.disconnect()
        voiceConnectionRef.current = null
        setVoiceChannelId(null)
        setVoiceStatus('idle')
        setVoiceReadyInfo(null)
        setSpeakingUserIds(new Set())
      }
    })

    gateway.on('VOICE_SERVER_UPDATE', (data) => {
      const serverUpdate = data as { token: string; guild_id: string | null; endpoint: string }
      const sessionId = voiceSessionIdRef.current
      const userId = currentUserIdRef.current
      const channelId = voiceChannelIdRef.current
      // eslint-disable-next-line no-console
      console.log('[voice] VOICE_SERVER_UPDATE', serverUpdate, 'using sessionId', sessionId, 'userId', userId, 'channelId', channelId)
      if (!sessionId || !userId || !channelId) return

      // Guard against a retry storm: if the server keeps re-provisioning a
      // voice endpoint right after each failed attempt, each cycle's
      // WebSocket + RTCPeerConnection + ICE work is heavy enough to freeze
      // the tab if it repeats unthrottled.
      const now = Date.now()
      if (now - lastVoiceAttemptRef.current < 3000) {
        console.warn('[voice] ignoring VOICE_SERVER_UPDATE — arrived too soon after the last attempt')
        return
      }
      if (voiceRetryCountRef.current >= 3) {
        console.error('[voice] giving up after repeated voice connection failures')
        setVoiceStatus('idle')
        return
      }
      lastVoiceAttemptRef.current = now
      voiceRetryCountRef.current += 1

      voiceConnectionRef.current?.disconnect()
      const connection = new VoiceConnection(serverUpdate.guild_id, channelId, userId, sessionId, serverUpdate.token)
      connection.on('ready', (readyData) => {
        setVoiceStatus('ready')
        setVoiceReadyInfo(readyData as VoiceReadyData)
      })
      connection.on('track', (event) => {
        const track = event as RTCTrackEvent
        if (track.track.kind === 'video') {
          setRemoteVideoStream(track.streams[0])
          track.track.addEventListener('ended', () => setRemoteVideoStream(null))
        } else if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = track.streams[0]
        }
      })
      connection.on('screenshare-stopped', () => setIsSharingScreen(false))
      connection.on('speaking', (data) => {
        const { userId, speaking } = data as { userId: string; speaking: boolean }
        setSpeakingUserIds((prev) => {
          if (speaking === prev.has(userId)) return prev
          const next = new Set(prev)
          if (speaking) next.add(userId)
          else next.delete(userId)
          return next
        })
      })
      connection.connect(serverUpdate.endpoint)
      voiceConnectionRef.current = connection
    })

    gateway.on('TYPING_START', (data) => {
      const typing = data as { channel_id: string; user_id: string; member?: { user: { username: string } } }
      if (typing.channel_id !== activeChannelRef.current) return
      if (typing.user_id === currentUserIdRef.current) return

      const username = typing.member?.user.username ?? typing.user_id
      setTypingUsers((prev) => new Map(prev).set(typing.user_id, username))

      clearTimeout(typingTimers.current.get(typing.user_id))
      typingTimers.current.set(
        typing.user_id,
        setTimeout(() => {
          setTypingUsers((prev) => {
            const next = new Map(prev)
            next.delete(typing.user_id)
            return next
          })
        }, TYPING_TIMEOUT_MS),
      )
    })

    gatewayRef.current = gateway
    return () => {
      voiceConnectionRef.current?.disconnect()
      gateway.disconnect()
    }
  }, [token])

  function scrollToBottom() {
    const el = messagesElRef.current
    if (el) el.scrollTop = el.scrollHeight
  }

  async function openDMs() {
    setView('dm')
    setActiveGuild(null)
    setActiveChannel(null)
    setMessages([])
    const fetched = dmChannels.length > 0 ? dmChannels : await getDMChannels()
    setDmChannels(sortByRecency(fetched))
  }

  async function openGuild(guildId: string) {
    setView('guild')
    setActiveGuild(guildId)
    setActiveChannel(null)
    setMessages([])
    openGuildRequestIdRef.current = guildId

    const chans = await getGuildChannels(guildId)
    const groups = groupChannelsByCategory(chans)
    // Show channels right away; permission-based filtering refines this
    // in the background once (if) it resolves, so a slow/rate-limited
    // permissions lookup never blocks the channel list from appearing.
    setChannelGroups(groups)

    const guildList = (await guildsPromiseRef.current) ?? guilds
    const isOwner = guildList.find((g) => g.id === guildId)?.owner ?? false
    try {
      const [roles, member] = await Promise.all([getGuildRoles(guildId), getOwnGuildMember(guildId)])
      if (openGuildRequestIdRef.current !== guildId) return // user navigated elsewhere meanwhile

      const memberRoleIds = Array.isArray(member?.roles) ? member.roles : []
      const visibleGroups = groups
        .map((group) => ({
          category: group.category,
          channels: group.channels.filter((c) => {
            const perms = computeChannelPermissions(guildId, c, roles, memberRoleIds, isOwner)
            return c.type === CHANNEL_TYPE.GUILD_VOICE ? canConnect(perms) : canSendMessages(perms)
          }),
        }))
        .filter((group) => group.channels.length > 0)
      setChannelGroups(visibleGroups)
    } catch (err) {
      // Own-member/roles lookup can fail in ways that aren't just network errors
      // (unexpected response shape, rate limiting, etc.) — leave the unfiltered
      // list showing rather than hiding or blocking on it.
      console.error('[permissions] failed to compute channel visibility, leaving channels unfiltered', err)
    }
  }

  async function openChannel(channelId: string) {
    setActiveChannel(channelId)
    setTypingUsers(new Map())
    setHasMore(true)
    stickToBottomRef.current = true
    const msgs = await getChannelMessages(channelId)
    setMessages(msgs.reverse())
    requestAnimationFrame(scrollToBottom)
  }

  async function handleScroll(e: Event) {
    const el = e.currentTarget as HTMLDivElement
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_TO_BOTTOM_THRESHOLD_PX

    if (el.scrollTop > PAGINATE_THRESHOLD_PX || !hasMore || loadingMoreRef.current || !activeChannel) return
    if (messages.length === 0) return

    loadingMoreRef.current = true
    try {
      const older = await getChannelMessages(activeChannel, { before: messages[0].id })
      if (older.length === 0) {
        setHasMore(false)
        return
      }
      const prevHeight = el.scrollHeight
      setMessages((prev) => [...older.reverse(), ...prev])
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight - prevHeight
      })
    } finally {
      loadingMoreRef.current = false
    }
  }

  function handleDraftInput(e: Event) {
    setDraft((e.target as HTMLInputElement).value)
    const now = Date.now()
    if (activeChannel && now - lastTypingSentRef.current > TYPING_THROTTLE_MS) {
      lastTypingSentRef.current = now
      sendTyping(activeChannel).catch(() => {})
    }
  }

  function addFiles(files: FileList | File[]) {
    setPendingFiles((prev) => [...prev, ...Array.from(files)])
  }

  function removeFile(index: number) {
    setPendingFiles((prev) => prev.filter((_, i) => i !== index))
  }

  function handleFilePicked(e: Event) {
    const files = (e.target as HTMLInputElement).files
    if (files) addFiles(files)
    ;(e.target as HTMLInputElement).value = ''
  }

  function handleDrop(e: DragEvent) {
    e.preventDefault()
    if (e.dataTransfer?.files.length) addFiles(e.dataTransfer.files)
  }

  async function handleSend(e: Event) {
    e.preventDefault()
    if (!activeChannel || sending) return
    if (!draft.trim() && pendingFiles.length === 0) return

    const content = draft
    const files = pendingFiles
    setDraft('')
    setPendingFiles([])
    stickToBottomRef.current = true
    setSending(true)
    try {
      if (files.length > 0) {
        await sendMessageWithFiles(activeChannel, content, files)
      } else {
        await sendMessage(activeChannel, content)
      }
    } finally {
      setSending(false)
    }
  }

  function openProfileCard(userId: string, e: MouseEvent) {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    setProfileCard({ userId, x: rect.left, y: rect.bottom + 6 })
  }

  function joinVoiceChannel(guildId: string | null, channelId: string) {
    voiceChannelIdRef.current = channelId
    voiceGuildIdRef.current = guildId
    voiceRetryCountRef.current = 0
    lastVoiceAttemptRef.current = 0
    setVoiceChannelId(channelId)
    setVoiceStatus('connecting')
    setVoiceReadyInfo(null)
    gatewayRef.current?.updateVoiceState(guildId, channelId)
  }

  function leaveVoiceChannel() {
    gatewayRef.current?.updateVoiceState(voiceGuildIdRef.current, null)
    voiceConnectionRef.current?.disconnect()
    voiceConnectionRef.current = null
    voiceChannelIdRef.current = null
    voiceGuildIdRef.current = null
    setVoiceChannelId(null)
    setVoiceStatus('idle')
    setVoiceReadyInfo(null)
    setSpeakingUserIds(new Set())
    setIsSharingScreen(false)
    setRemoteVideoStream(null)
  }

  async function toggleScreenShare() {
    const connection = voiceConnectionRef.current
    const channelId = voiceChannelIdRef.current
    if (!connection || !channelId) return
    const guildId = voiceGuildIdRef.current
    const userId = currentUserIdRef.current

    if (isSharingScreen) {
      connection.stopScreenShare()
      setIsSharingScreen(false)
      // The real video keeps flowing over the existing voice connection —
      // these just tell other (real) Discord clients the stream stopped, so
      // their "Watch Stream" UI and self_stream badge clear.
      if (userId) {
        const streamKey = guildId ? `guild:${guildId}:${channelId}:${userId}` : `call:${channelId}:${userId}`
        gatewayRef.current?.deleteStream(streamKey)
      }
      gatewayRef.current?.updateVoiceState(guildId, channelId, false, false, false)
      return
    }
    try {
      await connection.startScreenShare()
      setIsSharingScreen(true)
      // Real clients don't discover our video by inspecting the voice
      // connection at all — they learn a stream exists via STREAM_CREATE
      // (triggered by createStream) and show the "is streaming" badge via
      // self_stream on our voice state. Without these, the underlying video
      // can be flowing perfectly and no one would ever know to watch it.
      gatewayRef.current?.createStream(guildId, channelId)
      gatewayRef.current?.updateVoiceState(guildId, channelId, false, false, true)
    } catch (err) {
      console.error('[voice] failed to start screen share', err)
    }
  }

  /** Starts or joins a DM/group-DM call — same channel doubles as the call. */
  async function startOrJoinDMCall(channelId: string) {
    const call = activeCalls.get(channelId)
    if (!call) {
      await ringCall(channelId)
      setRingSent(true)
      setTimeout(() => setRingSent(false), 4000)
    }
    joinVoiceChannel(null, channelId)
  }

  async function acceptIncomingCall(channelId: string) {
    setView('dm')
    await openChannel(channelId)
    joinVoiceChannel(null, channelId)
  }

  function dismissIncomingCall(channelId: string) {
    setDismissedCalls((prev) => new Set(prev).add(channelId))
  }

  const typingLabel =
    typingUsers.size === 0
      ? null
      : `${[...typingUsers.values()].join(', ')} ${typingUsers.size === 1 ? 'is' : 'are'} typing…`

  const activeGuildName = guilds.find((g) => g.id === activeGuild)?.name
  const activeDmChannel = dmChannels.find((c) => c.id === activeChannel)
  const allGuildChannels = channelGroups.flatMap((g) => g.channels)
  const headerLabel =
    view === 'dm'
      ? activeDmChannel
        ? dmChannelName(activeDmChannel)
        : 'Direct Messages'
      : allGuildChannels.find((c) => c.id === activeChannel)?.name

  // Guild voice states carry a `member` object with the user's avatar/name,
  // but DM/group-DM voice states don't (there's no "guild member" there) —
  // fall back to the DM channel's own recipient list (and our cached own
  // user for ourselves) so call tiles don't show a blank avatar and raw id.
  const voiceDmChannel = dmChannels.find((c) => c.id === voiceChannelId)
  function resolveCallParticipant(vs: VoiceStateLite): { name: string; avatar: string | null } {
    if (vs.member?.user) return { name: displayName(vs.member.user, vs.member), avatar: vs.member.user.avatar }
    if (vs.user_id === currentUser?.id) return { name: displayName(currentUser), avatar: currentUser.avatar }
    const recipient = voiceDmChannel?.recipients?.find((r) => r.id === vs.user_id)
    if (recipient) return { name: displayName(recipient), avatar: recipient.avatar }
    return { name: vs.user_id, avatar: null }
  }

  const incomingCalls = Array.from(activeCalls.entries()).filter(
    ([channelId, call]) =>
      currentUserIdRef.current != null &&
      call.ringing.includes(currentUserIdRef.current) &&
      !dismissedCalls.has(channelId) &&
      voiceChannelId !== channelId,
  )

  return (
    <div class="chat-app">
      {incomingCalls.length > 0 && (
        <div class="incoming-call-stack">
          {incomingCalls.map(([channelId]) => {
            const channel = dmChannels.find((c) => c.id === channelId)
            const name = channel ? dmChannelName(channel) : 'Someone'
            return (
              <div key={channelId} class="incoming-call-banner">
                <span>📞 {name} is calling…</span>
                <button class="incoming-call-accept" onClick={() => acceptIncomingCall(channelId)}>
                  Accept
                </button>
                <button class="incoming-call-dismiss" onClick={() => dismissIncomingCall(channelId)}>
                  Dismiss
                </button>
              </div>
            )
          })}
        </div>
      )}
      <nav class="guild-rail">
        <div class="guild-scroll">
          <button class={view === 'dm' ? 'guild dm-button active' : 'guild dm-button'} onClick={openDMs} title="Direct Messages">
            DM
          </button>
          <div class="guild-divider" />
          {guilds.map((g) => {
            const icon = guildIconUrl(g.id, g.icon)
            return (
              <button
                key={g.id}
                class={g.id === activeGuild ? 'guild active' : 'guild'}
                onClick={() => openGuild(g.id)}
                title={g.name}
              >
                {icon ? <img src={icon} alt="" class="guild-icon" /> : g.name.slice(0, 2).toUpperCase()}
              </button>
            )
          })}
        </div>
        <div class="guild-rail-footer">
          <button
            class="guild lock"
            onClick={() => {
              lock()
              onLock()
            }}
            title="Lock"
          >
            🔒
          </button>
        </div>
      </nav>

      <aside class="sidebar">
        <div class="sidebar-header">{view === 'dm' ? 'Direct Messages' : (activeGuildName ?? 'Select a server')}</div>
        <div class="sidebar-scroll">
          {view === 'dm'
            ? dmChannels.map((c) => {
                const isGroup = c.type === CHANNEL_TYPE.GROUP_DM
                const recipient = c.recipients?.[0]
                const icon = isGroup ? channelIconUrl(c.id, c.icon) : null
                return (
                  <button
                    key={c.id}
                    class={c.id === activeChannel ? 'dm-entry active' : 'dm-entry'}
                    onClick={() => openChannel(c.id)}
                  >
                    <span class="dm-avatar-wrap">
                      {isGroup ? (
                        icon ? (
                          <img src={icon} alt="" class="dm-avatar" />
                        ) : (
                          <span class="dm-avatar dm-avatar-group">👥</span>
                        )
                      ) : (
                        <img src={avatarUrl(recipient?.id ?? c.id, recipient?.avatar ?? null, 32)} alt="" class="dm-avatar" />
                      )}
                      {!isGroup && recipient && <StatusDot status={presences.get(recipient.id)} />}
                    </span>
                    <span class="dm-name">{dmChannelName(c)}</span>
                    {!isGroup && recipient && <GuildTag user={recipient} />}
                  </button>
                )
              })
            : channelGroups.map((group) => (
                <div key={group.category?.id ?? 'uncategorized'} class="channel-group">
                  {group.category && <div class="channel-group-header">{group.category.name}</div>}
                  {group.channels.map((c) =>
                    c.type === CHANNEL_TYPE.GUILD_VOICE ? (
                      <div key={c.id} class="voice-channel">
                        <span class="voice-channel-name">🔊 {c.name}</span>
                        {voiceChannelId === c.id ? (
                          <button type="button" class="voice-leave" onClick={leaveVoiceChannel}>
                            Leave
                          </button>
                        ) : (
                          <button
                            type="button"
                            class="voice-join"
                            onClick={() => activeGuild && joinVoiceChannel(activeGuild, c.id)}
                          >
                            Join
                          </button>
                        )}
                      </div>
                    ) : (
                      <button
                        key={c.id}
                        class={c.id === activeChannel ? 'channel active' : 'channel'}
                        onClick={() => openChannel(c.id)}
                      >
                        # {c.name}
                      </button>
                    ),
                  )}
                </div>
              ))}
        </div>
        {voiceChannelId && (
          <div class="voice-status-bar">
            {voiceStatus === 'connecting' && <span>Connecting to voice…</span>}
            {voiceStatus === 'ready' && voiceReadyInfo && (
              <span>
                Voice signaling ready (ssrc {voiceReadyInfo.ssrc}, modes: {voiceReadyInfo.modes.join(', ')})
              </span>
            )}
            <button
              type="button"
              class={isSharingScreen ? 'screen-share-button active' : 'screen-share-button'}
              onClick={toggleScreenShare}
            >
              {isSharingScreen ? 'Stop Sharing' : 'Share Screen'}
            </button>
          </div>
        )}
      </aside>

      <main class="message-pane">
        <div class="message-pane-header">
          <span>{headerLabel ?? ' '}</span>
          {view === 'dm' && activeChannel && (
            voiceChannelId === activeChannel ? (
              <button class="ring-button call-active" onClick={leaveVoiceChannel} title="Leave call">
                📞 Leave
              </button>
            ) : (
              <button
                class="ring-button"
                onClick={() => startOrJoinDMCall(activeChannel)}
                title={activeCalls.has(activeChannel) ? 'Join call' : 'Start call'}
              >
                {ringSent ? 'Ringing…' : activeCalls.has(activeChannel) ? '📞 Join' : '📞'}
              </button>
            )
          )}
        </div>
        {voiceChannelId && (
          <div class="call-panel">
            {Array.from(voiceStates.values())
              .filter((vs) => vs.channel_id === voiceChannelId)
              .map((vs) => {
                const { name, avatar } = resolveCallParticipant(vs)
                const speaking = speakingUserIds.has(vs.user_id)
                return (
                  <div key={vs.user_id} class={speaking ? 'call-tile speaking' : 'call-tile'}>
                    <img class="call-avatar" src={avatarUrl(vs.user_id, avatar, 128)} alt="" />
                    <span class="call-name">{name}</span>
                  </div>
                )
              })}
          </div>
        )}
        {remoteVideoStream && (
          <div class="screen-share-viewer">
            <video ref={remoteVideoRef} autoPlay playsInline />
          </div>
        )}
        <div class="messages" ref={messagesElRef} onScroll={handleScroll}>
          {messages.map((m) => (
            <div key={m.id} class="message">
              <span class="avatar-wrap">
                <img
                  class="avatar"
                  src={avatarUrl(m.author.id, m.author.avatar, 32)}
                  alt=""
                  onClick={(e) => openProfileCard(m.author.id, e)}
                />
                <StatusDot status={presences.get(m.author.id)} />
              </span>
              <div class="message-body">
                <div>
                  <span class="author" onClick={(e) => openProfileCard(m.author.id, e)}>
                    {displayName(m.author, m.member)}
                  </span>
                  <GuildTag user={m.author} />
                  <span class="content">{m.content}</span>
                </div>
                {m.attachments.map((a) => {
                  if (a.content_type?.startsWith('image/')) {
                    return <img key={a.id} src={a.url} alt={a.filename} class="attachment-image" />
                  }
                  if (a.content_type?.startsWith('video/')) {
                    return <video key={a.id} src={a.url} controls class="attachment-video" />
                  }
                  if (a.content_type?.startsWith('audio/')) {
                    return <audio key={a.id} src={a.url} controls class="attachment-audio" />
                  }
                  return (
                    <a key={a.id} href={a.url} target="_blank" rel="noreferrer" class="attachment-file">
                      <span class="attachment-file-icon">📄</span>
                      <span>
                        <span class="attachment-file-name">{a.filename}</span>
                        <span class="attachment-file-size">{formatFileSize(a.size)}</span>
                      </span>
                    </a>
                  )
                })}
                {m.embeds.map((embed, i) => (
                  <div key={i} class="embed">
                    {embed.title &&
                      (embed.url ? (
                        <a class="embed-title" href={embed.url} target="_blank" rel="noreferrer">
                          {embed.title}
                        </a>
                      ) : (
                        <div class="embed-title">{embed.title}</div>
                      ))}
                    {embed.description && <div class="embed-description">{embed.description}</div>}
                    {(embed.image?.url || embed.thumbnail?.url) && (
                      <img class="embed-image" src={embed.image?.url ?? embed.thumbnail?.url} alt="" />
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
        {typingLabel && <div class="typing-indicator">{typingLabel}</div>}
        {activeChannel && (
          <form
            class="composer"
            onSubmit={handleSend}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            {pendingFiles.length > 0 && (
              <div class="pending-files">
                {pendingFiles.map((file, i) => (
                  <div key={i} class="pending-file">
                    <span class="pending-file-name">{file.name}</span>
                    <button type="button" class="pending-file-remove" onClick={() => removeFile(i)}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div class="composer-row">
              <input
                type="file"
                multiple
                ref={fileInputRef}
                class="file-input"
                onChange={handleFilePicked}
              />
              <button
                type="button"
                class="attach-button"
                onClick={() => fileInputRef.current?.click()}
                title="Upload a file"
              >
                +
              </button>
              <input value={draft} onInput={handleDraftInput} placeholder="Message…" />
              <button type="submit" disabled={sending}>
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </form>
        )}
      </main>

      {profileCard && (
        <UserProfileCard
          userId={profileCard.userId}
          anchor={profileCard}
          status={presences.get(profileCard.userId)}
          onClose={() => setProfileCard(null)}
        />
      )}

      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <audio ref={remoteAudioRef} autoPlay />
    </div>
  )
}
