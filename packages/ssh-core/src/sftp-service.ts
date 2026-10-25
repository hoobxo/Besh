/**
 * SFTP service: the v3 file protocol carried over a session channel.
 *
 * The protocol itself is the extracted `protocol/sftp.ts` client; this file owns
 * the channel, the subsystem handshake and a small product-facing API (list,
 * stat, read, write, mkdir, remove, rename).
 */
import { SFTPClient, SFTPStatusError, type SFTPHandle } from "./protocol/sftp.ts"
import {
  SFTP_OPEN_FLAGS,
  type SFTPAttrs,
  type SFTPDirEntry,
} from "./protocol/sftp-types.ts"
import type { SessionChannel } from "./channels.ts"

export type SftpEntry = {
  name: string
  path: string
  kind: "file" | "directory" | "symlink" | "other"
  size: number
  /** Unix mode bits, e.g. 0o644. */
  mode: number | null
  modifiedAt: number | null
}

/**
 * A technical fallback for a status code.
 *
 * The interface translates the code itself (it owns the reader's language); this text only
 * travels when a code has no mapping yet.
 */
function describeStatus(code: number, description: string): string {
  switch (code) {
    case 1:
      return "End of file"
    case 2:
      return "No such file or directory"
    case 3:
      return "Permission denied"
    case 4:
      return description && description !== "Failure" ? `Server refused: ${description}` : "Server refused the operation"
    case 5:
      return "Operation not supported by this server"
    case 8:
      return "Operation rejected by the server"
    default:
      return description ? `Operation failed (${code}): ${description}` : `Operation failed (status ${code})`
  }
}

export class SftpError extends Error {
  readonly code: number | null

  constructor(message: string, code: number | null = null) {
    super(message)
    this.name = "SftpError"
    this.code = code
  }
}

const DIRECTORY_BIT = 0o040000
const SYMLINK_BIT = 0o120000
const MAX_READ_BYTES = 8 * 1024 * 1024

export type WriteState = "open" | "committing" | "committed" | "aborting" | "aborted" | "failed"

/** A staged upload. `path` is the destination; only `temporaryPath` is writable. */
export type WriteSession = {
  handle: SFTPHandle
  offset: number
  path: string
  temporaryPath: string
  state: WriteState
  handleClosed: boolean
}

/** Counts include the selected entry itself, not just its descendants. */
export type RemovedEntries = { files: number; dirs: number }

export class SftpService {
  readonly #channel: SessionChannel
  readonly #client: SFTPClient
  #closed = false
  #closing = false
  readonly #writes = new Map<WriteSession, { tail: Promise<void> }>()
  readonly #openingWrites = new Set<Promise<WriteSession>>()

  constructor(channel: SessionChannel, client: SFTPClient) {
    this.#channel = channel
    this.#client = client
  }

  /** Resolves the server's home/absolute path for a relative input. */
  async realpath(path: string): Promise<string> {
    return await this.#guard(() => this.#client.realpath(path))
  }

  async stat(path: string): Promise<SftpEntry> {
    const attrs = await this.#guard(() => this.#client.stat(path))
    return toEntry(path, attrs)
  }

  async lstat(path: string): Promise<SftpEntry> {
    const attrs = await this.#guard(() => this.#client.lstat(path))
    return toEntry(path, attrs)
  }

  /** Lists a directory via open/read/close, following the SFTP v3 handle flow. */
  async list(path: string): Promise<SftpEntry[]> {
    return await this.#listAt(await this.realpath(path))
  }

  /** Internal destructive traversal never REALPATHs the selected leaf. */
  async #listAt(resolved: string): Promise<SftpEntry[]> {
    const handle = await this.#guard(() => this.#client.openDir(resolved))
    const entries: SftpEntry[] = []
    const names = new Set<string>()
    try {
      for (;;) {
        const batch = await this.#guard(() => this.#client.readDir(handle))
        // A null batch is the protocol's end-of-directory marker.
        if (batch === null) break
        if (batch.length === 0) break
        for (const entry of batch) {
          if (entry.filename === "." || entry.filename === "..") continue
          validateLeaf(entry.filename)
          if (names.has(entry.filename)) throw new SftpError("Duplicate directory entry")
          names.add(entry.filename)
          entries.push(toChildEntry(resolved, entry))
        }
      }
    } finally {
      await this.#guard(() => this.#client.closeHandle(handle))
    }
    // directories first, then by name: readdir order is arbitrary on disk
    return entries.sort((left, right) => {
      const leftDir = left.kind === "directory" ? 0 : 1
      const rightDir = right.kind === "directory" ? 0 : 1
      if (leftDir !== rightDir) return leftDir - rightDir
      return left.name.localeCompare(right.name, "en")
    }).sort((left, right) => left.name.localeCompare(right.name))
  }

  async readFile(path: string, maxBytes = MAX_READ_BYTES): Promise<Uint8Array> {
    const resolved = await this.realpath(path)
    const handle = await this.#guard(() => this.#client.openFile(resolved, 0x00000001))
    const chunks: Uint8Array[] = []
    let offset = 0
    try {
      for (;;) {
        const chunk = await this.#guard(() => this.#client.readFile(handle, offset, 32 * 1024))
        if (chunk === null || chunk.length === 0) break
        chunks.push(chunk)
        offset += chunk.length
        if (offset > maxBytes) throw new SftpError(`File exceeds the ${maxBytes} byte read limit`)
      }
    } finally {
      await this.#guard(() => this.#client.closeHandle(handle))
    }
    const merged = new Uint8Array(offset)
    let position = 0
    for (const chunk of chunks) {
      merged.set(chunk, position)
      position += chunk.length
    }
    return merged
  }

  /**
   * Reads a slice of a file.
   *
   * A long sequential read of one handle is the natural way to fetch a file, but it
   * leaves the caller with a single request that can stall half way with no way to
   * resume. Reading by offset lets the caller make progress in bounded steps.
   */
  async readRange(path: string, offset: number, length: number): Promise<Uint8Array> {
    if (!Number.isInteger(offset) || offset < 0) throw new SftpError("Read offset must be a positive integer")
    if (!Number.isInteger(length) || length <= 0) throw new SftpError("Read length must be positive")
    const resolved = await this.realpath(path)
    const handle = await this.#guard(() => this.#client.openFile(resolved, 0x00000001))
    try {
      const chunks: Uint8Array[] = []
      let position = offset
      let remaining = length
      while (remaining > 0) {
        const want = Math.min(remaining, 32 * 1024)
        const chunk = await this.#guard(() => this.#client.readFile(handle, position, want))
        if (chunk === null || chunk.length === 0) break
        chunks.push(chunk)
        position += chunk.length
        remaining -= chunk.length
      }
      const merged = new Uint8Array(position - offset)
      let at = 0
      for (const chunk of chunks) {
        merged.set(chunk, at)
        at += chunk.length
      }
      return merged
    } finally {
      await this.#guard(() => this.#client.closeHandle(handle))
    }
  }

  /** Whole-file writes use the same staged commit as chunked uploads. */
  async writeFile(path: string, data: Uint8Array): Promise<void> {
    const session = await this.beginWrite(path)
    try {
      await this.writeChunk(session, data)
      await this.endWrite(session)
    } catch (error) {
      await this.abortWrite(session).catch(() => {})
      throw error
    }
  }

  /**
   * Stage into an exclusive same-directory temporary file. Never REALPATH or open
   * the destination: doing either could follow a symlink or truncate the old file.
   * New files are private (0600); an existing regular file retains its mode bits.
   */
  async beginWrite(path: string): Promise<WriteSession> {
    if (this.#closed || this.#closing) throw new SftpError("SFTP session is closing")
    const opening = this.#beginWrite(path)
    this.#openingWrites.add(opening)
    try {
      return await opening
    } finally {
      this.#openingWrites.delete(opening)
    }
  }

  async #beginWrite(path: string): Promise<WriteSession> {
    const destination = await this.#entryPath(path)
    let permissions = 0o600
    try {
      const target = await this.lstat(destination)
      if (target.kind === "directory") throw new SftpError("Upload destination is a directory")
      if (target.kind === "file" && target.mode !== null) permissions = target.mode & 0o777
    } catch (error) {
      if (!(error instanceof SftpError && error.code === 2)) throw error
    }
    const parent = destination.slice(0, destination.lastIndexOf("/")) || "/"
    const temporaryPath = `${parent === "/" ? "" : parent}/.besh-upload-${crypto.randomUUID()}.tmp`
    const handle = await this.#guard(() =>
      this.#client.openFile(
      temporaryPath,
      SFTP_OPEN_FLAGS.WRITE | SFTP_OPEN_FLAGS.CREATE | SFTP_OPEN_FLAGS.EXCLUSIVE,
      { permissions },
    )
    )
    const session: WriteSession = { handle, offset: 0, path: destination, temporaryPath, state: "open", handleClosed: false }
    this.#writes.set(session, { tail: Promise.resolve() })
    return session
  }

  /**
   * Append at the staged file's current end.
   *
   * A failed chunk leaves the session open on purpose: the staged file is still
   * there, and `writeAt` lets the caller retry the same range instead of throwing
   * away everything it already sent.
   */
  async writeChunk(session: WriteSession, data: Uint8Array): Promise<void> {
    await this.#writeAt(session, session.offset, data)
  }

  /**
   * Write at an explicit position, so a retried chunk overwrites the range it was
   * already given instead of appending a second copy of it.
   */
  async writeAt(session: WriteSession, offset: number, data: Uint8Array): Promise<void> {
    if (!Number.isInteger(offset) || offset < 0) throw new SftpError("Write offset must be a non-negative integer")
    await this.#writeAt(session, offset, data)
  }

  async #writeAt(session: WriteSession, offset: number, data: Uint8Array): Promise<void> {
    await this.#writeExclusive(session, async () => {
      if (session.state !== "open") throw new SftpError(`Upload is ${session.state}`)
      let written = 0
      try {
        for (; written < data.length;) {
          const slice = data.subarray(written, Math.min(written + 32 * 1024, data.length))
          await this.#guard(() => this.#client.writeFile(session.handle, offset + written, slice))
          written += slice.length
          session.offset = offset + written
        }
      } catch (error) {
        // Keep the highest byte the server acknowledged, so an append-style retry
        // does not write over data that did land.
        session.offset = Math.max(session.offset, offset + written)
        throw error
      }
    })
  }

  /**
   * Close before commit. OpenSSH POSIX rename atomically replaces existing files;
   * standard v3 rename may refuse an existing target. Never delete that target as
   * a fallback. On failure the caller can abortWrite to clean the temporary file.
   */
  async endWrite(session: WriteSession): Promise<void> {
    if (session.state === "committed") return
    await this.#writeExclusive(session, async () => {
      if (session.state === "committed") return
      if (session.state !== "open") throw new SftpError(`Upload is ${session.state}`)
      session.state = "committing"
      try {
        await this.#guard(() => this.#client.closeHandle(session.handle))
        session.handleClosed = true
        await this.#guard(() => this.#client.renameAtomic(session.temporaryPath, session.path))
        session.state = "committed"
        this.#writes.delete(session)
      } catch (error) {
        session.state = "failed"
        throw error
      }
    })
  }

  /**
   * DO timeout/disconnect cleanup: close the handle and remove only the staged
   * file. Repeat calls after success/commit are harmless. If cleanup fails, retain
   * the session so the caller may retry; the original destination is never touched.
   */
  async abortWrite(session: WriteSession): Promise<void> {
    if (session.state === "committed" || session.state === "aborted") return
    await this.#writeExclusive(session, async () => {
      if (session.state === "committed" || session.state === "aborted") return
      session.state = "aborting"
      let closeError: unknown
      if (!session.handleClosed) {
        try {
          await this.#guard(() => this.#client.closeHandle(session.handle))
          session.handleClosed = true
        } catch (error) { closeError = error }
      }
      try {
        await this.#guard(() => this.#client.removeFile(session.temporaryPath))
      } catch (error) {
        if (!(error instanceof SftpError && error.code === 2)) {
          session.state = "failed"
          throw error
        }
      }
      if (closeError) {
        session.state = "failed"
        throw closeError
      }
      session.state = "aborted"
      this.#writes.delete(session)
    })
  }

  async #writeExclusive(session: WriteSession, operation: () => Promise<void>): Promise<void> {
    const tracked = this.#writes.get(session)
    if (!tracked) throw new SftpError("Unknown upload session")
    const run = tracked.tail.then(operation)
    tracked.tail = run.catch(() => {})
    return await run
  }

  async mkdir(path: string, mode = 0o755): Promise<void> {
    await this.#guard(() => this.#client.mkdir(path, { permissions: mode }))
  }

  /**
   * Creates an empty file and refuses to replace anything already there. The check is
   * LSTAT, so a symlink counts as an existing name instead of being followed and
   * truncated, and the zero-byte data goes through the same staged commit as an upload.
   */
  async createFile(path: string): Promise<void> {
    const destination = await this.#entryPath(path)
    let exists = false
    try {
      await this.lstat(destination)
      exists = true
    } catch (error) {
      if (!(error instanceof SftpError && error.code === 2)) throw error
    }
    // SSH_FX_FILE_ALREADY_EXISTS, so the browser can say "that name is taken".
    if (exists) throw new SftpError("File already exists", 11)
    await this.writeFile(destination, new Uint8Array(0))
  }

  async remove(path: string): Promise<void> {
    await this.#guard(() => this.#client.removeFile(path))
  }

  /** Directories need the RMDIR request, not REMOVE. */
  async removeDirectory(path: string): Promise<void> {
    await this.#guard(() => this.#client.rmdir(path))
  }

  /** Unified delete entry point: LSTAT never follows the selected symlink. */
  async removeEntry(path: string): Promise<RemovedEntries> {
    return await this.#removeAt(await this.#entryPath(path), 0)
  }

  /** Safe even when called directly with a symlink or a trailing slash. */
  async removeTree(path: string): Promise<RemovedEntries> {
    return await this.removeEntry(path)
  }

  async #removeAt(path: string, depth: number): Promise<RemovedEntries> {
    if (depth > 128) throw new SftpError("Directory nesting exceeds the deletion limit")
    const entry = await this.lstat(path)
    if (entry.kind !== "directory") {
      await this.remove(path)
      return { files: 1, dirs: 0 }
    }
    const entries = await this.#listAt(path)
    let files = 0
    let dirs = 1
    for (const child of entries) {
      // Do not trust READDIR attrs: a symlink can be reported as a directory or
      // replaced after listing. Every child is classified freshly with LSTAT.
      const removed = await this.#removeAt(child.path, depth + 1)
      files += removed.files
      dirs += removed.dirs
    }
    await this.removeDirectory(path)
    return { files, dirs }
  }

  /** Resolve only the parent, preserving the leaf's identity for LSTAT/rename. */
  async #entryPath(path: string): Promise<string> {
    if (!path || path.includes("\0") || path.includes("\\")) throw new SftpError("Invalid entry path")
    const trimmed = path.replace(/\/+$/, "")
    if (!trimmed) throw new SftpError("Refusing to operate on the filesystem root")
    const parts = trimmed.split("/")
    if (parts.some((part) => part === "." || part === "..")) throw new SftpError("Dot path components are not allowed")
    const slash = trimmed.lastIndexOf("/")
    const name = trimmed.slice(slash + 1)
    validateLeaf(name)
    const parent = slash < 0 ? "." : trimmed.slice(0, slash) || "/"
    const resolved = await this.realpath(parent)
    if (!resolved.startsWith("/") || resolved.includes("\0") || resolved.includes("\\") || resolved.split("/").some((p) => p === "." || p === "..")) {
      throw new SftpError("Server returned an invalid parent path")
    }
    return `${resolved.replace(/\/+$/, "")}/${name}`
  }

  async rename(from: string, to: string): Promise<void> {
    await this.#guard(() => this.#client.rename(from, to))
  }

  async close(): Promise<void> {
    if (this.#closed || this.#closing) return
    this.#closing = true
    // Best effort while the SSH/SFTP channel is still usable. A dead transport may
    // prevent cleanup; callers can also abort explicitly before closing SSH.
    await Promise.allSettled([...this.#openingWrites])
    await Promise.allSettled([...this.#writes.keys()].map((session) => this.abortWrite(session)))
    this.#closed = true
    this.#client.dispose(new SftpError("SFTP session closed"))
    await this.#channel.close()
  }

  /** Wraps protocol failures in one error type the caller can translate. */
  async #guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#closed) throw new SftpError("SFTP session is closed")
    try {
      return await operation()
    } catch (error) {
      if (error instanceof SFTPStatusError) {
        throw new SftpError(describeStatus(error.code, error.description), error.code)
      }
      if (error instanceof SftpError) throw error
      throw new SftpError(error instanceof Error ? error.message : "SFTP operation failed")
    }
  }
}

function toEntry(path: string, attrs: SFTPAttrs): SftpEntry {
  const mode = typeof attrs.permissions === "number" ? attrs.permissions : null
  return {
    name: path.split("/").filter(Boolean).pop() ?? path,
    path,
    kind: kindOf(mode),
    size: Number(attrs.size ?? 0),
    mode: mode === null ? null : mode & 0o7777,
    modifiedAt: typeof attrs.mtime === "number" ? attrs.mtime * 1000 : null,
  }
}

function toChildEntry(parent: string, entry: SFTPDirEntry): SftpEntry {
  const mode = typeof entry.attrs.permissions === "number" ? entry.attrs.permissions : null
  return {
    name: entry.filename,
    path: `${parent.replace(/\/+$/, "")}/${entry.filename}`,
    kind: kindOf(mode),
    size: Number(entry.attrs.size ?? 0),
    mode: mode === null ? null : mode & 0o7777,
    modifiedAt: typeof entry.attrs.mtime === "number" ? entry.attrs.mtime * 1000 : null,
  }
}

function kindOf(mode: number | null): SftpEntry["kind"] {
  if (mode === null) return "other"
  if ((mode & 0o170000) === DIRECTORY_BIT) return "directory"
  if ((mode & 0o170000) === SYMLINK_BIT) return "symlink"
  if ((mode & 0o170000) === 0o100000) return "file"
  return "other"
}

/** A READDIR name must be one POSIX basename, never a path supplied by a peer. */
function validateLeaf(name: string): void {
  if (!name || name === "." || name === ".." || /[\/\\\0]/.test(name)) {
    throw new SftpError("Invalid directory entry name")
  }
}
