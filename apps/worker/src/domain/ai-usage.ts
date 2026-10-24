/**
 * Token accounting for the assistant.
 *
 * The provider reports how many tokens a call consumed; this module keeps the
 * running totals. Two questions are answered from the same table: "what has this
 * conversation cost" (every day it was used) and "how much of today's budget is
 * gone" (every conversation together).
 *
 * The counters are best effort by design. Failing to record usage must never fail
 * an answer, so callers ignore the returned promise where that matters.
 */

/** What one provider call reported, in the provider's own numbers. */
export type TokenUsage = {
  promptTokens: number
  completionTokens: number
}

export type UsageTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  requests: number
}

const EMPTY: UsageTotals = { promptTokens: 0, completionTokens: 0, totalTokens: 0, requests: 0 }

function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null
  return Math.round(value)
}

/**
 * Reads the usage block of a provider response.
 *
 * OpenAI reports `prompt_tokens` / `completion_tokens`; several compatible
 * gateways use the newer `input_tokens` / `output_tokens`. Both mean the same
 * thing here, and a provider that reports neither yields null rather than a zero
 * that would look like a free call.
 */
export function readProviderUsage(raw: unknown): TokenUsage | null {
  if (!raw || typeof raw !== "object") return null
  const value = raw as Record<string, unknown>
  const prompt = count(value.prompt_tokens) ?? count(value.input_tokens)
  const completion = count(value.completion_tokens) ?? count(value.output_tokens)
  if (prompt === null && completion === null) return null
  return { promptTokens: prompt ?? 0, completionTokens: completion ?? 0 }
}

/** The UTC day a timestamp belongs to; the budget resets at UTC midnight. */
export function usageDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

export function totalOf(promptTokens: number, completionTokens: number, requests: number): UsageTotals {
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    requests,
  }
}

export async function recordUsage(
  db: D1Database,
  serverId: string,
  conversationId: string,
  usage: TokenUsage,
  now = Date.now()
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ai_usage (server_id, conversation_id, day, prompt_tokens, completion_tokens, requests, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(server_id, conversation_id, day) DO UPDATE SET
         prompt_tokens = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         requests = requests + 1,
         updated_at = excluded.updated_at`
    )
    .bind(serverId, conversationId, usageDay(now), usage.promptTokens, usage.completionTokens, now)
    .run()
}

async function sum(db: D1Database, where: string, value: string): Promise<UsageTotals> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(requests), 0) AS requests
       FROM ai_usage WHERE ${where} = ?`
    )
    .bind(value)
    .first<{ prompt_tokens: number; completion_tokens: number; requests: number }>()
  if (!row) return EMPTY
  return totalOf(row.prompt_tokens, row.completion_tokens, row.requests)
}

/** Every call this conversation ever made, not just today's. */
export async function readConversationTotals(
  db: D1Database,
  serverId: string,
  conversationId: string
): Promise<UsageTotals> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
              COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
              COALESCE(SUM(requests), 0) AS requests
       FROM ai_usage WHERE server_id = ? AND conversation_id = ?`
    )
    .bind(serverId, conversationId)
    .first<{ prompt_tokens: number; completion_tokens: number; requests: number }>()
  if (!row) return EMPTY
  return totalOf(row.prompt_tokens, row.completion_tokens, row.requests)
}

/** Every call across the installation today; this is what the budget counts. */
export async function readDayTotals(db: D1Database, now = Date.now()): Promise<UsageTotals> {
  return await sum(db, "day", usageDay(now))
}

/** Drops the counters of a deleted conversation, so the day total shrinks with it. */
export async function forgetUsage(db: D1Database, serverId: string, conversationId: string): Promise<void> {
  await db
    .prepare("DELETE FROM ai_usage WHERE server_id = ? AND conversation_id = ?")
    .bind(serverId, conversationId)
    .run()
}
