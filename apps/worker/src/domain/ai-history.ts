/**
 * Assistant conversation history, kept per server.
 *
 * The rows hold exactly the entry objects the panel renders, so there is one
 * definition of the wire shape. History is best effort: a failure to record must
 * never break an answer, so callers get a promise they can ignore.
 */
import { forgetAttachments, type AttachmentBucket } from "./attachments.ts"

export type StoredEntry = Record<string, unknown>

const MAX_ENTRIES = 200

/** How many rows are read at a time while a server's history is being dropped. */
const PURGE_BATCH = 200

export async function appendEntry(
  db: D1Database,
  serverId: string,
  conversationId: string,
  entry: StoredEntry,
  now = Date.now()
): Promise<void> {
  await db
    .prepare("INSERT INTO ai_messages (server_id, conversation_id, entry, created_at) VALUES (?, ?, ?, ?)")
    .bind(serverId, conversationId, JSON.stringify(entry), now)
    .run()
  // keep the tail bounded without a separate job
  await db
    .prepare(
      "DELETE FROM ai_messages WHERE server_id = ? AND conversation_id = ? AND id NOT IN (SELECT id FROM ai_messages WHERE server_id = ? AND conversation_id = ? ORDER BY id DESC LIMIT ?)"
    )
    .bind(serverId, conversationId, serverId, conversationId, MAX_ENTRIES)
    .run()
}

export async function listEntries(
  db: D1Database,
  serverId: string,
  conversationId: string
): Promise<StoredEntry[]> {
  const rows = await db
    .prepare("SELECT entry FROM ai_messages WHERE server_id = ? AND conversation_id = ? ORDER BY id ASC")
    .bind(serverId, conversationId)
    .all<{ entry: string }>()
  const entries: StoredEntry[] = []
  for (const row of rows.results ?? []) {
    try {
      entries.push(JSON.parse(row.entry) as StoredEntry)
    } catch {
      // a corrupt row should not poison the whole history
    }
  }
  return entries
}

/** Gives a conversation a title of its own, overriding its first question. */
export async function renameConversation(
  db: D1Database,
  serverId: string,
  conversationId: string,
  title: string,
  now = Date.now()
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_conversations (id, server_id, title, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET title = excluded.title"
    )
    .bind(conversationId, serverId, title.slice(0, 80), now)
    .run()
}

/**
 * A title from the question itself, with no model call.
 *
 * The first clause is what the question is about; the rest is usually framing
 * ("帮我看看…"). A clause shorter than four characters is a fragment such as
 * "1." and says nothing, so the whole first line is used instead.
 */
export function titleFromQuestion(question: string): string {
  const line = question.split(/[\r\n]/)[0].replace(/\s+/g, " ").trim()
  if (line.length === 0) return ""
  const clause = line.split(/[，。！？；、,.!?;]/)[0].trim()
  const text = clause.length >= 4 ? clause : line
  return text.length <= 16 ? text : `${text.slice(0, 16)}…`
}

/**
 * Names a conversation that has no name yet.
 *
 * The suggested title must never replace a name the user chose — the two writes
 * can interleave, so this one loses the race on purpose.
 */
export async function nameIfUntitled(
  db: D1Database,
  serverId: string,
  conversationId: string,
  title: string,
  now = Date.now()
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO ai_conversations (id, server_id, title, created_at) VALUES (?, ?, ?, ?) " +
        "ON CONFLICT(id) DO NOTHING"
    )
    .bind(conversationId, serverId, title.slice(0, 80), now)
    .run()
}

export async function clearHistory(
  db: D1Database,
  serverId: string,
  conversationId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM ai_messages WHERE server_id = ? AND conversation_id = ?")
    .bind(serverId, conversationId)
    .run()
  // the title belonged to the messages that are now gone
  await db
    .prepare("DELETE FROM ai_conversations WHERE server_id = ? AND id = ?")
    .bind(serverId, conversationId)
    .run()
}

export type Conversation = { id: string; title: string; updatedAt: number }

/**
 * Conversations for a server, newest first.
 *
 * The title is the first thing the user asked, which is what the design shows; a
 * thread with no user turn yet is labelled by its id so it is never blank.
 */
export async function listConversations(db: D1Database, serverId: string): Promise<Conversation[]> {
  const rows = await db
    .prepare(
      `SELECT conversation_id AS id,
              MIN(id) AS firstId,
              MAX(created_at) AS updatedAt
         FROM ai_messages
        WHERE server_id = ?
        GROUP BY conversation_id
        ORDER BY MAX(id) DESC`
    )
    .bind(serverId)
    .all<{ id: string; firstId: number; updatedAt: number }>()

  const titles = await db
    .prepare("SELECT id, title FROM ai_conversations WHERE server_id = ?")
    .bind(serverId)
    .all<{ id: string; title: string }>()
  const renamed = new Map((titles.results ?? []).map((row) => [row.id, row.title]))

  const conversations: Conversation[] = []
  for (const row of rows.results ?? []) {
    const first = await db
      .prepare("SELECT entry FROM ai_messages WHERE server_id = ? AND conversation_id = ? ORDER BY id ASC LIMIT 20")
      .bind(serverId, row.id)
      .all<{ entry: string }>()
    let title = ""
    for (const candidate of first.results ?? []) {
      try {
        const entry = JSON.parse(candidate.entry) as StoredEntry
        if (entry.kind === "user" && typeof entry.text === "string") {
          // The same rule as a stored title, so a thread named by its fallback
          // does not look different from one named when the question arrived.
          title = titleFromQuestion(entry.text)
          break
        }
      } catch {
        // skip a corrupt row
      }
    }
    conversations.push({
      id: row.id,
      title: renamed.get(row.id) ?? (title || row.id.slice(0, 8)),
      updatedAt: row.updatedAt,
    })
  }
  return conversations
}

/** Folds a command's outcome into the proposal row that produced it. */
export async function recordOutcome(
  db: D1Database,
  serverId: string,
  proposalId: string,
  outcome: { output: string; exitCode: number | null }
): Promise<void> {
  await db
    .prepare(
      `UPDATE ai_messages
         SET entry = json_set(entry, '$.state', 'approved', '$.output', ?, '$.exitCode', ?)
       WHERE server_id = ? AND json_extract(entry, '$.proposal.id') = ?`
    )
    .bind(outcome.output, outcome.exitCode, serverId, proposalId)
    .run()
}

/**
 * Drops everything a server owns: its conversations, the messages in them, the
 * images those messages point at, and the token totals they accumulated.
 *
 * Nothing here has a foreign key to `servers`, so deleting the server row alone
 * would leave the history stored but unreachable — and because the attachment
 * sweep treats a referenced id as live, it would keep those images forever.
 *
 * The images go before the rows that name them. An image that fails to delete is
 * then left unreferenced, which is exactly what the daily sweep collects; doing it
 * the other way round would leave an id that nothing can find again.
 */
export async function forgetServerHistory(
  db: D1Database,
  bucket: AttachmentBucket,
  serverId: string
): Promise<number> {
  let removed = 0
  for (;;) {
    const rows = await db
      .prepare("SELECT id, entry FROM ai_messages WHERE server_id = ? ORDER BY id LIMIT ?")
      .bind(serverId, PURGE_BATCH)
      .all<{ id: number; entry: string }>()
    const batch = rows.results ?? []
    if (batch.length === 0) break

    const entries: StoredEntry[] = []
    for (const row of batch) {
      try {
        const parsed: unknown = JSON.parse(row.entry)
        // A row that is not an object cannot name an attachment, so it is skipped
        // rather than failing the whole purge.
        if (parsed && typeof parsed === "object") entries.push(parsed as StoredEntry)
      } catch {
        // a corrupt row holds no id worth looking for
      }
    }
    await forgetAttachments(bucket, entries)

    const lastId = batch[batch.length - 1]!.id
    await db.prepare("DELETE FROM ai_messages WHERE server_id = ? AND id <= ?").bind(serverId, lastId).run()
    removed += batch.length
  }

  await db.prepare("DELETE FROM ai_conversations WHERE server_id = ?").bind(serverId).run()
  await db.prepare("DELETE FROM ai_usage WHERE server_id = ?").bind(serverId).run()
  return removed
}
