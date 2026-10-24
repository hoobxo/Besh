import { hashSessionToken, readCookie } from "./auth.ts"

/**
 * A revocable HTTP-session identity carried inside a signed SSH ticket.
 * Never put the cookie token here: a ticket may be visible in URL diagnostics.
 */
export const SESSION_BINDING_CHECK_INTERVAL_MS = 15_000

export type SessionBinding = {
  sessionHash: string
  expiresAt: number
}

/** Runtime validation is also required when this object came from signed JSON. */
export function isSessionBinding(value: unknown): value is SessionBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  const binding = value as Record<string, unknown>
  return (
    typeof binding.sessionHash === "string" &&
    /^[A-Za-z0-9_-]{43}$/.test(binding.sessionHash) &&
    typeof binding.expiresAt === "number" &&
    Number.isSafeInteger(binding.expiresAt) &&
    binding.expiresAt > 0
  )
}

type SessionRow = { token_hash: string; expires_at: number }

/**
 * Read the cookie, hash it, and validate the live database session before returning
 * a binding. This is the only HTTP issuance path; a raw cookie is not an identity.
 * Database errors propagate so callers cannot accidentally authorize on outage.
 */
export async function readSessionBinding(
  db: D1Database,
  request: Request,
  now = Date.now()
): Promise<SessionBinding | null> {
  const token = readCookie(request.headers.get("Cookie"))
  if (!token) return null
  const hash = await hashSessionToken(token)
  const row = await db
    .prepare("SELECT token_hash, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(hash, now)
    .first<SessionRow>()
  if (!row) return null
  const binding = { sessionHash: row.token_hash, expiresAt: row.expires_at }
  return isSessionBinding(binding) && binding.sessionHash === hash && binding.expiresAt > now ? binding : null
}

/**
 * Re-check on every WebSocket operation and at least every 15 seconds while idle.
 * Logout removes one row; password changes remove all rows. Both invalidate this
 * check immediately without a new table, registry, or plaintext cookie in the DO.
 * Do not cache a successful answer: an expiry-only cache misses logout/revocation.
 * A database error is thrown, not converted into a successful authorization.
 */
export async function checkSessionBinding(
  db: D1Database,
  binding: SessionBinding,
  now = Date.now()
): Promise<boolean> {
  if (!isSessionBinding(binding) || binding.expiresAt <= now) return false
  const row = await db
    .prepare("SELECT token_hash, expires_at FROM admin_sessions WHERE token_hash = ? AND expires_at > ?")
    .bind(binding.sessionHash, now)
    .first<SessionRow>()
  return !!row && row.token_hash === binding.sessionHash && row.expires_at === binding.expiresAt && row.expires_at > now
}
