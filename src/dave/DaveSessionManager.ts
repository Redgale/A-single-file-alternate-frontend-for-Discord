// Ported from discord/libdave's samples/typescript/DaveSessionManager.ts,
// with the networking/media TODOs filled in: outgoing MLS messages go back
// out over the voice gateway via the callbacks passed to the constructor,
// and key ratchet changes are forwarded to the media layer so it can update
// its Encryptor/Decryptor.

import type { Session, TransientKeys, SignaturePrivateKey } from './wasm/libdave'
import type { DaveModule } from './wasm'

const MLS_NEW_GROUP_EXPECTED_EPOCH = '1'
const DAVE_PROTOCOL_INIT_TRANSITION_ID = 0

export interface DaveKeyRatchet {
  cipherSuite: number
  baseSecret: Uint8Array
}

export interface DaveSessionCallbacks {
  sendReadyForTransition(transitionId: number): void
  sendKeyPackage(keyPackage: Uint8Array): void
  sendCommitWelcome(commitWelcome: Uint8Array): void
  sendInvalidCommitWelcome(transitionId: number): void
  /** keyRatchet is null when the user should fall back to passthrough (no encryption). */
  onKeyRatchetChanged(userId: string, keyRatchet: DaveKeyRatchet | null, protocolVersion: number): void
  onUserRemoved(userId: string): void
}

function toUint8Array(value: unknown): Uint8Array {
  return new Uint8Array(value as ArrayLike<number>)
}

export class DaveSessionManager {
  private readonly dave: DaveModule
  private readonly transientKeys: TransientKeys | null
  private readonly mlsSession: Session
  private readonly callbacks: DaveSessionCallbacks

  private readonly selfUserId: string
  private readonly groupId: string
  private readonly recognizedUserIds: Set<string> = new Set()
  private readonly daveProtocolTransitions: Map<number, number> = new Map()
  private latestPreparedTransitionVersion = 0

  constructor(
    dave: DaveModule,
    transientKeys: TransientKeys | null,
    selfUserId: string,
    groupId: string,
    callbacks: DaveSessionCallbacks,
  ) {
    this.dave = dave
    this.transientKeys = transientKeys
    this.selfUserId = selfUserId
    this.groupId = groupId
    this.callbacks = callbacks

    this.mlsSession = new dave.Session('', '', (source: string, reason: string) => {
      console.error(`[dave] MLS failure: ${source} ${reason}`)
    })
  }

  public createUser(userId: string) {
    this.recognizedUserIds.add(userId)
    this._setupKeyRatchetForUser(userId, this.latestPreparedTransitionVersion)
  }

  public destroyUser(userId: string) {
    console.log('[dave-trace] destroyUser', userId)
    this.recognizedUserIds.delete(userId)
    this.callbacks.onUserRemoved(userId)
  }

  // --- Incoming voice gateway opcodes ---

  public onSelectProtocolAck(protocolVersion: number) {
    this._handleDaveProtocolInit(protocolVersion)
  }

  public onDaveProtocolPrepareTransition(transitionId: number, protocolVersion: number) {
    this._prepareDaveProtocolRatchets(transitionId, protocolVersion)
    this._maybeSendDaveProtocolReadyForTransition(transitionId)
  }

  public onDaveProtocolExecuteTransition(transitionId: number) {
    this._handleDaveProtocolExecuteTransition(transitionId)
  }

  public onDaveProtocolPrepareEpoch(epoch: string, protocolVersion: number) {
    this._handleDaveProtocolPrepareEpoch(epoch, protocolVersion, this.groupId)
    if (epoch === MLS_NEW_GROUP_EXPECTED_EPOCH) {
      this._sendMLSKeyPackage()
    }
  }

  public onDaveProtocolMLSExternalSenderPackage(externalSenderPackage: Uint8Array) {
    this.mlsSession.SetExternalSender(externalSenderPackage)
  }

  public onMLSProposals(proposals: Uint8Array) {
    const commitWelcome = this.mlsSession.ProcessProposals(proposals, this._getRecognizedUserIDs())
    if (commitWelcome) {
      this.callbacks.sendCommitWelcome(toUint8Array(commitWelcome))
    }
  }

  public onMLSAnnounceCommitTransition(transitionId: number, commit: Uint8Array) {
    const processedCommit = this.mlsSession.ProcessCommit(commit) as {
      failed: boolean
      ignored: boolean
      rosterUpdate: Record<string, unknown> | null
    }
    console.log('[dave-trace] ProcessCommit result', processedCommit, 'recognized =', Array.from(this.recognizedUserIds))
    if (processedCommit.ignored) {
      // REVERTED: forcing a full mlsSession.Init()/rejoin here (via
      // _handleDaveProtocolInit) was tried as a self-heal, but Init() calls
      // Reset() first, which tears down currentState_ entirely — wiping out
      // every *already working* user's key ratchet immediately, not just
      // the affected one. That's strictly worse than doing nothing: it
      // turns "some users may be stuck" into "everyone is definitely stuck
      // until a fresh Welcome round-trips." Back to a no-op pending a real
      // fix — see [[dave-trace]] logging left in place above to keep
      // gathering evidence on why the commit is ignored.
      console.log('[dave-trace] commit ignored — no-op (see comment)')
      return
    }

    const joinedGroup = processedCommit.rosterUpdate != null
    if (joinedGroup) {
      console.log('[dave-trace] commit accepted, preparing ratchets for transition', transitionId)
      this._prepareDaveProtocolRatchets(transitionId, this.mlsSession.GetProtocolVersion())
      this._maybeSendDaveProtocolReadyForTransition(transitionId)
    } else {
      console.log('[dave-trace] commit REJECTED as invalid — sending InvalidCommitWelcome and reinitializing')
      this.callbacks.sendInvalidCommitWelcome(transitionId)
      this._handleDaveProtocolInit(this.mlsSession.GetProtocolVersion())
    }
  }

  public onMLSWelcome(transitionId: number, welcome: Uint8Array) {
    const roster = this.mlsSession.ProcessWelcome(welcome, this._getRecognizedUserIDs())
    const joinedGroup = roster != null

    if (joinedGroup) {
      this._prepareDaveProtocolRatchets(transitionId, this.mlsSession.GetProtocolVersion())
      this._maybeSendDaveProtocolReadyForTransition(transitionId)
    } else {
      this.callbacks.sendInvalidCommitWelcome(transitionId)
      this._sendMLSKeyPackage()
    }
  }

  // --- Outgoing ---

  private _sendMLSKeyPackage() {
    const keyPackage = this.mlsSession.GetMarshalledKeyPackage()
    this.callbacks.sendKeyPackage(toUint8Array(keyPackage))
  }

  private _maybeSendDaveProtocolReadyForTransition(transitionId: number) {
    if (transitionId !== DAVE_PROTOCOL_INIT_TRANSITION_ID) {
      this.callbacks.sendReadyForTransition(transitionId)
    }
  }

  // --- Internal ---

  private _setupKeyRatchetForUser(userId: string, protocolVersion: number) {
    const keyRatchet = this._makeUserKeyRatchet(userId, protocolVersion)
    console.log('[dave-trace] _setupKeyRatchetForUser', userId, 'protocolVersion =', protocolVersion, 'gotRatchet =', keyRatchet != null)
    this.callbacks.onKeyRatchetChanged(userId, keyRatchet, protocolVersion)
  }

  private _handleDaveProtocolInit(protocolVersion: number) {
    if (protocolVersion > 0) {
      this._handleDaveProtocolPrepareEpoch(MLS_NEW_GROUP_EXPECTED_EPOCH, protocolVersion, this.groupId)
      this._sendMLSKeyPackage()
    } else {
      this._prepareDaveProtocolRatchets(DAVE_PROTOCOL_INIT_TRANSITION_ID, protocolVersion)
      this._handleDaveProtocolExecuteTransition(DAVE_PROTOCOL_INIT_TRANSITION_ID)
    }
  }

  private _handleDaveProtocolPrepareEpoch(epoch: string, protocolVersion: number, groupId: string): void {
    if (epoch === MLS_NEW_GROUP_EXPECTED_EPOCH) {
      let privateKey: SignaturePrivateKey | null = null
      if (this.transientKeys != null) {
        privateKey = this.transientKeys.GetTransientPrivateKey(protocolVersion)
      }
      this.mlsSession.Init(protocolVersion, BigInt(groupId), this.selfUserId, privateKey)
    }
  }

  private _handleDaveProtocolExecuteTransition(transitionId: number): void {
    if (!this.daveProtocolTransitions.has(transitionId)) return

    const protocolVersion = this.daveProtocolTransitions.get(transitionId)!
    this.daveProtocolTransitions.delete(transitionId)

    if (protocolVersion === this.dave.kDisabledVersion) {
      this.mlsSession.Reset()
    }

    this._setupKeyRatchetForUser(this.selfUserId, protocolVersion)
  }

  private _getRecognizedUserIDs(): string[] {
    return Array.from(this.recognizedUserIds).concat([this.selfUserId])
  }

  private _makeUserKeyRatchet(userId: string, protocolVersion: number): DaveKeyRatchet | null {
    if (protocolVersion === this.dave.kDisabledVersion) return null
    const keyRatchet = this.mlsSession.GetKeyRatchet(userId)
    if (!keyRatchet) return null
    return {
      cipherSuite: keyRatchet.cipherSuite,
      baseSecret: toUint8Array(keyRatchet.baseSecret),
    }
  }

  private _prepareDaveProtocolRatchets(transitionId: number, protocolVersion: number): void {
    console.log(
      '[dave-trace] _prepareDaveProtocolRatchets transitionId =',
      transitionId,
      'protocolVersion =',
      protocolVersion,
      'for users =',
      this._getRecognizedUserIDs(),
    )
    for (const userId of this._getRecognizedUserIDs()) {
      if (userId === this.selfUserId) continue
      this._setupKeyRatchetForUser(userId, protocolVersion)
    }

    if (transitionId === this.dave.kInitTransitionId) {
      this._setupKeyRatchetForUser(this.selfUserId, protocolVersion)
    } else {
      this.daveProtocolTransitions.set(transitionId, protocolVersion)
    }

    this.latestPreparedTransitionVersion = protocolVersion
  }
}
