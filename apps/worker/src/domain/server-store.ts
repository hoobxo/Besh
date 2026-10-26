/**
 * Server inventory persistence.
 *
 * Credentials are stored only as sealed envelopes and are never selected into a
 * public shape: `listServers` reads the envelope, `toPublic` drops it. A caller
 * that needs the secret must ask for it explicitly.
 */
import type { SealedCredential } from "./credentials.ts"

export type AuthMethod = "password" | "publickey"

/** What the API may return. No credential material, ever. */
export type PublicServer = {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  groupId: string | null
  fingerprint: string | null
  /** Reported by the host during a session; null until it has been seen. */
  os: string | null
  trustedAt: number | null
  version: number
  createdAt: number
  updatedAt: number
}

type ServerRecord = {
  id: string
  name: string
  host: string
  port: number
  username: string
  auth_method: AuthMethod
  group_id: string | null
  credential: string
  fingerprint: string | null
  os: string | null
  trusted_at: number | null
  version: number
  created_at: number
  updated_at: number
}

const COLUMNS =
  "id, name, host, port, username, auth_method, group_id, credential, fingerprint, os, trusted_at, version, created_at, updated_at"

export class ServerStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ServerStoreError"
  }
}

export async function listServers(db: D1Database): Promise<PublicServer[]> {
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM servers ORDER BY created_at ASC`).all<ServerRecord>()
  return results.map(toPublic)
}

export async function getServerPublic(db: D1Database, id: string): Promise<PublicServer | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`).bind(id).first<ServerRecord>()
  return row ? toPublic(row) : null
}

/** The only way to reach a secret: explicit, by id, and never used in a DTO. */
export async function getServerSecret(
  db: D1Database,
  id: string
): Promise<{ server: PublicServer; credential: SealedCredential } | null> {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM servers WHERE id = ?`).bind(id).first<ServerRecord>()
  if (!row) return null
  return { server: toPublic(row), credential: parseSealed(row.credential) }
}

export async function insertServer(
  db: D1Database,
  input: {
    id: string
    name: string
    host: string
    port: number
    username: string
    authMethod: AuthMethod
    groupId: string | null
    credential: SealedCredential
    now: number
  }
): Promise<PublicServer> {
  await db
    .prepare(
      `INSERT INTO servers (id, name, host, port, username, auth_method, group_id, credential, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    )
    .bind(
      input.id,
      input.name,
      input.host,
      input.port,
      input.username,
      input.authMethod,
      input.groupId,
      JSON.stringify(input.credential),
      input.now,
      input.now
    )
    .run()
  return (await getServerPublic(db, input.id))!
}

/**
 * Updates a server.
 *
 * `credential` is optional: omitting it keeps the stored secret, which is what the
 * UI sends when the administrator edits the name and leaves the password blank.
 * The version guard makes concurrent edits fail loudly instead of silently
 * overwriting one another.
 */
export async function updateServer(
  db: D1Database,
  id: string,
  input: {
    name: string
    host: string
    port: number
    username: string
    authMethod: AuthMethod
    groupId: string | null
    credential?: SealedCredential
    expectedVersion?: number
    now: number
  }
): Promise<PublicServer> {
  const existing = await db
    .prepare("SELECT credential, version, auth_method FROM servers WHERE id = ?")
    .bind(id)
    .first<{ credential: string; version: number; auth_method: AuthMethod }>()
  if (!existing) throw new ServerStoreError("Server not found")
  if (input.expectedVersion !== undefined && existing.version !== input.expectedVersion) {
    throw new ServerStoreError("This server was changed elsewhere; reload before saving")
  }
  // The envelope is bound to the credential kind, and the kind is derived from the
  // authentication method. Keeping a password envelope on a row that now says
  // publickey would leave a server nothing can decrypt, so the switch has to carry
  // a replacement secret.
  if (input.credential === undefined && input.authMethod !== existing.auth_method) {
    throw new ServerStoreError("A new credential is required when the authentication method changes")
  }

  const credential = input.credential ? JSON.stringify(input.credential) : existing.credential
  // The version the read above saw has to be part of the write, or two edits that
  // both read version N would both pass the check and the later one would silently
  // overwrite the earlier.
  const updated = await db
    .prepare(
      `UPDATE servers
       SET name = ?, host = ?, port = ?, username = ?, auth_method = ?, group_id = ?, credential = ?,
           version = version + 1, updated_at = ?
       WHERE id = ? AND version = ?`
    )
    .bind(
      input.name,
      input.host,
      input.port,
      input.username,
      input.authMethod,
      input.groupId,
      credential,
      input.now,
      id,
      existing.version
    )
    .run()
  if (updated.meta.changes !== 1) {
    const still = await db.prepare("SELECT id FROM servers WHERE id = ?").bind(id).first<{ id: string }>()
    if (!still) throw new ServerStoreError("Server not found")
    throw new ServerStoreError("This server was changed elsewhere; reload before saving")
  }

  return (await getServerPublic(db, id))!
}

export async function deleteServer(db: D1Database, id: string): Promise<boolean> {
  const result = await db.prepare("DELETE FROM servers WHERE id = ?").bind(id).run()
  return result.meta.changes > 0
}

/** Records the host key the administrator accepted, so later changes are visible. */
export async function recordTrust(db: D1Database, id: string, fingerprint: string, now: number): Promise<void> {
  await db
    .prepare("UPDATE servers SET fingerprint = ?, trusted_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
    .bind(fingerprint, now, now, id)
    .run()
}

function toPublic(row: ServerRecord): PublicServer {
  return {
    id: row.id,
    name: row.name,
    host: row.host,
    port: row.port,
    username: row.username,
    authMethod: row.auth_method,
    groupId: row.group_id,
    fingerprint: row.fingerprint,
    os: row.os ?? null,
    trustedAt: row.trusted_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function parseSealed(value: string): SealedCredential {
  const parsed = JSON.parse(value) as SealedCredential
  if (!parsed || typeof parsed !== "object" || typeof parsed.data !== "string" || typeof parsed.iv !== "string") {
    throw new ServerStoreError("Stored credential envelope is malformed")
  }
  return parsed
}

/**
 * Records the operating system a host reported.
 *
 * Called from the session object once the metrics collector has read
 * /etc/os-release. Only the first useful answer is kept: a host does not usually
 * change distribution, and rewriting it on every poll would be a write per 15s.
 */
export async function recordServerOs(db: D1Database, id: string, os: string): Promise<void> {
  const trimmed = os.trim().slice(0, 60)
  if (trimmed.length === 0) return
  await db
    .prepare("UPDATE servers SET os = ? WHERE id = ? AND (os IS NULL OR os <> ?)")
    .bind(trimmed, id, trimmed)
    .run()
}
