/**
 * Session channels: the multiplexer that turns one encrypted connection into
 * terminal (and later SFTP / exec) channels.
 *
 * The wire framing itself lives in the extracted `protocol/channel.ts`; this file
 * owns dispatch, request acknowledgement and the public handle a caller uses.
 */
import { SSHChannel } from "./protocol/channel.ts"
import {
  SSH_MSG_CHANNEL_CLOSE,
  SSH_MSG_CHANNEL_EOF,
  SSH_MSG_CHANNEL_DATA,
  SSH_MSG_CHANNEL_EXTENDED_DATA,
  SSH_MSG_CHANNEL_FAILURE,
  SSH_MSG_CHANNEL_OPEN_CONFIRMATION,
  SSH_MSG_CHANNEL_OPEN_FAILURE,
  SSH_MSG_CHANNEL_REQUEST,
  SSH_MSG_CHANNEL_SUCCESS,
  SSH_MSG_CHANNEL_WINDOW_ADJUST,
  SSH_MSG_DEBUG,
  SSH_MSG_DISCONNECT,
  SSH_MSG_IGNORE,
  SSH_MSG_KEXINIT,
} from "./protocol/types.ts"
import { SshByteReader } from "./ssh-bytes.ts"
import type { IncomingPacketQueue } from "./packet-channel.ts"

export type OpenSessionOptions = {
  cols: number
  rows: number
  term?: string
}

export class ChannelError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ChannelError"
  }
}

type Waiter = { resolve: () => void; reject: (error: Error) => void }

/** A single open session channel on an authenticated connection. */
export class SessionChannel {
  readonly id: number
  readonly #wire: SSHChannel
  readonly #send: (payload: Uint8Array) => Promise<void>
  readonly #dataListeners: Array<(chunk: Uint8Array) => void> = []
  #exitListener: ((code: number | null) => void) | null = null
  #closeListener: (() => void) | null = null
  #openWaiter: Waiter | null = null
  #requestWaiter: Waiter | null = null
  #closed = false

  constructor(id: number, send: (payload: Uint8Array) => Promise<void>) {
    this.id = id
    this.#wire = new SSHChannel()
    this.#send = send
  }

  onData(listener: (chunk: Uint8Array) => void): void {
    this.#dataListeners.push(listener)
  }

  onExit(listener: (code: number | null) => void): void {
    this.#exitListener = listener
  }

  onClose(listener: () => void): void {
    this.#closeListener = listener
  }

  /** Sends terminal input, respecting the peer's window and packet size. */
  async write(data: Uint8Array): Promise<void> {
    if (this.#closed) throw new ChannelError("Channel is closed")
    let offset = 0
    for (;;) {
      const chunk = this.#wire.takeChannelDataChunk(data, offset)
      // A zero window means the peer must send WINDOW_ADJUST first; dropping the
      // write silently would corrupt the terminal, so surface it instead.
      if (!chunk) throw new ChannelError("Remote window is exhausted; no credit to send data")
      const payload = new Uint8Array(chunk.payloadLength)
      this.#wire.writeChannelDataPayload(payload, 0, data, chunk.sourceOffset, chunk.bytesConsumed)
      await this.#send(payload)
      offset += chunk.bytesConsumed
      if (offset >= data.length) return
    }
  }

  async resize(cols: number, rows: number): Promise<void> {
    if (this.#closed) throw new ChannelError("Channel is closed")
    await this.#send(this.#wire.buildWindowChange(cols, rows))
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    await this.#send(this.#wire.buildClose())
  }

  // ---- internal, driven by the multiplexer ----

  _buildOpen(): Uint8Array {
    return this.#wire.buildOpenSession(this.id)
  }

  _awaitOpen(): Promise<void> {
    return this.#await((waiter) => {
      this.#openWaiter = waiter
    })
  }

  _awaitRequest(): Promise<void> {
    return this.#await((waiter) => {
      this.#requestWaiter = waiter
    })
  }

  _expectPTYRequest(options: OpenSessionOptions): Uint8Array {
    return this.#wire.buildPTYRequest(options.cols, options.rows, options.term ?? "xterm-256color")
  }

  _buildShellRequest(): Uint8Array {
    return this.#wire.buildShellRequest()
  }

  _buildExecRequest(command: string): Uint8Array {
    return this.#wire.buildExecRequest(command)
  }

  _buildSubsystemRequest(subsystem: string): Uint8Array {
    return this.#wire.buildSubsystemRequest(subsystem)
  }

  _handleConfirmation(payload: Uint8Array): void {
    this.#wire.handleOpenConfirmation(payload)
    this.#resolveOpen()
  }

  _handleOpenFailure(payload: Uint8Array): void {
    // The payload carries a reason code and description; the generic message is
    // enough for now, but the code is preserved for diagnostics.
    const reader = new SshByteReader(payload)
    reader.readByte()
    reader.readUint32()
    const reason = reader.readUint32()
    const description = reader.remaining > 0 ? reader.readText() : ""
    this.#rejectOpen(new ChannelError(`The server refused to open a session channel (reason ${reason})${description ? `: ${description}` : ""}`))
  }

  _handleData(payload: Uint8Array): void {
    const data = this.#wire.handleChannelData(payload)
    for (const listener of this.#dataListeners) listener(data)
    // Replenish our window once the consumer has the bytes, or the server stalls
    // after the initial window is used up.
    const adjustment = this.#wire.takeLocalWindowAdjustment(16 * 1024)
    if (adjustment !== null) {
      void this.#send(this.#wire.buildWindowAdjust(adjustment))
    }
  }

  _handleExtendedData(payload: Uint8Array): void {
    // stderr on a shell channel: today it is merged into the data listeners so
    // nothing is silently dropped; a structured stream is a later step.
    const data = this.#wire.handleExtendedData(payload)
    for (const listener of this.#dataListeners) listener(data)
  }

  _handleRequest(payload: Uint8Array): void {
    const reader = new SshByteReader(payload)
    reader.readByte() // message type
    reader.readUint32() // recipient channel
    const request = reader.readText()
    reader.readByte() // want-reply precedes request-specific fields (RFC 4254).
    if (request === "exit-status") {
      const code = reader.readUint32()
      this.#exitListener?.(code)
      return
    }
    // exit-signal carries a signal name and message; report it as an unknown status.
    if (request === "exit-signal") {
      this.#exitListener?.(null)
    }
  }

  _handleSuccess(payload: Uint8Array): void {
    this.#wire.handleRequestResult(payload)
    this.#resolveRequest()
  }

  _handleFailure(payload: Uint8Array): void {
    this.#wire.handleRequestResult(payload)
    this.#rejectRequest(new ChannelError("The server rejected the channel request"))
  }

  _handleEof(payload: Uint8Array): void {
    this.#wire.handleEof(payload)
  }

  async _handleClose(payload: Uint8Array): Promise<void> {
    this.#wire.handleClose(payload)
    // RFC 4254 section 5.3: acknowledge a peer-initiated close before releasing
    // the channel. Otherwise sshd retains session slots until MaxSessions is hit.
    this.#closed = true
    if (!this.#wire.hasSentClose()) await this.#send(this.#wire.buildClose())
    this.#closeListener?.()
  }

  _handleWindowAdjust(payload: Uint8Array): void {
    this.#wire.handleWindowAdjust(payload)
  }

  _fail(error: Error): void {
    this.#closed = true
    this.#rejectOpen(error)
    this.#rejectRequest(error)
  }

  async #await(register: (waiter: Waiter) => void): Promise<void> {
    return await new Promise<void>((resolve, reject) => {
      register({ resolve, reject })
    })
  }

  #resolveOpen(): void {
    const waiter = this.#openWaiter
    this.#openWaiter = null
    waiter?.resolve()
  }

  #rejectOpen(error: Error): void {
    const waiter = this.#openWaiter
    this.#openWaiter = null
    waiter?.reject(error)
  }

  #resolveRequest(): void {
    const waiter = this.#requestWaiter
    this.#requestWaiter = null
    waiter?.resolve()
  }

  #rejectRequest(error: Error): void {
    const waiter = this.#requestWaiter
    this.#requestWaiter = null
    waiter?.reject(error)
  }
}

/** Routes inbound channel messages to the channel they belong to. */
export class ChannelMux {
  readonly #queue: IncomingPacketQueue
  readonly #send: (payload: Uint8Array) => Promise<void>
  readonly #onKeyExchange: ((serverKexInit: Uint8Array) => Promise<void>) | undefined
  readonly #channels = new Map<number, SessionChannel>()
  #nextId = 0
  #loop: Promise<void> | null = null
  #failure: Error | null = null

  constructor(
    queue: IncomingPacketQueue,
    send: (payload: Uint8Array) => Promise<void>,
    /**
     * Runs the key re-exchange the peer asked for. Without it a KEXINIT is fatal:
     * silently ignoring it would leave the peer waiting forever.
     */
    onKeyExchange?: (serverKexInit: Uint8Array) => Promise<void>
  ) {
    this.#queue = queue
    this.#send = send
    this.#onKeyExchange = onKeyExchange
  }

  get failure(): Error | null {
    return this.#failure
  }

  /** Starts the single read loop. Must be called before opening a channel. */
  start(): void {
    if (this.#loop) return
    this.#loop = this.#run()
  }

  /**
   * Opens a channel for a subsystem (SFTP), without a PTY or a shell.
   *
   * The subsystem handshake is the same request/acknowledge pattern as a shell,
   * so it reuses the pending-request mechanism.
   */
  async openSubsystem(name: string): Promise<SessionChannel> {
    if (this.#failure) throw this.#failure
    const channel = await this.#open(name)
    return channel
  }

  /** Opens a channel that runs one command and exits; no PTY, no shell. */
  async openExec(command: string): Promise<SessionChannel> {
    if (this.#failure) throw this.#failure
    const channel = await this.#open("exec")
    const reply = channel._awaitRequest()
    try {
      await this.#send(channel._buildExecRequest(command))
      await reply
      return channel
    } catch (error) {
      await channel.close().catch(() => {})
      throw error
    }
  }

  async openSession(options: OpenSessionOptions): Promise<SessionChannel> {
    if (this.#failure) throw this.#failure
    const channel = await this.#open(options.term ?? "session")

    const ptyReply = channel._awaitRequest()
    await this.#send(channel._expectPTYRequest(options))
    await ptyReply

    const shellReply = channel._awaitRequest()
    await this.#send(channel._buildShellRequest())
    await shellReply

    return channel
  }

  async #open(label: string): Promise<SessionChannel> {
    const id = this.#nextId++
    const channel = new SessionChannel(id, this.#send)
    this.#channels.set(id, channel)
    void label

    const opened = channel._awaitOpen()
    try {
      await this.#send(channel._buildOpen())
      await opened
      return channel
    } catch (error) {
      this.#channels.delete(id)
      channel._fail(error instanceof Error ? error : new ChannelError("Channel open failed"))
      throw error
    }
  }

  dispose(error: Error): void {
    if (this.#failure) return
    this.#failure = error
    for (const channel of this.#channels.values()) channel._fail(error)
    this.#channels.clear()
  }

  async #run(): Promise<void> {
    for (;;) {
      let payload: Uint8Array
      try {
        payload = await this.#queue.receive()
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error("Packet channel failed"))
        return
      }

      try {
        await this.#dispatch(payload)
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error("Malformed channel message"))
        return
      }
    }
  }

  async #dispatch(payload: Uint8Array): Promise<void> {
    const type = payload[0]
    switch (type) {
      case SSH_MSG_IGNORE:
      case SSH_MSG_DEBUG:
        return
      case SSH_MSG_DISCONNECT:
        throw new ChannelError("The server closed the connection")
      case SSH_MSG_CHANNEL_OPEN_CONFIRMATION:
      case SSH_MSG_CHANNEL_OPEN_FAILURE:
      case SSH_MSG_CHANNEL_WINDOW_ADJUST:
      case SSH_MSG_CHANNEL_DATA:
      case SSH_MSG_CHANNEL_EXTENDED_DATA:
      case SSH_MSG_CHANNEL_REQUEST:
      case SSH_MSG_CHANNEL_SUCCESS:
      case SSH_MSG_CHANNEL_FAILURE:
      case SSH_MSG_CHANNEL_EOF:
      case SSH_MSG_CHANNEL_CLOSE: {
        // Every one of these is addressed to one of our channels.
        const recipient = new SshByteReader(payload.subarray(1)).readUint32()
        const channel = this.#channels.get(recipient)
        if (!channel) throw new ChannelError(`Message ${type} for an unknown channel ${recipient}`)
        switch (type) {
          case SSH_MSG_CHANNEL_OPEN_CONFIRMATION:
            channel._handleConfirmation(payload)
            break
          case SSH_MSG_CHANNEL_OPEN_FAILURE:
            channel._handleOpenFailure(payload)
            break
          case SSH_MSG_CHANNEL_WINDOW_ADJUST:
            channel._handleWindowAdjust(payload)
            break
          case SSH_MSG_CHANNEL_DATA:
            channel._handleData(payload)
            break
          case SSH_MSG_CHANNEL_EXTENDED_DATA:
            channel._handleExtendedData(payload)
            break
          case SSH_MSG_CHANNEL_REQUEST:
            channel._handleRequest(payload)
            break
          case SSH_MSG_CHANNEL_SUCCESS:
            channel._handleSuccess(payload)
            break
          case SSH_MSG_CHANNEL_FAILURE:
            channel._handleFailure(payload)
            break
          case SSH_MSG_CHANNEL_EOF:
            channel._handleEof(payload)
            break
          case SSH_MSG_CHANNEL_CLOSE:
            await channel._handleClose(payload)
            this.#channels.delete(recipient)
            break
        }
        return
      }
      case SSH_MSG_KEXINIT: {
        // Key re-exchange (RFC 4253 section 9). Dispatching it here blocks this
        // loop for the whole exchange, which is correct: while keys are being
        // renegotiated no channel message may be sent or accepted.
        if (!this.#onKeyExchange) {
          throw new ChannelError("The server started a key re-exchange, but none is supported")
        }
        await this.#onKeyExchange(payload)
        return
      }
      default:
        // Global requests and anything else are ignored rather than fatal.
        return
    }
  }
}
