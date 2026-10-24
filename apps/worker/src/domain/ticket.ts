/**
 * Session tickets.
 *
 * A ticket is what lets a browser open a WebSocket without ever holding a
 * credential or a server id list: the Worker mints one short-lived, signed token
 * that names exactly one session, and the Durable Object accepts nothing else.
 *
 * HMAC-SHA-256 over a compact payload, base64url encoded, with a hard 60 second
 * lifetime. The nonce exists so a replayed ticket can be recognised by the
 * session object rather than relying on expiry alone.
 */

import { base64UrlToBytes, bytesToBase64Url, equalText, toBytes } from "./bytes.ts"
import { isSessionBinding, type SessionBinding } from "./session-binding.ts"

export const TICKET_TTL_MS = 60_000

export type TicketPayload = {
  v: 2
  /** Validated, revocable HTTP session; contains a hash, never the cookie. */
  auth: SessionBinding
  /** Session id (Durable Object id string). */
  sid: string
  /** Server row id this session may connect to. */
  srv: string
  exp: number
  nonce: string
}

export class TicketError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TicketError"
  }
}

export async function issueTicket(
  secret: string,
  input: { sessionId: string; serverId: string; binding: SessionBinding },
  now = Date.now()
): Promise<{ ticket: string; expiresAt: number }> {
  if (!Number.isSafeInteger(now) || !isSessionBinding(input.binding) || input.binding.expiresAt <= now) {
    throw new TicketError("A live validated HTTP session binding is required")
  }
  if (!validIdentifier(input.sessionId) || !validIdentifier(input.serverId)) {
    throw new TicketError("Session and server identifiers are required")
  }
  const payload: TicketPayload = {
    v: 2,
    auth: { sessionHash: input.binding.sessionHash, expiresAt: input.binding.expiresAt },
    sid: input.sessionId,
    srv: input.serverId,
    exp: Math.min(now + TICKET_TTL_MS, input.binding.expiresAt),
    nonce: crypto.randomUUID(),
  }
  const encoded = bytesToBase64Url(new TextEncoder().encode(JSON.stringify(payload)))
  const signature = await sign(secret, encoded)
  return { ticket: `${encoded}.${signature}`, expiresAt: payload.exp }
}

/** Returns the payload only when the signature is valid and the ticket is live. */
export async function verifyTicket(
  secret: string,
  ticket: string,
  now = Date.now()
): Promise<TicketPayload | null> {
  const parts = ticket.split(".")
  if (parts.length !== 2) return null
  const [encoded, signature] = parts as [string, string]
  if (encoded.length === 0 || encoded.length > 2048 || signature.length === 0 || signature.length > 128) {
    return null
  }

  const expected = await sign(secret, encoded)
  if (!equalText(expected, signature)) return null

  let value: unknown
  try {
    value = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)))
  } catch {
    return null
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const payload = value as Record<string, unknown>
  // No legacy compatibility: an unbound ticket cannot authorize a revocable socket.
  if (
    payload.v !== 2 ||
    !validIdentifier(payload.sid) ||
    !validIdentifier(payload.srv) ||
    !validIdentifier(payload.nonce) ||
    typeof payload.exp !== "number" ||
    !Number.isSafeInteger(payload.exp) ||
    !isSessionBinding(payload.auth) ||
    !Number.isSafeInteger(now)
  ) {
    return null
  }
  // At the exact deadline the ticket is dead. Signed tickets cannot outlive their
  // HTTP session, and an arbitrarily far-future ticket is never accepted.
  if (payload.exp <= now || payload.exp > now + TICKET_TTL_MS + 5_000) return null
  if (payload.auth.expiresAt <= now || payload.exp > payload.auth.expiresAt) return null
  return payload as TicketPayload
}

function validIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020]/.test(value)
}

async function sign(secret: string, value: string): Promise<string> {
  if (secret.length < 16) throw new TicketError("Ticket secret is too short to be useful")
  const key = await crypto.subtle.importKey(
    "raw",
    toBytes(new TextEncoder().encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  )
  const signature = await crypto.subtle.sign("HMAC", key, toBytes(new TextEncoder().encode(value)))
  return bytesToBase64Url(new Uint8Array(signature))
}
