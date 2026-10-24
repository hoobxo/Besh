/**
 * Proposal lifecycle for AI-driven commands.
 *
 * A model can propose; only an administrator can approve, and the approval is
 * checked again at that moment rather than trusted from the proposal. Three things
 * make that safe, and all three are enforced here rather than in the session
 * object so they can be tested:
 *
 *   1. a proposal expires, because approving a stale `rm -rf` is the worst thing
 *      this feature could do;
 *   2. the command text is bound into the proposal and compared on approval;
 *   3. a proposal is single-use — approving twice must not run twice.
 *
 * The permission level is also re-checked on approval: it may have been tightened
 * between the model proposing and the administrator clicking.
 */
import { decide, type Permission, type Risk } from "./ai-approval.ts"

export const PROPOSAL_TTL_MS = 60_000

export type ProposalStatus = "pending" | "denied" | "approved" | "rejected" | "expired"

export type Proposal = {
  id: string
  command: string
  purpose: string
  risk: Risk
  reason: string
  status: ProposalStatus
  createdAt: number
  expiresAt: number
}

export type CreateResult =
  | { accepted: true; proposal: Proposal }
  | { accepted: false; risk: Risk; reason: string }

export type ApproveResult =
  | { ok: true; command: string }
  | { ok: false; reason: string; status: ProposalStatus }

/**
 * Turns a model proposal into either a pending item or an immediate refusal.
 *
 * `readonly` never produces a pending item at all: there is nothing for the user
 * to approve, so the UI cannot accidentally offer one.
 */
export function createProposal(
  input: { id: string; command: string; purpose: string; permission: Permission },
  now = Date.now()
): CreateResult {
  const verdict = decide(input.permission, input.command)

  if (verdict.action === "deny") {
    return { accepted: false, risk: verdict.risk, reason: verdict.reason }
  }

  return {
    accepted: true,
    proposal: {
      id: input.id,
      command: input.command,
      purpose: input.purpose,
      risk: verdict.risk,
      reason: "reason" in verdict ? verdict.reason : "只读命令",
      // `run` (semi-auto on a read-only command) is treated as pending too: the
      // caller decides whether to execute immediately, and the same expiry and
      // single-use rules then apply either way.
      status: "pending",
      createdAt: now,
      expiresAt: now + PROPOSAL_TTL_MS,
    },
  }
}

/**
 * Checks an approval against the current state of the world.
 *
 * Returns the command to run, or a reason and the status the proposal should now
 * carry. It never mutates the input: the caller applies the new status, so a
 * failed approval leaves nothing half-changed.
 */
export function approveProposal(
  proposal: Proposal,
  input: { permission: Permission; command?: string; now?: number }
): ApproveResult {
  const now = input.now ?? Date.now()

  if (proposal.status !== "pending") {
    return { ok: false, reason: `提案已处于 ${proposal.status} 状态`, status: proposal.status }
  }
  if (now >= proposal.expiresAt) {
    return { ok: false, reason: "提案已过期，请重新提问", status: "expired" }
  }
  // The client sends the command back so the check is explicit; if it differs from
  // what was proposed, someone is trying to approve something else.
  if (input.command !== undefined && input.command !== proposal.command) {
    return { ok: false, reason: "命令内容与提案不一致", status: "rejected" }
  }
  // Permissions may have been tightened since the proposal was created.
  const verdict = decide(input.permission, proposal.command)
  if (verdict.action === "deny") {
    return { ok: false, reason: verdict.reason, status: "denied" }
  }

  return { ok: true, command: proposal.command }
}

/** Rejection is terminal; a rejected proposal can never become approvable. */
export function rejectProposal(proposal: Proposal, now = Date.now()): Proposal {
  if (proposal.status !== "pending") return proposal
  void now
  return { ...proposal, status: "rejected" }
}

/** Marks a proposal approved and records that it was consumed. */
export function markApproved(proposal: Proposal): Proposal {
  return { ...proposal, status: "approved" }
}

/** True when the proposal can no longer be acted on, for UI refresh decisions. */
export function isStale(proposal: Proposal, now = Date.now()): boolean {
  return proposal.status === "pending" && now >= proposal.expiresAt
}

/** Drops finished or expired proposals so the map cannot grow without bound. */
export function pruneProposals(proposals: Map<string, Proposal>, now = Date.now()): void {
  for (const [id, proposal] of proposals) {
    if (proposal.status !== "pending" || now >= proposal.expiresAt) proposals.delete(id)
  }
}


/** Atomically consumes the current proposal after any asynchronous permission lookup. */
export function claimProposal(
  proposals: Map<string, Proposal>,
  id: string,
  input: { permission: Permission; command?: string; now?: number; source: "manual" | "automatic" }
): ApproveResult {
  const current = proposals.get(id)
  if (!current) return { ok: false, reason: "提案不存在或已失效", status: "expired" }
  const checked = approveProposal(current, input)
  if (!checked.ok) return checked
  if (input.source === "automatic" && decide(input.permission, current.command).action !== "run") {
    return { ok: false, reason: "权限已变更，此命令需要重新确认", status: "pending" }
  }
  // No await between reading the live entry and consuming it.
  proposals.set(id, markApproved(current))
  return checked
}
