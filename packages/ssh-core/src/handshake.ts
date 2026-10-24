/**
 * Key exchange for Besh: curve25519-sha256 (RFC 8731) over the extracted
 * protocol primitives.
 *
 * The order is the security contract, not a style choice:
 *   KEXINIT -> ECDH init/reply -> exchange hash -> verify the host signature
 *   -> fingerprint -> trust policy -> (caller derives keys and sends NEWKEYS)
 *
 * Nothing that depends on the server's identity happens before the signature
 * verifies, and the trust decision is asked *after* verification: a policy can
 * only accept a key that the server demonstrably owns.
 */
import {
  HostKeyVerificationError,
  verifyHostKeySignature,
  type VerifiedHostKey,
} from "./host-key.ts"
import { KEXInitBuilder, filterExtInfo, negotiate, parseKEXInit } from "./protocol/kex.ts"
import { Curve25519KeyExchange } from "./protocol/kex-curve25519.ts"
import { SSH_MSG_KEXINIT, SSH_MSG_KEX_ECDH_REPLY } from "./protocol/types.ts"

export type HostKeyDecision = {
  keyType: string
  fingerprint: string
  host: string
  port: number
}

/** Product policy: does this host key match what the user has stored? */
export type HostKeyPolicy = (decision: HostKeyDecision) => Promise<boolean> | boolean

export type KeyExchangeResult = {
  /** `SHA256:...` fingerprint of the host key, already verified. */
  fingerprint: string
  keyType: string
  /** H from the first key exchange; also the SSH session id. */
  exchangeHash: Uint8Array
  sharedSecret: Uint8Array
  /** Negotiated algorithms, needed when keys are derived. */
  algorithms: NegotiatedAlgorithms
  hostKey: VerifiedHostKey
}

export type NegotiatedAlgorithms = {
  kex: string
  hostKey: string
  cipherC2S: string
  cipherS2C: string
  macC2S: string
  macS2C: string
}

export type KeyExchangeChannel = {
  send(payload: Uint8Array): Promise<void>
  receive(): Promise<Uint8Array>
}

export class KeyExchangeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "KeyExchangeError"
  }
}

/**
 * Runs the key exchange and the host key gate.
 *
 * Resolves only when the server proved ownership of its key *and* the policy
 * accepted it. Throws otherwise, leaving the caller to fail the connection.
 */
export async function performKeyExchange(options: {
  channel: KeyExchangeChannel
  clientVersion: string
  serverVersion: string
  /** Absent for a re-exchange: the peer's key is compared with the pinned one instead. */
  hostKeyPolicy?: HostKeyPolicy
  host: string
  port: number
  /**
   * Re-exchange (RFC 4253 section 9) already received the peer's KEXINIT, so it
   * must not wait for a second one. Our own KEXINIT is still sent first.
   */
  serverKexInit?: Uint8Array
  /**
   * Re-exchange this client started: the exact KEXINIT already sent. The exchange
   * hash covers those bytes, so they must not be regenerated.
   */
  clientKexInit?: Uint8Array
  /** Re-exchange: the fingerprint the first exchange pinned. */
  expectedFingerprint?: string
}): Promise<KeyExchangeResult> {
  const { channel, clientVersion, serverVersion, hostKeyPolicy, expectedFingerprint } = options

  const clientKexInit = options.clientKexInit ?? KEXInitBuilder.build()
  if (!options.clientKexInit) await channel.send(clientKexInit)

  const serverKexInit = options.serverKexInit ?? (await expectMessage(channel, SSH_MSG_KEXINIT, "KEXINIT"))
  const clientLists = parseKEXInit(clientKexInit)
  const serverLists = parseKEXInit(serverKexInit)

  const algorithms = negotiateAlgorithms(clientLists, serverLists)
  if (algorithms.kex !== "curve25519-sha256") {
    throw new KeyExchangeError(`Only curve25519-sha256 is implemented, negotiated ${algorithms.kex}`)
  }

  const keyPair = await Curve25519KeyExchange.generateKeyPair()
  const clientRawPublicKey = await Curve25519KeyExchange.exportRawPublicKey(keyPair)
  await channel.send(Curve25519KeyExchange.buildInit(clientRawPublicKey))

  const reply = await expectMessage(channel, SSH_MSG_KEX_ECDH_REPLY, "key exchange reply")
  const { hostKey, serverRawPublicKey, signature } = Curve25519KeyExchange.parseReply(reply)

  const sharedSecret = await Curve25519KeyExchange.computeSharedSecret(keyPair.privateKey, serverRawPublicKey)
  const exchangeHash = await Curve25519KeyExchange.computeExchangeHash(
    clientVersion,
    serverVersion,
    clientKexInit,
    serverKexInit,
    hostKey,
    clientRawPublicKey,
    serverRawPublicKey,
    sharedSecret
  )

  // Verify before anything else looks at the key, and before the policy is asked.
  let verified: VerifiedHostKey
  try {
    verified = await verifyHostKeySignature({
      keyBlob: hostKey,
      signatureBlob: signature,
      exchangeHash,
      negotiatedHostKeyAlgorithm: algorithms.hostKey,
    })
  } catch (error) {
    if (error instanceof HostKeyVerificationError) {
      throw new KeyExchangeError(`Host key verification failed: ${error.message}`)
    }
    throw error
  }

  if (expectedFingerprint !== undefined) {
    // A re-exchange must name the same host key. A different one is exactly the
    // substitution the first exchange was supposed to rule out.
    if (verified.fingerprint !== expectedFingerprint) {
      // Same error the first exchange uses for a key the product refuses: the
      // peer proved ownership, of the wrong key.
      throw new HostKeyRejectedError(verified.fingerprint, verified.keyType)
    }
  } else {
    if (!hostKeyPolicy) throw new KeyExchangeError("A key exchange needs either a host key policy or a pinned fingerprint")
    const accepted = await hostKeyPolicy({
      keyType: verified.keyType,
      fingerprint: verified.fingerprint,
      host: options.host,
      port: options.port,
    })
    if (!accepted) {
      throw new HostKeyRejectedError(verified.fingerprint, verified.keyType)
    }
  }

  return {
    fingerprint: verified.fingerprint,
    keyType: verified.keyType,
    exchangeHash,
    sharedSecret,
    algorithms,
    hostKey: verified,
  }
}

/** The policy declined the key; the caller must fail with HOST_KEY_MISMATCH. */
export class HostKeyRejectedError extends Error {
  readonly fingerprint: string
  readonly keyType: string

  constructor(fingerprint: string, keyType: string) {
    super(`Host key ${fingerprint} was rejected by policy`)
    this.name = "HostKeyRejectedError"
    this.fingerprint = fingerprint
    this.keyType = keyType
  }
}

function negotiateAlgorithms(
  client: ReturnType<typeof parseKEXInit>,
  server: ReturnType<typeof parseKEXInit>
): NegotiatedAlgorithms {
  // `ext-info-c` is a client-side pseudo algorithm; comparing it as a real kex
  // method would either select nothing or pick something the server never offered.
  const kex = negotiate(filterExtInfo(client.kexAlgorithms), filterExtInfo(server.kexAlgorithms), "kex")
  const hostKey = negotiate(client.hostKeyAlgorithms, server.hostKeyAlgorithms, "host key")
  const cipherC2S = negotiate(client.encryptionC2S, server.encryptionC2S, "cipher client-to-server")
  const cipherS2C = negotiate(client.encryptionS2C, server.encryptionS2C, "cipher server-to-client")
  const macC2S = negotiate(client.macC2S, server.macC2S, "MAC client-to-server")
  const macS2C = negotiate(client.macS2C, server.macS2C, "MAC server-to-client")

  // Besh supports no compression; a server insisting on one must be refused
  // rather than silently ignored, because the framing would then differ.
  if (!client.compressionC2S.includes("none") || !server.compressionC2S.includes("none")) {
    throw new KeyExchangeError("Both sides must offer no compression")
  }
  if (!client.compressionS2C.includes("none") || !server.compressionS2C.includes("none")) {
    throw new KeyExchangeError("Both sides must offer no compression")
  }

  return { kex, hostKey, cipherC2S, cipherS2C, macC2S, macS2C }
}

async function expectMessage(
  channel: KeyExchangeChannel,
  expectedType: number,
  label: string
): Promise<Uint8Array> {
  for (;;) {
    const payload = await channel.receive()
    const type = payload[0]
    if (type === undefined) throw new KeyExchangeError(`Empty packet while waiting for ${label}`)
    // Transport-level noise is legal and must not derail the exchange.
    if (type === 2 || type === 4) continue // IGNORE, DEBUG
    if (type === 1) throw new KeyExchangeError(`Server disconnected during the key exchange`)
    if (type === 3) throw new KeyExchangeError("Server reported an unimplemented message")
    if (type !== expectedType) {
      throw new KeyExchangeError(`Expected ${label} (message ${expectedType}), received message ${type}`)
    }
    return payload
  }
}
