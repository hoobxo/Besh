import type { ConnectionPhase, ErrorCode } from "@besh/contracts"

import {
  IdentificationError,
  clientIdentification,
  encodeIdentification,
  readServerIdentification,
  type ServerIdentification,
} from "./identification.ts"
import { ChannelMux, type OpenSessionOptions, type SessionChannel } from "./channels.ts"
import { SftpService } from "./sftp-service.ts"
import { OutputCollector } from "./command-output.ts"
import { createDirectionalCipher, type DirectionalCipher } from "./ciphers.ts"
import { IncomingPacketQueue } from "./packet-channel.ts"
import { PacketSendQueue } from "./outgoing-packets.ts"
import { getCipherSpec, getMacSpec } from "./protocol/algorithms.ts"
import { KEXInitBuilder } from "./protocol/kex.ts"
import { SSHPacketBuilder, SSHPacketParser, nextSequenceNumber } from "./protocol/packet.ts"
import { KeyDerivation } from "./protocol/keys.ts"
import { SFTPClient } from "./protocol/sftp.ts"
import { buildKeepaliveRequest } from "./protocol/keepalive.ts"
import { SSHAuth } from "./protocol/auth.ts"
import type { KeyboardInteractiveChallenge } from "./protocol/auth-password.ts"
import { AuthProtocolError, authFailureReason, awaitAuthVerdict, readAuthFailure, shouldTryKeyboardInteractive } from "./protocol/auth-conversation.ts"
import {
  isKeyExchangeMessage,
  SSH_MSG_NEWKEYS,
  SSH_MSG_SERVICE_ACCEPT,
  SSH_MSG_SERVICE_REQUEST,
  SSH_MSG_USERAUTH_FAILURE,
  SSH_MSG_USERAUTH_INFO_REQUEST,
  SSH_MSG_USERAUTH_SUCCESS,
} from "./protocol/types.ts"
import {
  HostKeyRejectedError,
  performKeyExchange,
  type HostKeyPolicy,
  type KeyExchangeResult,
} from "./handshake.ts"
import { ConnectionStateError, ConnectionStateMachine, type ConnectionSnapshot } from "./state.ts"
import type { ByteTransport, TransportCloseReason, TransportFactory } from "./transport.ts"

/**
 * One authentication method and how to answer it if the server drives the prompts.
 *
 * Keyboard-interactive is a conversation, not a request: the server may ask for input
 * several times before deciding, so an attempt has to be able to answer.
 */
type AuthAttempt = {
  /** The method name the server will see, used to read its refusal. */
  method: string
  build: () => Promise<Uint8Array> | Uint8Array
  answer?: (challenge: KeyboardInteractiveChallenge) => string[]
}

/** Compatibility accessor; malformed packets are protocol errors, never an empty offer. */
export function readFailureMethods(payload: Uint8Array): string[] {
  return readAuthFailure(payload).methods
}

export type SshConnectionOptions = {
  /** Opens the byte stream. Address validation happens before this is called. */
  factory: TransportFactory
  host: string
  port: number
  /** Deadline for TCP connect *and* for the identification exchange. */
  connectTimeoutMs?: number
  clientSoftware?: string
  /** Refuses to buffer more than this while no protocol stage is consuming data. */
  maxIdleBufferBytes?: number
  /**
   * Asked whether to accept the server's host key. Without it the connection
   * stops in the `kex` phase: nothing may proceed unverified.
   */
  hostKeyPolicy?: HostKeyPolicy
  /**
   * When to re-exchange keys on our own initiative. RFC 4253 section 9 asks for
   * roughly one gigabyte or one hour; either limit trips the exchange, and the
   * peer may still start one whenever it likes.
   */
  rekey?: { afterBytes?: number; afterMs?: number }
}

export type SshConnectionListeners = {
  onStateChange?: (snapshot: ConnectionSnapshot) => void
  onServerIdentification?: (identification: ServerIdentification) => void
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_IDLE_BUFFER_BYTES = 64 * 1024
/** The thresholds RFC 4253 section 9 names: about one gigabyte or one hour. */
const DEFAULT_REKEY_BYTES = 1024 * 1024 * 1024
const DEFAULT_REKEY_MS = 60 * 60 * 1000

/** Enough for a build-log tail, small enough that a runaway command cannot exhaust the worker. */
export const MAX_COMMAND_OUTPUT_BYTES = 256 * 1024

/**
 * Drives one SSH connection up to the point where the key exchange begins.
 *
 * Scope today: dial with a deadline, exchange identification, and keep the byte
 * stream in a known state for the KEX stage that lands next. It does **not**
 * perform key exchange, host key verification or authentication, and it cannot
 * therefore reach `authenticated`.
 *
 * The credential invariant is not just a state machine rule: this class exposes
 * no API that writes credentials, so there is nothing to misuse before the host
 * key is trusted.
 */
export class SshConnection {
  readonly #machine = new ConnectionStateMachine()
  readonly #options: SshConnectionOptions
  readonly #listeners: SshConnectionListeners
  readonly #timeoutMs: number
  readonly #maxIdleBufferBytes: number
  readonly #clientLine: string

  #transport: ByteTransport | null = null
  #buffer = new Uint8Array(0)
  #queue: IncomingPacketQueue | null = null
  #sendSequence = 0
  readonly #sendQueue = new PacketSendQueue()
  #keyExchange: KeyExchangeResult | null = null
  #outbound: DirectionalCipher | null = null
  #mux: ChannelMux | null = null
  #rekeying = false
  /** Non-key-exchange writes wait on this while keys are being renegotiated. */
  #rekeyBarrier: Promise<void> | null = null
  #releaseRekey: (() => void) | null = null
  /** Bytes carried under the current keys, both directions counted together. */
  #bytesSinceRekey = 0
  #keysInstalledAt = 0
  /** An exchange this client started, waiting for the peer's KEXINIT to join it. */
  #clientRekey: { clientKexInit: Uint8Array; settle: () => void } | null = null
  #serverIdentification: ServerIdentification | null = null
  #awaitingIdentification: ((value: ServerIdentification) => void) | null = null
  #identificationReject: ((error: Error) => void) | null = null
  #identificationSettled = false

  constructor(options: SshConnectionOptions, listeners: SshConnectionListeners = {}) {
    this.#options = options
    this.#listeners = listeners
    this.#timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.#maxIdleBufferBytes = options.maxIdleBufferBytes ?? DEFAULT_MAX_IDLE_BUFFER_BYTES
    this.#clientLine = clientIdentification(options.clientSoftware)
  }

  get snapshot(): Readonly<ConnectionSnapshot> {
    return this.#machine.snapshot
  }

  get phase(): ConnectionPhase {
    return this.#machine.phase
  }

  /** True while the server's requested key re-exchange is in flight. */
  get isRekeying(): boolean {
    return this.#rekeying
  }

  get serverIdentification(): ServerIdentification | null {
    return this.#serverIdentification
  }

  /** Bytes received beyond the identification line, for the next protocol stage. */
  get pendingBytes(): Uint8Array {
    return this.#buffer
  }

  /** Present once the key exchange completed and the host key was accepted. */
  get keyExchange(): KeyExchangeResult | null {
    return this.#keyExchange
  }

  get hostKeyFingerprint(): string | null {
    return this.#machine.snapshot.hostKeyFingerprint
  }

  /**
   * Dials and completes the identification exchange.
   *
   * Resolves once the connection is in the `kex` phase. Any failure resolves the
   * promise as a rejection with the machine already moved to `failed`.
   */
  async connect(): Promise<Readonly<ConnectionSnapshot>> {
    this.#machine.apply({ type: "dial" })
    this.#notify()

    let transport: ByteTransport
    try {
      transport = await this.#withTimeout(
        this.#options.factory.dial({
          host: this.#options.host,
          port: this.#options.port,
          connectTimeoutMs: this.#timeoutMs,
        }),
        "TCP connection timed out"
      )
    } catch (error) {
      throw this.#fail("TARGET_UNREACHABLE", describe(error, "Unable to reach the SSH target"))
    }

    this.#transport = transport
    this.#machine.apply({ type: "tcp-connected" })
    this.#notify()

    try {
      transport.read({
        data: (chunk) => this.#onData(chunk),
        close: (reason, error) => this.#onTransportClose(reason, error),
      })
    } catch (error) {
      await this.#discardTransport()
      throw this.#fail("PROTOCOL_ERROR", describe(error, "Transport rejected the reader"))
    }

    try {
      await transport.write(encodeIdentification(this.#clientLine))
    } catch (error) {
      await this.#discardTransport()
      throw this.#fail("TARGET_UNREACHABLE", describe(error, "Unable to send the SSH identification"))
    }

    let identification: ServerIdentification
    try {
      identification = await this.#awaitServerIdentification()
    } catch (error) {
      // Without this, a timeout would reject the promise while leaving the state
      // machine in `kex` and the socket open.
      throw await this.#failWith("CONNECT_TIMEOUT", describe(error, "SSH server did not send an identification string in time"))
    }
    this.#serverIdentification = identification
    // `#buffer` was set to `identification.rest` when the line was parsed. Do not
    // overwrite it here: bytes that arrived in the same read would be lost.
    this.#listeners.onServerIdentification?.(identification)

    this.#machine.apply({ type: "kex-started" })
    this.#notify()

    const policy = this.#options.hostKeyPolicy
    if (!policy) return this.#machine.snapshot

    return await this.#exchangeKeys(policy)
  }

  async #exchangeKeys(policy: HostKeyPolicy): Promise<Readonly<ConnectionSnapshot>> {
    const queue = new IncomingPacketQueue(new SSHPacketParser(), 8)
    this.#queue = queue
    // Byte-parity with the old stop-at-kex behaviour: the leftover bytes after
    // the identification line are the first packet, not garbage.
    if (this.#buffer.length > 0) queue.push(this.#buffer)

    const transport = this.#transport
    if (!transport) throw this.#fail("TARGET_UNREACHABLE", "Transport disappeared before the key exchange")

    let result: KeyExchangeResult
    try {
      result = await this.#withTimeout(
        performKeyExchange({
          channel: {
            send: (payload) => this.#send(payload),
            receive: () => queue.receive(),
          },
          clientVersion: this.#clientLine,
          serverVersion: this.#serverIdentification?.line ?? "",
          hostKeyPolicy: policy,
          host: this.#options.host,
          port: this.#options.port,
        }),
        "SSH key exchange timed out"
      )
    } catch (error) {
      if (error instanceof HostKeyRejectedError) {
        // The signature was valid but the product policy refused this key: a
        // mismatch, not a protocol error.
        if (!this.#machine.isTerminal) {
          this.#machine.apply({ type: "kex-complete", hostKeyFingerprint: error.fingerprint })
        }
        if (!this.#machine.isTerminal) this.#machine.apply({ type: "host-key-rejected" })
        this.#notify()
        throw await this.#failWith("HOST_KEY_MISMATCH", error.message)
      }
      if (error instanceof TimeoutError) {
        throw await this.#failWith("CONNECT_TIMEOUT", error.message)
      }
      throw await this.#failWith("PROTOCOL_ERROR", describe(error, "SSH key exchange failed"))
    }

    // Signature verified and the policy accepted it; record both facts separately
    // so the state machine can still distinguish "negotiated" from "trusted".
    this.#machine.apply({ type: "kex-complete", hostKeyFingerprint: result.fingerprint })
    this.#notify()
    this.#machine.apply({ type: "host-key-verified", fingerprint: result.fingerprint })
    this.#notify()
    this.#keyExchange = result

    try {
      // The first exchange hash is also the session id (RFC 4253 section 7.2).
      await this.#startEncryption(result, queue, result.exchangeHash)
    } catch (error) {
      if (error instanceof TimeoutError) throw await this.#failWith("CONNECT_TIMEOUT", error.message)
      throw await this.#failWith("PROTOCOL_ERROR", describe(error, "Unable to establish SSH encryption"))
    }
    return this.#machine.snapshot
  }

  /**
   * NEWKEYS and the two independent direction switches (RFC 4253 section 7.3).
   *
   * The outbound direction switches immediately after our own NEWKEYS is on the
   * wire; the inbound direction switches only after the server's NEWKEYS arrives,
   * because everything it sent before that point is still plaintext.
   */
  async #startEncryption(
    result: KeyExchangeResult,
    queue: IncomingPacketQueue,
    sessionId: Uint8Array
  ): Promise<void> {
    const { algorithms } = result
    const c2s = getCipherSpec(algorithms.cipherC2S)
    const s2c = getCipherSpec(algorithms.cipherS2C)
    const macC2S = getMacSpec(algorithms.macC2S)
    const macS2C = getMacSpec(algorithms.macS2C)

    const keys = await KeyDerivation.deriveKeys(
      result.sharedSecret,
      result.exchangeHash,
      sessionId,
      c2s.ivLength,
      s2c.ivLength,
      macC2S.keyLength,
      macS2C.keyLength,
      c2s.keyLength,
      s2c.keyLength
    )

    await this.#send(new Uint8Array([SSH_MSG_NEWKEYS]))

    this.#outbound = await createDirectionalCipher({
      cipherAlgorithm: algorithms.cipherC2S,
      macAlgorithm: algorithms.macC2S,
      keys,
      direction: "c2s",
    })

    const serverNewKeys = await this.#withTimeout(
      this.#awaitMessage(queue, SSH_MSG_NEWKEYS, "NEWKEYS"),
      "SSH server did not complete the key exchange in time"
    )
    if (serverNewKeys[0] !== SSH_MSG_NEWKEYS) throw new Error("Unexpected message instead of NEWKEYS")

    const inbound = await createDirectionalCipher({
      cipherAlgorithm: algorithms.cipherS2C,
      macAlgorithm: algorithms.macS2C,
      keys,
      direction: "s2c",
    })
    queue.setCipher(inbound)
    this.#bytesSinceRekey = 0
    this.#keysInstalledAt = Date.now()
  }

  /**
   * Opens a session channel with a PTY and an interactive shell.
   *
   * Only valid once authenticated: the channel multiplexer starts here, so a
   * connection that never authenticates never claims the packet stream.
   */
  async openSession(options: Partial<OpenSessionOptions> = {}): Promise<SessionChannel> {
    if (this.phase !== "authenticated") {
      throw new ConnectionStateError(`Cannot open a session while connection is ${this.phase}`)
    }
    const queue = this.#queue
    if (!queue) throw new ConnectionStateError("Connection has no packet channel")

    const mux = this.#ensureMux()
    return await this.#withTimeout(
      mux.openSession({
        cols: options.cols ?? 80,
        rows: options.rows ?? 24,
        term: options.term,
      }),
      "SSH server did not open a session channel in time"
    )
  }

  /**
   * Runs one command and returns its output and exit status.
   *
   * Output is captured up to `maxOutputBytes`; anything past it is counted in
   * `droppedBytes` instead of being buffered. The default is generous for a log tail
   * and far below the worker's memory, which is the point: the remote command does not
   * get to decide how much this process holds.
   *
   * No PTY is requested, so the command sees a pipe rather than a terminal: no
   * echo, no prompt noise, and output ends at EOF. This is the primitive the
   * metrics collector and, later, the AI executor both use.
   */
  async runCommand(
    command: string,
    options: { timeoutMs?: number; maxOutputBytes?: number } = {}
  ): Promise<{ stdout: string; exitCode: number | null; droppedBytes: number }> {
    if (this.phase !== "authenticated") {
      throw new ConnectionStateError(`Cannot run a command while connection is ${this.phase}`)
    }
    const mux = this.#ensureMux()
    const channel = await this.#withTimeout(mux.openExec(command), "SSH server did not start the command in time")

    const collector = new OutputCollector(options.maxOutputBytes ?? MAX_COMMAND_OUTPUT_BYTES)
    let exitCode: number | null = null
    let finished = false

    channel.onData((chunk) => {
      collector.push(chunk)
    })
    channel.onExit((code) => {
      exitCode = code
    })
    channel.onClose(() => {
      finished = true
    })

    const deadline = (options.timeoutMs ?? 15_000)
    const startedAt = Date.now()
    while (!finished) {
      if (Date.now() - startedAt > deadline) {
        await channel.close().catch(() => {})
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    const captured = collector.finish()
    return { stdout: captured.text, exitCode, droppedBytes: captured.droppedBytes }
  }

  /**
   * Opens an SFTP subsystem on its own channel.
   *
   * Shares the authenticated connection with any terminal channels, which is the
   * whole point of the multiplexer: one TCP connection, many services.
   */
  async openSftp(): Promise<SftpService> {
    if (this.phase !== "authenticated") {
      throw new ConnectionStateError(`Cannot open SFTP while connection is ${this.phase}`)
    }
    const mux = this.#ensureMux()
    const channel = await this.#withTimeout(mux.openSubsystem("sftp"), "SSH server did not open an SFTP channel in time")

    const reply = channel._awaitRequest()
    await this.#send(channel._buildSubsystemRequest("sftp"))
    await this.#withTimeout(reply, "SSH server did not accept the SFTP subsystem in time")

    const client = new SFTPClient((data) => channel.write(data))
    channel.onData((chunk) => client.feed(chunk))
    channel.onClose(() => client.dispose(new Error("SFTP channel closed")))
    await this.#withTimeout(client.initialize(), "SFTP subsystem did not complete its version handshake")

    return new SftpService(channel, client)
  }

  #ensureMux(): ChannelMux {
    if (!this.#mux) {
      const queue = this.#queue
      if (!queue) throw new ConnectionStateError("Connection has no packet channel")
      this.#mux = new ChannelMux(
        queue,
        (payload) => this.#send(payload),
        (serverKexInit) => this.#rekey(serverKexInit)
      )
      this.#mux.start()
    }
    return this.#mux
  }

  /**
   * Authenticates on an encrypted, host-key-verified connection.
   *
   * Only reachable after NEWKEYS: the credentials travel inside the encrypted
   * stream, and nothing is sent before the host key was verified.
   */
  async authenticate(credentials: { username: string; password: string }): Promise<Readonly<ConnectionSnapshot>> {
    const identity = { username: credentials.username, host: this.#options.host }
    const answer = (challenge: KeyboardInteractiveChallenge): string[] =>
      SSHAuth.passwordResponsesForChallenge(challenge, credentials.password, identity)
    return await this.#authenticateWith(
      {
        method: "password",
        build: () => SSHAuth.buildPasswordAuthRequest(credentials.username, credentials.password),
      },
      // Servers that disabled plain password authentication keep only this method, and
      // the same password is still the answer — the server asks for it instead.
      {
        method: "keyboard-interactive",
        build: () => SSHAuth.buildKeyboardInteractiveAuthRequest(credentials.username),
        answer,
      }
    )
  }

  /**
   * Public key authentication.
   *
   * The signature covers the session id, which is the exchange hash of the first
   * key exchange, so the request cannot be replayed onto another connection.
   */
  async authenticateWithKey(credentials: { username: string; privateKey: string }): Promise<Readonly<ConnectionSnapshot>> {
    const sessionId = this.#keyExchange?.exchangeHash
    if (!sessionId) throw new ConnectionStateError("Authentication attempted before the key exchange")
    return await this.#authenticateWith({
      method: "publickey",
      build: async () => await SSHAuth.buildPublicKeyAuthRequest(credentials.username, credentials.privateKey, sessionId),
    })
  }

  async #authenticateWith(primary: AuthAttempt, fallback?: AuthAttempt): Promise<Readonly<ConnectionSnapshot>> {
    if (this.phase !== "authenticating") {
      throw new ConnectionStateError(`Cannot authenticate while connection is ${this.phase}`)
    }
    const queue = this.#queue
    if (!queue) throw new ConnectionStateError("Connection has no packet channel")
    if (!this.#keyExchange) throw new ConnectionStateError("Authentication attempted before the key exchange")

    this.#machine.apply({ type: "auth-started" })
    this.#notify()

    try {
      await this.#requestUserAuthService(queue)

      let attempted = primary.method
      let result = await this.#attempt(queue, primary)
      if (!result.ok && fallback && shouldTryKeyboardInteractive(result.methods, result.partialSuccess)) {
        // Only when the server has stopped offering the method at all. A wrong password
        // still lists "password", and retrying there would double the attempts the
        // server counts against the account.
        attempted = fallback.method
        result = await this.#attempt(queue, fallback)
      }

      if (!result.ok) {
        // Select the terminal failure once. Applying auth-failed first would freeze
        // AUTH_FAILED and cause #failWith to discard AUTH_METHOD_UNSUPPORTED.
        if (result.partialSuccess) {
          throw await this.#failWith(
            "AUTH_FAILED",
            "An authentication factor succeeded, but additional authentication is required",
            result.methods
          )
        }
        if (authFailureReason(attempted, result.methods) === "method-not-offered") {
          throw await this.#failWith(
            "AUTH_METHOD_UNSUPPORTED",
            `The server does not accept ${attempted} authentication`,
            result.methods
          )
        }
        throw await this.#failWith("AUTH_FAILED", "The SSH server rejected these credentials")
      }

      this.#machine.apply({ type: "auth-succeeded" })
      this.#notify()
      return this.#machine.snapshot
    } catch (error) {
      if (this.#machine.isTerminal) throw error
      if (error instanceof AuthProtocolError) throw await this.#failWith("PROTOCOL_ERROR", error.message)
      if (error instanceof TimeoutError) throw await this.#failWith("CONNECT_TIMEOUT", error.message)
      throw await this.#failWith("AUTH_FAILED", describe(error, "SSH authentication failed"))
    }
  }

  /** Sends one method's request and waits for the verdict, answering any prompts. */
  async #attempt(
    queue: IncomingPacketQueue,
    attempt: AuthAttempt
  ): Promise<{ ok: true } | { ok: false; methods: string[]; partialSuccess: boolean }> {
    await this.#send(await attempt.build())
    const reply = await this.#withTimeout(
      awaitAuthVerdict({
        receive: () => queue.receive(),
        send: async (payload) => await this.#send(payload),
        answer: attempt.answer,
      }),
      "SSH authentication timed out"
    )
    if (reply[0] === SSH_MSG_USERAUTH_SUCCESS) return { ok: true }
    return { ok: false, ...readAuthFailure(reply) }
  }

  async #requestUserAuthService(queue: IncomingPacketQueue): Promise<void> {
    const name = new TextEncoder().encode("ssh-userauth")
    const payload = new Uint8Array(1 + 4 + name.length)
    payload[0] = SSH_MSG_SERVICE_REQUEST
    new DataView(payload.buffer).setUint32(1, name.length, false)
    payload.set(name, 5)
    await this.#send(payload)

    const accept = await this.#withTimeout(
      this.#awaitMessage(queue, SSH_MSG_SERVICE_ACCEPT, "SERVICE_ACCEPT"),
      "SSH server did not accept the user authentication service"
    )
    if (accept[0] !== SSH_MSG_SERVICE_ACCEPT) throw new Error("Unexpected reply to the service request")
  }

  async #awaitAny(queue: IncomingPacketQueue, expected: number[]): Promise<Uint8Array> {
    for (;;) {
      const payload = await queue.receive()
      const type = payload[0]
      // IGNORE, DEBUG and EXT_INFO are legal between the service request and the reply.
      if (type === 2 || type === 4 || type === 7) continue
      if (type === 1) throw new Error("The SSH server disconnected during authentication")
      if (type === undefined || !expected.includes(type)) {
        throw new Error(`Unexpected authentication reply: message ${type}`)
      }
      return payload
    }
  }

  async #awaitMessage(
    queue: IncomingPacketQueue,
    expectedType: number,
    label: string
  ): Promise<Uint8Array> {
    for (;;) {
      const payload = await queue.receive()
      const type = payload[0]
      // IGNORE, DEBUG and EXT_INFO may precede the message we are waiting for.
      if (type === 2 || type === 4 || type === 7) continue
      if (type === 1) throw new Error("Server disconnected during the key exchange")
      if (type !== expectedType) throw new Error(`Expected ${label}, received message ${type}`)
      return payload
    }
  }

  #send(payload: Uint8Array): Promise<void> {
    const barrier = this.#rekeyBarrier
    // Anything that is not part of the exchange itself must wait for NEWKEYS, or
    // the peer receives a channel packet in the middle of a key exchange and
    // disconnects (RFC 4253 section 7.1).
    if (barrier && !isKeyExchangeMessage(payload[0])) {
      return barrier.then(() => this.#enqueue(payload))
    }
    return this.#enqueue(payload)
  }

  #enqueue(payload: Uint8Array): Promise<void> {
    return this.#sendQueue.send(() => this.#sendPacket(payload))
  }

  async #sendPacket(payload: Uint8Array): Promise<void> {
    const transport = this.#transport
    if (!transport) throw new Error("Transport is not connected")
    const cipher = this.#outbound
    const framed = cipher
      ? await SSHPacketBuilder.build(
          payload,
          cipher.blockSize,
          (data, sequence, aad) => cipher.encrypt(data, sequence, aad),
          this.#sendSequence,
          cipher.aead,
          cipher.sign ? (packet, sequence) => cipher.sign!(packet, sequence) : undefined
        )
      : await SSHPacketBuilder.build(payload, 8, null, this.#sendSequence)
    this.#bytesSinceRekey += framed.byteLength
    this.#sendSequence = nextSequenceNumber(this.#sendSequence)
    await transport.write(framed)
  }

  /** Closes the connection and releases the socket. */
  /**
   * Sends the OpenSSH keepalive global request.
   *
   * Scheduling belongs to the caller: this package has no timers of its own, and a
   * caller that decides the interval also knows when the connection stops being
   * interesting.
   */
  async keepalive(): Promise<void> {
    if (this.snapshot.phase !== "authenticated") {
      throw new ConnectionStateError(`Cannot send a keepalive while ${this.snapshot.phase}`)
    }
    await this.#send(buildKeepaliveRequest())
  }

  /**
   * Starts a key re-exchange when the configured limit has been reached.
   *
   * Meant for the same timer that sends keepalives: the byte limit is checked as
   * data arrives, but only a clock can notice that an idle session has carried the
   * same keys for an hour. Returns quietly when the connection cannot start one.
   */
  async rekeyIfDue(): Promise<void> {
    if (!this.#rekeyDue()) return
    await this.#initiateRekey()
  }

  #rekeyDue(): boolean {
    if (this.#rekeying || this.phase !== "authenticated") return false
    const afterBytes = this.#options.rekey?.afterBytes ?? DEFAULT_REKEY_BYTES
    const afterMs = this.#options.rekey?.afterMs ?? DEFAULT_REKEY_MS
    return this.#bytesSinceRekey >= afterBytes || Date.now() - this.#keysInstalledAt >= afterMs
  }

  /**
   * Begins a re-exchange we start ourselves (RFC 4253 section 9).
   *
   * The peer answers a KEXINIT with its own, and that answer is what drives the
   * exchange through the normal `#rekey` path, so the packet reader keeps a single
   * owner. This method only opens the barrier, sends our KEXINIT and waits.
   */
  async #initiateRekey(): Promise<void> {
    if (this.#rekeying || this.phase !== "authenticated") return
    if (!this.#queue || !this.#keyExchange) return

    const clientKexInit = KEXInitBuilder.build()
    let settle: () => void = () => {}
    const completed = new Promise<void>((resolve) => {
      settle = resolve
    })
    this.#clientRekey = { clientKexInit, settle }
    this.#rekeying = true
    this.#rekeyBarrier = new Promise<void>((resolve) => {
      this.#releaseRekey = resolve
    })
    try {
      await this.#send(clientKexInit)
      await this.#withTimeout(completed, "SSH server did not answer the key re-exchange in time")
    } catch (error) {
      // A failed exchange already failed the connection; only silence needs one.
      if (this.#machine.isTerminal) return
      throw await this.#failWith("CONNECT_TIMEOUT", describe(error, "SSH server did not answer the key re-exchange in time"))
    }
  }

  async close(): Promise<Readonly<ConnectionSnapshot>> {
    if (this.#machine.isTerminal) return this.#machine.snapshot
    this.#machine.apply({ type: "close" })
    this.#notify()
    await this.#discardTransport()
    return this.#machine.closed()
  }

  /**
   * Re-exchanges keys because the peer asked for it (RFC 4253 section 9).
   *
   * Two things must hold for the exchange to be safe. Outbound traffic stops at
   * the barrier the moment the peer's KEXINIT is dispatched, and the keys are
   * derived against the *first* exchange hash, which stays the session id for the
   * life of the connection. Sequence numbers are deliberately not reset: RFC 4253
   * section 6.4 keeps them monotonic across a re-exchange.
   */
  async #rekey(serverKexInit: Uint8Array): Promise<void> {
    const queue = this.#queue
    const exchange = this.#keyExchange
    if (!queue || !exchange) throw new ConnectionStateError("Cannot re-exchange keys before the first key exchange")
    // An exchange we started already opened the barrier and sent our KEXINIT; the
    // peer's KEXINIT is what resumes it, so only a second peer-initiated start is an
    // error here.
    const client = this.#clientRekey
    if (this.#rekeying && !client) {
      throw new ConnectionStateError("The server started a second key re-exchange before the first finished")
    }
    if (this.phase !== "authenticated") {
      throw new ConnectionStateError(`Cannot re-exchange keys while connection is ${this.phase}`)
    }

    if (!client) {
      this.#rekeying = true
      this.#rekeyBarrier = new Promise<void>((resolve) => {
        this.#releaseRekey = resolve
      })
    }
    try {
      const result = await this.#withTimeout(
        performKeyExchange({
          channel: { send: (payload) => this.#send(payload), receive: () => queue.receive() },
          clientVersion: this.#clientLine,
          serverVersion: this.#serverIdentification?.line ?? "",
          host: this.#options.host,
          port: this.#options.port,
          serverKexInit,
          // Ours is already on the wire when we started the exchange; re-sending it
          // would make the peer hash a different pair of KEXINIT messages.
          clientKexInit: client?.clientKexInit,
          // Pinned, not asked again: a re-exchange that names another host key is
          // a substitution, not a trust decision.
          expectedFingerprint: exchange.fingerprint,
        }),
        "SSH server did not finish the key re-exchange in time"
      )
      await this.#startEncryption(result, queue, exchange.exchangeHash)
    } catch (error) {
      if (error instanceof HostKeyRejectedError) {
        throw await this.#failWith("HOST_KEY_MISMATCH", error.message)
      }
      if (error instanceof TimeoutError) throw await this.#failWith("CONNECT_TIMEOUT", error.message)
      throw await this.#failWith("PROTOCOL_ERROR", describe(error, "SSH key re-exchange failed"))
    } finally {
      this.#rekeying = false
      this.#rekeyBarrier = null
      const finished = this.#clientRekey
      this.#clientRekey = null
      finished?.settle()
      const release = this.#releaseRekey
      this.#releaseRekey = null
      release?.()
    }
  }

  async #awaitServerIdentification(): Promise<ServerIdentification> {
    const existing = readServerIdentification(this.#buffer)
    if (existing) return existing

    return await this.#withTimeout(
      new Promise<ServerIdentification>((resolve, reject) => {
        this.#awaitingIdentification = resolve
        this.#identificationReject = reject
      }),
      "SSH server did not send an identification string in time"
    )
  }

  #onData(chunk: Uint8Array): void {
    if (this.#machine.isTerminal) return
    this.#bytesSinceRekey += chunk.byteLength
    if (this.#queue) {
      this.#queue.push(chunk)
      if (this.#rekeyDue()) void this.#initiateRekey().catch(() => {})
      return
    }

    const merged = new Uint8Array(this.#buffer.length + chunk.length)
    merged.set(this.#buffer, 0)
    merged.set(chunk, this.#buffer.length)
    this.#buffer = merged

    if (!this.#identificationSettled) {
      let identification: ServerIdentification | null = null
      try {
        identification = readServerIdentification(this.#buffer)
      } catch (error) {
        void this.#failAsync("PROTOCOL_ERROR", describe(error, "Invalid SSH identification"))
        return
      }
      if (!identification) return

      // The identification line is consumed here; `connect` re-reads the same
      // buffer, so the state stays consistent for the KEX stage.
      this.#identificationSettled = true
      this.#buffer = identification.rest.slice()
      const resolve = this.#awaitingIdentification
      this.#awaitingIdentification = null
      this.#identificationReject = null
      resolve?.(identification)
      return
    }

    if (this.#buffer.length > this.#maxIdleBufferBytes) {
      void this.#failAsync("PROTOCOL_ERROR", "Peer sent more data than the current protocol stage can consume")
    }
  }

  #onTransportClose(reason: TransportCloseReason, error?: Error): void {
    this.#queue?.dispose(error ?? new Error(`Transport closed (${reason})`))
    if (this.#machine.isTerminal) return
    // Marking the failure also rejects a pending identification wait, so a peer
    // that disappears mid-handshake surfaces as a coded failure rather than a
    // bare exception escaping the receive path.
    void this.#failAsync("TARGET_UNREACHABLE", error?.message ?? `Transport closed (${reason})`)
  }

  async #failAsync(code: ErrorCode, message: string): Promise<void> {
    if (this.#machine.isTerminal) return
    // Move to `failed` (and reject any pending stage) before closing the socket,
    // so the close callback cannot overwrite the real reason.
    this.#fail(code, message)
    await this.#discardTransport()
  }

  /** Fails the connection, releases the socket, and returns the error to throw. */
  async #failWith(code: ErrorCode, message: string, methods: readonly string[] = []): Promise<Error> {
    const error = this.#fail(code, message, methods)
    await this.#discardTransport()
    return error
  }

  #fail(code: ErrorCode, message: string, methods: readonly string[] = []): Error {
    if (!this.#machine.isTerminal) {
      this.#machine.apply({ type: "fail", error: { code, message } })
      this.#notify()
    }
    // An existing failure keeps its own code: a later wrapper must not relabel a
    // protocol violation as a timeout just because it was thrown from a wait.
    const failure = this.#machine.snapshot.failure
    const error = new SshConnectionError(failure?.code ?? code, failure?.message ?? message, methods)
    if (this.#identificationReject && !this.#identificationSettled) {
      const reject = this.#identificationReject
      this.#identificationReject = null
      this.#awaitingIdentification = null
      reject(error)
    }
    return error
  }

  async #discardTransport(): Promise<void> {
    const transport = this.#transport
    this.#transport = null
    if (!transport || transport.closed) return
    try {
      await transport.close("local")
    } catch {
      // Closing twice or on an already-dead socket must not mask the real error.
    }
  }

  async #withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new TimeoutError(message)), this.#timeoutMs)
        }),
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  #notify(): void {
    this.#listeners.onStateChange?.(this.#machine.snapshot)
  }
}

/** A deadline expired; kept distinct so it is not reported as a protocol error. */
export class TimeoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TimeoutError"
  }
}

/** A connection failure with the stable code the client translates through i18n. */
export class SshConnectionError extends Error {
  readonly code: ErrorCode
  /** Methods the server says may still succeed, when it told us. */
  readonly methods: readonly string[]

  constructor(code: ErrorCode, message: string, methods: readonly string[] = []) {
    super(message)
    this.name = "SshConnectionError"
    this.code = code
    this.methods = methods
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof IdentificationError) return `${fallback}: ${error.message}`
  if (error instanceof ConnectionStateError) return `${fallback}: ${error.message}`
  if (error instanceof Error && error.message) return error.message
  return fallback
}
