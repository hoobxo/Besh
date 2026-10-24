import type { DirectionalCipher } from "./ciphers.ts"
import type { SSHPacketParser } from "./protocol/packet.ts"

/**
 * Turns the transport's byte stream into payloads while the connection is still
 * unencrypted.
 *
 * Push-based on purpose: the connection already owns the single transport reader
 * (it needed it for the identification exchange), so the packet stage receives
 * chunks instead of competing for the socket.
 */
export class IncomingPacketQueue {
  readonly #parser: SSHPacketParser
  readonly #blockSize: number
  #payloads: Uint8Array[] = []
  #waiter: { resolve: (payload: Uint8Array) => void; reject: (error: Error) => void } | null = null
  #failure: Error | null = null
  #cipher: DirectionalCipher | null = null
  #draining = false

  constructor(parser: SSHPacketParser, blockSize: number) {
    this.#parser = parser
    this.#blockSize = blockSize
  }

  /**
   * Switches from plaintext to ciphertext parsing.
   *
   * Draining stops as soon as a payload is handed to a waiter, so the caller can
   * install this between NEWKEYS and the first encrypted packet even when the
   * server sent both in one TCP segment.
   */
  setCipher(cipher: DirectionalCipher): void {
    this.#cipher = cipher
    void this.#drain()
  }

  push(chunk: Uint8Array): void {
    if (this.#failure) return
    try {
      this.#parser.feed(chunk)
    } catch (error) {
      this.dispose(asError(error, "Invalid SSH packet"))
      return
    }
    void this.#drain()
  }

  /** Resolves with the next complete payload, waiting for more bytes if needed. */
  receive(): Promise<Uint8Array> {
    const queued = this.#payloads.shift()
    if (queued) {
      void this.#drain()
      return Promise.resolve(queued)
    }
    if (this.#failure) return Promise.reject(this.#failure)
    const pending = new Promise<Uint8Array>((resolve, reject) => {
      this.#waiter = { resolve, reject }
    })
    // Draining stopped after the previous payload was handed over, so bytes that
    // arrived in the same segment (the normal case for ECDH reply + NEWKEYS) are
    // still sitting in the parser buffer. Resume parsing before waiting, or the
    // connection waits forever for a packet it already has.
    void this.#drain()
    return pending
  }

  /** Fails every future receive; called when the socket dies or the stage aborts. */
  dispose(error: Error): void {
    if (this.#failure) return
    this.#failure = error
    this.#payloads = []
    const waiter = this.#waiter
    this.#waiter = null
    waiter?.reject(error)
  }

  async #drain(): Promise<void> {
    if (this.#draining) return
    this.#draining = true
    try {
      await this.#drainLoop()
    } finally {
      this.#draining = false
    }
  }

  async #drainLoop(): Promise<void> {
    for (;;) {
      const cipher = this.#cipher
      let packet
      try {
        packet = cipher
          ? await this.#parser.nextPacket(
              cipher.blockSize,
              (data, sequence, aad, commit) => cipher.decrypt(data, sequence, aad, commit),
              cipher.aead,
              cipher.macLength,
              cipher.verify ? (packetBytes, mac, sequence) => cipher.verify!(packetBytes, mac, sequence) : undefined
            )
          : // Plaintext: identity transform, no MAC and no auth tag.
            await this.#parser.nextPacket(this.#blockSize, (data) => data, false, 0)
      } catch (error) {
        this.dispose(asError(error, "Malformed SSH packet"))
        return
      }
      if (!packet) return

      const waiter = this.#waiter
      if (waiter) {
        this.#waiter = null
        waiter.resolve(packet.payload)
        // Stop here: the consumer may need to change the transform before the
        // bytes that follow this packet can be parsed.
        return
      }
      this.#payloads.push(packet.payload)
      if (this.#payloads.length > 64) {
        this.dispose(new Error("Too many unread SSH packets"))
        return
      }
    }
  }
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback)
}
