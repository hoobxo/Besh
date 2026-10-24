/**
 * SSH identification exchange (RFC 4253 section 4.2).
 *
 * This is the first real protocol step: both sides send a printable
 * `SSH-2.0-<software>` line terminated by CRLF before any binary packet, and the
 * server may precede its line with other lines (banners, MOTD).
 *
 * Implemented from the RFC rather than copied, so the limits are explicit.
 */

export const MAX_IDENTIFICATION_LINE_BYTES = 255
export const MAX_IDENTIFICATION_TOTAL_BYTES = 1024
export const MAX_PRE_IDENTIFICATION_LINES = 50

const IDENTIFICATION_RE = /^SSH-(\d\.\d{1,2})-([\x20-\x7e]{1,200})$/
/**
 * Versions we can actually speak. `1.99` is the "I also do 2.0" marker that
 * older servers send.
 */
const SUPPORTED_PROTOCOLS = new Set(["2.0", "1.99"])

export type IdentificationFailure = "line-too-long" | "unterminated" | "malformed" | "unsupported-version"

export class IdentificationError extends Error {
  readonly reason: IdentificationFailure

  constructor(reason: IdentificationFailure, message: string) {
    super(message)
    this.name = "IdentificationError"
    this.reason = reason
  }
}

export type ServerIdentification = {
  /** The full line as received, without the line terminator. */
  line: string
  protocol: "2.0" | "1.99"
  software: string
  /** Bytes received after the identification line (the first binary packet). */
  rest: Uint8Array
}

/** A client identification line. `software` must contain no spaces. */
export function clientIdentification(software = "Besh_0.1"): string {
  if (!/^[\x21-\x7e]{1,200}$/.test(software)) throw new Error("Invalid client identification software string")
  return `SSH-2.0-${software}`
}

/** Serialises an identification line with its CRLF terminator. */
export function encodeIdentification(line: string): Uint8Array {
  if (!IDENTIFICATION_RE.test(line)) throw new Error("Invalid identification line")
  const bytes = new TextEncoder().encode(`${line}\r\n`)
  if (bytes.length > MAX_IDENTIFICATION_LINE_BYTES) throw new Error("Identification line exceeds the SSH limit")
  return bytes
}

/**
 * Tries to read the server identification from buffered bytes.
 *
 * Returns `null` when more bytes are needed. Throws on a peer that exceeds the
 * line or total limits, which is a protocol violation rather than something to
 * wait out.
 */
export function readServerIdentification(buffer: Uint8Array): ServerIdentification | null {
  let start = 0
  let lines = 0

  for (let index = 0; index < buffer.length; index++) {
    if (buffer[index] !== 0x0a) continue

    // Reject CR-less LF? The RFC allows bare LF; accept it but drop a trailing CR.
    const lineEnd = index > start && buffer[index - 1] === 0x0d ? index - 1 : index
    const lineBytes = buffer.subarray(start, lineEnd)
    const line = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(lineBytes)

    if (line.startsWith("SSH-")) {
      const match = IDENTIFICATION_RE.exec(line)
      if (!match) throw new IdentificationError("malformed", `Malformed SSH identification: ${JSON.stringify(line)}`)
      const protocol = match[1] as string
      if (!SUPPORTED_PROTOCOLS.has(protocol)) {
        throw new IdentificationError("unsupported-version", `Unsupported SSH protocol version: ${protocol}`)
      }
      return {
        line,
        protocol: protocol as "2.0" | "1.99",
        software: match[2] as string,
        rest: buffer.subarray(index + 1),
      }
    }

    lines++
    if (lines > MAX_PRE_IDENTIFICATION_LINES) {
      throw new IdentificationError("unterminated", "Too many lines before the SSH identification string")
    }
    start = index + 1
  }

  if (buffer.length - start > MAX_IDENTIFICATION_LINE_BYTES) {
    throw new IdentificationError("line-too-long", "SSH identification line exceeds 255 bytes")
  }
  if (buffer.length > MAX_IDENTIFICATION_TOTAL_BYTES) {
    throw new IdentificationError("unterminated", "No SSH identification string within 1024 bytes")
  }
  return null
}
