import { readFileSync } from "node:fs"
import path from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

/* The release tag, the root manifest and the About page stay the same number:
   the version is read here instead of being typed a second time in the UI. */
const rootManifest = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "../../package.json"), "utf8"),
) as { version?: string }

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(rootManifest.version ?? "0.0.0") },
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "./src") },
  },
  server: {
    port: 5173,
    // The worker runs on 8787; a relative API path keeps cookies same-origin
    // during development without loosening CORS.
    proxy: { "/api": { target: "http://127.0.0.1:8787", changeOrigin: false, ws: true } },
  },
})
