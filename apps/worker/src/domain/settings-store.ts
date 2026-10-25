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
}

const AI_PERMISSION_KEY = "ai_permission"
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
    .prepare("SELECT key, value FROM settings WHERE key = ?")
    .bind(AI_PERMISSION_KEY)
    .all<{ key: string; value: string }>()
  const stored = new Map((rows.results ?? []).map((row) => [row.key, row.value]))

  // A missing or corrupt row falls back to the strictest useful default rather
  // than failing to load: the assistant still works, it just asks first.
  const rawPermission = stored.get(AI_PERMISSION_KEY)
  const permission = isPermission(rawPermission) ? rawPermission : DEFAULT_PERMISSION
  return { aiPermission: permission, aiConfigured }
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

export { PERMISSIONS, DEFAULT_PERMISSION }

/**
 * Appearance settings that used to live in the browser.
 *
 * They belong to the installation like everything else here: the same account opening
 * the console on a second machine should find its theme, its language and its terminal
 * size, and clearing site data should not silently reset them. The browser keeps a
 * copy purely so the first paint is not a flash of the wrong theme — the database is
 * the source of truth and is read again on every load.
 */
export type ThemeChoice = "system" | "light" | "dark"
export type LanguageChoice = "zh-CN" | "en-US"

export type UiSettings = {
  theme: ThemeChoice
  language: LanguageChoice
  terminalFont: number
}

export const THEMES: ThemeChoice[] = ["system", "light", "dark"]
export const LANGUAGES: LanguageChoice[] = ["zh-CN", "en-US"]
export const TERMINAL_FONT_MIN = 11
export const TERMINAL_FONT_MAX = 20

export const UI_DEFAULTS: UiSettings = { theme: "system", language: "zh-CN", terminalFont: 13 }

const UI_KEYS = {
  theme: "ui_theme",
  language: "ui_language",
  terminalFont: "ui_terminal_font",
} as const

function isTheme(value: unknown): value is ThemeChoice {
  return typeof value === "string" && (THEMES as string[]).includes(value)
}

function isLanguage(value: unknown): value is LanguageChoice {
  return typeof value === "string" && (LANGUAGES as string[]).includes(value)
}

function isFontSize(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= TERMINAL_FONT_MIN && value <= TERMINAL_FONT_MAX
}

export async function readUiSettings(db: D1Database): Promise<UiSettings> {
  const rows = await db
    .prepare("SELECT key, value FROM settings WHERE key IN (?, ?, ?)")
    .bind(UI_KEYS.theme, UI_KEYS.language, UI_KEYS.terminalFont)
    .all<{ key: string; value: string }>()
  const stored = new Map((rows.results ?? []).map((row) => [row.key, row.value]))

  // A row that no longer parses falls back to the default instead of failing the load:
  // a bad appearance value must never keep the console from opening.
  const theme = stored.get(UI_KEYS.theme)
  const language = stored.get(UI_KEYS.language)
  const font = Number(stored.get(UI_KEYS.terminalFont))
  return {
    theme: isTheme(theme) ? theme : UI_DEFAULTS.theme,
    language: isLanguage(language) ? language : UI_DEFAULTS.language,
    terminalFont: isFontSize(font) ? font : UI_DEFAULTS.terminalFont,
  }
}

/**
 * Stores whichever appearance fields the caller sent.
 *
 * Validation happens here rather than in the route so the same rules guard the HTTP
 * endpoint and any future caller; an out-of-range value is rejected instead of being
 * quietly clamped, because a clamped value the browser did not ask for is a bug the
 * administrator would have to discover by noticing the wrong font size.
 */
export async function writeUiSettings(
  db: D1Database,
  patch: { theme?: unknown; language?: unknown; terminalFont?: unknown },
  now = Date.now()
): Promise<UiSettings> {
  const writes: Array<{ key: string; value: string }> = []

  if (patch.theme !== undefined) {
    if (!isTheme(patch.theme)) throw new SettingsError(`theme must be one of ${THEMES.join(", ")}`)
    writes.push({ key: UI_KEYS.theme, value: patch.theme })
  }
  if (patch.language !== undefined) {
    if (!isLanguage(patch.language)) throw new SettingsError(`language must be one of ${LANGUAGES.join(", ")}`)
    writes.push({ key: UI_KEYS.language, value: patch.language })
  }
  if (patch.terminalFont !== undefined) {
    if (!isFontSize(patch.terminalFont)) {
      throw new SettingsError(`terminalFont must be a whole number from ${TERMINAL_FONT_MIN} to ${TERMINAL_FONT_MAX}`)
    }
    writes.push({ key: UI_KEYS.terminalFont, value: String(patch.terminalFont) })
  }

  if (writes.length > 0) {
    await db.batch(
      writes.map((write) =>
        db
          .prepare(
            `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
          )
          .bind(write.key, write.value, now)
      )
    )
  }

  return readUiSettings(db)
}
