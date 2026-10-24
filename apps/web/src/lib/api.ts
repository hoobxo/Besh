/**
 * Typed access to the Besh worker API.
 *
 * Everything is same-origin and cookie-based, so no token is ever stored in
 * JavaScript. Errors carry the worker's stable code so the UI can translate them.
 */

import type { AiErrorCode, ErrorCode } from "@besh/contracts"

export type { AiErrorCode, ErrorCode }

export class ApiError extends Error {
  readonly code: ErrorCode
  readonly status: number

  constructor(code: ErrorCode, message: string, status: number) {
    super(message)
    this.name = "ApiError"
    this.code = code
    this.status = status
  }
}

/** What the assistant has cost, in the provider's own token counts. */
export type TokenTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  requests: number
}

export type Permission = "readonly" | "confirm" | "semi-auto"

export type ReasoningEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max"

/** Generation settings the administrator declares for the chosen model. */
type ModelParams = {
  contextWindow: number | null
  maxOutput: number | null
  inputs: { text: true; image: boolean }
  effort: ReasoningEffort
}


type AiProvider = {
  configured: boolean
  baseUrl: string
  model: string
  hasKey: boolean
  params: ModelParams
}

export type Group = {
  id: string
  name: string
  sortOrder: number
  serverCount: number
}

export type Server = {
  id: string
  name: string
  host: string
  port: number
  username: string
  authMethod: "password" | "publickey"
  groupId: string | null
  fingerprint: string | null
  /** The distribution the host reported, once a session has seen it. */
  os: string | null
  version: number
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  })
  const text = await response.text()
  if (!response.ok) {
    let code: ErrorCode = "INTERNAL"
    let message = text || response.statusText
    try {
      const parsed = JSON.parse(text) as { error?: { code?: ErrorCode; message?: string } }
      if (parsed.error?.code) code = parsed.error.code
      if (parsed.error?.message) message = parsed.error.message
    } catch {
      // A non-JSON error body keeps the generic code.
    }
    throw new ApiError(code, message, response.status)
  }
  return text.length > 0 ? (JSON.parse(text) as T) : (undefined as T)
}

export const api = {
  async session(): Promise<boolean> {
    try {
      await request<{ authenticated: boolean }>("/api/auth/session")
      return true
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) return false
      throw error
    }
  },

  async bootstrapRequired(): Promise<boolean> {
    const body = await request<{ required: boolean }>("/api/auth/bootstrap")
    return body.required
  },

  bootstrap(username: string, password: string): Promise<{ authenticated: boolean }> {
    return request("/api/auth/bootstrap", { method: "POST", body: JSON.stringify({ username, password }) })
  },

  login(username: string, password: string, turnstileToken?: string): Promise<{ authenticated: boolean }> {
    return request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password, turnstileToken }),
    })
  },

  changePassword(currentPassword: string, newPassword: string): Promise<unknown> {
    return request("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    })
  },

  logout(): Promise<unknown> {
    return request("/api/auth/logout", { method: "POST" })
  },

  async settings(): Promise<{
    aiPermission: Permission
    aiConfigured: boolean
    aiDailyTokenBudget: number
    aiProvider: AiProvider
    turnstile: TurnstileState
  }> {
    return await request("/api/settings")
  },

  saveSettings(input: {
    aiPermission?: Permission
    aiDailyTokenBudget?: number
    aiProvider?: { baseUrl: string; model: string; apiKey?: string; params?: unknown }
    turnstile?: { enabled?: boolean; siteKey?: string; secret?: string }
  }): Promise<{
    aiPermission: Permission
    aiConfigured: boolean
    aiDailyTokenBudget: number
    aiProvider: AiProvider
    turnstile: TurnstileState
  }> {
    return request("/api/settings", { method: "PUT", body: JSON.stringify(input) })
  },

  async groups(): Promise<Group[]> {
    const body = await request<{ groups: Group[] }>("/api/server-groups")
    return body.groups
  },

  createGroup(name: string): Promise<{ group: Group }> {
    return request("/api/server-groups", { method: "POST", body: JSON.stringify({ name }) })
  },

  renameGroup(id: string, name: string): Promise<unknown> {
    return request(`/api/server-groups/${id}`, { method: "PATCH", body: JSON.stringify({ name }) })
  },

  deleteGroup(id: string): Promise<unknown> {
    return request(`/api/server-groups/${id}`, { method: "DELETE" })
  },

  async servers(): Promise<Server[]> {
    const body = await request<{ servers: Server[] }>("/api/servers")
    return body.servers
  },

  updateServer(id: string, input: {
    name: string
    host: string
    port: number
    username: string
    authMethod: "password" | "publickey"
    credential: string
    groupId: string | null
    version: number
  }): Promise<{ server: Server }> {
    return request(`/api/servers/${id}`, { method: "PATCH", body: JSON.stringify(input) })
  },

  createServer(input: {
    name: string
    host: string
    port: number
    username: string
    authMethod: "password" | "publickey"
    credential: string
    groupId: string | null
  }): Promise<{ server: Server }> {
    return request("/api/servers", { method: "POST", body: JSON.stringify(input) })
  },

  deleteServer(id: string): Promise<unknown> {
    return request(`/api/servers/${id}`, { method: "DELETE" })
  },

  createSession(serverId: string): Promise<{ sessionId: string; ticket: string }> {
    return request("/api/sessions", { method: "POST", body: JSON.stringify({ serverId }) })
  },
}

export type SftpEntry = {
  name: string
  path: string
  kind: "directory" | "file" | "symlink" | "other"
  size?: number
  mode?: number
  /** Seconds since the epoch, as SFTP v3 reports it. */
  modifiedAt?: number
}

export type FsReply = {
  entries?: SftpEntry[]
  entry?: SftpEntry
  data?: string
  uploadId?: string
  /** What a recursive delete removed, so the result can be stated. */
  removed?: { files: number; dirs: number }
}

/** Extra fields a file operation may carry; only the ones it needs are set. */
export type FsRequest = {
  to?: string
  data?: string
  maxBytes?: number
  offset?: number
  uploadId?: string
}

type HostKeyChange = { stored: string; presented: string }

export type TerminalMessage =
  | { type: "ready" }
  | { type: "data"; data: string }
  | { type: "exit"; code: number | null }
  | { type: "closed" }
  | { type: "error"; code: ErrorCode; message: string; hostKey?: HostKeyChange; methods?: string[] }
  | ({ type: "fs.result"; id: number } & FsReply)
  | { type: "fs.error"; id: number; message: string; code?: number }
  | { type: "ai.delta"; id: number; text: string }
  | { type: "ai.reply"; id: number; content: string; proposals: unknown[] }
  | { type: "ai.result"; id: number; command: string; output: string; exitCode: number | null }
  | { type: "ai.rejected"; id: number; proposalId: string }
  | { type: "ai.error"; id: number; code: AiErrorCode; message: string }
  | { type: "ai.messages"; id: number; entries: Array<{ kind: string; [key: string]: unknown }> }
  | { type: "ai.cleared"; id: number }
  | { type: "ai.canceled"; id: number }
  | { type: "ai.usage"; conversation: TokenTotals; day: TokenTotals; budget: number }
  | {
      type: "ai.conversationList"
      id: number
      current: string
      conversations: Array<{ id: string; title: string; updatedAt: number }>
    }
  | { type: "metrics.result"; id: number; metrics: unknown }
  | { type: "metrics.error"; id: number; message: string }

export function terminalSocket(sessionId: string, ticket: string): WebSocket {
  const scheme = location.protocol === "https:" ? "wss" : "ws"
  return new WebSocket(`${scheme}://${location.host}/api/sessions/${sessionId}/terminal?ticket=${ticket}`)
}

/** The models the configured endpoint offers, fetched with the stored key. */
export type AttachmentRef = { id: string; name: string; mime: string }

/**
 * Uploads attachment bytes.
 *
 * The bytes never travel over the session socket: the answer carries an id and the
 * worker reads the object once, while it builds the turn.
 */
export async function uploadAttachment(blob: Blob, name: string): Promise<AttachmentRef> {
  return await request<AttachmentRef>(`/api/attachments?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  })
}

/** Drops an uploaded file the user removed before sending it. */
export async function deleteAttachment(id: string): Promise<void> {
  await request<{ ok: boolean }>(`/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" })
}

export async function listAiModels(): Promise<string[]> {
  const body = await request<{ models: string[] }>("/api/settings/ai/models")
  return body.models
}

type TurnstileConfig = { enabled: boolean; siteKey: string }

/** What the settings dialog is allowed to see: never the secret itself. */
type TurnstileState = { enabled: boolean; siteKey: string; hasSecret: boolean }

/** Asked by the login form before a session exists; deliberately unauthenticated. */
export async function turnstileConfig(): Promise<TurnstileConfig> {
  return request<TurnstileConfig>("/api/auth/turnstile")
}

/** Confirms a changed host key, after the administrator has seen both fingerprints. */
export async function trustHostKey(serverId: string, fingerprint: string): Promise<void> {
  await request(`/api/servers/${serverId}/host-key`, {
    method: "POST",
    body: JSON.stringify({ fingerprint }),
  })
}
