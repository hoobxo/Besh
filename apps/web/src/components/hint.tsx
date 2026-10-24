import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"

/**
 * A styled hover label for an icon-only control.
 *
 * The native `title` attribute waits about a second, cannot be styled and ignores
 * the theme, so every control that needs a label uses this instead. The child keeps
 * its own `aria-label`: the tooltip is for the eye, the label is for the reader.
 */
export function Hint({ label, side = "bottom", children }: {
  label: string
  side?: "top" | "right" | "bottom" | "left"
  children: React.ReactNode
}) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side={side}>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
