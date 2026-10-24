import path from "node:path"

import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

export default defineConfig({
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
