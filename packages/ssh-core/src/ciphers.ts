/**
 * Directional packet protection: one object per direction, built from the keys
 * derived after the key exchange.
 *
 * Both encryption modes the negotiated algorithm allows are supported, and the
 * asymmetry between them is preserved: AES-GCM is authenticated by its tag and
 * uses the packet length as AAD, while AES-CTR carries a separate HMAC over
 * `seq || packet`.
 */
import { getCipherSpec, getMacSpec } from "./protocol/algorithms.ts"
import { SSHAESCTRCipher, SSHAESGCMCipher, SSHHMAC } from "./protocol/crypto.ts"
import type { SessionKeys } from "./protocol/types.ts"

export type Direction = "c2s" | "s2c"

export type DirectionalCipher = {
  readonly blockSize: number
  readonly aead: boolean
  readonly macLength: number
  encrypt(data: Uint8Array, sequence: number, aad?: Uint8Array, commit?: boolean): Promise<Uint8Array>
  decrypt(
    data: Uint8Array,
    sequence: number,
    aad?: Uint8Array,
    commit?: boolean
  ): Promise<Uint8Array | null>
  sign?(packet: Uint8Array, sequence: number): Promise<Uint8Array>
  verify?(packet: Uint8Array, mac: Uint8Array, sequence: number): Promise<boolean>
}

export class CipherError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CipherError"
  }
}

/**
 * Builds the cipher for one direction.
 *
 * Derived key material is longer than the cipher needs, so each key is sliced to
 * the negotiated length; using the full blob would make every peer reject the
 * first packet for reasons that look like a protocol bug.
 */
export async function createDirectionalCipher(options: {
  cipherAlgorithm: string
  macAlgorithm: string
  keys: SessionKeys
  direction: Direction
}): Promise<DirectionalCipher> {
  const spec = getCipherSpec(options.cipherAlgorithm)
  const macSpec = getMacSpec(options.macAlgorithm)
  const { direction, keys } = options

  const rawKey = (direction === "c2s" ? keys.encKeyClientToServer : keys.encKeyServerToClient).subarray(
    0,
    spec.keyLength
  )
  const iv = (direction === "c2s" ? keys.ivClientToServer : keys.ivServerToClient).subarray(0, spec.ivLength)

  if (spec.mode === "gcm") {
    const cipher = new SSHAESGCMCipher(rawKey, iv)
    await cipher.init()
    return {
      blockSize: spec.blockSize,
      aead: true,
      // The GCM tag is appended by the cipher, not framed as a separate MAC.
      macLength: 16,
      encrypt: (data, sequence, aad, commit) => cipher.encrypt(data, sequence, aad, commit),
      decrypt: (data, sequence, aad, commit) => cipher.decrypt(data, sequence, aad, commit),
    }
  }

  const cipher = new SSHAESCTRCipher(rawKey, iv)
  await cipher.init()

  if (options.macAlgorithm === "none" || macSpec.length === 0) {
    return {
      blockSize: spec.blockSize,
      aead: false,
      macLength: 0,
      encrypt: (data, sequence, aad, commit) => cipher.encrypt(data, sequence, aad, commit),
      decrypt: (data, sequence, aad, commit) => cipher.decrypt(data, sequence, aad, commit),
    }
  }

  const integrityKey = (
    direction === "c2s" ? keys.integrityKeyC2S : keys.integrityKeyS2C
  ).subarray(0, macSpec.keyLength)
  const hmac = new SSHHMAC(options.macAlgorithm, integrityKey)
  await hmac.init()

  if (hmac.length !== macSpec.length) {
    throw new CipherError(`MAC length ${hmac.length} does not match the negotiated ${macSpec.length}`)
  }

  return {
    blockSize: spec.blockSize,
    aead: false,
    macLength: hmac.length,
    encrypt: (data, sequence, aad, commit) => cipher.encrypt(data, sequence, aad, commit),
    decrypt: (data, sequence, aad, commit) => cipher.decrypt(data, sequence, aad, commit),
    sign: (packet, sequence) => hmac.sign(packet, sequence),
    // `nextPacket` asks (packet, mac, seq); the HMAC object wants (packet, seq, expected).
    verify: (packet, mac, sequence) => hmac.verify(packet, sequence, mac),
  }
}
