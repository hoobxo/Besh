/**
 * Persistence for the administrator and their sessions.
 *
 * Every query is prepared: D1 has no query builder, and string interpolation in
 * SQL is how injection happens. The repository takes a `D1Database` so tests can
 * run the same SQL against a real SQLite engine.
 */
import type { PasswordRecord } from "./auth.ts"

export type AdminRow = PasswordRecord & { username: string; createdAt: number; updatedAt: number }

export class StoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StoreError"
  }
}

type AdminRecord = {
  username: string
  password_hash: string
  salt: string
  iterations: number
  created_at: number
  updated_at: number
}

export async function getAdmin(db: D1Database): Promise<AdminRow | null> {
  const row = await db
    .prepare("SELECT username, password_hash, salt, iterations, created_at, updated_at FROM admin WHERE id = 1")
    .first<AdminRecord>()
  if (!row) return null
  return {
    username: row.username,
    hash: row.password_hash,
    salt: row.salt,
    iterations: row.iterations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

/** Creates the single administrator. Fails if one already exists. */
export async function createAdmin(
  db: D1Database,
  record: PasswordRecord & { username: string },
  now = Date.now()
): Promise<void> {
  const existing = await db.prepare("SELECT id FROM admin WHERE id = 1").first<{ id: number }>()
  if (existing) throw new StoreError("An administrator account already exists")

  await db
    .prepare(
      "INSERT INTO admin (id, username, password_hash, salt, iterations, created_at, updated_at) VALUES (1, ?, ?, ?, ?, ?, ?)"
    )
    .bind(record.username, record.hash, record.salt, record.iterations, now, now)
    .run()
}

export async function updateAdminPassword(
  db: D1Database,
  record: PasswordRecord,
  now = Date.now()
): Promise<void> {
  const result = await db
    .prepare("UPDATE admin SET password_hash = ?, salt = ?, iterations = ?, updated_at = ? WHERE id = 1")
    .bind(record.hash, record.salt, record.iterations, now)
    .run()
  if (result.meta.changes === 0) throw new StoreError("There is no administrator to update")
  // Any password change invalidates every existing session.
  await db.prepare("DELETE FROM admin_sessions").run()
}

export async function insertSession(
  db: D1Database,
  session: { hash: string; createdAt: number; expiresAt: number }
): Promise<void> {
  await db
    .prepare("INSERT INTO admin_sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
    .bind(session.hash, session.createdAt, session.expiresAt)
    .run()
}

/** Returns the token hash when a live, unexpired session exists. */
export async function findLiveSession(db: D1Database, hash: string, now = Date.now()): Promise<string | null> {
  const row = await db
    .prepare("SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, now)
    .first<{ token_hash: string }>()
  return row?.token_hash ?? null
}

export async function deleteSession(db: D1Database, hash: string): Promise<void> {
  await db.prepare("DELETE FROM admin_sessions WHERE token_hash = ?").bind(hash).run()
}

export async function pruneExpiredSessions(db: D1Database, now = Date.now()): Promise<number> {
  const result = await db.prepare("DELETE FROM admin_sessions WHERE expires_at <= ?").bind(now).run()
  return result.meta.changes
}
