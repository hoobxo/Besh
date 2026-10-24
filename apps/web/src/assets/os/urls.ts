/**
 * Bundled URLs for the operating-system marks.
 *
 * Vite turns each import into a hashed asset, so the SVG stays a separate file that
 * the browser caches and the component can use as an `<img src>`. Regenerate the
 * files with `node scripts/build-os-icons.mjs`; the glob picks them up automatically.
 */
const modules = import.meta.glob("./*.svg", { eager: true, query: "?url", import: "default" }) as Record<string, string>

export const OS_ICON_URLS: Record<string, string> = Object.fromEntries(
  Object.entries(modules).map(([path, url]) => [path.replace(/^\.\//, "").replace(/\.svg$/, ""), url])
)
