/**
 * Cloudflare Turnstile in front of the login form.
 *
 * Counting failed attempts locally only slows an attacker down; Turnstile decides
 * whether a request came from a browser at all. The secret is sealed with the same
 * envelope as credentials and never leaves the worker, so the login page only ever
 * learns whether the challenge is on and which site key to render.
 */
import { openCredential, sealCredential, type SealedCredential } from "./credentials.ts"

export type TurnstileConfig = {
  enabled: boolean
  siteKey: string
  secretSealed?: SealedCredential
}

/** What the login page may know. Never the secret. */
export type TurnstilePublic = { enabled: boolean; siteKey: string }

const SETTING_KEY = "turnstile"
const AAD_ID = "turnstile"
const AAD_KIND = "turnstileSecret" as const

export class TurnstileError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "TurnstileError"
  }
}

export async function readTurnstileConfig(db: D1Database): Promise<TurnstileConfig> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTING_KEY).first<{ value: string }>()
  if (!row) return { enabled: false, siteKey: "" }
  try {
    const parsed = JSON.parse(row.value) as Partial<TurnstileConfig>
    return {
      enabled: parsed.enabled === true,
      siteKey: typeof parsed.siteKey === "string" ? parsed.siteKey : "",
      secretSealed: parsed.secretSealed,
    }
  } catch {
    // A corrupt row must fail closed: an unreadable challenge is no challenge.
    return { enabled: false, siteKey: "" }
  }
}

export async function writeTurnstileConfig(
  db: D1Database,
  input: { enabled?: unknown; siteKey?: unknown; secret?: unknown },
  credentialKey: Uint8Array,
  now = Date.now()
): Promise<TurnstileConfig> {
  const current = await readTurnstileConfig(db)
  const siteKey = typeof input.siteKey === "string" ? input.siteKey.trim() : current.siteKey
  const enabled = input.enabled === undefined ? current.enabled : input.enabled === true

  let secretSealed = current.secretSealed
  const secret = typeof input.secret === "string" ? input.secret.trim() : ""
  if (secret.length > 0) {
    secretSealed = await sealCredential(credentialKey, secret, { serverId: AAD_ID, kind: AAD_KIND, keyVersion: 1 })
  }

  // Turning it on without both halves would tell the login page to render a challenge
  // the worker cannot verify, which locks the administrator out of their own console.
  if (enabled && (siteKey.length === 0 || !secretSealed)) {
    throw new TurnstileError("Both the site key and the secret key are required to enable Turnstile")
  }

  const next: TurnstileConfig = { enabled, siteKey, secretSealed }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SETTING_KEY, JSON.stringify(next), now)
    .run()
  return next
}

/** On only when it can actually be enforced. */
export function publicTurnstile(config: TurnstileConfig): TurnstilePublic {
  return { enabled: config.enabled && config.siteKey.length > 0 && Boolean(config.secretSealed), siteKey: config.siteKey }
}

export function describeTurnstile(config: TurnstileConfig): {
  enabled: boolean
  siteKey: string
  hasSecret: boolean
} {
  return { enabled: config.enabled, siteKey: config.siteKey, hasSecret: Boolean(config.secretSealed) }
}

/** Opens the sealed secret; only the login path calls this. */
export async function openTurnstileSecret(
  config: TurnstileConfig,
  credentialKey: Uint8Array
): Promise<string | null> {
  if (!config.secretSealed) return null
  try {
    return await openCredential(credentialKey, config.secretSealed, { serverId: AAD_ID, kind: AAD_KIND })
  } catch {
    return null
  }
}

/**
 * Asks Cloudflare whether a token is genuine.
 *
 * Fails closed on every path — a network error, a 5xx or an unreadable body all mean
 * "not verified", because the alternative is a challenge that quietly stops working.
 */
export async function verifyTurnstile(secret: string, token: string, remoteIp?: string): Promise<boolean> {
  if (token.length === 0) return false
  const body = new FormData()
  body.append("secret", secret)
  body.append("response", token)
  if (remoteIp) body.append("remoteip", remoteIp)
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body,
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) return false
    const parsed = (await response.json()) as { success?: unknown }
    return parsed.success === true
  } catch {
    return false
  }
}
