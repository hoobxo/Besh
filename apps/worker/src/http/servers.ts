/**
 * Server inventory endpoints.
 *
 * Every handler assumes the caller was already authenticated by `requireAdmin`.
 * Validation happens before anything is stored: a target that fails the public
 * address policy is rejected, so the inventory can never contain a host the
 * Worker would refuse to dial.
 */
import type { ErrorCode } from "@besh/contracts"

import { readCredentialKey } from "../domain/credential-key.ts"
import { forgetServerHistory } from "../domain/ai-history.ts"
import type { AttachmentBucket } from "../domain/attachments.ts"
import { CredentialError, sealCredential } from "../domain/credentials.ts"
import {
  ServerStoreError,
  deleteServer,
  getServerPublic,
  insertServer,
  listServers,
  updateServer,
} from "../domain/server-store.ts"
import { TargetRejectedError, resolvePublicTarget, type AddressResolver } from "../domain/target.ts"
import * as serverStore from "../domain/server-store.ts"
import { jsonError } from "./auth.ts"
import { json } from "./response.ts"

export type ServerEnv = {
  DB: D1Database
  /** Base64 of a 32-byte AES-256 key. In production this is a Worker secret. */
  CREDENTIAL_KEY: string
  CREDENTIAL_KEY_VERSION?: string
  /** Where the assistant's images live; absent only in tests that never touch them. */
  ATTACHMENTS?: AttachmentBucket
}

export type ServerDeps = {
  resolve: AddressResolver
  now?: () => number
  newId?: () => string
}

const NAME_LIMIT = 120
const USERNAME_LIMIT = 128
const SECRET_LIMIT = 128 * 1024

export async function handleListServers(env: ServerEnv): Promise<Response> {
  return json({ servers: await listServers(env.DB) })
}

export async function handleCreateServer(
  request: Request,
  env: ServerEnv,
  deps: ServerDeps
): Promise<Response> {
  const parsed = await readServerBody(request)
  if ("response" in parsed) return parsed.response
  const body = parsed.body

  const target = await validateTarget(body, env, deps)
  if ("response" in target) return target.response

  const id = body.id ?? deps.newId?.() ?? crypto.randomUUID()
  const now = (deps.now ?? Date.now)()
  const sealed = await seal(env, body.credential, { serverId: id, kind: body.authMethod })
  if ("response" in sealed) return sealed.response

  try {
    const server = await insertServer(env.DB, {
      id,
      name: body.name,
      host: target.host,
      port: body.port,
      username: body.username,
      authMethod: body.authMethod,
      groupId: body.groupId,
      credential: sealed.sealed,
      now,
    })
    return json({ server }, 201)
  } catch (error) {
    if (error instanceof ServerStoreError) return jsonError("INVALID_REQUEST", error.message, 400)
    throw error
  }
}

export async function handleUpdateServer(
  request: Request,
  env: ServerEnv,
  id: string,
  deps: ServerDeps
): Promise<Response> {
  const existing = await getServerPublic(env.DB, id)
  if (!existing) return jsonError("NOT_FOUND", "Server not found", 404)

  const parsed = await readServerBody(request, { requireCredential: false })
  if ("response" in parsed) return parsed.response
  const body = parsed.body

  const target = await validateTarget(body, env, deps)
  if ("response" in target) return target.response

  let credential
  if (body.credential !== undefined && body.credential.length > 0) {
    const sealed = await seal(env, body.credential, { serverId: id, kind: body.authMethod })
    if ("response" in sealed) return sealed.response
    credential = sealed.sealed
  }

  try {
    const server = await updateServer(env.DB, id, {
      name: body.name,
      host: target.host,
      port: body.port,
      username: body.username,
      authMethod: body.authMethod,
      groupId: body.groupId,
      credential,
      expectedVersion: body.version,
      now: (deps.now ?? Date.now)(),
    })
    return json({ server })
  } catch (error) {
    if (error instanceof ServerStoreError) {
      const message = error.message
      if (message.includes("changed elsewhere")) return jsonError("INVALID_REQUEST", message, 409)
      // Switching authentication without a replacement secret would leave a row whose
      // stored envelope no longer matches how it would be opened.
      if (message.includes("authentication method")) return jsonError("INVALID_REQUEST", message, 400)
      return jsonError("NOT_FOUND", message, 404)
    }
    throw error
  }
}

export async function handleDeleteServer(env: ServerEnv, id: string): Promise<Response> {
  const removed = await deleteServer(env.DB, id)
  if (!removed) return jsonError("NOT_FOUND", "Server not found", 404)
  // The history outlives the server row unless it is dropped here: it has no
  // foreign key, so it would stay stored, unreachable, and its images would look
  // referenced forever. Failing this must not undo a delete the user asked for, so
  // a problem is logged and the request still succeeds — the rows that survive keep
  // pointing at their images, so nothing is half-removed.
  if (env.ATTACHMENTS) {
    try {
      await forgetServerHistory(env.DB, env.ATTACHMENTS, id)
    } catch (error) {
      console.error("server history purge failed", error)
    }
  }
  return json({ deleted: true })
}

// -------------------------------------------------------------------------- helpers

type AuthMethod = "password" | "publickey"

type ServerBody = {
  id?: string
  name: string
  host: string
  port: number
  username: string
  authMethod: AuthMethod
  groupId: string | null
  credential: string
  version?: number
}

type Parsed = { body: ServerBody } | { response: Response }

async function readServerBody(request: Request, options: { requireCredential?: boolean } = {}): Promise<Parsed> {
  const requireCredential = options.requireCredential ?? true
  let raw: unknown
  try {
    raw = await request.json()
  } catch {
    return { response: jsonError("INVALID_REQUEST", "Expected a JSON body", 400) }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { response: jsonError("INVALID_REQUEST", "Expected a JSON object", 400) }
  }
  const value = raw as Record<string, unknown>

  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (name.length === 0 || name.length > NAME_LIMIT) {
    return { response: jsonError("INVALID_REQUEST", `Name must be 1-${NAME_LIMIT} characters`, 400) }
  }

  const host = typeof value.host === "string" ? value.host.trim() : ""
  if (host.length === 0) return { response: jsonError("INVALID_REQUEST", "Host is required", 400) }

  const port = typeof value.port === "number" ? value.port : Number(value.port ?? 22)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return { response: jsonError("INVALID_REQUEST", "Port must be between 1 and 65535", 400) }
  }

  const username = typeof value.username === "string" ? value.username.trim() : ""
  if (username.length === 0 || username.length > USERNAME_LIMIT || /[\0\r\n]/.test(username)) {
    return { response: jsonError("INVALID_REQUEST", "Invalid SSH username", 400) }
  }

  const authMethod = value.authMethod
  if (authMethod !== "password" && authMethod !== "publickey") {
    return { response: jsonError("INVALID_REQUEST", "authMethod must be password or publickey", 400) }
  }

  const credential = typeof value.credential === "string" ? value.credential : ""
  if (requireCredential && credential.length === 0) {
    return { response: jsonError("INVALID_REQUEST", "A credential is required", 400) }
  }
  if (credential.length > SECRET_LIMIT) {
    return { response: jsonError("INVALID_REQUEST", "Credential is too large", 400) }
  }

  const groupId = typeof value.groupId === "string" && value.groupId.length > 0 ? value.groupId : null
  const version = typeof value.version === "number" ? value.version : undefined
  const id = typeof value.id === "string" && value.id.length > 0 ? value.id : undefined

  return { body: { id, name, host, port, username, authMethod, groupId, credential, version } }
}

async function validateTarget(
  body: ServerBody,
  env: ServerEnv,
  deps: ServerDeps
): Promise<{ host: string } | { response: Response }> {
  try {
    await resolvePublicTarget(body.host, { resolve: deps.resolve })
    void env
    return { host: body.host }
  } catch (error) {
    if (error instanceof TargetRejectedError) {
      // The actionable message is the reason, not the raw hostname.
      return { response: jsonError("TARGET_REJECTED", `Target rejected: ${error.reason}`, 400) }
    }
    throw error
  }
}

async function seal(
  env: ServerEnv,
  secret: string,
  options: { serverId: string; kind: AuthMethod }
): Promise<{ sealed: Awaited<ReturnType<typeof sealCredential>> } | { response: Response }> {
  if (secret.length === 0) return { response: jsonError("INVALID_REQUEST", "A credential is required", 400) }
  try {
    const sealed = await sealCredential(readKey(env), secret, {
      serverId: options.serverId,
      kind: options.kind === "publickey" ? "privateKey" : "password",
      keyVersion: readKeyVersion(env),
    })
    return { sealed }
  } catch (error) {
    if (error instanceof CredentialError) return { response: jsonError("INTERNAL", error.message, 500) }
    throw error
  }
}

function readKey(env: ServerEnv): Uint8Array {
  const key = readCredentialKey(env)
  if (key) return key
  throw new CredentialError(
    env.CREDENTIAL_KEY ? "CREDENTIAL_KEY must decode to 32 bytes" : "CREDENTIAL_KEY is not configured"
  )
}

function readKeyVersion(env: ServerEnv): number {
  const parsed = Number(env.CREDENTIAL_KEY_VERSION ?? "1")
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 1
}

export type { ErrorCode }

/**
 * Records a host key the administrator has just confirmed.
 *
 * Only ever called from the dialog that shows both fingerprints side by side: the
 * value is what the server presented in this connection attempt, and writing it is the
 * consent that the automatic check refuses to give.
 */
export async function handleTrustHostKey(request: Request, env: ServerEnv, id: string): Promise<Response> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("INVALID_REQUEST", "Expected a JSON body", 400)
  }
  const fingerprint = (body as { fingerprint?: unknown } | null)?.fingerprint
  if (typeof fingerprint !== "string" || !fingerprint.startsWith("SHA256:")) {
    return jsonError("INVALID_REQUEST", "A SHA256 fingerprint is required", 400)
  }
  if (!(await getServerPublic(env.DB, id))) return jsonError("NOT_FOUND", "Server not found", 404)
  await serverStore.recordTrust(env.DB, id, fingerprint, Date.now())
  return Response.json({ ok: true })
}
