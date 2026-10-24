/**
 * Installation settings.
 *
 * One administrator means settings belong to the installation, not a user, so a
 * key/value table is enough and there is no per-user merge to reason about.
 *
 * The AI permission specifically must be readable server-side at the moment a
 * command is about to run: taking it from the browser would let a caller grant
 * itself permission to execute.
 */
import type { Permission } from "./ai-approval.ts"

export type Settings = {
  aiPermission: Permission
  /** Whether a model endpoint is configured. Deliberately not the key or URL. */
  aiConfigured: boolean
  /** Tokens allowed per UTC day across the installation; 0 means no ceiling. */
  aiDailyTokenBudget: number
}

const AI_PERMISSION_KEY = "ai_permission"
const DAILY_BUDGET_KEY = "ai_daily_token_budget"
/** Far above any real use, low enough that a typo cannot break the counters. */
const MAX_DAILY_TOKENS = 100_000_000
const PERMISSIONS: Permission[] = ["readonly", "confirm", "semi-auto"]
const DEFAULT_PERMISSION: Permission = "confirm"

export class SettingsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "SettingsError"
  }
}

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && (PERMISSIONS as string[]).includes(value)
}

export async function readSettings(db: D1Database, aiConfigured = false): Promise<Settings> {
  const rows = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?)")
    .bind(AI_PERMISSION_KEY, DAILY_BUDGET_KEY)
    .all<{ key: string; value: string }>()
  const stored = new Map((rows.results ?? []).map((row) => [row.key, row.value]))

  // A missing or corrupt row falls back to the strictest useful default rather
  // than failing to load: the assistant still works, it just asks first.
  const rawPermission = stored.get(AI_PERMISSION_KEY)
  const permission = isPermission(rawPermission) ? rawPermission : DEFAULT_PERMISSION
  return { aiPermission: permission, aiConfigured, aiDailyTokenBudget: parseBudget(stored.get(DAILY_BUDGET_KEY)) }
}

/** A stored budget is a plain non-negative integer; anything else means "no ceiling". */
function parseBudget(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > MAX_DAILY_TOKENS) return 0
  return parsed
}

export async function readDailyTokenBudget(db: D1Database): Promise<number> {
  return (await readSettings(db)).aiDailyTokenBudget
}

export async function writeDailyTokenBudget(db: D1Database, budget: number, now = Date.now()): Promise<void> {
  if (!Number.isInteger(budget) || budget < 0 || budget > MAX_DAILY_TOKENS) {
    throw new SettingsError(`The daily token budget must be a whole number between 0 and ${MAX_DAILY_TOKENS}`)
  }
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(DAILY_BUDGET_KEY, String(budget), now)
    .run()
}

export async function readPermission(db: D1Database): Promise<Permission> {
  return (await readSettings(db)).aiPermission
}

export async function writePermission(db: D1Database, permission: Permission, now = Date.now()): Promise<void> {
  if (!isPermission(permission)) throw new SettingsError("Unknown permission level")
  await db
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
    )
    .bind(AI_PERMISSION_KEY, permission, now)
    .run()
}

export { PERMISSIONS, DEFAULT_PERMISSION, MAX_DAILY_TOKENS }
