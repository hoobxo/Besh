import { SSH_MSG_USERAUTH_FAILURE, SSH_MSG_USERAUTH_INFO_REQUEST } from "./types.ts"
import { SSHAuth } from "./auth.ts"
import type { KeyboardInteractiveChallenge } from "./auth-password.ts"

export class AuthProtocolError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "AuthProtocolError"
  }
}

export type AuthFailure = { methods: string[]; partialSuccess: boolean }

/** RFC 4252 §5.1: byte 51, name-list, then the partial-success boolean. */
export function readAuthFailure(payload: Uint8Array): AuthFailure {
  if (payload[0] !== SSH_MSG_USERAUTH_FAILURE || payload.length < 6) {
    throw new AuthProtocolError("Malformed USERAUTH_FAILURE header")
  }
  const length = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(1, false)
  // Require the final boolean and consume exactly one packet, not a truncated list or
  // unparsed suffix. Subarray inputs must respect their own byte offset and length.
  if (length !== payload.length - 6) throw new AuthProtocolError("Malformed USERAUTH_FAILURE length")
  const names = payload.subarray(5, 5 + length)
  if (names.some((byte) => byte < 0x21 || byte > 0x7e)) {
    throw new AuthProtocolError("Malformed USERAUTH_FAILURE name-list")
  }
  const methods = length === 0 ? [] : new TextDecoder().decode(names).split(",")
  if (methods.some((method) => method.length === 0)) {
    throw new AuthProtocolError("Malformed USERAUTH_FAILURE name-list")
  }
  // RFC 4251: senders use 0/1; receivers interpret any nonzero boolean as true.
  return { methods, partialSuccess: payload[5 + length] !== 0 }
}

/**
 * The authentication conversation, separated from the connection so it can be exercised
 * against real byte sequences.
 *
 * A server may answer a request with prompts before it decides. A client that stops
 * reading after its own request waits forever for a verdict that already depends on its
 * answer, so this loop is not an optimisation — it is the difference between working and
 * hanging.
 */
export type AuthConversation = {
  receive: () => Promise<Uint8Array>
  send: (payload: Uint8Array) => Promise<void>
  /** Answers one challenge. Absent means this method cannot answer prompts. */
  answer?: (challenge: KeyboardInteractiveChallenge) => string[]
}

/**
 * Waits for USERAUTH_SUCCESS or USERAUTH_FAILURE, answering prompts in between.
 *
 * Returns the verdict payload itself, because a failure carries the methods that may
 * still succeed and the caller needs them.
 */
export async function awaitAuthVerdict(conversation: AuthConversation): Promise<Uint8Array> {
  for (;;) {
    const payload = await conversation.receive()
    const type = payload[0]
    // IGNORE, DEBUG and EXT_INFO are legal between the request and the verdict.
    if (type === 2 || type === 4 || type === 7) continue
    if (type === 1) throw new Error("The SSH server disconnected during authentication")
    if (type === SSH_MSG_USERAUTH_INFO_REQUEST) {
      if (!conversation.answer) {
        throw new Error("The SSH server asked for interactive input during a method that does not answer prompts")
      }
      const challenge = SSHAuth.parseKeyboardInteractiveChallenge(payload)
      await conversation.send(SSHAuth.buildKeyboardInteractiveResponse(conversation.answer(challenge)))
      continue
    }
    if (type !== 52 && type !== 51) {
      throw new Error(`Unexpected authentication reply: message ${type}`)
    }
    return payload
  }
}

/**
 * Whether a rejection means "that method is not available here".
 *
 * Only then is retrying with keyboard-interactive useful. When the failure still lists
 * "password", the password was wrong: trying again would double the failed attempts the
 * server counts against the account, which is how people get locked out.
 */
export function shouldTryKeyboardInteractive(methods: readonly string[], partialSuccess = false): boolean {
  return !partialSuccess && methods.includes("keyboard-interactive") && !methods.includes("password")
}

/**
 * Why an authentication attempt failed.
 *
 * A server that keeps listing the method means the secret was wrong. A server that stops
 * listing it means the method is not available there — a wrong password and a server that
 * only accepts keys look identical unless the offered list is read, and the fix is
 * different for each.
 */
export function authFailureReason(
  attempted: string,
  offered: readonly string[]
): "method-not-offered" | "credentials-rejected" {
  if (offered.length === 0) return "credentials-rejected"
  return offered.includes(attempted) ? "credentials-rejected" : "method-not-offered"
}
