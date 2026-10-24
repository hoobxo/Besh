/**
 * Session endpoints.
 *
 * `POST /api/sessions` mints a ticket; `GET /api/sessions/:id/terminal` spends it
 * by upgrading to a WebSocket and handing the request to the session object.
 * The browser only ever learns a session id and a one-minute ticket.
 */
import type { ErrorCode } from "@besh/contracts"

import { getServerPublic } from "../domain/server-store.ts"
import { TicketError, issueTicket, verifyTicket } from "../domain/ticket.ts"
import { readSessionBinding } from "../domain/session-binding.ts"
import { jsonError } from "./auth.ts"

export type SessionHttpEnv = {
  DB: D1Database
  TICKET_SECRET: string
  SESSIONS: DurableObjectNamespace
}

export async function handleCreateSession(request: Request, env: SessionHttpEnv): Promise<Response> {
  const binding = await readSessionBinding(env.DB, request)
  if (!binding) return jsonError("AUTH_REQUIRED", "Session expired or invalid", 401)

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return jsonError("INVALID_REQUEST", "Expected a JSON body", 400)
  }
  const serverId = (body as { serverId?: unknown } | null)?.serverId
  if (typeof serverId !== "string" || serverId.length === 0) {
    return jsonError("INVALID_REQUEST", "serverId is required", 400)
  }

  const server = await getServerPublic(env.DB, serverId)
  if (!server) return jsonError("NOT_FOUND", "Server not found", 404)

  const id = env.SESSIONS.newUniqueId()
  const sessionId = id.toString()

  let ticket: string
  let expiresAt: number
  try {
    const issued = await issueTicket(env.TICKET_SECRET, { sessionId, serverId, binding })
    ticket = issued.ticket
    expiresAt = issued.expiresAt
  } catch (error) {
    if (error instanceof TicketError) return jsonError("INTERNAL", "Session tickets are not configured", 500)
    throw error
  }

  // The credential and the address are never part of this response.
  return Response.json(
    { sessionId, ticket, expiresAt, server: { id: server.id, name: server.name } },
    { status: 201, headers: { "Cache-Control": "no-store" } }
  )
}

export async function handleTerminal(
  request: Request,
  env: SessionHttpEnv,
  sessionId: string,
  url: URL
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return errorFor("INVALID_REQUEST", "WebSocket upgrade required", 426)
  }

  const ticket = url.searchParams.get("ticket") ?? ""
  const payload = await verifyTicket(env.TICKET_SECRET, ticket).catch(() => null)
  if (!payload) return errorFor("TICKET_INVALID", "Invalid or expired session ticket", 401)
  if (payload.sid !== sessionId) return errorFor("TICKET_INVALID", "Ticket belongs to another session", 401)

  const binding = await readSessionBinding(env.DB, request)
  if (!binding) return errorFor("AUTH_REQUIRED", "Session expired or invalid", 401)
  if (binding.sessionHash !== payload.auth.sessionHash || binding.expiresAt !== payload.auth.expiresAt) {
    return errorFor("TICKET_INVALID", "Ticket belongs to another login session", 401)
  }

  let id: DurableObjectId
  try {
    id = env.SESSIONS.idFromString(sessionId)
  } catch {
    return errorFor("TICKET_INVALID", "Invalid session identifier", 401)
  }

  // Forward the original request: constructing a new one drops the WebSocket
  // upgrade marker, which the object needs to accept the socket. The signed
  // ticket already names the server, so no extra header is required.
  const stub = env.SESSIONS.get(id)
  return await stub.fetch(request)
}

function errorFor(code: ErrorCode, message: string, status: number): Response {
  return jsonError(code, message, status)
}
