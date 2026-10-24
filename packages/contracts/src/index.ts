/**
 * Public contract shared by the Besh worker and the web client.
 *
 * This file must stay free of platform APIs, credentials and SSH internals: it is
 * the only part of ssh-core that the browser is allowed to reason about.
 */

/** Bumped whenever the request/event envelope changes incompatibly. */
export const PROTOCOL_VERSION = 1 as const

/**
 * Stable error codes. The client renders these through i18n and never parses
 * message text, so wording can change without breaking the UI.
 */
export const ERROR_CODES = [
  "AUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "INVALID_REQUEST",
  "TARGET_REJECTED",
  "TARGET_UNREACHABLE",
  "CONNECT_TIMEOUT",
  "PROTOCOL_ERROR",
  "HOST_KEY_UNKNOWN",
  "HOST_KEY_CHANGED",
  "HOST_KEY_MISMATCH",
  "AUTH_FAILED",
  /** The server does not offer the method that was tried at all. */
  "AUTH_METHOD_UNSUPPORTED",
  "CANCELLED",
  "TICKET_INVALID",
  "INTERNAL",
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

export type ApiErrorBody = {
  error: { code: ErrorCode; message: string }
}

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && (ERROR_CODES as readonly string[]).includes(value)
}

export const AI_ERROR_CODES = [
  "NOT_CONFIGURED",
  "BUDGET_EXHAUSTED",
  "ATTACHMENT_MISSING",
  "EXEC_UNCONFIRMED",
] as const

export type AiErrorCode = (typeof AI_ERROR_CODES)[number]

/**
 * Observable connection phases. `authenticated` deliberately does not imply a
 * terminal, SFTP session or any other service: those are attached on demand.
 */
export const CONNECTION_PHASES = [
  "idle",
  "dialing",
  "kex",
  "host-trust",
  "authenticating",
  "authenticated",
  "closing",
  "closed",
  "failed",
] as const

export type ConnectionPhase = (typeof CONNECTION_PHASES)[number]

/** Phases from which no further progress is possible. */
export const TERMINAL_PHASES: readonly ConnectionPhase[] = ["closed", "failed"]
