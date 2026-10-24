import {
  TERMINAL_PHASES,
  type ConnectionPhase,
  type ErrorCode,
} from "@besh/contracts"

export type ConnectionFailure = {
  code: ErrorCode
  message: string
}

/**
 * Events the connection accepts. The names mirror observable protocol progress,
 * not implementation steps, so the same machine can back Cloudflare, Node tests
 * or a future runtime.
 */
export type ConnectionEvent =
  | { type: "dial" }
  | { type: "tcp-connected" }
  | { type: "kex-started" }
  | { type: "kex-complete"; hostKeyFingerprint: string }
  | { type: "host-key-verified"; fingerprint: string }
  | { type: "host-key-rejected" }
  | { type: "auth-started" }
  | { type: "auth-succeeded" }
  | { type: "auth-failed" }
  | { type: "close" }
  | { type: "fail"; error: ConnectionFailure }

export type ConnectionSnapshot = {
  phase: ConnectionPhase
  /** Set once the key exchange produced a server host key. */
  hostKeyFingerprint: string | null
  /**
   * True only after the peer's signature was verified against a trusted
   * fingerprint. Credentials must never be sent while this is false.
   */
  hostKeyTrusted: boolean
  failure: ConnectionFailure | null
}

export class ConnectionStateError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ConnectionStateError"
  }
}

/**
 * Explicit connection lifecycle.
 *
 * Two invariants matter more than convenience here, and both are enforced by
 * throwing instead of returning a soft failure:
 *
 * 1. User credentials are only exchanged from `authenticating`, and the only
 *    way into that phase is a verified host key. A mismatch can therefore never
 *    be followed by a password or private-key signature.
 * 2. Terminal phases are final. Reviving a closed or failed connection silently
 *    would hide the fact that the remote socket is gone and no queued work can
 *    be replayed.
 *
 * The machine deliberately knows nothing about channels, PTY or SFTP; those are
 * separate services attached to an `authenticated` connection.
 */
export class ConnectionStateMachine {
  #snapshot: ConnectionSnapshot = {
    phase: "idle",
    hostKeyFingerprint: null,
    hostKeyTrusted: false,
    failure: null,
  }

  get snapshot(): Readonly<ConnectionSnapshot> {
    return this.#snapshot
  }

  get phase(): ConnectionPhase {
    return this.#snapshot.phase
  }

  get isTerminal(): boolean {
    return TERMINAL_PHASES.includes(this.#snapshot.phase)
  }

  /** True once credentials may be exchanged with the peer. */
  get canExchangeCredentials(): boolean {
    return this.#snapshot.phase === "authenticating" && this.#snapshot.hostKeyTrusted
  }

  apply(event: ConnectionEvent): Readonly<ConnectionSnapshot> {
    const { phase } = this.#snapshot

    if (this.isTerminal) {
      throw new ConnectionStateError(`Connection is already ${phase}; event ${event.type} cannot be applied`)
    }

    switch (event.type) {
      case "dial": {
        this.#expect(phase, ["idle"], event.type)
        this.#set({ phase: "dialing" })
        break
      }
      case "tcp-connected": {
        this.#expect(phase, ["dialing"], event.type)
        this.#set({ phase: "kex" })
        break
      }
      case "kex-started": {
        this.#expect(phase, ["kex"], event.type)
        break
      }
      case "kex-complete": {
        this.#expect(phase, ["kex"], event.type)
        // A second host key in one connection means the peer rekeyed or is
        // misbehaving; neither is supported yet, so refuse instead of trusting
        // whichever key arrived last.
        if (this.#snapshot.hostKeyFingerprint !== null) {
          throw new ConnectionStateError("Host key was already established for this connection")
        }
        this.#set({ phase: "host-trust", hostKeyFingerprint: event.hostKeyFingerprint })
        break
      }
      case "host-key-verified": {
        this.#expect(phase, ["host-trust"], event.type)
        if (event.fingerprint !== this.#snapshot.hostKeyFingerprint) {
          throw new ConnectionStateError("Verified fingerprint does not match the negotiated host key")
        }
        this.#set({ phase: "authenticating", hostKeyTrusted: true })
        break
      }
      case "host-key-rejected": {
        this.#expect(phase, ["host-trust"], event.type)
        this.#set({
          phase: "failed",
          hostKeyTrusted: false,
          failure: { code: "HOST_KEY_MISMATCH", message: "Host key was rejected before authentication" },
        })
        break
      }
      case "auth-started": {
        this.#expect(phase, ["authenticating"], event.type)
        break
      }
      case "auth-succeeded": {
        this.#expect(phase, ["authenticating"], event.type)
        this.#set({ phase: "authenticated" })
        break
      }
      case "auth-failed": {
        this.#expect(phase, ["authenticating"], event.type)
        this.#set({ phase: "failed", failure: { code: "AUTH_FAILED", message: "SSH authentication was rejected" } })
        break
      }
      case "close": {
        this.#expect(phase, ["dialing", "kex", "host-trust", "authenticating", "authenticated"], event.type)
        this.#set({ phase: "closing" })
        break
      }
      case "fail": {
        this.#set({ phase: "failed", failure: event.error })
        break
      }
      default: {
        const exhaustive: never = event
        throw new ConnectionStateError(`Unhandled connection event: ${JSON.stringify(exhaustive)}`)
      }
    }

    return this.#snapshot
  }

  /** Marks the socket as released. Called once the transport close completes. */
  closed(): Readonly<ConnectionSnapshot> {
    const { phase } = this.#snapshot
    if (phase !== "closing" && phase !== "failed") {
      throw new ConnectionStateError(`Transport closed while connection was ${phase}`)
    }
    this.#set({ phase: "closed" })
    return this.#snapshot
  }

  #set(patch: Partial<ConnectionSnapshot>): void {
    this.#snapshot = { ...this.#snapshot, ...patch }
  }

  #expect(phase: ConnectionPhase, allowed: readonly ConnectionPhase[], event: string): void {
    if (!allowed.includes(phase)) {
      throw new ConnectionStateError(`Cannot apply ${event} while connection is ${phase}`)
    }
  }
}
