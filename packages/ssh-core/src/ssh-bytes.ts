/**
 * Byte reader for the SSH wire encoding (RFC 4251 section 5).
 *
 * Kept separate from the extracted `protocol/utils.ts` helpers because those are
 * encode-oriented and write into caller-provided buffers; this one is a cursor
 * over received bytes with strict bounds and explicit end-of-input checks.
 */
export class SshByteReader {
  #offset = 0
  readonly #bytes: Uint8Array

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  get offset(): number {
    return this.#offset
  }

  get remaining(): number {
    return this.#bytes.length - this.#offset
  }

  readUint32(): number {
    if (this.remaining < 4) throw new Error("Truncated SSH uint32")
    const value =
      ((this.#bytes[this.#offset]! << 24) |
        (this.#bytes[this.#offset + 1]! << 16) |
        (this.#bytes[this.#offset + 2]! << 8) |
        this.#bytes[this.#offset + 3]!) >>>
      0
    this.#offset += 4
    return value
  }

  readByte(): number {
    if (this.remaining < 1) throw new Error("Truncated SSH byte")
    return this.#bytes[this.#offset++]!
  }

  /** A length-prefixed opaque string. */
  readString(): Uint8Array {
    const length = this.readUint32()
    if (length > this.remaining) throw new Error("Truncated SSH string")
    const value = this.#bytes.subarray(this.#offset, this.#offset + length)
    this.#offset += length
    return value
  }

  readText(): string {
    return new TextDecoder("utf-8", { fatal: false, ignoreBOM: false }).decode(this.readString())
  }

  /** Everything left, without copying. */
  rest(): Uint8Array {
    const value = this.#bytes.subarray(this.#offset)
    this.#offset = this.#bytes.length
    return value
  }

  /** Rejects any trailing data, which would mean a malformed message. */
  expectEnd(what: string): void {
    if (this.remaining !== 0) throw new Error(`Unexpected trailing data in ${what}`)
  }
}

/** Big-endian unsigned bytes from an SSH mpint, dropping sign padding. */
export function mpintToUnsignedBytes(mpint: Uint8Array): Uint8Array {
  let index = 0
  while (index < mpint.length - 1 && mpint[index] === 0x00) index++
  const value = mpint.subarray(index)
  // A leading zero byte followed by a high bit is sign padding, not magnitude.
  return value.length > 1 && value[0] === 0x00 ? value.subarray(1) : value
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

