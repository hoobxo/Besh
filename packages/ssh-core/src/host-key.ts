/**
 * Host key verification for Besh.
 *
 * Implemented from RFC 4253 (transport), RFC 5656 (ECDSA), RFC 8332
 * (RSA SHA-2) and RFC 8709 (Ed25519). Its only job is to answer one
 * question — does the server hold the private key for the public key it
 * just sent?
 *
 * Ordering matters more than anything else in this file: the signature is
 * verified before the fingerprint is compared, before any trust prompt and
 * before any credential exists. A false result must stop the handshake.
 */
import {
  SshByteReader,
  bytesToBase64,
  bytesToBase64Url,
  mpintToUnsignedBytes,
} from "./ssh-bytes.ts"

export type EcdsaHostKeyType = "ecdsa-sha2-nistp256" | "ecdsa-sha2-nistp384" | "ecdsa-sha2-nistp521"
export type RsaSignatureType = "rsa-sha2-256" | "rsa-sha2-512"
export type HostKeyType = "ssh-ed25519" | EcdsaHostKeyType | "ssh-rsa"

export type VerifiedHostKey = {
  /** Key type from the key blob itself (for RSA this is `ssh-rsa`, not the signature type). */
  keyType: HostKeyType
  /** `SHA256:<base64 without padding>` — the format OpenSSH prints. */
  fingerprint: string
  /** The raw `K_S` blob, needed later for the exchange hash. */
  blob: Uint8Array
}

export class HostKeyVerificationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "HostKeyVerificationError"
  }
}

const ECDSA_CURVES: Record<EcdsaHostKeyType, { namedCurve: string; hash: string; coordinateBytes: number }> = {
  "ecdsa-sha2-nistp256": { namedCurve: "P-256", hash: "SHA-256", coordinateBytes: 32 },
  "ecdsa-sha2-nistp384": { namedCurve: "P-384", hash: "SHA-384", coordinateBytes: 48 },
  "ecdsa-sha2-nistp521": { namedCurve: "P-521", hash: "SHA-512", coordinateBytes: 66 },
}

const MAX_HOST_KEY_BYTES = 8192

/**
 * `SHA256:<base64>` over the entire key blob including its type string.
 *
 * The encoding matters: OpenSSH strips `=` padding and uses standard base64
 * rather than base64url, so a "close enough" variant silently never matches a
 * fingerprint the user copied from `ssh-keygen -lf`.
 */
export async function hostKeyFingerprint(keyBlob: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", toBytes(keyBlob)))
  return `SHA256:${bytesToBase64(digest).replace(/=+$/, "")}`
}

/** Reads the key type without verifying anything. Used only for diagnostics. */
export function readHostKeyType(keyBlob: Uint8Array): string {
  return new SshByteReader(keyBlob).readText()
}

/**
 * Verifies the server's signature over the exchange hash.
 *
 * Throws `HostKeyVerificationError` on any mismatch. A caller must treat a throw
 * as fatal: continuing would mean trusting a host that could not prove key
 * ownership.
 */
export async function verifyHostKeySignature(options: {
  keyBlob: Uint8Array
  signatureBlob: Uint8Array
  exchangeHash: Uint8Array
  negotiatedHostKeyAlgorithm: string
}): Promise<VerifiedHostKey> {
  const { keyBlob, signatureBlob, exchangeHash, negotiatedHostKeyAlgorithm } = options

  const reader = new SshByteReader(keyBlob)
  const keyType = reader.readText() as HostKeyType
  assertCompatibleAlgorithm(negotiatedHostKeyAlgorithm, keyType)

  const fingerprint = await hostKeyFingerprint(keyBlob)
  const signed = toBytes(exchangeHash)
  const remaining = reader.rest()
  if (remaining.length > MAX_HOST_KEY_BYTES) throw new HostKeyVerificationError("Host key blob is unreasonably large")

  switch (keyType) {
    case "ssh-ed25519": {
      const keyReader = new SshByteReader(remaining)
      const rawKey = keyReader.readString()
      keyReader.expectEnd("ed25519 host key")
      if (rawKey.length !== 32) throw new HostKeyVerificationError("Ed25519 host key must be 32 bytes")

      const signature = readSignature(signatureBlob, "ssh-ed25519")
      if (signature.length !== 64) throw new HostKeyVerificationError("Ed25519 signature must be 64 bytes")

      const key = await crypto.subtle.importKey("raw", toBytes(rawKey), { name: "Ed25519" }, false, ["verify"])
      const ok = await crypto.subtle.verify("Ed25519", key, toBytes(signature), signed)
      if (!ok) throw new HostKeyVerificationError("Ed25519 signature does not match the exchange hash")
      break
    }

    case "ecdsa-sha2-nistp256":
    case "ecdsa-sha2-nistp384":
    case "ecdsa-sha2-nistp521": {
      const spec = ECDSA_CURVES[keyType]
      const keyReader = new SshByteReader(remaining)
      const curveName = keyReader.readText()
      if (curveName !== keyType.replace("ecdsa-sha2-", "")) {
        throw new HostKeyVerificationError(`ECDSA curve name ${curveName} does not match ${keyType}`)
      }
      const point = keyReader.readString()
      keyReader.expectEnd("ECDSA host key")
      if (point.length === 0) throw new HostKeyVerificationError("Empty ECDSA public point")

      const signature = readSignature(signatureBlob, keyType)
      const raw = ecdsaSignatureToP1363(signature, spec.coordinateBytes)

      const key = await crypto.subtle.importKey(
        "raw",
        toBytes(point),
        { name: "ECDSA", namedCurve: spec.namedCurve },
        false,
        ["verify"]
      )
      const ok = await crypto.subtle.verify({ name: "ECDSA", hash: spec.hash }, key, toBytes(raw), signed)
      if (!ok) throw new HostKeyVerificationError(`${keyType} signature does not match the exchange hash`)
      break
    }

    case "ssh-rsa": {
      // The key blob says `ssh-rsa` even when the negotiated algorithm and the
      // signature are rsa-sha2-256/512 (RFC 8332). Both must agree.
      const signatureType = new SshByteReader(signatureBlob).readText()
      if (signatureType !== "rsa-sha2-256" && signatureType !== "rsa-sha2-512") {
        throw new HostKeyVerificationError(
          `RSA host key requires an rsa-sha2 signature, received ${signatureType || "(empty)"}`
        )
      }
      if (signatureType !== negotiatedHostKeyAlgorithm) {
        throw new HostKeyVerificationError(
          `RSA signature type ${signatureType} does not match the negotiated ${negotiatedHostKeyAlgorithm}`
        )
      }

      const keyReader = new SshByteReader(remaining)
      const exponent = mpintToUnsignedBytes(keyReader.readString())
      const modulus = mpintToUnsignedBytes(keyReader.readString())
      keyReader.expectEnd("RSA host key")
      if (modulus.length === 0 || exponent.length === 0) throw new HostKeyVerificationError("Empty RSA host key")

      const hash = signatureType === "rsa-sha2-512" ? "SHA-512" : "SHA-256"
      const signature = readSignature(signatureBlob, signatureType as RsaSignatureType)
      const key = await crypto.subtle.importKey(
        "jwk",
        { kty: "RSA", e: bytesToBase64Url(exponent), n: bytesToBase64Url(modulus), ext: true },
        { name: "RSASSA-PKCS1-v1_5", hash },
        false,
        ["verify"]
      )
      // The RSA signature is raw bytes, not an mpint.
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, toBytes(signature), signed)
      if (!ok) throw new HostKeyVerificationError("RSA signature does not match the exchange hash")
      break
    }

    default:
      throw new HostKeyVerificationError(`Unsupported host key type: ${keyType}`)
  }

  return { keyType, fingerprint, blob: keyBlob }
}

/** `signature_blob = string(signature_format) || string(signature)`. */
function readSignature(signatureBlob: Uint8Array, expectedType: string): Uint8Array {
  const reader = new SshByteReader(signatureBlob)
  const signatureType = reader.readText()
  if (signatureType !== expectedType) {
    throw new HostKeyVerificationError(
      `Signature type ${signatureType || "(empty)"} does not match the expected ${expectedType}`
    )
  }
  const signature = reader.readString()
  reader.expectEnd("host signature")
  return signature
}

/**
 * ECDSA signatures travel as two SSH mpints; WebCrypto wants IEEE P1363
 * (`r || s`, each padded to the coordinate size).
 */
export function ecdsaSignatureToP1363(signature: Uint8Array, coordinateBytes: number): Uint8Array {
  const reader = new SshByteReader(signature)
  const r = mpintToUnsignedBytes(reader.readString())
  const s = mpintToUnsignedBytes(reader.readString())
  reader.expectEnd("ECDSA signature")

  if (r.length === 0 || s.length === 0) throw new HostKeyVerificationError("ECDSA signature has an empty integer")
  if (r.length > coordinateBytes || s.length > coordinateBytes) {
    throw new HostKeyVerificationError("ECDSA signature integer is longer than the curve size")
  }
  const p1363 = new Uint8Array(coordinateBytes * 2)
  p1363.set(r, coordinateBytes - r.length)
  p1363.set(s, coordinateBytes * 2 - s.length)
  return p1363
}

/** RFC 8332 lets a `ssh-rsa` blob be used with an `rsa-sha2-*` negotiation. */
function assertCompatibleAlgorithm(negotiated: string, keyType: HostKeyType): void {
  if (negotiated === keyType) return
  if (keyType === "ssh-rsa" && (negotiated === "rsa-sha2-256" || negotiated === "rsa-sha2-512")) return
  throw new HostKeyVerificationError(`Host key type ${keyType} does not match the negotiated ${negotiated}`)
}

/** WebCrypto wants ArrayBuffer-backed views; subarray views are not always accepted. */
function toBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(value.length)
  copy.set(value)
  return copy
}
