import { connect } from "cloudflare:sockets"

import type {
  ByteTransport,
  DialOptions,
  TransportCloseReason,
  TransportEvents,
  TransportFactory,
} from "@besh/ssh-core"
import { SshConnectionError } from "@besh/ssh-core"

/**
 * Cloudflare TCP transport.
 *
 * This is the only place in the project allowed to touch `cloudflare:sockets`;
 * the SSH core sees nothing but `ByteTransport`, so a different runtime or a
 * test double can replace it.
 *
 * `secureTransport: "off"` is deliberate and not a downgrade: SSH negotiates and
 * performs its own encryption inside this stream, so a second TLS layer would be
 * both redundant and wrong.
 */
export class TcpTransport implements ByteTransport {
  #closed = false
  #handler: TransportEvents | null = null
  #writer: WritableStreamDefaultWriter<Uint8Array> | null = null
  #reader: ReadableStreamDefaultReader<Uint8Array> | null = null
  readonly #socket: Socket

  constructor(socket: Socket) {
    this.#socket = socket
  }

  read(handler: TransportEvents): void {
    if (this.#handler) throw new Error("TcpTransport already has a reader")
    if (this.#closed) throw new Error("TcpTransport is already closed")
    this.#handler = handler

    const reader = this.#socket.readable.getReader()
    this.#reader = reader
    void (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (value && value.byteLength > 0) handler.data(value)
        }
        this.#finish("remote")
      } catch (error) {
        this.#finish("error", error instanceof Error ? error : new Error(String(error)))
      }
    })()
  }

  async write(chunk: Uint8Array): Promise<void> {
    if (this.#closed) throw new Error("Cannot write to a closed transport")
    this.#writer ??= this.#socket.writable.getWriter()
    await this.#writer.write(chunk)
  }

  async close(reason: TransportCloseReason): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    try {
      await this.#writer?.close()
    } catch {
      // A half-closed socket is expected during teardown.
    }
    try {
      await this.#socket.close()
    } catch {
      // Already closed by the peer.
    }
    this.#handler?.close(reason)
  }

  get closed(): boolean {
    return this.#closed
  }

  #finish(reason: TransportCloseReason, error?: Error): void {
    if (this.#closed) return
    this.#closed = true
    this.#handler?.close(reason, error)
  }
}

/**
 * Dials an already-authorized address.
 *
 * Address validation (public target, DNS resolution, rebinding checks) belongs
 * to the caller and must happen before this factory is invoked; the transport
 * deliberately performs no policy of its own.
 */
export class CloudflareTransportFactory implements TransportFactory {
  async dial(options: DialOptions): Promise<ByteTransport> {
    if (options.port < 1 || options.port > 65535) throw new SshConnectionError("TARGET_REJECTED", "Invalid SSH port")
    let socket: Socket
    try {
      socket = connect(
        { hostname: options.host, port: options.port },
        { secureTransport: "off", allowHalfOpen: false }
      )
    } catch (error) {
      throw new SshConnectionError("TARGET_UNREACHABLE", describe(error, "Unable to open a TCP connection"))
    }

    try {
      // Resolves once the socket is established; the caller applies its own deadline.
      await socket.opened
    } catch (error) {
      try {
        await socket.close()
      } catch {
        // Nothing useful to do if the failed socket also refuses to close.
      }
      throw new SshConnectionError("TARGET_UNREACHABLE", describe(error, "TCP connection failed"))
    }

    return new TcpTransport(socket)
  }
}

function describe(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message
  return fallback
}
