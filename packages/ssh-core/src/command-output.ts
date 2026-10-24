/**
 * Bounded capture of a command's output.
 *
 * A remote program decides how much it prints, so an unbounded `output += chunk`
 * hands it control of this process's memory: one `cat` of a large file is enough to
 * exhaust the worker. The cap is applied as the bytes arrive, which keeps the peak at
 * the limit rather than at whatever the command chose to emit.
 *
 * What is dropped is counted, not silently forgotten. A caller that shows the result
 * to a model has to say "this is only the beginning", or the model answers about a
 * file it believes it read in full.
 */

export type CapturedOutput = {
  /** Decoded prefix of the output, at most the configured number of bytes. */
  text: string
  /** Bytes received after the cap was reached, and therefore never decoded. */
  droppedBytes: number
}

export class OutputCollector {
  readonly #limit: number
  #decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false })
  #parts: string[] = []
  #captured = 0
  #dropped = 0
  #closed = false

  constructor(limitBytes: number) {
    if (!Number.isFinite(limitBytes) || limitBytes < 0) throw new RangeError("limitBytes must be a non-negative number")
    this.#limit = Math.floor(limitBytes)
  }

  push(chunk: Uint8Array): void {
    if (this.#closed) return
    // Once the cap is passed, only the size still matters.
    if (this.#dropped > 0) {
      this.#dropped += chunk.byteLength
      return
    }
    const room = this.#limit - this.#captured
    if (chunk.byteLength <= room) {
      this.#captured += chunk.byteLength
      this.#parts.push(this.#decoder.decode(chunk, { stream: true }))
      return
    }
    // Cut at the byte limit rather than at a character boundary: the kept text stays a
    // true prefix of the output, and the split code point is flushed away below.
    if (room > 0) this.#parts.push(this.#decoder.decode(chunk.subarray(0, room), { stream: true }))
    this.#captured = this.#limit
    this.#parts.push(this.#decoder.decode())
    this.#dropped = chunk.byteLength - Math.max(0, room)
  }

  finish(): CapturedOutput {
    if (!this.#closed) {
      this.#closed = true
      // A complete stream ends on a character boundary; a truncated one may not.
      if (this.#dropped === 0) this.#parts.push(this.#decoder.decode())
    }
    const text = this.#parts.join("")
    // Dropping the incomplete tail keeps the promise in the type: a prefix, not a
    // replacement character the caller would have to explain.
    return { text: this.#dropped > 0 ? text.replace(/\uFFFD$/, "") : text, droppedBytes: this.#dropped }
  }
}
