/**
 * Terminal font size, chosen in the appearance settings.
 *
 * The terminal used to hard-code 13px, which left anyone on a dense or high-DPI
 * display with no way to read it comfortably. The size is stored per browser like
 * the theme, and changes are broadcast so an open terminal resizes without being
 * remounted (a remount would drop the scrollback).
 */
export const TERMINAL_FONT_MIN = 11
export const TERMINAL_FONT_MAX = 20
export const DEFAULT_TERMINAL_FONT = 13

const STORAGE_KEY = "besh:terminal-font"
const EVENT = "besh:terminal-font"

export function clampTerminalFont(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_FONT
  return Math.min(TERMINAL_FONT_MAX, Math.max(TERMINAL_FONT_MIN, Math.round(value)))
}

export function readTerminalFont(): number {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === null) return DEFAULT_TERMINAL_FONT
    const size = Number.parseInt(stored, 10)
    return Number.isFinite(size) ? clampTerminalFont(size) : DEFAULT_TERMINAL_FONT
  } catch {
    return DEFAULT_TERMINAL_FONT
  }
}

export function saveTerminalFont(size: number): void {
  const value = clampTerminalFont(size)
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // A browser that refuses storage still gets the size for this session.
  }
  window.dispatchEvent(new CustomEvent<number>(EVENT, { detail: value }))
}

/** Calls back whenever the saved size changes; returns the unsubscribe. */
export function watchTerminalFont(listener: (size: number) => void): () => void {
  const onChange = (event: Event) => {
    listener(typeof (event as CustomEvent<number>).detail === "number" ? (event as CustomEvent<number>).detail : readTerminalFont())
  }
  window.addEventListener(EVENT, onChange)
  return () => window.removeEventListener(EVENT, onChange)
}
