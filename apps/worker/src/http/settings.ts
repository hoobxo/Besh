/**
 * Settings endpoints.
 *
 * Only the AI permission exists today. The GET is what the client uses to render
 * the choice; a PUT is validated against the same list the decision code uses, so
 * an unknown value cannot be stored and later fall back silently.
 */
import { PERMISSIONS, SettingsError, isPermission, readSettings, writePermission } from "../domain/settings-store.ts"
import { describeProvider, readProviderConfig, resolveProvider, writeProviderConfig, ProviderError } from "../domain/ai-provider.ts"
import { describeTurnstile, publicTurnstile, readTurnstileConfig, writeTurnstileConfig, TurnstileError } from "../domain/turnstile.ts"
import { readCredentialKey } from "../domain/credential-key.ts"
import { jsonError } from "./auth.ts"

export type SettingsEnv = {
  DB: D1Database
  CREDENTIAL_KEY?: string
  AI_BASE_URL?: string
  AI_API_KEY?: string
  AI_MODEL?: string
}

/** Only whether it is configured: the key and endpoint never leave the worker. */
function aiConfigured(env: SettingsEnv): boolean {
  return Boolean(env.AI_BASE_URL && env.AI_API_KEY && env.AI_MODEL)
}

export async function handleGetSettings(env: SettingsEnv): Promise<Response> {
  const provider = describeProvider(await readProviderConfig(env.DB))
  const turnstile = describeTurnstile(await readTurnstileConfig(env.DB))
  return Response.json(
    { ...(await readSettings(env.DB, aiConfigured(env) || provider.configured)), aiProvider: provider, turnstile },
    { headers: { "Cache-Control": "no-store" } }
  )
}

export async function handlePutSettings(request: Request, env: SettingsEnv): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("INVALID_REQUEST", "Expected a JSON body", 400)
  }

  const parsed = (body ?? {}) as {
    aiPermission?: unknown
    aiProvider?: { baseUrl?: unknown; model?: unknown; apiKey?: unknown; params?: unknown }
    turnstile?: { enabled?: unknown; siteKey?: unknown; secret?: unknown }
  }

  // the provider and the permission can be saved independently
  if (parsed.aiProvider) {
    const baseUrl = typeof parsed.aiProvider.baseUrl === "string" ? parsed.aiProvider.baseUrl : ""
    const model = typeof parsed.aiProvider.model === "string" ? parsed.aiProvider.model : ""
    const apiKey = typeof parsed.aiProvider.apiKey === "string" ? parsed.aiProvider.apiKey : ""
    const key = readCredentialKey(env)
    if (!key) return jsonError("INTERNAL", "Credential key is not configured", 500)
    try {
      // params is undefined when the caller only changed the key, which keeps the
      // stored settings instead of resetting them.
      await writeProviderConfig(env.DB, { baseUrl, model, apiKey, params: parsed.aiProvider.params }, key)
    } catch (error) {
      if (error instanceof ProviderError) return jsonError("INVALID_REQUEST", error.message, 400)
      throw error
    }
  }

  if (parsed.aiPermission !== undefined) {
    if (!isPermission(parsed.aiPermission)) {
      return jsonError("INVALID_REQUEST", `aiPermission must be one of ${PERMISSIONS.join(", ")}`, 400)
    }
    try {
      await writePermission(env.DB, parsed.aiPermission)
    } catch (error) {
      if (error instanceof SettingsError) return jsonError("INVALID_REQUEST", error.message, 400)
      throw error
    }
  }

  if (parsed.turnstile) {
    const key = readCredentialKey(env)
    if (!key) return jsonError("INTERNAL", "Credential key is not configured", 500)
    try {
      await writeTurnstileConfig(env.DB, parsed.turnstile, key)
    } catch (error) {
      if (error instanceof TurnstileError) return jsonError("INVALID_REQUEST", error.message, 400)
      throw error
    }
  }

  const provider = describeProvider(await readProviderConfig(env.DB))
  const turnstile = describeTurnstile(await readTurnstileConfig(env.DB))
  return Response.json(
    { ...(await readSettings(env.DB, aiConfigured(env) || provider.configured)), aiProvider: provider, turnstile },
    { headers: { "Cache-Control": "no-store" } }
  )
}

/** The 32-byte credential key from the environment, or null when absent. */
/**
 * The models the configured endpoint offers.
 *
 * Fetched server-side because the request needs the sealed key; the browser learns
 * the list and nothing else. A provider that does not implement /models answers 404,
 * which is reported as such rather than as a failure to connect.
 */
export async function handleListModels(env: SettingsEnv): Promise<Response> {
  const key = readCredentialKey(env)
  if (!key) return jsonError("INTERNAL", "Credential key is not configured", 500)

  const provider = await resolveProvider(env.DB, key)
  if (!provider) return jsonError("INVALID_REQUEST", "Model provider is not configured", 400)

  let response: Response
  try {
    response = await fetch(`${provider.baseUrl.replace(/\/+$/, "")}/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}` },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return jsonError("INTERNAL", "无法连接模型服务", 502)
  }

  if (!response.ok) {
    return jsonError("INTERNAL", `模型服务返回 ${response.status}`, response.status === 404 ? 404 : 502)
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return jsonError("INTERNAL", "模型服务返回了无法解析的响应", 502)
  }

  const data = (body as { data?: Array<{ id?: unknown }> }).data
  const models = Array.isArray(data)
    ? data
        .map((item) => (typeof item?.id === "string" ? item.id : null))
        .filter((id): id is string => id !== null)
        .sort((a, b) => a.localeCompare(b))
    : []

  return Response.json({ models }, { headers: { "Cache-Control": "no-store" } })
}

/**
 * What the login page needs to render the challenge, and nothing more.
 *
 * Public on purpose: the page has no session yet, and this is the same information
 * the widget would be given in the HTML.
 */
export async function handleTurnstileConfig(env: SettingsEnv): Promise<Response> {
  const config = publicTurnstile(await readTurnstileConfig(env.DB))
  return Response.json(config, { headers: { "Cache-Control": "no-store" } })
}
