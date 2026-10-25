import { PROTOCOL_VERSION } from "@besh/contracts"
import { withFramingProtection } from "./http/security-headers.ts"

import {
  handleBootstrap,
  handleBootstrapStatus,
  handleLogin,
  handleLogout,
  handleSession,
  isSameOrigin,
  jsonError,
  requireAdmin,
} from "./http/auth.ts"
import {
  handleCreateServer,
  handleDeleteServer,
  handleTrustHostKey,
  handleListServers,
  handleUpdateServer,
  type ServerDeps,
} from "./http/servers.ts"
import { dohResolver } from "./platform/dns.ts"
import { handleCreateSession, handleTerminal } from "./http/sessions.ts"
import { handleGetSettings, handleListModels, handlePutSettings, handleTurnstileConfig } from "./http/settings.ts"
import { handleChangePassword } from "./http/password.ts"
import { handleDeleteAttachment, handleReadAttachment, handleUploadAttachment } from "./http/attachments.ts"
import type { AttachmentStore } from "./domain/attachments.ts"
import { sweepOrphanAttachments } from "./domain/attachment-gc.ts"
import {
  handleCreateGroup,
  handleDeleteGroup,
  handleListGroups,
  handleRenameGroup,
} from "./http/groups.ts"
export { SessionOwner } from "./do/session.ts"

export type Env = {
  DB: D1Database
  ASSETS: Fetcher
  SESSIONS: DurableObjectNamespace
  TICKET_SECRET: string
  /** Base64 32-byte AES key for sealed credentials; a Worker secret in production. */
  CREDENTIAL_KEY: string
  CREDENTIAL_KEY_VERSION?: string
  /** AI attachment bytes; only ids travel over the session socket. */
  ATTACHMENTS: AttachmentStore
  /** Overridable for tests; production uses DNS over HTTPS. */
  RESOLVE?: ServerDeps["resolve"]
}

/**
 * Besh worker entry point.
 *
 * HTTP carries what the session socket must not: authentication, servers, settings,
 * attachments and the ticket that opens a terminal. Unknown paths are refused with a
 * stable error code rather than falling through to the asset binding.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === "/api/health") {
      if (request.method !== "GET") return jsonError("INVALID_REQUEST", "Method not allowed", 405)
      return Response.json(
        { service: "besh", protocolVersion: PROTOCOL_VERSION, ssh: "not-wired-to-http" },
        { headers: { "Cache-Control": "no-store" } }
      )
    }

    if (!url.pathname.startsWith("/api/")) {
      // Everything that is not an API call is the SPA. Delegating keeps routing
      // and caching in the platform instead of reimplementing static serving.
      return withFramingProtection(await env.ASSETS.fetch(request))
    }

    // State-changing requests must come from the same origin.
    if (request.method !== "GET" && request.method !== "HEAD" && !isSameOrigin(request)) {
      return jsonError("FORBIDDEN", "Cross-origin request rejected", 403)
    }

    const handled = await route(request, env, url)
    return handled ?? jsonError("NOT_FOUND", "Unknown endpoint", 404)
  },
  /**
   * Daily sweep of attachments no stored turn points at.
   *
   * Runs off the request path through `waitUntil`, so a slow bucket listing never
   * delays a user, and a failure here is logged rather than retried into a loop.
   */
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      sweepOrphanAttachments(env.DB, env.ATTACHMENTS)
        .then((sweep) =>
          console.log(
            `attachment sweep: scanned ${sweep.scanned}, deleted ${sweep.deleted}, kept ${sweep.kept}, skipped ${sweep.skipped}`
          )
        )
        .catch((error: unknown) => console.error("attachment sweep failed", error))
    )
  },
} satisfies ExportedHandler<Env>

async function route(request: Request, env: Env, url: URL): Promise<Response | null> {
  switch (url.pathname) {
    case "/api/auth/bootstrap":
      return request.method === "GET" ? await handleBootstrapStatus(request, env) : await handleBootstrap(request, env)
    case "/api/auth/login":
      return await handleLogin(request, env)
    case "/api/auth/logout":
      return await handleLogout(request, env)
    case "/api/auth/password": {
      const denied = await requireAdmin(request, env)
      if (denied) return denied
      return await handleChangePassword(request, env)
    }
    case "/api/auth/session":
      return await handleSession(request, env)
  }

  // Everything below touches the inventory and needs a live session.
  if (url.pathname === "/api/servers" || url.pathname.startsWith("/api/servers/")) {
    const denied = await requireAdmin(request, env)
    if (denied) return denied

    const deps: ServerDeps = { resolve: env.RESOLVE ?? dohResolver }
    const id = url.pathname.startsWith("/api/servers/") ? url.pathname.slice("/api/servers/".length) : null

    if (url.pathname === "/api/servers") {
      if (request.method === "GET") return await handleListServers(env)
      if (request.method === "POST") return await handleCreateServer(request, env, deps)
      return jsonError("INVALID_REQUEST", "Method not allowed", 405)
    }
    // A host-key confirmation sits below a server, so it must be recognised before the
    // id guard rejects the extra segment as an unknown endpoint.
    if (url.pathname.endsWith("/host-key") && request.method === "POST") {
      const trustId = url.pathname.slice("/api/servers/".length, -"/host-key".length)
      if (!trustId || trustId.includes("/")) return jsonError("NOT_FOUND", "Unknown endpoint", 404)
      return await handleTrustHostKey(request, env, trustId)
    }

    if (!id || id.includes("/")) return jsonError("NOT_FOUND", "Unknown endpoint", 404)
    if (request.method === "GET") {
      const { getServerPublic } = await import("./domain/server-store.ts")
      const server = await getServerPublic(env.DB, id)
      return server ? Response.json({ server }) : jsonError("NOT_FOUND", "Server not found", 404)
    }
    if (request.method === "PATCH" || request.method === "PUT") return await handleUpdateServer(request, env, id, deps)
    if (request.method === "DELETE") return await handleDeleteServer(env, id)
    return jsonError("INVALID_REQUEST", "Method not allowed", 405)
  }

  if (url.pathname === "/api/auth/turnstile") {
    // No session by design: this is what the login form asks before it can render.
    if (request.method !== "GET") return jsonError("INVALID_REQUEST", "Method not allowed", 405)
    return await handleTurnstileConfig(env)
  }

  if (url.pathname === "/api/attachments" || url.pathname.startsWith("/api/attachments/")) {
    const denied = await requireAdmin(request, env)
    if (denied) return denied

    if (url.pathname === "/api/attachments") {
      if (request.method !== "POST") return jsonError("INVALID_REQUEST", "Method not allowed", 405)
      return await handleUploadAttachment(request, env, url)
    }
    const attachmentId = url.pathname.slice("/api/attachments/".length)
    if (request.method === "GET") return await handleReadAttachment(env, attachmentId)
    if (request.method !== "DELETE") return jsonError("INVALID_REQUEST", "Method not allowed", 405)
    return await handleDeleteAttachment(env, attachmentId)
  }

  if (url.pathname === "/api/settings/ai/models") {
    const denied = await requireAdmin(request, env)
    if (denied) return denied
    if (request.method !== "GET") return jsonError("INVALID_REQUEST", "Method not allowed", 405)
    return await handleListModels(env)
  }

  if (url.pathname === "/api/settings") {
    const denied = await requireAdmin(request, env)
    if (denied) return denied
    if (request.method === "GET") return await handleGetSettings(env)
    if (request.method === "PUT" || request.method === "PATCH") return await handlePutSettings(request, env)
    return jsonError("INVALID_REQUEST", "Method not allowed", 405)
  }

  if (url.pathname === "/api/server-groups" || url.pathname.startsWith("/api/server-groups/")) {
    const denied = await requireAdmin(request, env)
    if (denied) return denied

    const groupId = url.pathname.startsWith("/api/server-groups/")
      ? url.pathname.slice("/api/server-groups/".length)
      : null

    if (!groupId) {
      if (request.method === "GET") return await handleListGroups(env)
      if (request.method === "POST") return await handleCreateGroup(request, env)
      return jsonError("INVALID_REQUEST", "Method not allowed", 405)
    }
    if (groupId.includes("/")) return jsonError("NOT_FOUND", "Unknown endpoint", 404)
    if (request.method === "PATCH" || request.method === "PUT") return await handleRenameGroup(request, env, groupId)
    if (request.method === "DELETE") return await handleDeleteGroup(env, groupId)
    return jsonError("INVALID_REQUEST", "Method not allowed", 405)
  }

  if (url.pathname === "/api/sessions") {
    const denied = await requireAdmin(request, env)
    if (denied) return denied
    if (request.method !== "POST") return jsonError("INVALID_REQUEST", "Method not allowed", 405)
    return await handleCreateSession(request, env)
  }

  const terminal = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/terminal$/.exec(url.pathname)
  if (terminal?.[1]) {
    const denied = await requireAdmin(request, env)
    if (denied) return denied
    return await handleTerminal(request, env, terminal[1], url)
  }

  return null
}
