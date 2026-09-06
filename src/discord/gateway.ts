// Discord Gateway (websocket) client: identify, heartbeat, resume, and
// dispatch events. Covers enough to receive live MESSAGE_CREATE, TYPING_START
// etc. Voice and sharding are not implemented.

const GATEWAY_URL = 'wss://gateway.discord.gg/?v=10&encoding=json'

const OpCode = {
  Dispatch: 0,
  Heartbeat: 1,
  Identify: 2,
  VoiceStateUpdate: 4,
  Resume: 6,
  Reconnect: 7,
  InvalidSession: 9,
  Hello: 10,
  HeartbeatAck: 11,
  // "Go Live" screen share announcement opcodes. The actual video media
  // still flows over the existing voice connection (confirmed via a real
  // capture — starting your own share doesn't open a new voice-media
  // connection), but real clients only learn a stream exists to watch at
  // all via STREAM_CREATE, which is triggered by sending this.
  CreateStream: 18,
  DeleteStream: 19,
} as const
type OpCode = (typeof OpCode)[keyof typeof OpCode]

interface GatewayPayload {
  op: OpCode
  d?: unknown
  s?: number | null
  t?: string | null
}

type EventHandler = (data: unknown) => void

// Close codes Discord defines as non-recoverable — don't retry these.
const FATAL_CLOSE_CODES = [4004, 4010, 4011, 4012, 4013, 4014]

export class GatewayClient {
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sequence: number | null = null
  private sessionId: string | null = null
  private resumeUrl: string = GATEWAY_URL
  private handlers = new Map<string, Set<EventHandler>>()
  private token: string

  constructor(token: string) {
    this.token = token
  }

  connect(): void {
    const url = this.sessionId ? this.resumeUrl : GATEWAY_URL
    this.ws = new WebSocket(url)
    this.ws.addEventListener('message', (event) => this.handleMessage(JSON.parse(event.data)))
    this.ws.addEventListener('close', (event) => this.handleClose(event))
  }

  disconnect(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.sessionId = null
    this.sequence = null
    this.ws?.close(1000)
    this.ws = null
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set())
    this.handlers.get(eventType)!.add(handler)
    return () => this.handlers.get(eventType)?.delete(handler)
  }

  /**
   * Joins (or leaves, with channelId null) a voice channel or DM/group-DM
   * call. guildId is null for DM/group-DM calls — Discord identifies those
   * purely by channelId.
   */
  updateVoiceState(
    guildId: string | null,
    channelId: string | null,
    selfMute = false,
    selfDeaf = false,
    selfStream = false,
  ): void {
    this.send({
      op: OpCode.VoiceStateUpdate,
      d: {
        guild_id: guildId,
        channel_id: channelId,
        self_mute: selfMute,
        self_deaf: selfDeaf,
        self_stream: selfStream,
      },
    })
  }

  /** Announces a "Go Live" screen share so other clients see it and can Watch Stream it. guildId null means a DM/group-DM call ("call" type). */
  createStream(guildId: string | null, channelId: string): void {
    this.send({
      op: OpCode.CreateStream,
      d: guildId ? { type: 'guild', guild_id: guildId, channel_id: channelId } : { type: 'call', channel_id: channelId },
    })
  }

  deleteStream(streamKey: string): void {
    this.send({ op: OpCode.DeleteStream, d: { stream_key: streamKey } })
  }

  private send(payload: GatewayPayload): void {
    this.ws?.send(JSON.stringify(payload))
  }

  private handleMessage(payload: GatewayPayload): void {
    if (payload.s != null) this.sequence = payload.s

    switch (payload.op) {
      case OpCode.Hello: {
        const { heartbeat_interval } = payload.d as { heartbeat_interval: number }
        this.startHeartbeat(heartbeat_interval)
        if (this.sessionId && this.sequence != null) this.resume()
        else this.identify()
        break
      }
      case OpCode.Dispatch:
        if (payload.t === 'READY') {
          const ready = payload.d as { session_id: string; resume_gateway_url: string }
          this.sessionId = ready.session_id
          this.resumeUrl = `${ready.resume_gateway_url}/?v=10&encoding=json`
        }
        if (payload.t) this.emit(payload.t, payload.d)
        break
      case OpCode.InvalidSession: {
        // d is true if the session could still be resumed, false if we must start fresh.
        const resumable = payload.d === true
        if (!resumable) {
          this.sessionId = null
          this.sequence = null
        }
        setTimeout(() => (resumable && this.sessionId ? this.resume() : this.identify()), 1500)
        break
      }
      case OpCode.Reconnect:
        this.ws?.close()
        this.connect()
        break
      default:
        break
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    if (FATAL_CLOSE_CODES.includes(event.code)) {
      this.sessionId = null
      this.sequence = null
      return
    }
    setTimeout(() => this.connect(), 2000)
  }

  private startHeartbeat(intervalMs: number): void {
    this.send({ op: OpCode.Heartbeat, d: this.sequence })
    this.heartbeatTimer = setInterval(() => {
      this.send({ op: OpCode.Heartbeat, d: this.sequence })
    }, intervalMs)
  }

  private identify(): void {
    this.send({
      op: OpCode.Identify,
      d: {
        token: this.token,
        properties: { os: 'browser', browser: 'custom-frontend', device: 'custom-frontend' },
        compress: false,
      },
    })
  }

  private resume(): void {
    this.send({
      op: OpCode.Resume,
      d: { token: this.token, session_id: this.sessionId, seq: this.sequence },
    })
  }

  private emit(eventType: string, data: unknown): void {
    this.handlers.get(eventType)?.forEach((handler) => handler(data))
  }
}
