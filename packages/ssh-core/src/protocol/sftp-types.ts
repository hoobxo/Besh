/** SFTP protocol version implemented by this client. */
export const SFTP_VERSION = 3;

export const SFTP_PACKET_TYPES = {
  INIT: 1,
  VERSION: 2,
  OPEN: 3,
  CLOSE: 4,
  READ: 5,
  WRITE: 6,
  LSTAT: 7,
  FSTAT: 8,
  SETSTAT: 9,
  FSETSTAT: 10,
  OPENDIR: 11,
  READDIR: 12,
  REMOVE: 13,
  MKDIR: 14,
  RMDIR: 15,
  REALPATH: 16,
  STAT: 17,
  RENAME: 18,
  READLINK: 19,
  SYMLINK: 20,
  STATUS: 101,
  HANDLE: 102,
  DATA: 103,
  NAME: 104,
  ATTRS: 105,
  EXTENDED: 200,
  EXTENDED_REPLY: 201,
} as const;

export const SFTP_STATUS = {
  OK: 0,
  EOF: 1,
  NO_SUCH_FILE: 2,
  PERMISSION_DENIED: 3,
  FAILURE: 4,
  BAD_MESSAGE: 5,
  NO_CONNECTION: 6,
  CONNECTION_LOST: 7,
  OP_UNSUPPORTED: 8,
} as const;

export const SFTP_OPEN_FLAGS = {
  READ: 0x00000001,
  WRITE: 0x00000002,
  APPEND: 0x00000004,
  CREATE: 0x00000008,
  TRUNCATE: 0x00000010,
  EXCLUSIVE: 0x00000020,
} as const;

export const SFTP_ATTR_FLAGS = {
  SIZE: 0x00000001,
  UID_GID: 0x00000002,
  PERMISSIONS: 0x00000004,
  ACCESS_MODIFY_TIME: 0x00000008,
  EXTENDED: 0x80000000,
} as const;

export type SFTPOpenFlags = number;
export type SFTPHandle = Uint8Array;
export type SFTPUint64Input = number | bigint | string;
export type SFTPSize = number | string;

export interface SFTPExtendedAttribute {
  readonly type: string;
  readonly data: Uint8Array;
}

export interface SFTPExtendedAttributeInput {
  readonly type: string;
  readonly data: string | Uint8Array;
}

export interface SFTPAttrs {
  readonly flags: number;
  readonly size?: SFTPSize;
  readonly uid?: number;
  readonly gid?: number;
  readonly permissions?: number;
  readonly atime?: number;
  readonly mtime?: number;
  readonly extended?: readonly SFTPExtendedAttribute[];
}

export interface SFTPAttrsInput {
  readonly size?: SFTPUint64Input;
  readonly uid?: number;
  readonly gid?: number;
  readonly permissions?: number;
  readonly atime?: number;
  readonly mtime?: number;
  readonly extended?: readonly SFTPExtendedAttributeInput[];
}

export interface SFTPDirEntry {
  readonly filename: string;
  readonly longname: string;
  readonly attrs: SFTPAttrs;
}

export interface SFTPVersionInfo {
  readonly version: number;
  readonly extensions: ReadonlyMap<string, string>;
}

export interface SFTPClientOptions {
  /** Maximum packet length, excluding the four-byte packet length field. */
  readonly maxPacketLength?: number;
  /** Maximum memory reserved for a partially received framed packet. */
  readonly maxBufferedBytes?: number;
  readonly maxNameEntries?: number;
  readonly maxExtendedAttributes?: number;
  readonly maxVersionExtensions?: number;
  readonly requestTimeoutMs?: number;
  /** Primarily useful for deterministic request-ID rollover tests. */
  readonly initialRequestId?: number;
}
