/** Deny framing without changing the application's script, style or connection policy. */
export function withFramingProtection(response: Response): Response {
  // Upgrades carry runtime-owned WebSocket state and must never be reconstructed.
  if (response.status === 101) return response

  const headers = new Headers(response.headers)
  const framingPolicy = "frame-ancestors 'none'"
  // A separate CSP policy preserves any existing directives; all policies apply.
  if (headers.get("Content-Security-Policy") !== framingPolicy) {
    headers.append("Content-Security-Policy", framingPolicy)
  }
  headers.set("X-Frame-Options", "DENY")
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
