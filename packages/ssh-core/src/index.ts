export type {
  ByteTransport,
  DialOptions,
  TransportCloseReason,
  TransportEvents,
  TransportFactory,
} from "./transport.ts"

export type { ConnectionEvent, ConnectionFailure, ConnectionSnapshot } from "./state.ts"
export { ConnectionStateError, ConnectionStateMachine } from "./state.ts"

export type { ServerIdentification } from "./identification.ts"
export {
  IdentificationError,
  MAX_IDENTIFICATION_LINE_BYTES,
  MAX_IDENTIFICATION_TOTAL_BYTES,
  MAX_PRE_IDENTIFICATION_LINES,
  clientIdentification,
  encodeIdentification,
  readServerIdentification,
} from "./identification.ts"

export type { SshConnectionListeners, SshConnectionOptions } from "./connection.ts"
export { SshConnection, SshConnectionError } from "./connection.ts"

export { MemoryTransport, ScriptedTransportFactory } from "./transports/memory.ts"

export type { EcdsaHostKeyType, HostKeyType, RsaSignatureType, VerifiedHostKey } from "./host-key.ts"
export {
  HostKeyVerificationError,
  ecdsaSignatureToP1363,
  hostKeyFingerprint,
  readHostKeyType,
  verifyHostKeySignature,
} from "./host-key.ts"

export { SshByteReader, bytesToBase64, bytesToBase64Url, mpintToUnsignedBytes } from "./ssh-bytes.ts"

export {
  CONNECTION_PHASES,
  ERROR_CODES,
  PROTOCOL_VERSION,
  TERMINAL_PHASES,
  isErrorCode,
  type ConnectionPhase,
  type ErrorCode,
} from "@besh/contracts"

export type { HostKeyDecision, HostKeyPolicy, KeyExchangeChannel, KeyExchangeResult, NegotiatedAlgorithms } from "./handshake.ts"
export { HostKeyRejectedError, KeyExchangeError, performKeyExchange } from "./handshake.ts"

export { Curve25519KeyExchange } from "./protocol/kex-curve25519.ts"
export { KEXInitBuilder, parseKEXInit, negotiate, filterExtInfo } from "./protocol/kex.ts"
export { SSHPacketBuilder, SSHPacketParser } from "./protocol/packet.ts"

export type { RemovedEntries, SftpEntry, WriteSession, WriteState } from "./sftp-service.ts"
export { SftpError, SftpService } from "./sftp-service.ts"
