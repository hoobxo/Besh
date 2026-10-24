/** Browser-independent connection bookkeeping, with an injectable clock for regression tests. */
import { isErrorCode, type ErrorCode } from "@besh/contracts"

export type Clock = {
  set: (callback: () => void, delay: number) => unknown
  clear: (timer: unknown) => void
}
const clock: Clock = {
  set: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
}

export function fsReadKey(op: string, path: string, extra: { offset?: number; maxBytes?: number }): string | null {
  if (op !== "list" && op !== "stat" && op !== "read") return null
  return JSON.stringify([op, path, ...(op === "read" ? [extra.offset ?? 0, extra.maxBytes ?? null] : [])])
}

/** Every pending request settles, including when the connection disappears. */
export class PendingRequests<T> {
  #next = 1
  #pending = new Map<number, { resolve: (value: T) => void; reject: (error: Error) => void; timer: unknown; key: string | null }>()
  #inFlight = new Map<string, Promise<T>>()
  private readonly timer: Clock
  constructor(timer: Clock = clock) { this.timer = timer }

  request(key: string | null, send: (id: number) => void, timeout: Error): Promise<T> {
    if (key !== null) {
      const existing = this.#inFlight.get(key)
      if (existing) return existing
    }
    const id = this.#next++
    let start!: () => void
    const flight = new Promise<T>((resolve, reject) => {
      const timer = this.timer.set(() => this.reject(id, timeout), 30_000)
      this.#pending.set(id, { resolve, reject, timer, key })
      start = () => { try { send(id) } catch (error) { this.reject(id, error instanceof Error ? error : new Error(String(error))) } }
    })
    if (key !== null) this.#inFlight.set(key, flight)
    start()
    return flight
  }

  #take(id: number) {
    const request = this.#pending.get(id)
    if (!request) return undefined
    this.#pending.delete(id)
    this.timer.clear(request.timer)
    if (request.key !== null) this.#inFlight.delete(request.key)
    return request
  }
  resolve(id: number, value: T): void { this.#take(id)?.resolve(value) }
  reject(id: number, error: Error): void { this.#take(id)?.reject(error) }
  cancelAll(error: Error): void {
    for (const id of [...this.#pending.keys()]) this.reject(id, error)
    this.#inFlight.clear()
  }
}

const PERMANENT: ReadonlySet<ErrorCode> = new Set([
  "HOST_KEY_CHANGED", "HOST_KEY_MISMATCH", "HOST_KEY_UNKNOWN", "AUTH_FAILED", "AUTH_METHOD_UNSUPPORTED",
  "AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND", "TARGET_REJECTED", "INVALID_REQUEST", "TICKET_INVALID",
  "CANCELLED",
])
export function permanentConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const { code, status } = error as { code?: string; status?: number }
  return (isErrorCode(code) && PERMANENT.has(code)) || status === 401 || status === 403 || status === 404
}

type ReconnectOptions = {
  connect: (signal: AbortSignal) => Promise<void>
  scheduled: (attempt: number, delay: number) => void
  exhausted: () => void
  permanent: (error: unknown) => void
  clock?: Clock
}

/** One retry budget covers HTTP ticket failures and subsequent socket failures. */
export class ReconnectLoop {
  #attempt = 0
  #timer: unknown = null
  #running = false
  #generation = 0
  #stopped = false
  #failedWhileRunning = false
  #controller: AbortController | null = null
  private readonly options: ReconnectOptions
  constructor(options: ReconnectOptions) { this.options = options }
  get attempt(): number { return this.#attempt }
  get #clock(): Clock { return this.options.clock ?? clock }
  stop(): void {
    this.#stopped = true
    this.#generation++
    this.#controller?.abort()
    this.#controller = null
    if (this.#timer !== null) this.#clock.clear(this.#timer)
    this.#timer = null
    this.#running = false
    this.#failedWhileRunning = false
  }
  reset(): void { this.stop(); this.#attempt = 0; this.#stopped = false }
  ready(): void { this.reset() }
  failed(error?: unknown): void {
    if (this.#stopped) return
    if (permanentConnectionError(error)) { this.stop(); this.options.permanent(error); return }
    if (this.#timer !== null) return
    if (this.#running) { this.#failedWhileRunning = true; return }
    if (this.#attempt >= 5) { this.stop(); this.options.exhausted(); return }
    const attempt = ++this.#attempt
    const delay = Math.min(8000, 500 * 2 ** (attempt - 1))
    const generation = this.#generation
    this.options.scheduled(attempt, delay)
    this.#timer = this.#clock.set(() => {
      this.#timer = null
      if (this.#stopped || generation !== this.#generation) return
      this.#running = true
      const controller = new AbortController()
      this.#controller = controller
      void this.options.connect(controller.signal).then(
        () => {
          if (generation !== this.#generation) return
          this.#running = false
          if (this.#failedWhileRunning) { this.#failedWhileRunning = false; this.failed() }
        },
        (error: unknown) => {
          if (generation !== this.#generation) return
          this.#running = false
          this.#failedWhileRunning = false
          this.failed(error)
        },
      )
    }, delay)
  }
}

export function currentSocket<T>(current: T | null, candidate: T, disposed: boolean, closed: boolean): boolean {
  return current === candidate && !disposed && !closed
}

export function currentAiResponse(activeId: number | null, responseId: unknown): boolean {
  return activeId !== null && responseId === activeId
}

/** Strip transient streaming markers without throwing away already displayed text. */
export function finishStreaming<T extends { kind: string }>(entries: readonly T[]): T[] {
  return entries.map((entry) => entry.kind === "assistant" ? { ...entry, streaming: false } : entry)
}
