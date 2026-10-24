/**
 * Decoding of the `CREDENTIAL_KEY` secret.
 *
 * Callers differ in how they react to a bad key (HTTP routes render a 500, the
 * Durable Object throws), so this module only decodes and validates; each site
 * keeps its own failure policy.
 */

/** The secret as bytes, or `null` when it is missing, not base64 or not 32 bytes. */
export function readCredentialKey(env: { CREDENTIAL_KEY?: string }): Uint8Array | null {
  const raw = env.CREDENTIAL_KEY
  if (typeof raw !== "string" || raw.length === 0) return null
  try {
    const bytes = Uint8Array.from(atob(raw), (char) => char.charCodeAt(0))
    return bytes.length === 32 ? bytes : null
  } catch {
    return null
  }
}
