/**
 * SSH protocol constants and wire types used by the protocol layer.
 *
 * Deliberately excludes anything that belonged to the old product: the
 * Cloudflare Env binding, the browser-supplied `connect` message and its
 * credential parsing — Besh never accepts credentials from the browser.
 */

export interface SSHPacket {
  length: number
  paddingLength: number
  payload: Uint8Array
  mac?: Uint8Array
}

export interface KEXInitMessage {
  kexAlgorithms: string[]
  hostKeyAlgorithms: string[]
  encryptionC2S: string[]
  encryptionS2C: string[]
  macC2S: string[]
  macS2C: string[]
  compressionC2S: string[]
  compressionS2C: string[]
  firstKexPacketFollows: boolean
}

export interface SessionKeys {
  ivClientToServer: Uint8Array
  ivServerToClient: Uint8Array
  encKeyClientToServer: Uint8Array
  encKeyServerToClient: Uint8Array
  integrityKeyC2S: Uint8Array
  integrityKeyS2C: Uint8Array
  sessionID: Uint8Array
}

export const SSH_MSG_DISCONNECT = 1
export const SSH_MSG_IGNORE = 2
export const SSH_MSG_UNIMPLEMENTED = 3
export const SSH_MSG_DEBUG = 4
export const SSH_MSG_SERVICE_REQUEST = 5
export const SSH_MSG_SERVICE_ACCEPT = 6
export const SSH_MSG_EXT_INFO = 7
export const SSH_MSG_KEXINIT = 20
export const SSH_MSG_NEWKEYS = 21
export const SSH_MSG_KEX_ECDH_INIT = 30
export const SSH_MSG_KEX_ECDH_REPLY = 31
/**
 * True for the messages that belong to the key exchange layer.
 *
 * A re-exchange may only carry these (RFC 4253 section 7.1): everything else has
 * to wait until NEWKEYS, or the peer sees a packet it is not allowed to read yet
 * and drops the connection.
 */
export function isKeyExchangeMessage(type: number | undefined): boolean {
  if (type === undefined) return false
  // 30-49 are reserved for key exchange methods, so a future method stays covered.
  return type === SSH_MSG_KEXINIT || type === SSH_MSG_NEWKEYS || (type >= 30 && type <= 49)
}

export const SSH_MSG_USERAUTH_REQUEST = 50
export const SSH_MSG_USERAUTH_FAILURE = 51
export const SSH_MSG_USERAUTH_SUCCESS = 52
export const SSH_MSG_USERAUTH_INFO_REQUEST = 60
export const SSH_MSG_GLOBAL_REQUEST = 80
export const SSH_MSG_REQUEST_SUCCESS = 81
export const SSH_MSG_REQUEST_FAILURE = 82
export const SSH_MSG_CHANNEL_OPEN = 90
export const SSH_MSG_CHANNEL_OPEN_CONFIRMATION = 91
export const SSH_MSG_CHANNEL_OPEN_FAILURE = 92
export const SSH_MSG_CHANNEL_WINDOW_ADJUST = 93
export const SSH_MSG_CHANNEL_DATA = 94
export const SSH_MSG_CHANNEL_EXTENDED_DATA = 95
export const SSH_MSG_CHANNEL_EOF = 96
export const SSH_MSG_CHANNEL_CLOSE = 97
export const SSH_MSG_CHANNEL_REQUEST = 98
export const SSH_MSG_CHANNEL_SUCCESS = 99
export const SSH_MSG_CHANNEL_FAILURE = 100
