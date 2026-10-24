import { useCallback, useState } from "react"

import { applyThemeChoice, readThemeChoice, saveThemeChoice, type ThemeChoice } from "@/lib/theme"

export function useThemeChoice(): { choice: ThemeChoice; setChoice: (next: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(readThemeChoice)

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next)
    saveThemeChoice(next)
    applyThemeChoice(next)
  }, [])

  return { choice, setChoice }
}
