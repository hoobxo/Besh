/**
 * Upload and download queue.
 *
 * Transfers run one at a time so a flaky link only ever has one open staging
 * file, and every item remembers how far it got: a retry resumes from that byte
 * instead of starting over. Uploads stage into a temporary file the server keeps
 * between attempts, so a resumed chunk overwrites its own range rather than
 * appending a second copy.
 *
 * IO is injected so the state machine can be tested without a browser or a server.
 */

export type TransferDirection = "upload" | "download"
export type TransferStatus = "queued" | "running" | "done" | "failed" | "canceled"

export type TransferItem = {
  id: string
  direction: TransferDirection
  /** File name shown in the list; the remote path is what the server sees. */
  name: string
  path: string
  size: number
  /** Bytes the server acknowledged (upload) or that arrived here (download). */
  transferred: number
  status: TransferStatus
  /** Human-readable reason the last attempt gave up; `reason` keeps the raw error. */
  error?: string
  reason?: unknown
  /** Upload staging id, kept across a retry so the server resumes the same file. */
  uploadId?: string
  /** Upload payload, kept so a retry does not re-read the file from disk. */
  bytes?: Uint8Array
  /** Download chunks received so far, kept so a retry continues instead of restarting. */
  pieces?: Uint8Array[]
}

export type TransferIo = {
  beginUpload: (path: string) => Promise<string>
  writeChunk: (path: string, uploadId: string, offset: number, data: Uint8Array) => Promise<void>
  endUpload: (path: string, uploadId: string) => Promise<void>
  abortUpload: (path: string, uploadId: string) => Promise<void>
  readRange: (path: string, offset: number, length: number) => Promise<Uint8Array>
}

export type TransferQueueOptions = {
  /** Bytes per upload request. Base64 grows by a third, so this has a frame budget. */
  chunkSize?: number
  /** Bytes per download request. */
  sliceSize?: number
  /** Attempts per chunk before the item is marked failed. */
  attempts?: number
  sleep?: (ms: number) => Promise<void>
  /** Called once per settled item, with the queue's copy of it. */
  onSettled?: (item: TransferItem) => void
}

const DEFAULTS = {
  chunkSize: 160 * 1024,
  sliceSize: 256 * 1024,
  attempts: 3,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
}

let counter = 0
function nextId(): string {
  counter += 1
  return `t${counter}`
}

export class TransferQueue {
  #items: TransferItem[] = []
  #running = false
  #listeners = new Set<() => void>()
  readonly #io: TransferIo
  readonly #options: Required<Omit<TransferQueueOptions, "onSettled">> & Pick<TransferQueueOptions, "onSettled">

  constructor(io: TransferIo, options: TransferQueueOptions = {}) {
    this.#io = io
    this.#options = { ...DEFAULTS, ...options }
  }

  get items(): TransferItem[] { return this.#items }
  get running(): boolean { return this.#running }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  #notify(): void {
    for (const listener of this.#listeners) listener()
  }

  /** Queues uploads for the given files and starts running if idle. */
  addUploads(files: { name: string; path: string; bytes: Uint8Array }[]): TransferItem[] {
    const added = files.map((file) => ({
      id: nextId(),
      direction: "upload" as const,
      name: file.name,
      path: file.path,
      size: file.bytes.length,
      transferred: 0,
      status: "queued" as const,
      bytes: file.bytes,
    }))
    this.#items.push(...added)
    this.#notify()
    void this.#pump()
    return added
  }

  addDownload(input: { name: string; path: string; size: number }): TransferItem {
    const item: TransferItem = {
      id: nextId(),
      direction: "download",
      name: input.name,
      path: input.path,
      size: input.size,
      transferred: 0,
      status: "queued",
      pieces: [],
    }
    this.#items.push(item)
    this.#notify()
    void this.#pump()
    return item
  }

  /** Puts a failed or canceled item back in line, keeping the bytes it already moved. */
  retry(id: string): void {
    const item = this.#items.find((entry) => entry.id === id)
    if (!item || item.status === "running" || item.status === "done") return
    item.status = "queued"
    item.error = undefined
    item.reason = undefined
    this.#notify()
    void this.#pump()
  }

  /** Drops a queued item, or asks a running one to stop at the next chunk boundary. */
  async cancel(id: string): Promise<void> {
    const item = this.#items.find((entry) => entry.id === id)
    if (!item || item.status === "done") return
    const wasRunning = item.status === "running"
    item.status = "canceled"
    item.error = undefined
    this.#notify()
    if (wasRunning) await this.#abortStaging(item)
  }

  clearFinished(): void {
    this.#items = this.#items.filter((item) => item.status === "running" || item.status === "queued" || item.status === "failed")
    this.#notify()
  }

  /** Contents of a finished download, in order. */
  static bytes(item: TransferItem): Uint8Array {
    const pieces = item.pieces ?? []
    const total = pieces.reduce((sum, piece) => sum + piece.length, 0)
    const merged = new Uint8Array(total)
    let at = 0
    for (const piece of pieces) {
      merged.set(piece, at)
      at += piece.length
    }
    return merged
  }

  /** Widens the narrowed type, since `cancel` changes the field from another task. */
  #statusOf(item: TransferItem): TransferStatus {
    return item.status
  }

  async #abortStaging(item: TransferItem): Promise<void> {
    if (item.direction !== "upload" || !item.uploadId) return
    const uploadId = item.uploadId
    item.uploadId = undefined
    await this.#io.abortUpload(item.path, uploadId).catch(() => undefined)
  }

  async #pump(): Promise<void> {
    if (this.#running) return
    this.#running = true
    try {
      for (;;) {
        const item = this.#items.find((entry) => entry.status === "queued")
        if (!item) break
        item.status = "running"
        this.#notify()
        try {
          if (item.direction === "upload") await this.#runUpload(item)
          else await this.#runDownload(item)
          if (item.status === "running") item.status = "done"
        } catch (reason) {
          // `cancel` writes through the same object, which the compiler cannot see.
          if ((item.status as TransferStatus) !== "canceled") {
            item.status = "failed"
            item.reason = reason
            item.error = reason instanceof Error ? reason.message : String(reason)
          }
        }
        this.#notify()
        if (item.status === "done" || item.status === "failed") {
          this.#options.onSettled?.(item)
        }
      }
    } finally {
      this.#running = false
      this.#notify()
    }
  }

  async #runUpload(item: TransferItem): Promise<void> {
    const bytes = item.bytes
    if (!bytes) throw new Error("Upload has no payload")
    if (!item.uploadId) item.uploadId = await this.#io.beginUpload(item.path)
    if (item.status === "canceled") {
      // Canceled while `beginUpload` was in flight: nothing else will clean this up.
      await this.#abortStaging(item)
      return
    }
    const uploadId = item.uploadId
    while (item.transferred < bytes.length) {
      // Read through a method: `cancel` writes the same field from another task.
      if (this.#statusOf(item) === "canceled") return
      const offset = item.transferred
      const slice = bytes.subarray(offset, Math.min(offset + this.#options.chunkSize, bytes.length))
      await this.#attempt(async () => {
        await this.#io.writeChunk(item.path, uploadId, offset, slice)
      })
      item.transferred = Math.min(offset + slice.length, bytes.length)
      this.#notify()
    }
    // Zero-byte files never enter the loop above but still need committing.
    await this.#attempt(async () => { await this.#io.endUpload(item.path, uploadId) })
    item.uploadId = undefined
    item.bytes = undefined
    item.transferred = bytes.length
  }

  async #runDownload(item: TransferItem): Promise<void> {
    item.pieces ??= []
    while (item.size === 0 || item.transferred < item.size) {
      // Read through a method: `cancel` writes the same field from another task.
      if (this.#statusOf(item) === "canceled") return
      const offset = item.transferred
      const chunk = await this.#attempt(async () => this.#io.readRange(item.path, offset, this.#options.sliceSize))
      if (chunk.length === 0) break
      item.pieces.push(chunk)
      item.transferred = offset + chunk.length
      // The advertised size can be wrong (or unknown); a short read means the end.
      if (chunk.length < this.#options.sliceSize) break
      this.#notify()
    }
    item.size = item.transferred
  }

  /** Runs one request, retrying the same range so a resumed chunk stays idempotent. */
  async #attempt<T>(run: () => Promise<T>): Promise<T> {
    let last: unknown
    for (let attempt = 1; attempt <= this.#options.attempts; attempt += 1) {
      try {
        return await run()
      } catch (reason) {
        last = reason
        if (attempt < this.#options.attempts) await this.#options.sleep(400 * attempt)
      }
    }
    throw last
  }
}
