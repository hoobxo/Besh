/**
 * Shared JSON responses for the HTTP routes.
 *
 * Every response is `no-store`: these endpoints carry session and credential
 * state, so an intermediary cache must never keep a copy.
 */

export function json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } })
}
