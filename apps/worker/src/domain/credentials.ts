/**
 * Credential sealing.
 *
 * SSH secrets are stored encrypted, versioned and bound to the record they belong
 * to. The key never leaves Worker secrets, and every envelope carries the fields
 * needed to rotate it later without guessing which key encrypted what.
 *
 * AES-GCM with a random 96-bit IV per seal, and an AAD that binds the ciphertext
 * to one server id, one credential kind and one schema version — so moving a
 * ciphertext to another server's row makes it fail to open instead of silently
 * authenticating somewhere else.
 */

import { base64ToBytes, bytesToBase64, toBytes } from "./bytes.ts"

export type CredentialKind = "password" | "privateKey" | "aiApiKey" | "turnstileSecret"

export type SealedCredential = {
  /** Envelope schema version, not the key version. */
  v: 1
  /** Which encryption key sealed this, so rotation is possible. */
  keyVersion: number
  /** Base64 IV. */
  iv: string
  /** Base64 ciphertext, tag included (AES-GCM output). */
  data: string
}

export type CredentialAad = {
  serverId: string
  kind: CredentialKind
  keyVersion: number
}

export class CredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CredentialError"
  }
}

const IV_BYTES = 12
const SCHEMA_VERSION = 1

export async function sealCredential(
  key: Uint8Array,
  plaintext: string,
  aad: CredentialAad
): Promise<SealedCredential> {
  if (key.length !== 32) throw new CredentialError("Credential key must be 32 bytes (AES-256)")
  if (plaintext.length === 0) throw new CredentialError("Refusing to seal an empty secret")

  const iv = new Uint8Array(IV_BYTES)
  crypto.getRandomValues(iv)
  const cryptoKey = await importKey(key, ["encrypt"])
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: toBytes(iv), additionalData: toBytes(encodeAad(aad)) },
      cryptoKey,
      toBytes(new TextEncoder().encode(plaintext))
    )
  )

  return {
    v: SCHEMA_VERSION,
    keyVersion: aad.keyVersion,
    iv: bytesToBase64(iv),
    data: bytesToBase64(sealed),
  }
}

export async function openCredential(
  key: Uint8Array,
  sealed: SealedCredential,
  aad: { serverId: string; kind: CredentialKind }
): Promise<string> {
  if (sealed.v !== SCHEMA_VERSION) throw new CredentialError(`Unsupported credential envelope v${sealed.v}`)
  if (sealed.keyVersion !== aadVersion(sealed)) {
    throw new CredentialError("Credential key version does not match the envelope")
  }
  if (key.length !== 32) throw new CredentialError("Credential key must be 32 bytes (AES-256)")

  const iv = base64ToBytes(sealed.iv)
  if (iv.length !== IV_BYTES) throw new CredentialError("Credential IV has the wrong length")

  const cryptoKey = await importKey(key, ["decrypt"])
  try {
    const opened = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: toBytes(iv),
        additionalData: toBytes(
          encodeAad({ serverId: aad.serverId, kind: aad.kind, keyVersion: sealed.keyVersion })
        ),
      },
      cryptoKey,
      toBytes(base64ToBytes(sealed.data))
    )
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(opened)
  } catch {
    // A wrong key, a wrong server id, a wrong kind and a tampered payload are
    // indistinguishable here on purpose: all mean "do not use this".
    throw new CredentialError("Credential could not be opened")
  }
}

/** True when the envelope can be opened with the given key version. */
export function isSealedWith(sealed: SealedCredential, keyVersion: number): boolean {
  return sealed.v === SCHEMA_VERSION && sealed.keyVersion === keyVersion
}

function aadVersion(sealed: SealedCredential): number {
  return sealed.keyVersion
}

function encodeAad(aad: CredentialAad): Uint8Array {
  // A fixed field order, with lengths implied by the separators. Server ids are
  // opaque strings and never contain ":*".
  return new TextEncoder().encode(`v${SCHEMA_VERSION}|${aad.keyVersion}|${aad.serverId}|${aad.kind}`)
}

async function importKey(key: Uint8Array, usages: Array<"encrypt" | "decrypt">): Promise<CryptoKey> {
  return await crypto.subtle.importKey("raw", toBytes(key), { name: "AES-GCM", length: 256 }, false, usages)
}
