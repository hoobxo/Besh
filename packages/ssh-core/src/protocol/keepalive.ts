import { SSH_MSG_GLOBAL_REQUEST } from "./types.ts"
import { writeUint32 } from "./utils.ts"

/**
 * The request OpenSSH's own client sends to keep an idle connection alive.
 *
 * A terminal is the kind of connection people leave open. Without traffic, a NAT, a
 * load balancer or the server's `ClientAliveInterval` can decide it is dead and drop
 * it — and the shell, with whatever was running in it, dies with the socket. The
 * name is deliberately OpenSSH's: servers recognise it by convention and answer
 * nothing, which is why no reply is requested.
 */
export const KEEPALIVE_REQUEST_NAME = "keepalive@openssh.com"

export function buildKeepaliveRequest(): Uint8Array {
  const name = new TextEncoder().encode(KEEPALIVE_REQUEST_NAME)
  const payload = new Uint8Array(1 + 4 + name.length + 1)
  payload[0] = SSH_MSG_GLOBAL_REQUEST
  writeUint32(payload, 1, name.length)
  payload.set(name, 5)
  // want-reply = false: a server that does not know this request must not answer.
  payload[5 + name.length] = 0
  return payload
}
