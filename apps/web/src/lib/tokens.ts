/**
 * Token counts as people write them.
 *
 * Nobody wants to count zeros in 128000, and one missing zero turns a context window
 * into a truncation. The form accepts 128K or 1M and stores the number.
 */

/** Reads "128K", "1M", "200000", or nothing. Returns null for anything else. */
export function parseTokenCount(input: string): number | null {
  const text = input.trim().toUpperCase().replace(/\s+/g, "")
  if (text.length === 0) return null
  const match = /^(\d+(?:\.\d+)?)([KM])?$/.exec(text)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value) || value <= 0) return null
  const scale = match[2] === "M" ? 1_000_000 : match[2] === "K" ? 1_000 : 1
  return Math.round(value * scale)
}

/**
 * Writes a count back in the shortest form that is exact.
 *
 * 128000 becomes "128K" because it is a round thousand; 8192 stays "8192", since a
 * shorthand that rounds would quietly change the setting.
 */
export function formatTokenCount(value: number | null): string {
  if (!value || value <= 0) return ""
  // 2.5M reads better than 2500K, and stays exact while the value is a tenth of a million.
  if (value >= 1_000_000 && value % 100_000 === 0) return `${value / 1_000_000}M`
  if (value % 1_000 === 0) return `${value / 1_000}K`
  return String(value)
}
