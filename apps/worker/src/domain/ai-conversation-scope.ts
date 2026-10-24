export type ConversationToken = { revision: number; signal: AbortSignal }

/** Serializes AI actions without forcing a newly selected thread to wait for an old one. */
export class ConversationScope {
  #revision = 0
  #controller = new AbortController()
  #tail: Promise<unknown> = Promise.resolve()

  capture(): ConversationToken {
    return { revision: this.#revision, signal: this.#controller.signal }
  }

  current(token: ConversationToken): boolean {
    return token.revision === this.#revision && !token.signal.aborted
  }

  reset(): void {
    this.#controller.abort()
    this.#revision++
    this.#controller = new AbortController()
    this.#tail = Promise.resolve()
  }

  /**
   * Stops what is in flight but keeps the same thread selected.
   *
   * The revision is intentionally unchanged: a cancel is not a switch of conversation,
   * so the next question lands in the thread the user is already looking at.
   */
  interrupt(): void {
    this.#controller.abort()
    this.#controller = new AbortController()
    this.#tail = Promise.resolve()
  }

  run(task: () => Promise<void>): Promise<void> {
    const token = this.capture()
    const result = this.#tail.then(async () => {
      if (this.current(token)) await task()
    })
    this.#tail = result.catch(() => undefined)
    return result
  }
}
