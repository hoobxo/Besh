/**
 * Appearance settings live in the installation, not in one browser.
 *
 * The theme, the language and the terminal font size used to be stored in
 * localStorage only, which made them a property of the machine that happened to open
 * the console: a second device started light with the default font, and clearing site
 * data silently threw the choice away. The server's settings row is now the source of
 * truth and is read on every load.
 *
 * The browser keeps a copy purely so boot can paint the right theme before the session
 * is known — that copy is written from server values on every load, never instead of
 * them.
 */
import i18n, { setLanguage } from "@/i18n"
import { api, type UiSettings } from "@/lib/api"
import { readTerminalFont, saveTerminalFont } from "@/lib/terminal-font"
import { applyThemeChoice, readThemeChoice, saveThemeChoice } from "@/lib/theme"

export type { UiSettings }

/** What this browser currently shows; used to put things back when a save fails. */
export function currentUiSettings(): UiSettings {
  return {
    theme: readThemeChoice(),
    language: i18n.resolvedLanguage === "en-US" ? "en-US" : "zh-CN",
    terminalFont: readTerminalFont(),
  }
}

/** Applies settings and refreshes the local copy used by the first paint. */
export function applyUiSettings(patch: Partial<UiSettings>): void {
  if (patch.theme) {
    saveThemeChoice(patch.theme)
    applyThemeChoice(patch.theme)
  }
  if (patch.language && patch.language !== currentUiSettings().language) setLanguage(patch.language)
  if (typeof patch.terminalFont === "number") saveTerminalFont(patch.terminalFont)
}

/**
 * Applies the change immediately, then stores it.
 *
 * The change is applied first because a theme switch that waits for a round trip
 * feels broken; if the request fails the previous values are restored so the screen
 * never claims a setting the server did not accept.
 */
export async function saveUiSettings(patch: Partial<UiSettings>): Promise<void> {
  const before = currentUiSettings()
  applyUiSettings(patch)
  try {
    const saved = await api.saveSettings({ ui: patch })
    applyUiSettings(saved.ui)
  } catch (reason) {
    applyUiSettings(before)
    throw reason
  }
}
