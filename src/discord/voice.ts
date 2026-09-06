// Discord Voice Gateway client with DAVE (E2EE) support.
//
// Flow: connect -> Identify (advertises max_dave_protocol_version) -> Hello
// (heartbeat) -> we build a WebRTC offer and send it as a stripped SDP
// fragment via Select Protocol (op 1, protocol "webrtc") -> server replies
// with Session Description (op 4) carrying its own SDP + the negotiated
// dave_protocol_version -> DAVE/MLS handshake runs over opcodes 21-31
// (mix of JSON and binary frames) via DaveSessionManager -> once a key
// ratchet is available, WebRTC Encoded Transforms en/decrypt real frames
// through the compiled libdave WASM module.
//
// This is fresh, largely unverified-against-a-live-session integration code
// built from the documented protocol rather than a known-working reference —
// expect to iterate on it against real traffic.

import { DaveSessionManager, type DaveKeyRatchet } from '../dave/DaveSessionManager'
import { decryptFrame, encryptFrame } from '../dave/frameCrypto'
import { loadDaveModule } from '../dave/wasm'
import type { Decryptor, Encryptor } from '../dave/wasm/libdave'
import type { DaveModule } from '../dave/wasm'

const VOICE_OPCODE = {
  Identify: 0,
  SelectProtocol: 1,
  Ready: 2,
  Heartbeat: 3,
  SessionDescription: 4,
  Speaking: 5,
  HeartbeatAck: 6,
  Resume: 7,
  Hello: 8,
  Resumed: 9,
  // Announces a client's video/screen-share state: sent with our own ssrc(s)
  // whenever we start/stop sending video, received to learn another user's
  // video ssrc so we know what to renegotiate a receiving transceiver for.
  // Confirmed via real capture of a live screen-share session.
  Video: 12,
  DavePrepareTransition: 21,
  DaveExecuteTransition: 22,
  DaveReadyForTransition: 23,
  DavePrepareEpoch: 24,
  DaveMlsExternalSenderPackage: 25,
  DaveMlsKeyPackage: 26,
  DaveMlsProposals: 27,
  DaveMlsCommitWelcome: 28,
  DaveMlsAnnounceCommitTransition: 29,
  DaveMlsWelcome: 30,
  DaveMlsInvalidCommitWelcome: 31,
  // Undocumented: client/server build-info exchange observed right after
  // Ready, before Select Protocol, in a captured real session.
  ClientInfo: 16,
  // Undocumented, observed in real captures right after Ready, well before
  // any Speaking event: announces the user ID(s) already present in the
  // channel ("Client Connect") and per-user state (video flags, platform).
  // These are the only signal we get for a silent peer's identity, so they
  // must feed DaveSessionManager.createUser() or MLS Welcome verification
  // rejects that peer as an "unrecognized user ID".
  ClientConnect: 11,
  ClientDisconnect: 13,
  ClientFlags: 18,
  ClientPlatform: 20,
} as const

interface VoiceJsonPayload {
  op: number
  d?: unknown
  seq?: number
}

export interface VoiceReadyData {
  ssrc: number
  ip: string
  port: number
  modes: string[]
}

type EventHandler = (data: unknown) => void

// Ambient: Chrome's insertable-streams API isn't in lib.dom.d.ts yet.
interface RTCEncodedStreams {
  readable: ReadableStream
  writable: WritableStream
}
interface RTCRtpSenderWithEncodedStreams extends RTCRtpSender {
  createEncodedStreams(): RTCEncodedStreams
}
interface RTCRtpReceiverWithEncodedStreams extends RTCRtpReceiver {
  createEncodedStreams(): RTCEncodedStreams
}
interface EncodedFrameChunk {
  data: ArrayBuffer
  getMetadata?: () => { synchronizationSource?: number }
}

function readBigEndianUint16(view: DataView, offset: number): number {
  return view.getUint16(offset, false)
}

/** Server binary broadcasts are [seq: u16][opcode: u8][payload...]. */
function parseBinaryFrame(buf: ArrayBuffer): { opcode: number; payload: Uint8Array } {
  const view = new DataView(buf)
  const opcode = view.getUint8(2)
  return { opcode, payload: new Uint8Array(buf, 3) }
}

/** Client->server binary sends are just [opcode: u8][payload...], no sequence number. */
function buildBinaryFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + payload.byteLength)
  out[0] = opcode
  out.set(payload, 1)
  return out
}

// Per docs.discord.food/topics/voice-connections#select-protocol-sdp-fragment:
// keep transport lines plus ONLY the opus/VP8(+its RTX) rtpmap lines — not
// every codec the browser offered (G722/PCMU/PCMA/CN/telephone-event/red).
// We're audio-only here, so in practice that's just the opus line.
function extractWebRtcSdpFragment(sdp: string): string {
  const lines = sdp.split(/\r?\n/).filter((line) => {
    if (/^a=(extmap-allow-mixed|ice-|fingerprint|extmap:)/i.test(line)) return true
    if (/^a=rtpmap:\d+\s+opus\//i.test(line)) return true
    if (/^a=rtpmap:\d+\s+VP8\//i.test(line)) return true
    // The rtx (retransmission) payload paired with VP8 — present in a real
    // captured screen-share fragment alongside the VP8 rtpmap line.
    if (/^a=rtpmap:\d+\s+rtx\//i.test(line)) return true
    return false
  })
  return [...new Set(lines)].join('\n')
}

/** Splits an SDP into per-m-line chunks (each starting with its own "m="). */
function splitMLines(sdp: string): string[] {
  return sdp
    .split(/\r?\nm=/)
    .slice(1)
    .map((s) => 'm=' + s)
}

function extractSsrcForKind(sdp: string, kind: 'audio' | 'video'): number | null {
  const section = splitMLines(sdp).find((s) => s.startsWith(`m=${kind}`))
  if (!section) return null
  const match = /^a=ssrc:(\d+)/m.exec(section)
  return match ? Number(match[1]) : null
}

// Discord's own web client waits for ICE gathering to make real progress
// (it logs "connected to media server" from a discovered candidate) before
// sending its SDP — confirmed from a captured real client session. Waiting
// for full "complete" state is a reasonable proxy for that.
function waitForIceGatheringComplete(pc: RTCPeerConnection, timeoutMs: number): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pc.removeEventListener('icegatheringstatechange', check)
      resolve()
    }, timeoutMs)
    function check() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer)
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
    }
    pc.addEventListener('icegatheringstatechange', check)
  })
}

interface LocalMLine {
  kind: 'audio' | 'video'
  mid: string
  rtpmaps: { payloadType: string; codec: string }[]
}

function parseLocalMLines(localSdp: string): LocalMLine[] {
  return splitMLines(localSdp).map((section) => {
    const kind = /^m=(audio|video)/.exec(section)?.[1] === 'video' ? 'video' : 'audio'
    const mid = /^a=mid:(.+)$/im.exec(section)?.[1] ?? '0'
    const rtpmaps: { payloadType: string; codec: string }[] = []
    const rtpmapRegex = /^a=rtpmap:(\d+)\s+([\w-]+)\//gim
    let match: RegExpExecArray | null
    while ((match = rtpmapRegex.exec(section))) rtpmaps.push({ payloadType: match[1], codec: match[2] })
    return { kind, mid, rtpmaps }
  })
}

/**
 * The server's Session Description `sdp` is only a transport/codec
 * template (ice-ufrag/pwd, fingerprint, candidate, connection address) —
 * not a usable answer on its own, and it stays a single `m=audio` template
 * even once we add video (confirmed via a real captured screen-share
 * session — video_codec/audio_codec appear as separate top-level fields
 * instead). We synthesize a full multi-m-line answer by combining that
 * shared transport info with each m-line from our own local offer, per
 * docs.discord.food/topics/voice-connections#generating-the-browser-remote-answer.
 */
function buildAnswerSdp(serverSdp: string, localSdp: string): string {
  const connectionLine = serverSdp.split(/\r?\n/).find((l) => l.startsWith('c=')) ?? 'c=IN IP4 0.0.0.0'
  const iceUfrag = /^a=ice-ufrag:(.+)$/im.exec(serverSdp)?.[1] ?? ''
  const icePwd = /^a=ice-pwd:(.+)$/im.exec(serverSdp)?.[1] ?? ''
  const fingerprint = /^a=fingerprint:(.+)$/im.exec(serverSdp)?.[1] ?? ''
  const candidates = serverSdp.split(/\r?\n/).filter((l) => l.startsWith('a=candidate:'))

  const mLines = parseLocalMLines(localSdp)
  const transportLines = [
    connectionLine,
    'a=rtcp:9 IN IP4 0.0.0.0',
    `a=ice-ufrag:${iceUfrag}`,
    `a=ice-pwd:${icePwd}`,
    `a=fingerprint:${fingerprint}`,
    ...candidates,
    'a=setup:passive',
  ]

  const sections = mLines.map((line) => {
    if (line.kind === 'audio') {
      const pt = line.rtpmaps.find((r) => r.codec === 'opus')?.payloadType ?? '111'
      return [
        `m=audio 9 UDP/TLS/RTP/SAVPF ${pt}`,
        ...transportLines,
        `a=mid:${line.mid}`,
        // Discord's voice server is a media relay (SFU): each m-line both
        // carries our outbound media and receives every other participant's
        // audio/video multiplexed by SSRC — it's not point-to-point WebRTC
        // where recvonly would mean "the answerer never sends". Answering
        // recvonly here (reasoning from the two-party offer/answer direction
        // table) made Chrome negotiate a receive-only transceiver and
        // silently drop our own outgoing audio.
        'a=sendrecv',
        'a=rtcp-mux',
        `a=rtpmap:${pt} opus/48000/2`,
        `a=fmtp:${pt} minptime=10;useinbandfec=1;usedtx=1`,
        'a=maxptime:60',
        `a=rtcp-fb:${pt} transport-cc`,
        'a=extmap:1 urn:ietf:params:rtp-hdrext:ssrc-audio-level',
        'a=extmap:3 http://www.ietf.org/id/draft-holmer-rmcat-transport-wide-cc-extensions-01',
      ]
    }

    // Derived purely from our own local offer (which setCodecPreferences
    // restricted to VP8), never from the server's video_codec field — that
    // field mismatched our actual offer's payload type once, producing a
    // codec-name/payload-type pair Chrome rejected outright ("Failed to
    // parse codecs correctly").
    const codec = line.rtpmaps.find((r) => r.codec !== 'rtx')
    const pt = codec?.payloadType ?? '96'
    const rtx = line.rtpmaps.find((r) => r.codec === 'rtx')
    // Every payload type referenced anywhere below (rtpmap/fmtp) must also
    // be listed on the m= line itself, or Chrome rejects the whole SDP —
    // not just this m-line — with "Failed to parse codecs correctly",
    // which was silently taking the audio m-line down with it too.
    const payloadTypes = [pt, ...(rtx ? [rtx.payloadType] : [])].join(' ')
    return [
      `m=video 9 UDP/TLS/RTP/SAVPF ${payloadTypes}`,
      ...transportLines,
      `a=mid:${line.mid}`,
      'a=sendrecv',
      'a=rtcp-mux',
      `a=rtpmap:${pt} ${(codec?.codec ?? 'VP8').toUpperCase()}/90000`,
      `a=rtcp-fb:${pt} transport-cc`,
      `a=rtcp-fb:${pt} ccm fir`,
      `a=rtcp-fb:${pt} nack`,
      `a=rtcp-fb:${pt} nack pli`,
      `a=rtcp-fb:${pt} goog-remb`,
      ...(rtx ? [`a=rtpmap:${rtx.payloadType} rtx/90000`, `a=fmtp:${rtx.payloadType} apt=${pt}`] : []),
    ]
  })

  const lines = [
    'v=0',
    'o=- 1420070400000 0 IN IP4 127.0.0.1',
    's=-',
    't=0 0',
    `a=group:BUNDLE ${mLines.map((l) => l.mid).join(' ')}`,
    'a=msid-semantic: WMS *',
    ...sections.flat(),
  ]
  return lines.join('\r\n') + '\r\n'
}

interface CodecDescriptor {
  name: string
  type: 'audio' | 'video'
  priority: number
  payload_type: number
  rtx_payload_type: number | null
}

/**
 * If `codecs` is omitted, Discord assumes Opus at payload type 120 — but
 * browsers pick their own dynamic payload type (usually 111), so omitting
 * this causes a payload-type mismatch between what the server expects and
 * what the offer actually contains.
 */
function extractOpusCodecDescriptor(sdp: string): CodecDescriptor | null {
  const match = /^a=rtpmap:(\d+)\s+opus\//im.exec(sdp)
  if (!match) return null
  return { name: 'opus', type: 'audio', priority: 1000, payload_type: Number(match[1]), rtx_payload_type: null }
}

/** Priority 2000 and the VP8/rtx pairing match a real captured screen-share Select Protocol payload. */
function extractVideoCodecDescriptor(sdp: string): CodecDescriptor | null {
  const match = /^a=rtpmap:(\d+)\s+VP8\//im.exec(sdp)
  if (!match) return null
  const rtxMatch = new RegExp(`^a=fmtp:(\\d+)\\s+apt=${match[1]}$`, 'im').exec(sdp)
  return {
    name: 'VP8',
    type: 'video',
    priority: 2000,
    payload_type: Number(match[1]),
    rtx_payload_type: rtxMatch ? Number(rtxMatch[1]) : null,
  }
}

const FATAL_CLOSE_CODES = [4004, 4006, 4010, 4011, 4012, 4013, 4014, 4015, 4016, 4017]

export class VoiceConnection {
  private ws: WebSocket | null = null
  private pc: RTCPeerConnection | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private handlers = new Map<string, Set<EventHandler>>()

  // "server_id" in Identify — the guild id for guild voice channels, or the
  // channel id itself for DM/group-DM calls, which have no guild. This is
  // NOT the same scope as the DAVE MLS group id (see channelId below):
  // ProcessWelcome/VerifyWelcomeState never check group_id, so joining a
  // group and steady-state encrypt/decrypt both work fine regardless of
  // what groupId_ is set to — but CanProcessCommit() does compare
  // commit.group_id() against it, and that's only ever exercised by the
  // first join/leave commit of the call. Passing the guild id there instead
  // of the channel id makes every such commit permanently fail as
  // `ignored`, silently freezing the MLS epoch for the rest of the call.
  private serverId: string
  private userId: string
  private sessionId: string
  private token: string
  private channelId: string

  private ownSsrc: number | null = null
  private ownVideoSsrc: number | null = null
  private screenStream: MediaStream | null = null
  private videoTransceiver: RTCRtpTransceiver | null = null
  private lastSeq: number | null = null
  private audioContext: AudioContext | null = null
  private vadInterval: ReturnType<typeof setInterval> | null = null
  private selfSpeaking = false
  private dave: DaveModule | null = null
  private daveSession: DaveSessionManager | null = null
  private encryptor: Encryptor | null = null
  private decryptorsByUser = new Map<string, Decryptor>()
  private ssrcToUserId = new Map<number, string>()
  // User IDs learned from ClientConnect/ClientFlags/ClientPlatform/Speaking
  // before a DaveSessionManager exists yet (it's created lazily on
  // SessionDescription). Flushed into the session once it's created, and
  // consulted directly for any that arrive after.
  private knownUserIds = new Set<string>()

  constructor(guildId: string | null, channelId: string, userId: string, sessionId: string, token: string) {
    this.serverId = guildId ?? channelId
    this.channelId = channelId
    this.userId = userId
    this.sessionId = sessionId
    this.token = token
  }

  async connect(endpoint: string): Promise<void> {
    this.dave = await loadDaveModule()

    this.ws = new WebSocket(`wss://${endpoint}/?v=9`)
    this.ws.binaryType = 'arraybuffer'
    this.ws.addEventListener('open', () => this.identify())
    this.ws.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        this.handleJson(JSON.parse(event.data))
      } else {
        this.handleBinary(event.data as ArrayBuffer)
      }
    })
    this.ws.addEventListener('error', (event) => console.error('[voice] websocket error', event))
    this.ws.addEventListener('close', (event) => {
      console.log(`[voice] websocket closed: code=${event.code} reason=${event.reason || '(none)'}`)
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      this.emit('close', event)
    })
  }

  disconnect(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    if (this.vadInterval) {
      clearInterval(this.vadInterval)
      this.vadInterval = null
    }
    this.audioContext?.close()
    this.audioContext = null
    this.screenStream?.getTracks().forEach((track) => track.stop())
    this.screenStream = null
    this.videoTransceiver = null
    this.pc?.close()
    this.pc = null
    this.ws?.close(1000)
    this.ws = null
  }

  on(eventType: string, handler: EventHandler): () => void {
    if (!this.handlers.has(eventType)) this.handlers.set(eventType, new Set())
    this.handlers.get(eventType)!.add(handler)
    return () => this.handlers.get(eventType)?.delete(handler)
  }

  private registerUser(userId: string): void {
    if (userId === this.userId) return
    this.knownUserIds.add(userId)
    this.daveSession?.createUser(userId)
  }

  private send(payload: VoiceJsonPayload): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload))
  }

  private sendBinary(opcode: number, payload: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(buildBinaryFrame(opcode, payload) as BufferSource)
  }

  private identify(): void {
    const payload = {
      server_id: this.serverId,
      channel_id: this.channelId,
      user_id: this.userId,
      session_id: this.sessionId,
      token: this.token,
      max_dave_protocol_version: this.dave?.MaxSupportedProtocolVersion() ?? 0,
    }
    console.log('[voice] sending Identify', payload)
    this.send({ op: VOICE_OPCODE.Identify, d: payload })
  }

  private startHeartbeat(intervalMs: number): void {
    const beat = () =>
      this.send({ op: VOICE_OPCODE.Heartbeat, d: { t: Date.now(), seq_ack: this.lastSeq ?? 0 } })
    beat()
    this.heartbeatTimer = setInterval(beat, intervalMs)
  }

  private async handleJson(payload: VoiceJsonPayload): Promise<void> {
    if (payload.seq != null) this.lastSeq = payload.seq
    if (![3, 5, 6].includes(payload.op)) {
      console.log('[voice][dave-trace] JSON frame op =', payload.op, 'd =', payload.d)
    }

    switch (payload.op) {
      case VOICE_OPCODE.Hello: {
        const { heartbeat_interval } = payload.d as { heartbeat_interval: number }
        this.startHeartbeat(heartbeat_interval)
        break
      }
      case VOICE_OPCODE.Ready: {
        const ready = payload.d as VoiceReadyData
        this.ownSsrc = ready.ssrc
        console.log('[voice] Ready', ready)
        this.emit('ready', ready)
        this.send({ op: VOICE_OPCODE.ClientInfo, d: {} })
        await this.startWebRtc()
        break
      }
      case VOICE_OPCODE.ClientInfo:
        console.log('[voice] ClientInfo', payload.d)
        break
      case VOICE_OPCODE.SessionDescription: {
        const desc = payload.d as { sdp: string; dave_protocol_version?: number; video_codec?: string }
        console.log('[voice] SessionDescription received. dave_protocol_version =', desc.dave_protocol_version)
        console.log('[voice] server sdp:\n' + desc.sdp)

        // Create the DAVE session and ack the protocol version synchronously,
        // *before* the setRemoteDescription await below — otherwise any DAVE
        // opcode (e.g. the External Sender package, sent once and never
        // repeated) that arrives while we're awaiting would find
        // this.daveSession still null and get silently dropped forever.
        this.ensureDaveSession()
        this.daveSession?.onSelectProtocolAck(desc.dave_protocol_version ?? 0)

        if (this.pc) {
          const answerSdp = buildAnswerSdp(desc.sdp, this.pc.localDescription!.sdp)
          console.log('[voice] synthesized answer sdp:\n' + answerSdp)
          try {
            await this.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
            console.log('[voice] setRemoteDescription succeeded')
          } catch (err) {
            console.error('[voice] setRemoteDescription failed', err)
          }
        }
        break
      }
      case VOICE_OPCODE.Speaking: {
        const speaking = payload.d as { user_id: string; ssrc: number; speaking: number }
        if (!this.ssrcToUserId.has(speaking.ssrc)) {
          this.ssrcToUserId.set(speaking.ssrc, speaking.user_id)
          this.registerUser(speaking.user_id)
        }
        this.emit('speaking', { userId: speaking.user_id, speaking: (speaking.speaking ?? 0) !== 0 })
        break
      }
      case VOICE_OPCODE.ClientConnect: {
        const d = payload.d as { user_ids: string[] }
        for (const userId of d.user_ids) this.registerUser(userId)
        break
      }
      case VOICE_OPCODE.Video: {
        const d = payload.d as { video_ssrc?: number; user_id?: string; streams?: { ssrc: number }[] }
        if (!d.user_id) break
        this.registerUser(d.user_id)
        // Our video m-line is negotiated bidirectionally from connect time
        // (see startWebRtc), so there's nothing to renegotiate here — just
        // remember whose ssrc this is so the incoming-track decrypt pipeline
        // can attribute their frames to the right Decryptor.
        if (d.video_ssrc) this.ssrcToUserId.set(d.video_ssrc, d.user_id)
        for (const stream of d.streams ?? []) this.ssrcToUserId.set(stream.ssrc, d.user_id)
        break
      }
      case VOICE_OPCODE.ClientDisconnect: {
        const d = payload.d as { user_id: string }
        console.log('[voice][dave-trace] ClientDisconnect', d.user_id)
        this.knownUserIds.delete(d.user_id)
        this.daveSession?.destroyUser(d.user_id)
        break
      }
      case VOICE_OPCODE.ClientFlags: {
        const d = payload.d as { user_id: string; flags: number }
        this.registerUser(d.user_id)
        break
      }
      case VOICE_OPCODE.ClientPlatform: {
        const d = payload.d as { user_id: string; platform: number }
        this.registerUser(d.user_id)
        break
      }
      case VOICE_OPCODE.DavePrepareTransition: {
        const d = payload.d as { transition_id: number; protocol_version: number }
        console.log('[voice][dave-trace] DavePrepareTransition', d)
        this.daveSession?.onDaveProtocolPrepareTransition(d.transition_id, d.protocol_version)
        break
      }
      case VOICE_OPCODE.DaveExecuteTransition: {
        const d = payload.d as { transition_id: number }
        console.log('[voice][dave-trace] DaveExecuteTransition', d)
        this.daveSession?.onDaveProtocolExecuteTransition(d.transition_id)
        break
      }
      case VOICE_OPCODE.DavePrepareEpoch: {
        const d = payload.d as { epoch: number; protocol_version: number }
        console.log('[voice][dave-trace] DavePrepareEpoch', d)
        this.daveSession?.onDaveProtocolPrepareEpoch(String(d.epoch), d.protocol_version)
        break
      }
      default:
        console.log('[voice] unhandled JSON opcode', payload.op, payload.d)
        break
    }
  }

  private handleBinary(buf: ArrayBuffer): void {
    const { opcode, payload } = parseBinaryFrame(buf)
    console.log('[voice][dave-trace] binary frame opcode =', opcode, 'bytes =', payload.byteLength)
    switch (opcode) {
      case VOICE_OPCODE.DaveMlsExternalSenderPackage:
        this.daveSession?.onDaveProtocolMLSExternalSenderPackage(payload)
        break
      case VOICE_OPCODE.DaveMlsProposals:
        console.log('[voice][dave-trace] MLS Proposals, bytes =', payload.byteLength)
        this.daveSession?.onMLSProposals(payload)
        break
      case VOICE_OPCODE.DaveMlsAnnounceCommitTransition: {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        const transitionId = readBigEndianUint16(view, 0)
        console.log('[voice][dave-trace] MLS AnnounceCommitTransition, transitionId =', transitionId)
        this.daveSession?.onMLSAnnounceCommitTransition(transitionId, payload.subarray(2))
        break
      }
      case VOICE_OPCODE.DaveMlsWelcome: {
        const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
        const transitionId = readBigEndianUint16(view, 0)
        console.log('[voice][dave-trace] MLS Welcome, transitionId =', transitionId)
        this.daveSession?.onMLSWelcome(transitionId, payload.subarray(2))
        break
      }
      default:
        console.log('[voice] unhandled binary opcode', opcode)
        break
    }
  }

  private ensureDaveSession(): void {
    if (this.daveSession || !this.dave) return
    this.daveSession = new DaveSessionManager(this.dave, null, this.userId, this.channelId, {
      sendReadyForTransition: (transitionId) =>
        this.send({ op: VOICE_OPCODE.DaveReadyForTransition, d: { transition_id: transitionId } }),
      sendKeyPackage: (keyPackage) => this.sendBinary(VOICE_OPCODE.DaveMlsKeyPackage, keyPackage),
      sendCommitWelcome: (commitWelcome) => this.sendBinary(VOICE_OPCODE.DaveMlsCommitWelcome, commitWelcome),
      sendInvalidCommitWelcome: (transitionId) =>
        this.send({ op: VOICE_OPCODE.DaveMlsInvalidCommitWelcome, d: { transition_id: transitionId } }),
      onKeyRatchetChanged: (userId, keyRatchet, protocolVersion) =>
        this.handleKeyRatchetChanged(userId, keyRatchet, protocolVersion),
      onUserRemoved: (userId) => {
        this.decryptorsByUser.delete(userId)
      },
    })

    for (const userId of this.knownUserIds) this.daveSession.createUser(userId)
  }

  private handleKeyRatchetChanged(userId: string, keyRatchet: DaveKeyRatchet | null, protocolVersion: number): void {
    if (!this.dave) return
    const passthrough = protocolVersion === this.dave.kDisabledVersion

    if (userId === this.userId) {
      if (!this.encryptor) this.encryptor = new this.dave.Encryptor()
      this.encryptor.SetPassthroughMode(passthrough)
      if (!passthrough) this.encryptor.SetKeyRatchet(keyRatchet)
      if (this.ownSsrc != null) this.encryptor.AssignSsrcToCodec(this.ownSsrc, this.dave.Codec.Opus)
      if (this.ownVideoSsrc != null) this.encryptor.AssignSsrcToCodec(this.ownVideoSsrc, this.dave.Codec.VP8)
      return
    }

    let decryptor = this.decryptorsByUser.get(userId)
    if (!decryptor) {
      decryptor = new this.dave.Decryptor()
      this.decryptorsByUser.set(userId, decryptor)
    }
    decryptor.TransitionToPassthroughMode(passthrough)
    if (!passthrough) decryptor.TransitionToKeyRatchet(keyRatchet)
  }

  // --- WebRTC ---

  private async startWebRtc(): Promise<void> {
    try {
      // Chrome requires encodedInsertableStreams declared up front at
      // construction time. Without it, createEncodedStreams() on a receiver
      // is only safe if called before any RTP for that receiver has arrived —
      // fine in a solo test where nobody else is transmitting yet, but with
      // real participants already talking, packets can beat our 'track'
      // handler to the receiver and createEncodedStreams() throws
      // "Too late to create encoded streams", permanently breaking the
      // decrypt pipeline for that peer.
      const pc = new RTCPeerConnection({ encodedInsertableStreams: true } as RTCConfiguration)
      this.pc = pc
      pc.addEventListener('track', (event) => this.setupIncomingTrack(event))
      pc.addEventListener('connectionstatechange', () => console.log('[voice] pc.connectionState =', pc.connectionState))
      pc.addEventListener('iceconnectionstatechange', () =>
        console.log('[voice] pc.iceConnectionState =', pc.iceConnectionState),
      )

      // Get transceivers (and thus valid audio+video m-lines/rtpmaps for the
      // SDP fragment) up immediately, without waiting on any permission
      // prompt — the voice gateway expects Select Protocol back quickly after
      // Ready and will invalidate the session (close 4006) if we're too slow.
      //
      // The video transceiver is declared here, from connect time, with no
      // track attached — mirroring a real client, which always declares
      // video capability in Identify (`video: true`, a placeholder `streams`
      // entry) whether or not the user ever shares. Renegotiating mid-call to
      // *add* video later (create a fresh offer, re-run Select Protocol, wait
      // for a new SessionDescription) was tried first and broke the
      // already-working encrypted audio for everyone the moment a screen
      // share started — whatever the SFU does internally on renegotiation,
      // it doesn't preserve the audio DAVE/SRTP state cleanly. Negotiating
      // both m-lines exactly once, up front, avoids touching that path at
      // all: starting/stopping a share becomes a plain replaceTrack() + a
      // Video (op12) state announce, no SDP renegotiation involved.
      const audioTransceiver = pc.addTransceiver('audio', { direction: 'sendrecv' })
      this.setupOutgoingSender(audioTransceiver.sender, this.dave!.MediaType.Audio, () => this.ownSsrc)
      this.videoTransceiver = pc.addTransceiver('video', { direction: 'sendrecv' })
      // Restrict to VP8 (the only video codec our compiled DAVE module's
      // frame processor was validated against, and what a real captured
      // screen-share offer used) so the offer has exactly one video
      // rtpmap/rtx pair instead of every codec Chrome supports (VP9, H264,
      // AV1, ...), which would confuse extractWebRtcSdpFragment's line
      // filtering below.
      const vp8Codecs = RTCRtpSender.getCapabilities?.('video')?.codecs.filter((c) => /VP8|rtx/i.test(c.mimeType))
      if (vp8Codecs?.length) this.videoTransceiver.setCodecPreferences(vp8Codecs)
      this.setupOutgoingSender(this.videoTransceiver.sender, this.dave!.MediaType.Video, () => this.ownVideoSsrc)

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      console.log('[voice] local offer SDP', pc.localDescription!.sdp)

      // The DAVE encryptor keys its per-stream ratchet/nonce state off the
      // SSRC used for every AssignSsrcToCodec/Encrypt call, and that must
      // match the SSRC receivers actually see on the wire, or their
      // decryption derives the wrong keystream and silently fails — which is
      // exactly what happens if this stays set to the voice gateway's Ready
      // payload SSRC (an arbitrary server-assigned identifier that has
      // nothing to do with the real RTP SSRC Chrome negotiates for the
      // sender). Overwrite it with the actual local SSRCs from our own offer.
      const localAudioSsrc = extractSsrcForKind(pc.localDescription!.sdp, 'audio')
      if (localAudioSsrc != null) this.ownSsrc = localAudioSsrc
      const localVideoSsrc = extractSsrcForKind(pc.localDescription!.sdp, 'video')
      if (localVideoSsrc != null) this.ownVideoSsrc = localVideoSsrc

      await waitForIceGatheringComplete(pc, 5000)
      console.log('[voice] ICE gathering state after wait:', pc.iceGatheringState)

      const sdp = pc.localDescription!.sdp
      const fragment = extractWebRtcSdpFragment(sdp)
      const codecs = [extractOpusCodecDescriptor(sdp), extractVideoCodecDescriptor(sdp)].filter(
        (c): c is CodecDescriptor => c != null,
      )
      const rtcConnectionId = crypto.randomUUID()
      console.log('[voice] sending Select Protocol, codecs:', codecs, 'fragment:\n' + fragment)
      this.send({
        op: VOICE_OPCODE.SelectProtocol,
        d: { protocol: 'webrtc', data: fragment, sdp: fragment, codecs, rtc_connection_id: rtcConnectionId },
      })
      console.log('[voice] Select Protocol sent, ws.readyState =', this.ws?.readyState)

      navigator.mediaDevices
        .getUserMedia({ audio: true })
        .then((stream) => {
          audioTransceiver.sender.replaceTrack(stream.getAudioTracks()[0])
          this.setupSelfVad(stream)
        })
        .catch((err) => console.error('[voice] failed to get microphone, staying receive-only', err))
    } catch (err) {
      console.error('[voice] startWebRtc failed', err)
      throw err
    }
  }

  // --- Screen sharing ---

  async startScreenShare(): Promise<void> {
    if (!this.videoTransceiver) throw new Error('voice connection not ready')

    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { width: 1280, height: 720, frameRate: 30 },
    })
    this.screenStream = stream
    const track = stream.getVideoTracks()[0]
    track.addEventListener('ended', () => this.stopScreenShare())

    await this.videoTransceiver.sender.replaceTrack(track)
    this.sendVideoState(true)
  }

  stopScreenShare(): void {
    if (!this.screenStream) return
    for (const track of this.screenStream.getTracks()) track.stop()
    this.screenStream = null
    this.videoTransceiver?.sender.replaceTrack(null)
    this.sendVideoState(false)
    this.emit('screenshare-stopped', undefined)
  }

  private sendVideoState(active: boolean): void {
    this.send({
      op: VOICE_OPCODE.Video,
      d: {
        audio_ssrc: this.ownSsrc ?? 0,
        video_ssrc: this.ownVideoSsrc ?? 0,
        rtx_ssrc: 0,
        streams: [
          {
            type: 'video',
            rid: '100',
            ssrc: this.ownVideoSsrc ?? 0,
            active,
            quality: 100,
            max_bitrate: 2500000,
            max_framerate: 30,
            max_resolution: { type: 'fixed', width: 1280, height: 720 },
          },
        ],
      },
    })
  }

  // Discord's own Speaking (op5) broadcasts tell us when *other* people start
  // and stop talking, but nothing tells the server when *we* do — real
  // clients detect that locally from mic input and announce it themselves.
  // A simple volume-threshold VAD over the local mic stream drives both our
  // own "speaking" UI state and an outgoing Speaking frame so other (real)
  // Discord clients see our talk indicator too.
  private setupSelfVad(stream: MediaStream): void {
    try {
      const ctx = new AudioContext()
      this.audioContext = ctx
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      const data = new Uint8Array(analyser.frequencyBinCount)
      const SPEAKING_THRESHOLD = 12

      this.vadInterval = setInterval(() => {
        analyser.getByteFrequencyData(data)
        let sum = 0
        for (const v of data) sum += v
        const isSpeaking = sum / data.length > SPEAKING_THRESHOLD
        if (isSpeaking === this.selfSpeaking) return

        this.selfSpeaking = isSpeaking
        this.emit('speaking', { userId: this.userId, speaking: isSpeaking })
        if (this.ownSsrc != null) {
          this.send({ op: VOICE_OPCODE.Speaking, d: { speaking: isSpeaking ? 1 : 0, delay: 0, ssrc: this.ownSsrc } })
        }
      }, 150)
    } catch (err) {
      console.error('[voice] failed to set up local speaking detection', err)
    }
  }

  private setupOutgoingSender(sender: RTCRtpSender, mediaType: { value: number }, getSsrc: () => number | null): void {
    const encodedSender = sender as RTCRtpSenderWithEncodedStreams
    if (typeof encodedSender.createEncodedStreams !== 'function') {
      console.warn('[voice] this browser does not support Encoded Streams; media will be unencrypted passthrough')
      return
    }
    const isVideo = mediaType.value === this.dave!.MediaType.Video.value
    const { readable, writable } = encodedSender.createEncodedStreams()
    const transform = new TransformStream<EncodedFrameChunk, EncodedFrameChunk>({
      transform: (chunk, controller) => {
        // libdave's VP8 frame processor classifies key vs. delta frames from
        // byte 0 and then unconditionally slices off a fixed 10-byte (key
        // frame) or 1-byte (delta frame) unencrypted header via
        // `frame.size() - unencryptedHeaderBytes` — both unsigned — so any
        // VP8 frame under 10 bytes underflows that subtraction into a huge
        // value and reads far out of bounds inside the WASM heap. That heap
        // is shared by every user's Encryptor/Decryptor, so the corruption
        // doesn't stay contained to video — it's what was turning previously
        // fine audio decryption into garbage shortly after a screen share
        // starts. Chrome's VP8 encoder can and does emit tiny frames while
        // ramping up, so never let one reach Encrypt().
        if (isVideo && chunk.data.byteLength < 10) {
          controller.enqueue(chunk)
          return
        }
        const ssrc = getSsrc()
        if (this.dave && this.encryptor && ssrc != null) {
          const data = new Uint8Array(chunk.data)
          const encrypted = encryptFrame(this.dave, this.encryptor, mediaType, ssrc, data)
          chunk.data = encrypted.buffer as ArrayBuffer
        }
        controller.enqueue(chunk)
      },
    })
    readable.pipeThrough(transform).pipeTo(writable)
  }

  private setupIncomingTrack(event: RTCTrackEvent): void {
    this.emit('track', event)

    const mediaType = event.track.kind === 'video' ? this.dave?.MediaType.Video : this.dave?.MediaType.Audio
    const receiver = event.receiver as RTCRtpReceiverWithEncodedStreams
    if (typeof receiver.createEncodedStreams !== 'function') {
      console.warn('[voice] this browser does not support Encoded Streams; incoming media will be unencrypted passthrough')
      return
    }
    const { readable, writable } = receiver.createEncodedStreams()
    const transform = new TransformStream<EncodedFrameChunk, EncodedFrameChunk>({
      transform: (chunk, controller) => {
        const ssrc = chunk.getMetadata?.()?.synchronizationSource
        const userId = ssrc != null ? this.ssrcToUserId.get(ssrc) : undefined
        const decryptor = userId ? this.decryptorsByUser.get(userId) : undefined
        if (this.dave && decryptor && mediaType) {
          const data = new Uint8Array(chunk.data)
          const decrypted = decryptFrame(this.dave, decryptor, mediaType, data)
          if (decrypted) chunk.data = decrypted.buffer as ArrayBuffer
        }
        controller.enqueue(chunk)
      },
    })
    readable.pipeThrough(transform).pipeTo(writable)
  }

  private emit(eventType: string, data: unknown): void {
    this.handlers.get(eventType)?.forEach((handler) => handler(data))
  }
}

export { FATAL_CLOSE_CODES as VOICE_FATAL_CLOSE_CODES }
