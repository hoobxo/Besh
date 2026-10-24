import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"

/**
 * Asks for one line of text.
 *
 * Replaces `window.prompt`, which is unstyled, blocks the page, and cannot be
 * translated by the application — it renders the browser's own chrome.
 */
export function PromptDialog({ open, title, label, defaultValue = "", confirmLabel, onOpenChange, onSubmit }: {
  open: boolean
  title: string
  label: string
  defaultValue?: string
  confirmLabel: string
  onOpenChange: (open: boolean) => void
  onSubmit: (value: string) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState(defaultValue)

  // Each opening starts from the current default, not from the previous attempt.
  useEffect(() => {
    if (open) setValue(defaultValue)
  }, [open, defaultValue])

  const trimmed = value.trim()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    if (trimmed.length === 0) return
    onSubmit(trimmed)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="sr-only">{label}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit}>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="prompt-value">{label}</FieldLabel>
              <Input
                id="prompt-value"
                value={value}
                autoFocus
                onChange={(event) => setValue(event.target.value)}
                onFocus={(event) => event.target.select()}
              />
            </Field>
          </FieldGroup>
          <DialogFooter className="mt-4">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("dialog.cancel")}
            </Button>
            <Button type="submit" disabled={trimmed.length === 0}>
              {confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
