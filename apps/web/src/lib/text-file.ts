export const MAX_EDITABLE_BYTES = 512 * 1024

export type TextFile = {
  text: string
  eol: "\n" | "\r\n"
}

export type EditorMode = "shell" | "json" | "yaml" | "nginx" | "toml" | "ini" | "dockerfile" | "text"

const NUL = 0
const REPLACEMENT = 0xfffd

export function decodeTextFile(bytes: Uint8Array): TextFile | null {
  if (bytes.length === 0) return { text: "", eol: "\n" }
  for (const byte of bytes) {
    if (byte === NUL) return null
  }
  let decoded: string
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    return null
  }
  let replacements = 0
  for (const _ of decoded.matchAll(/\uFFFD/g)) replacements += 1
  if (replacements > REPLACEMENT || replacements * 100 > decoded.length) return null
  const eol = decoded.includes("\r\n") ? "\r\n" : "\n"
  return { text: eol === "\r\n" ? decoded.replaceAll("\r\n", "\n") : decoded, eol }
}

export function encodeTextFile(text: string, eol: TextFile["eol"]): Uint8Array {
  const normalized = text.replaceAll("\r\n", "\n")
  const body = eol === "\r\n" ? normalized.replaceAll("\n", "\r\n") : normalized
  return new TextEncoder().encode(body)
}

export function isWritableMode(mode: number | null): boolean {
  if (mode === null) return false
  return (mode & 0o222) !== 0
}

export function sameVersion(a: { size: number; modifiedAt: number | null }, b: { size: number; modifiedAt: number | null }): boolean {
  return a.size === b.size && a.modifiedAt === b.modifiedAt
}

export function editorModeFor(path: string): EditorMode {
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase()
  const dot = name.lastIndexOf(".")
  const extension = dot > 0 ? name.slice(dot + 1) : ""
  if (/\.(sh|bash|zsh|ksh)$/.test(name) || extension === "sh" || extension === "bash") return "shell"
  if (extension === "json") return "json"
  if (extension === "yaml" || extension === "yml") return "yaml"
  if (name === "dockerfile" || name.startsWith("dockerfile.")) return "dockerfile"
  if (name === "nginx.conf" || path.includes("/nginx/")) return "nginx"
  if (extension === "toml") return "toml"
  if (extension === "ini" || extension === "conf" || extension === "cfg" || extension === "properties") return "ini"
  return "text"
}

export function formatByteLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))} MB`
  return `${Math.round(bytes / 1024)} KB`
}
