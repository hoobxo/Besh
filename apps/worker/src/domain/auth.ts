/**
 * Administrator authentication.
 *
 * Password verification uses PBKDF2-SHA-256 with a per-installation salt and an
 * iteration count stored next to the hash, so the cost can be raised later
 * without invalidating existing credentials.
 *
 * Session tokens are random and are stored only as SHA-256 digests: a dump of the
 * session table must not yield anything a browser could present.
 */

import { base64ToBytes, bytesToBase64, bytesToBase64Url, equalBytes, randomBytes, toBytes } from "./bytes.ts"

/**
 * Cloudflare Workers rejects PBKDF2 above 100,000 iterations, so this is a
 * platform ceiling rather than a preference. It is far below the OWASP number;
 * the compensating controls are a single account, a strong password and the
 * absence of any endpoint that would let an attacker grind offline.
 */
export const PBKDF2_ITERATIONS = 100_000
export const SESSION_TTL_MS = 1000 * 60 * 60 * 12
export const SESSION_COOKIE = "besh_session"

export type PasswordRecord = {
  hash: string
  salt: string
  iterations: number
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthError"
  }
}

export async function hashPassword(
  password: string,
  options: { iterations?: number; salt?: Uint8Array } = {}
): Promise<PasswordRecord> {
  if (password.length < 8) throw new AuthError("Password must be at least 8 characters")
  if (password.length > 1024) throw new AuthError("Password is unreasonably long")

  const iterations = options.iterations ?? PBKDF2_ITERATIONS
  const salt = options.salt ?? randomBytes(16)
  const derived = await derive(password, salt, iterations)
  return { hash: bytesToBase64(derived), salt: bytesToBase64(salt), iterations }
}

/**
 * Verifies a password against a stored record.
 *
 * Returns false rather than throwing for a wrong password: the caller decides how
 * to respond, and a throwing API invites leaking the difference between "no such
 * user" and "wrong password".
 */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  if (password.length === 0 || password.length > 1024) return false
  if (!Number.isInteger(record.iterations) || record.iterations < 1000 || record.iterations > 5_000_000) {
    return false
  }
  let derived: Uint8Array
  try {
    derived = await derive(password, base64ToBytes(record.salt), record.iterations)
  } catch {
    return false
  }
  return equalBytes(derived, base64ToBytes(record.hash))
}

export type SessionToken = {
  /** The value handed to the browser; never stored. */
  token: string
  /** What the database stores. */
  hash: string
  expiresAt: number
}

export async function createSessionToken(now = Date.now(), ttlMs = SESSION_TTL_MS): Promise<SessionToken> {
  const token = bytesToBase64Url(randomBytes(32))
  return { token, hash: await hashSessionToken(token), expiresAt: now + ttlMs }
}

export async function hashSessionToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", toBytes(new TextEncoder().encode(token)))
  return bytesToBase64Url(new Uint8Array(digest))
}

export function isSessionExpired(expiresAt: number, now = Date.now()): boolean {
  return !Number.isFinite(expiresAt) || expiresAt <= now
}

/** `HttpOnly` is the point: script in the page must never read this value. */
export function buildSessionCookie(token: string, options: { secure: boolean; maxAgeSeconds?: number }): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${options.maxAgeSeconds ?? Math.floor(SESSION_TTL_MS / 1000)}`,
  ]
  if (options.secure) parts.push("Secure")
  return parts.join("; ")
}

export function clearSessionCookie(options: { secure: boolean }): string {
  const parts = [`${SESSION_COOKIE}=`, "Path=/", "HttpOnly", "SameSite=Strict", "Max-Age=0"]
  if (options.secure) parts.push("Secure")
  return parts.join("; ")
}

/** Reads one cookie out of a `Cookie` header without assuming it is last. */
export function readCookie(header: string | null, name = SESSION_COOKIE): string | null {
  if (!header) return null
  for (const part of header.split(";")) {
    const separator = part.indexOf("=")
    if (separator < 0) continue
    if (part.slice(0, separator).trim() !== name) continue
    const value = part.slice(separator + 1).trim()
    return value.length > 0 ? value : null
  }
  return null
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", toBytes(new TextEncoder().encode(password)), "PBKDF2", false, [
    "deriveBits",
  ])
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: toBytes(salt), iterations },
    key,
    256
  )
  return new Uint8Array(bits)
}

/** Length-independent, value-constant comparison of two byte strings. */
