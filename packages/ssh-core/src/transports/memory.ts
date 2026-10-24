import type { ByteTransport, DialOptions, TransportCloseReason, TransportEvents, TransportFactory } from "../transport.ts"

/**
 * In-memory duplex transport for tests and local wiring checks.
 *
 * It behaves like a socket from the core's point of view (ordered delivery,
 * idempotent close, no callbacks after close) and gives the test side explicit
 * control: read what the core wrote, feed bytes as the peer, or fail the dial.
 */
export class MemoryTransport implements ByteTransport {
  #handler: TransportEvents | null = null
  #closed = false
  #closeReason: TransportCloseReason | null = null
  #chunks: Uint8Array[] = []
  #ignoredAfterClose = 0

  read(handler: TransportEvents): void {
    if (this.#handler) throw new Error("MemoryTransport already has a reader")
    if (this.#closed) throw new Error("MemoryTransport is already closed")
    this.#handler = handler
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("Cannot write to a closed transport")
    this.#chunks.push(chunk.slice())
  }

  async close(reason: TransportCloseReason): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    this.#handler?.close(reason)
  }

  get closed(): boolean {
    return this.#closed
  }

  /** How the transport was closed, from either side. */
  get closeReason(): TransportCloseReason | null {
    return this.#closeReason
  }

  /** Number of peer writes dropped because the transport had already closed. */
  get ignoredAfterClose(): number {
    return this.#ignoredAfterClose
  }

  /** Everything the core has written so far. */
  sent(): Uint8Array {
    const total = this.#chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    const merged = new Uint8Array(total)
    let offset = 0
    for (const chunk of this.#chunks) {
      merged.set(chunk, offset)
      offset += chunk.length
    }
    return merged
  }

  sentText(): string {
    return new TextDecoder().decode(this.sent())
  }

  /** Delivers peer bytes to the core. Dropped once the transport is closed. */
  feed(bytes: Uint8Array | string): void {
    const chunk = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes
    if (this.#closed || !this.#handler) {
      this.#ignoredAfterClose++
      return
    }
    this.#handler.data(chunk)
  }

  /** Simulates the peer closing the connection. */
  peerClose(reason: TransportCloseReason = "remote", error?: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#closeReason = reason
    this.#handler?.close(reason, error)
  }
}

/** Scripted factory for connection tests. */
export class ScriptedTransportFactory implements TransportFactory {
  #dialError: Error | null = null
  #dialDelayMs = 0
  #transport = new MemoryTransport()
  dialCount = 0

  get transport(): MemoryTransport {
    return this.#transport
  }

  failDial(error: Error): void {
    this.#dialError = error
  }

  delayDial(ms: number): void {
    this.#dialDelayMs = ms
  }

  /** Replaces the transport returned by the next dial. */
  reset(transport = new MemoryTransport()): MemoryTransport {
    this.#transport = transport
    return transport
  }

  async dial(_options: DialOptions): Promise<ByteTransport> {
    this.dialCount++
    if (this.#dialDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.#dialDelayMs))
    if (this.#dialError) throw this.#dialError
    return this.#transport
  }
}
