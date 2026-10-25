/**
 * Password change for the single administrator.
 *
 * Requires the current password: a stolen session cookie must not be enough to
 * take the account over. Every other session is dropped on success, and the
 * caller keeps working because a fresh session is issued with the response.
 */
import {
  AuthError,
  buildSessionCookie,
  createSessionToken,
  hashPassword,
  verifyPassword,
} from "../domain/auth.ts"
import { getAdmin, insertSession, updateAdminPassword } from "../domain/admin-store.ts"
import { jsonError } from "./auth.ts"

export type PasswordEnv = { DB: D1Database }

export async function handleChangePassword(request: Request, env: PasswordEnv): Promise<Response> {
  if (request.method !== "POST") return jsonError("INVALID_REQUEST", "Method not allowed", 405)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("INVALID_REQUEST", "Expected a JSON body", 400)
  }

  const { currentPassword, newPassword } = (body ?? {}) as Record<string, unknown>
  if (typeof currentPassword !== "string" || typeof newPassword !== "string") {
    return jsonError("INVALID_REQUEST", "Both passwords are required", 400)
  }
  if (newPassword.length < 8 || newPassword.length > 1024) {
    return jsonError("INVALID_REQUEST", "Password must be at least 8 characters", 400)
  }
  if (newPassword === currentPassword) {
    return jsonError("INVALID_REQUEST", "The new password must differ from the current one", 400)
  }

  const admin = await getAdmin(env.DB)
  if (!admin) return jsonError("AUTH_REQUIRED", "Not signed in", 401)

  const ok = await verifyPassword(currentPassword, admin)
  if (!ok) return jsonError("AUTH_REQUIRED", "The current password is incorrect", 401)

  let record
  try {
    record = await hashPassword(newPassword)
  } catch (error) {
    if (error instanceof AuthError) return jsonError("INVALID_REQUEST", error.message, 400)
    return jsonError("INTERNAL", "Password hashing is unavailable in this runtime", 500)
  }

  const changed = await updateAdminPassword(env.DB, record, admin)
  if (!changed) return jsonError("AUTH_REQUIRED", "The current password is incorrect", 401)

  // Issue a replacement only while this request's new credential is still current.
  // A later password change must also invalidate this in-flight response.
  const now = Date.now()
  const session = await createSessionToken(now)
  const inserted = await insertSession(env.DB, { hash: session.hash, createdAt: now, expiresAt: session.expiresAt }, record)
  if (!inserted) return jsonError("AUTH_REQUIRED", "Session expired or invalid", 401)

  const secure = new URL(request.url).protocol === "https:"
  return Response.json(
    { changed: true },
    {
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": buildSessionCookie(session.token, {
          secure,
          maxAgeSeconds: Math.floor((session.expiresAt - now) / 1000),
        }),
      },
    }
  )
}

