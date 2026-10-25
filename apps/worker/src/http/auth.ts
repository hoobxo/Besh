import type { ApiErrorBody, ErrorCode } from "@besh/contracts"

import {
  AuthError,
  buildSessionCookie,
  clearSessionCookie,
  createSessionToken,
  hashPassword,
  readCookie,
  verifyPassword,
  SESSION_COOKIE,
} from "../domain/auth.ts"
import { StoreError, createAdmin, findLiveSession, getAdmin, insertSession, deleteSession, pruneExpiredSessions } from "../domain/admin-store.ts"
import { hashSessionToken } from "../domain/auth.ts"
import { openTurnstileSecret, publicTurnstile, readTurnstileConfig, verifyTurnstile } from "../domain/turnstile.ts"
import { readCredentialKey } from "../domain/credential-key.ts"
import { json } from "./response.ts"

/**
 * Administrator authentication endpoints.
 *
 * Kept separate from the router so the policy (what a request may do, and on what
 * evidence) is readable on its own.
 */

export type AuthEnv = { DB: D1Database; CREDENTIAL_KEY?: string }

export function jsonError(code: ErrorCode, message: string, status: number): Response {
  const body: ApiErrorBody = { error: { code, message } }
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  })
}

/** Cookie `Secure` follows the request scheme so http://localhost still works. */
function isSecure(request: Request): boolean {
  return new URL(request.url).protocol === "https:"
}

export async function handleLogin(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST") return jsonError("INVALID_REQUEST", "Method not allowed", 405)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("INVALID_REQUEST", "Expected a JSON body", 400)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return jsonError("INVALID_REQUEST", "Expected a JSON object", 400)
  }

  const { username, password } = body as Record<string, unknown>
  if (typeof username !== "string" || typeof password !== "string" || username.length === 0 || password.length === 0) {
    return jsonError("INVALID_REQUEST", "Username and password are required", 400)
  }

  // Before the password is hashed: a request that is not a browser should not cost
  // PBKDF2 time, and the answer must not depend on whether the account exists.
  const gate = await readTurnstileConfig(env.DB)
  const publicGate = publicTurnstile(gate)
  if (publicGate.enabled) {
    const credentialKey = readCredentialKey(env)
    if (!credentialKey) return jsonError("INTERNAL", "Credential key is not configured", 500)
    const secret = await openTurnstileSecret(gate, credentialKey)
    const token = typeof (body as Record<string, unknown>).turnstileToken === "string"
      ? ((body as Record<string, unknown>).turnstileToken as string)
      : ""
    const remoteIp = request.headers.get("CF-Connecting-IP") ?? undefined
    if (!secret || !(await verifyTurnstile(secret, token, remoteIp))) {
      return jsonError("INVALID_REQUEST", "Human verification failed", 400)
    }
  }

  const admin = await getAdmin(env.DB)
  // No account yet, a wrong username and a wrong password must be
  // indistinguishable to the caller: nothing here reveals whether Besh has been
  // set up, or which half of the pair was wrong.
  if (!admin) return jsonError("AUTH_REQUIRED", "Invalid credentials", 401)

  const usernameOk = await sameSecret(username, admin.username)
  // Always run the password check so the timing of a bad username matches a bad
  // password instead of returning immediately.
  const passwordOk = await verifyPassword(password, admin)
  if (!usernameOk || !passwordOk) return jsonError("AUTH_REQUIRED", "Invalid credentials", 401)

  const now = Date.now()
  const session = await createSessionToken(now)
  const inserted = await insertSession(env.DB, { hash: session.hash, createdAt: now, expiresAt: session.expiresAt }, admin)
  if (!inserted) return jsonError("AUTH_REQUIRED", "Invalid credentials", 401)
  // Opportunistic cleanup of dead rows; cheap and keeps the table small.
  await pruneExpiredSessions(env.DB, now)

  return json(
    { authenticated: true, expiresAt: session.expiresAt },
    200,
    {
      "Set-Cookie": buildSessionCookie(session.token, {
        secure: isSecure(request),
        maxAgeSeconds: Math.floor((session.expiresAt - now) / 1000),
      }),
    }
  )
}

/**
 * Whether Besh still needs its first administrator.
 *
 * Public by necessity, so it deliberately reveals nothing but a boolean: not the
 * username, not the hostname, nothing an attacker could build on.
 */
export async function handleBootstrapStatus(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "GET") return jsonError("INVALID_REQUEST", "Method not allowed", 405)

  const admin = await getAdmin(env.DB)
  return json({ required: admin === null })
}

/**
 * Creates the single administrator, once.
 *
 * The window is only open while no account exists; afterwards this answers 403 so
 * a deployed instance cannot be taken over by calling it again. Concurrency is
 * settled by the database: the admin table only ever holds id = 1, so a racing
 * request loses on the primary key rather than creating a second account.
 */
export async function handleBootstrap(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST") return jsonError("INVALID_REQUEST", "Method not allowed", 405)

  const existing = await getAdmin(env.DB)
  if (existing) return jsonError("FORBIDDEN", "Besh is already initialised", 403)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("INVALID_REQUEST", "Expected a JSON body", 400)
  }
  const { username, password } = (body ?? {}) as Record<string, unknown>
  const name = typeof username === "string" ? username.trim() : ""
  if (name.length === 0 || name.length > 64) {
    return jsonError("INVALID_REQUEST", "Username must be 1-64 characters", 400)
  }
  if (typeof password !== "string" || password.length < 8 || password.length > 1024) {
    return jsonError("INVALID_REQUEST", "Password must be at least 8 characters", 400)
  }

  let record
  try {
    record = await hashPassword(password)
  } catch (error) {
    // A rejected password and a broken crypto runtime are different problems and
    // must not share one message; that is what hid the iteration limit.
    if (error instanceof AuthError) return jsonError("INVALID_REQUEST", error.message, 400)
    return jsonError("INTERNAL", "Password hashing is unavailable in this runtime", 500)
  }

  try {
    await createAdmin(env.DB, { ...record, username: name })
  } catch (error) {
    if (error instanceof StoreError) return jsonError("FORBIDDEN", "Besh is already initialised", 403)
    throw error
  }

  // Sign the administrator in straight away: making them retype the password
  // adds nothing after they just chose it.
  return await handleLogin(
    new Request(request.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: name, password }),
    }),
    env
  )
}

export async function handleLogout(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "POST") return jsonError("INVALID_REQUEST", "Method not allowed", 405)

  const token = readCookie(request.headers.get("Cookie"))
  if (token) await deleteSession(env.DB, await hashSessionToken(token))

  return json({ authenticated: false }, 200, {
    "Set-Cookie": clearSessionCookie({ secure: isSecure(request) }),
  })
}

export async function handleSession(request: Request, env: AuthEnv): Promise<Response> {
  if (request.method !== "GET") return jsonError("INVALID_REQUEST", "Method not allowed", 405)

  const token = readCookie(request.headers.get("Cookie"))
  if (!token) return jsonError("AUTH_REQUIRED", "Not signed in", 401)

  const live = await findLiveSession(env.DB, await hashSessionToken(token))
  if (!live) return jsonError("AUTH_REQUIRED", "Session expired or invalid", 401)

  return json({ authenticated: true })
}

/**
 * Guard for every endpoint that touches servers, credentials or sessions.
 *
 * Returns a response to send instead of proceeding, or null when the caller is
 * authenticated. Same-origin is enforced separately for state-changing requests.
 */
export async function requireAdmin(request: Request, env: AuthEnv): Promise<Response | null> {
  const token = readCookie(request.headers.get("Cookie"))
  if (!token) return jsonError("AUTH_REQUIRED", "Not signed in", 401)
  const live = await findLiveSession(env.DB, await hashSessionToken(token))
  if (!live) return jsonError("AUTH_REQUIRED", "Session expired or invalid", 401)
  return null
}

/**
 * Rejects cross-site state changes.
 *
 * SameSite=Strict already blocks the common cases; this catches the rest and
 * keeps the rule explicit rather than implicit in a cookie attribute.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("Origin")
  if (!origin) return true // non-browser clients send no Origin
  return origin === new URL(request.url).origin
}

/** Constant-time comparison of two short secrets (username, tokens). */
async function sameSecret(left: string, right: string): Promise<boolean> {
  if (left.length !== right.length) return false
  let difference = 0
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index)
  }
  return difference === 0
}
