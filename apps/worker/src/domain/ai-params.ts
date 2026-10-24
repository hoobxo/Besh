/**
 * Per-model generation settings.
 *
 * These are things the provider will not tell us: a model's context window, how much
 * it may answer with, whether it reads images, and how hard it should think. They are
 * the administrator's declaration, stored beside the endpoint, and sent with each
 * request only when they mean something.
 */

/** The menu the settings dialog offers. "default" sends nothing at all. */
export type ReasoningEffort = "default" | "low" | "medium" | "high" | "xhigh" | "max"

export type ModelParams = {
  /** Tokens the model can hold, or null when the administrator has not said. */
  contextWindow: number | null
  /** Tokens it may produce in one answer. */
  maxOutput: number | null
  inputs: {
    /** Always on: the assistant reasons and answers in text, and runs tools. */
    text: true
    /** Off unless the administrator says the model reads pictures. */
    image: boolean
  }
  effort: ReasoningEffort
}

export const EFFORTS: ReasoningEffort[] = ["default", "low", "medium", "high", "xhigh", "max"]

export const DEFAULT_PARAMS: ModelParams = {
  contextWindow: null,
  maxOutput: null,
  inputs: { text: true, image: false },
  effort: "default",
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && (EFFORTS as string[]).includes(value)
}

/** Clamps a token count the browser may have typed into anything. */
function readCount(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null
  const rounded = Math.floor(value)
  if (rounded <= 0) return null
  return Math.min(rounded, 10_000_000)
}

/**
 * Accepts whatever was stored — including nothing, or an older shape — and returns
 * something usable. A missing image flag means "does not read images", which is the
 * safe direction: the composer will not offer an attachment that would 400.
 */
export function parseModelParams(value: unknown): ModelParams {
  const source = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const inputs = typeof source.inputs === "object" && source.inputs !== null ? (source.inputs as Record<string, unknown>) : {}
  return {
    contextWindow: readCount(source.contextWindow),
    maxOutput: readCount(source.maxOutput),
    inputs: { text: true, image: inputs.image === true },
    effort: isReasoningEffort(source.effort) ? source.effort : "default",
  }
}

/**
 * The `reasoning_effort` value for a choice, or null to leave the field out.
 *
 * "default" is not a value the provider understands — it means "send nothing" — and
 * is the reason this returns null rather than a string.
 */
export function wireEffort(effort: ReasoningEffort): string | null {
  return effort === "default" ? null : effort
}
