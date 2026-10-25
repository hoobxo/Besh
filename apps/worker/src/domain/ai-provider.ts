/**
 * The assistant's model provider, configured from the app rather than the
 * deployment.
 *
 * The endpoint and model name are ordinary settings; the API key is sealed with
 * the same AES-GCM envelope used for SSH credentials, bound to a fixed pseudo-id
 * so a sealed key cannot be lifted into another context. Nothing here ever returns
 * the key to a caller: the only path that opens it is the one that makes the
 * outbound request.
 */
import { DEFAULT_PARAMS, parseModelParams, type ModelParams } from "./ai-params.ts"
import { openCredential, sealCredential, type SealedCredential } from "./credentials.ts"

export type AiProviderConfig = {
  baseUrl: string
  model: string
  keySealed?: SealedCredential
  /** Generation settings for the chosen model; defaults when never configured. */
  params: ModelParams
}

export type AiProviderInput = {
  baseUrl: string
  model: string
  /** Empty means "keep the stored key", so the form never has to resend it. */
  apiKey?: string
  /** Raw from the browser; parsed and clamped before it is stored. */
  params?: unknown
}

export type ResolvedProvider = { baseUrl: string; model: string; apiKey: string; params: ModelParams }

const SETTING_KEY = "ai_provider"
/** AAD binds the sealed key to this purpose; it is not a real server id. */
const AAD_ID = "ai-provider"
const AAD_KIND = "aiApiKey" as const

export class ProviderError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProviderError"
  }
}

/** Normalises a base URL and rejects anything that is not http(s). */
export function normalizeBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "")
  if (trimmed.length === 0) return ""
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    throw new ProviderError("Base URL must be a valid URL")
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ProviderError("Base URL must use http or https")
  }
  return trimmed
}

export async function readProviderConfig(db: D1Database): Promise<AiProviderConfig> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(SETTING_KEY).first<{ value: string }>()
  if (!row) return { baseUrl: "", model: "", params: DEFAULT_PARAMS }
  try {
    const parsed = JSON.parse(row.value) as Partial<AiProviderConfig>
    return {
      baseUrl: typeof parsed.baseUrl === "string" ? parsed.baseUrl : "",
      model: typeof parsed.model === "string" ? parsed.model : "",
      keySealed: parsed.keySealed,
      params: parseModelParams(parsed.params),
    }
  } catch {
    // A corrupt row should behave like "not configured" rather than break settings.
    return { baseUrl: "", model: "", params: DEFAULT_PARAMS }
  }
}

export async function writeProviderConfig(
  db: D1Database,
  input: AiProviderInput,
  credentialKey: Uint8Array,
  now = Date.now()
): Promise<AiProviderConfig> {
  // The model may be empty: credentials have to be saved before the endpoint can be
  // asked which models it offers, and listing models needs no model name.
  const baseUrl = normalizeBaseUrl(input.baseUrl)
  const model = input.model.trim()

  const current = await readProviderConfig(db)
  let keySealed = current.keySealed

  const apiKey = input.apiKey?.trim() ?? ""
  if (apiKey.length > 0) {
    keySealed = await sealCredential(credentialKey, apiKey, {
      serverId: AAD_ID,
      kind: AAD_KIND,
      keyVersion: 1,
    })
  }

  // An absent params field keeps the stored ones, so saving a new key does not
  // silently reset the model's settings.
  const params = input.params === undefined ? current.params : parseModelParams(input.params)
  const next: AiProviderConfig = { baseUrl, model, keySealed, params }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(SETTING_KEY, JSON.stringify(next), now)
    .run()
  return next
}

/** The endpoint and key, which is all that asking for a model list needs. */
export async function resolveProviderEndpoint(
  db: D1Database,
  credentialKey: Uint8Array
): Promise<{ baseUrl: string; apiKey: string } | null> {
  const config = await readProviderConfig(db)
  if (!config.baseUrl || !config.keySealed) return null
  try {
    const apiKey = await openCredential(credentialKey, config.keySealed, {
      serverId: AAD_ID,
      kind: AAD_KIND,
    })
    return { baseUrl: config.baseUrl, apiKey }
  } catch {
    return null
  }
}

/** Opens the sealed key; the only caller is the outbound request path. */
export async function resolveProvider(
  db: D1Database,
  credentialKey: Uint8Array
): Promise<ResolvedProvider | null> {
  const config = await readProviderConfig(db)
  if (!config.baseUrl || !config.model || !config.keySealed) return null
  try {
    const apiKey = await openCredential(credentialKey, config.keySealed, {
      serverId: AAD_ID,
      kind: AAD_KIND,
    })
    return { baseUrl: config.baseUrl, model: config.model, apiKey, params: config.params }
  } catch {
    // A key sealed with a retired CREDENTIAL_KEY cannot be opened; treat the
    // provider as unconfigured and let the administrator re-enter it.
    return null
  }
}

/** What the browser is allowed to know: never the key, never the full URL query. */
export function describeProvider(config: AiProviderConfig): {
  configured: boolean
  baseUrl: string
  model: string
  hasKey: boolean
  params: ModelParams
} {
  return {
    configured: Boolean(config.baseUrl && config.keySealed),
    baseUrl: config.baseUrl,
    model: config.model,
    hasKey: Boolean(config.keySealed),
    params: config.params,
  }
}
