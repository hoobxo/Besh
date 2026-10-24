/**
 * Theme choice and its application.
 *
 * This used to live inside a component's effect, which meant the theme was only applied
 * once that component mounted. When the settings dialog became lazily mounted, a reload
 * on a dark system painted light until the dialog was opened. Loading and applying the
 * choice is therefore part of boot, not part of a component's lifetime.
 */
export type ThemeChoice = "system" | "light" | "dark"

const STORAGE_KEY = "besh:theme"

export function readThemeChoice(): ThemeChoice {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return stored === "light" || stored === "dark" ? stored : "system"
  } catch {
    return "system"
  }
}

export function applyThemeChoice(choice: ThemeChoice): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches
  const dark = choice === "dark" || (choice === "system" && prefersDark)
  // Tailwind's `dark` variant keys off this class; color-scheme tells the browser to
  // paint scrollbars and form controls to match.
  document.documentElement.classList.toggle("dark", dark)
  document.documentElement.style.colorScheme = dark ? "dark" : "light"
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // A browser that refuses storage still gets the theme for this session.
  }
}

/**
 * Keeps following the system while "system" is selected.
 *
 * Installed once at boot so the listener does not depend on which components are on
 * screen.
 */
export function watchSystemTheme(): () => void {
  const media = window.matchMedia("(prefers-color-scheme: dark)")
  const apply = () => applyThemeChoice(readThemeChoice())
  media.addEventListener("change", apply)
  return () => media.removeEventListener("change", apply)
}
