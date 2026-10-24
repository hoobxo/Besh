/**
 * Byte transport boundary for the SSH core.
 *
 * The core never imports a concrete socket implementation. Cloudflare TCP,
 * a Node test double or a future runtime all arrive through this interface, so
 * the protocol code stays platform independent and testable.
 */

export type TransportCloseReason =
  | "local" // we closed the socket
  | "remote" // the peer closed it
  | "error" // transport failure
  | "timeout" // connect or idle deadline
  | "cancelled" // outer request aborted

export interface TransportEvents {
  data: (chunk: Uint8Array) => void
  close: (reason: TransportCloseReason, error?: Error) => void
}

/**
 * An ordered, byte-exact duplex stream.
 *
 * Implementations must deliver `data` callbacks in arrival order, never after a
 * `close` callback, and must make `close()` idempotent.
 */
export interface ByteTransport {
  read(handler: TransportEvents): void
  write(chunk: Uint8Array): Promise<void>
  close(reason: TransportCloseReason): Promise<void>
  readonly closed: boolean
}

export type DialOptions = {
  host: string
  port: number
  /** Deadline from dial start to first byte, in milliseconds. */
  connectTimeoutMs: number
}

/**
 * Opens a byte transport to an already authorized target.
 *
 * Callers must resolve and validate the address before dialling; this boundary
 * never performs DNS resolution, retries or policy decisions of its own.
 */
export interface TransportFactory {
  dial(options: DialOptions): Promise<ByteTransport>
}
