import { useCallback, useState } from "react"

import { saveUiSettings } from "@/lib/ui-settings"
import { readThemeChoice, type ThemeChoice } from "@/lib/theme"

export function useThemeChoice(): { choice: ThemeChoice; setChoice: (next: ThemeChoice) => void } {
  const [choice, setChoiceState] = useState<ThemeChoice>(readThemeChoice)

  const setChoice = useCallback((next: ThemeChoice) => {
    setChoiceState(next)
    // The theme is stored with the installation, so a second device opens in the same
    // theme; the failure is not worth a dialog, the switch simply snaps back.
    void saveUiSettings({ theme: next }).catch(() => setChoiceState(readThemeChoice()))
  }, [])

  return { choice, setChoice }
}
