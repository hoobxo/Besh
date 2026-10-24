import React from "react"
import { createRoot } from "react-dom/client"

import { App } from "@/App"
import { applyThemeChoice, readThemeChoice, watchSystemTheme } from "@/lib/theme"
import "./i18n"
import "./index.css"

// Before the first paint: a dark system must not flash light while React mounts.
applyThemeChoice(readThemeChoice())
watchSystemTheme()

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
