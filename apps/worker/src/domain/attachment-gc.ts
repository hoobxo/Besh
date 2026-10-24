/**
 * Sweeps attachments that nothing points at any more.
 *
 * An upload happens before the question is sent, so closing the tab in between —
 * or removing the chip after the server already took the bytes — leaves an object
 * behind that no stored turn will ever name. The transcripts are the source of
 * truth: an id that appears in no `ai_messages.entry` is unreachable, because the
 * only thing that ever looks an object up is a turn being built.
 *
 * Two rails keep a sweep from becoming data loss:
 *
 * - nothing younger than a day is removed: an upload in flight belongs to a
 *   question that has not been stored yet, and a clock-skewed store must not make
 *   a fresh object look abandoned;
 * - the sweep walks away without deleting anything when the message table is
 *   larger than it is willing to read, because a reference set that is merely
 *   incomplete would make every live attachment look like an orphan.
 */
import { attachmentIdsOf, readAttachmentId, type AttachmentStore } from "./attachments.ts"

const KEY_PREFIX = "ai/"

/** Younger objects are left alone; see the header. */
export const SWEEP_MIN_AGE_MS = 24 * 60 * 60 * 1000

/** Above this many turns the sweep refuses to run rather than guess. */
export const SWEEP_MAX_ENTRIES = 50_000

const LIST_PAGE = 500
const DELETE_CHUNK = 20

export type AttachmentSweep = {
  /** Objects looked at. */
  scanned: number
  /** Objects removed because nothing referred to them. */
  deleted: number
  /** Objects kept: still referenced, too new, or not this code's to judge. */
  kept: number
  /** True when the sweep gave up because the table was too large to scan. */
  skipped: boolean
}

export async function sweepOrphanAttachments(
  db: D1Database,
  store: AttachmentStore,
  options: { now?: number; minAgeMs?: number; maxEntries?: number } = {}
): Promise<AttachmentSweep> {
  const now = options.now ?? Date.now()
  const minAge = options.minAgeMs ?? SWEEP_MIN_AGE_MS
  const maxEntries = options.maxEntries ?? SWEEP_MAX_ENTRIES

  // One row past the ceiling is enough to know the reference set would be partial.
  const rows = await db.prepare("SELECT entry FROM ai_messages LIMIT ?").bind(maxEntries + 1).all<{ entry: string }>()
  const stored = rows.results ?? []
  if (stored.length > maxEntries) return { scanned: 0, deleted: 0, kept: 0, skipped: true }

  const parsed: Record<string, unknown>[] = []
  for (const row of stored) {
    try {
      const value: unknown = JSON.parse(row.entry)
      if (typeof value === "object" && value !== null) parsed.push(value as Record<string, unknown>)
    } catch {
      // A corrupt row cannot name an attachment; the rest of the table still can.
    }
  }
  const referenced = new Set(attachmentIdsOf(parsed))

  const orphans: string[] = []
  let scanned = 0
  let kept = 0
  let cursor: string | undefined
  do {
    const page = await store.list({ prefix: KEY_PREFIX, cursor, limit: LIST_PAGE })
    for (const object of page.objects) {
      scanned += 1
      const id = readAttachmentId(object.key.slice(KEY_PREFIX.length))
      if (!id) {
        kept += 1
        continue
      }
      if (referenced.has(id)) {
        kept += 1
        continue
      }
      const uploaded = object.uploaded?.getTime()
      if (uploaded !== undefined && now - uploaded < minAge) {
        kept += 1
        continue
      }
      orphans.push(object.key)
    }
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)

  for (let index = 0; index < orphans.length; index += DELETE_CHUNK) {
    await Promise.all(orphans.slice(index, index + DELETE_CHUNK).map((key) => store.delete(key)))
  }

  return { scanned, deleted: orphans.length, kept, skipped: false }
}
