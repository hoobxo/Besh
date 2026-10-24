/**
 * Where AI attachments live.
 *
 * An uploaded image is stored once in the object store and referenced by id; the
 * bytes only come back when a turn is being built. Sending base64 through the
 * session socket instead would make every screenshot part of a WebSocket frame and
 * keep it resident in the Durable Object for the life of the connection.
 */
import { bytesToBase64 } from "./bytes.ts"

/**
 * What may be stored.
 *
 * The panel re-encodes every picture to WebP (JPEG where the browser cannot encode
 * it) before uploading, so this list is the contract for anything calling the
 * endpoint directly. GIF is deliberately absent: the pipeline flattens it to one
 * frame anyway, and a silent still frame is worse than saying so.
 */
export const ATTACHMENT_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

/** What the browser sends instead of the bytes. */
export type AttachmentRef = { id: string; name: string; mime: string }

/**
 * The subset of the object store this code needs.
 *
 * Declaring it here rather than importing the platform type keeps the domain
 * testable with a plain map-backed fake.
 */
export type AttachmentBucket = {
  put(
    key: string,
    value: ArrayBuffer,
    options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }
  ): Promise<unknown>
  get(key: string): Promise<{
    arrayBuffer(): Promise<ArrayBuffer>
    /** Set by the upload, so a read can answer with the type it was stored as. */
    httpMetadata?: { contentType?: string }
  } | null>
  delete(key: string): Promise<unknown>
}

/**
 * The object store plus the listing a sweep needs.
 *
 * Kept apart from `AttachmentBucket` so the read/write paths do not have to grow a
 * `list()` they never call.
 */
export type AttachmentStore = AttachmentBucket & {
  list(options?: { prefix?: string; cursor?: string; limit?: number }): Promise<{
    objects: ReadonlyArray<{ key: string; uploaded?: Date }>
    truncated: boolean
    cursor?: string
  }>
}

const ID_PATTERN = /^[a-f0-9]{32}$/

export function isAttachmentMime(value: string): boolean {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(value)
}

export function attachmentKey(id: string): string {
  return `ai/${id}`
}

/** Accepts only the ids this code writes, so a client cannot steer the object key. */
export function readAttachmentId(value: unknown): string | null {
  return typeof value === "string" && ID_PATTERN.test(value) ? value : null
}

export function newAttachmentId(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** The base64 data URL the model expects, or null once the object is gone. */
export async function readAttachmentDataUrl(
  bucket: AttachmentBucket,
  id: string,
  mime: string
): Promise<string | null> {
  const object = await bucket.get(attachmentKey(id))
  if (!object) return null
  const bytes = new Uint8Array(await object.arrayBuffer())
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

/** The ids a conversation's stored entries still point at. */
export function attachmentIdsOf(entries: readonly Record<string, unknown>[]): string[] {
  const ids = new Set<string>()
  for (const entry of entries) {
    const list = entry.attachments
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const id = readAttachmentId((item as { id?: unknown } | null)?.id)
      if (id) ids.add(id)
    }
  }
  return [...ids]
}

/**
 * Drops the objects a conversation used.
 *
 * Deleting a conversation deletes its images too; a failure here is not worth
 * failing the user's action over, the objects expire with the account.
 */
export async function forgetAttachments(
  bucket: AttachmentBucket,
  entries: readonly Record<string, unknown>[]
): Promise<void> {
  const ids = attachmentIdsOf(entries)
  if (ids.length === 0) return
  await Promise.all(ids.map((id) => bucket.delete(attachmentKey(id)).catch(() => undefined)))
}

/** How many images a restored conversation may carry. */
export const MAX_REPLAYED_ATTACHMENTS = 4

/** The ceiling on those images together, before base64 expansion. */
export const MAX_REPLAYED_BYTES = 4 * 1024 * 1024

export type ReplayedAttachment = { name: string; mime: string; dataUrl: string }

/**
 * Reads back the images a stored conversation points at.
 *
 * Restoring a conversation used to hand the model the words but not the pictures, so
 * "what does that error say" asked after a reload was answered from nothing. The
 * objects are read again here — newest first, under a count and a byte ceiling —
 * because a conversation with twenty screenshots must not turn one question into a
 * twenty-image request.
 *
 * The result is keyed by the position of the entry the images belong to. An entry
 * whose bytes have gone is simply absent: a deleted object is not a reason to fail
 * the whole load.
 */
export async function replayAttachments(
  bucket: AttachmentBucket,
  entries: readonly Record<string, unknown>[]
): Promise<Map<number, ReplayedAttachment[]>> {
  const chosen = new Map<number, ReplayedAttachment[]>()
  let count = 0
  let bytes = 0

  for (let index = entries.length - 1; index >= 0 && count < MAX_REPLAYED_ATTACHMENTS; index--) {
    const list = entries[index].attachments
    if (!Array.isArray(list) || list.length === 0) continue

    const kept: ReplayedAttachment[] = []
    for (const item of list) {
      if (count >= MAX_REPLAYED_ATTACHMENTS) break
      const ref = item as { id?: unknown; name?: unknown; mime?: unknown } | null
      const id = readAttachmentId(ref?.id)
      const mime = ref?.mime
      if (!id || typeof mime !== "string" || !isAttachmentMime(mime)) continue

      const dataUrl = await readAttachmentDataUrl(bucket, id, mime).catch(() => null)
      if (!dataUrl) continue
      const size = decodedSize(dataUrl)
      if (bytes + size > MAX_REPLAYED_BYTES) continue

      kept.push({ name: typeof ref?.name === "string" ? ref.name : "image", mime, dataUrl })
      count += 1
      bytes += size
    }
    if (kept.length > 0) chosen.set(index, kept)
  }

  // Chronological order, so a caller reading the map sees the conversation as it was
  // rather than as it was scanned.
  return new Map([...chosen].sort((left, right) => left[0] - right[0]))
}

/** The bytes behind a data URL, derived from its base64 length. */
function decodedSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(",")
  if (comma < 0) return 0
  return Math.floor(((dataUrl.length - comma - 1) * 3) / 4)
}
