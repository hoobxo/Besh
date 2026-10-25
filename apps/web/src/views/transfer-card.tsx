import { useEffect, useSyncExternalStore } from "react"
import { useTranslation } from "react-i18next"
import { Download, RotateCcw, Upload, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/format"
import { TransferQueue, type TransferItem } from "@/lib/transfer-queue"

/** How long a finished transfer stays on screen before the card clears itself. */
const LINGER_MS = 5000

/**
 * Transfer progress, shown where toasts live.
 *
 * It subscribes to the queue itself rather than receiving a snapshot, so the card
 * keeps counting even though a toast is created only once.
 */
export function TransferCard({ queue }: { queue: TransferQueue }) {
  const { t } = useTranslation()
  const version = useSyncExternalStore(
    (listener) => queue.subscribe(listener),
    () => queue.version,
    () => queue.version,
  )
  // `version` is the render trigger; the list itself is read fresh on every render.
  void version
  const items = queue.items
  const settled = items.every((item) => item.status !== "running" && item.status !== "queued")

  useEffect(() => {
    if (!settled) return
    // Nothing is moving any more: let the result sit for a moment, then tidy up.
    const timer = setTimeout(() => queue.clearFinished(), LINGER_MS)
    return () => clearTimeout(timer)
  }, [queue, settled])

  return (
    // A custom toast is deliberately left unstyled by sonner, so the surface is ours:
    // without it the card would be transparent over whatever is behind it.
    <div className="flex w-[320px] flex-col gap-2 rounded-[var(--radius)] border border-border bg-popover p-3 text-popover-foreground shadow-lg">
      <span className="text-xs font-medium">{t("files.transfers")}</span>
      <ul className="flex flex-col gap-2">
        {items.map((item) => (
          <TransferRow key={item.id} item={item} queue={queue} />
        ))}
      </ul>
    </div>
  )
}

function TransferRow({ item, queue }: { item: TransferItem; queue: TransferQueue }) {
  const { t } = useTranslation()
  const total = item.size || 1
  const percent = Math.min(100, Math.round((item.transferred / total) * 100))
  const label = item.status === "running" ? `${percent}%`
    : item.status === "queued" ? t("files.transferQueued")
    : item.status === "done" ? t("files.transferDone")
    : item.status === "failed" ? t("files.transferFailed")
    : t("files.transferCanceled")

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5 text-[11px]">
        {item.direction === "upload" ? <Upload className="size-3 shrink-0 text-muted-foreground" /> : <Download className="size-3 shrink-0 text-muted-foreground" />}
        <span className={cn("truncate", item.status === "canceled" && "text-muted-foreground line-through")}>{item.name}</span>
        <span className={cn("ml-auto shrink-0 tabular-nums", item.status === "failed" ? "text-danger" : item.status === "done" ? "text-ok" : "text-muted-foreground")}>
          {label}
        </span>
        {(item.status === "failed" || item.status === "canceled") && (
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("files.transferRetry")}
            className="text-muted-foreground hover:text-foreground"
            onClick={() => queue.retry(item.id)}
          >
            <RotateCcw />
          </Button>
        )}
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={item.status === "queued" || item.status === "running" ? t("files.transferCancel") : t("files.transferRemove")}
          className="text-muted-foreground hover:bg-danger/15 hover:text-danger active:bg-danger/25"
          onClick={() => {
            if (item.status === "queued" || item.status === "running") void queue.cancel(item.id)
            else queue.remove(item.id)
          }}
        >
          <X />
        </Button>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-muted/60" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100} aria-label={item.name}>
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-200",
            item.status === "failed" ? "bg-danger" : item.status === "done" ? "bg-ok" : "bg-primary",
          )}
          style={{ width: `${percent}%` }}
        />
      </div>
      <span className="font-mono text-[11px] text-muted-foreground">
        {formatBytes(item.transferred)} / {formatBytes(item.size)}
      </span>
    </li>
  )
}
