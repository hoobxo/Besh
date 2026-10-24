import { useTranslation } from "react-i18next"

import { ChevronDown, ChevronUp, Gauge, ServerIcon } from "lucide-react"

import { formatBytes } from "@/lib/format"

type MetricValue = { percent: number | null; detail: string }

type CpuMetric = MetricValue & { cores: number | null; model: string; mhz: number | null }
type MemoryMetric = MetricValue & { used: number | null; total: number | null; cache: number | null }
type DiskMetric = MetricValue & { used: number | null; total: number | null }

type HostIdentity = {
  hostname: string
  os: string
  kernel: string
  uptimeSeconds: number | null
}

export type HostMetrics = {
  host: HostIdentity
  cpu: CpuMetric
  memory: MemoryMetric
  swap: MetricValue | null
  disk: DiskMetric
}

/**
 * Usage bands, in one place so the strip and the panel can never disagree.
 *
 * Up to 20% is comfortable, up to 60% needs a look, beyond that needs attention.
 */
type Tone = "ok" | "warn" | "danger"

const TEXT_TONE: Record<Tone, string> = {
  ok: "text-ok",
  warn: "text-warn",
  danger: "text-danger",
}

const BAR_TONE: Record<Tone, string> = {
  ok: "bg-ok",
  warn: "bg-warn",
  danger: "bg-danger",
}

function toneOf(percent: number): Tone {
  if (percent <= 20) return "ok"
  if (percent <= 60) return "warn"
  return "danger"
}

/** Collapsed summary: usage stays visible without opening anything. */
export function MetricsStrip({ metrics, open, onToggle }: {
  metrics: HostMetrics | null
  open: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()

  const segments = metrics
    ? [
        { key: "cpu", label: t("metrics.cpu"), value: metrics.cpu },
        { key: "memory", label: t("metrics.memory"), value: metrics.memory },
        { key: "disk", label: t("metrics.disk"), value: metrics.disk },
      ].filter((segment) => segment.value.percent !== null) as Array<{
        key: string
        label: string
        value: MetricValue
      }>
    : []

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-label={open ? t("metrics.collapse") : t("metrics.expand")}
      className="flex h-11 w-full shrink-0 items-center gap-2 bg-card px-3 text-left transition-colors hover:bg-muted"
    >
      <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{t("metrics.title")}</span>
      <span className="flex-1" />
      {segments.length > 0 ? (
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden font-mono text-[11.5px] tabular-nums">
          {segments.map((segment, index) => (
            <span key={segment.key} className="flex shrink-0 items-center gap-1.5">
              {index > 0 && <span className="text-muted-foreground">·</span>}
              <span className="text-muted-foreground">{segment.label}</span>
              {/* every metric carries its band, not just CPU */}
              <span className={TEXT_TONE[toneOf(segment.value.percent as number)]}>
                {Math.round(segment.value.percent as number)}%
              </span>
            </span>
          ))}
        </span>
      ) : (
        <span className="truncate font-mono text-[11.5px] text-muted-foreground">{t("metrics.waiting")}</span>
      )}
      {open ? (
        <ChevronUp className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : (
        <ChevronDown className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </button>
  )
}

/** Expanded detail: the host card and the usage card, as the reference lays them out. */
export function MetricsPanel({ metrics }: { metrics: HostMetrics | null }) {
  const { t } = useTranslation()

  if (!metrics) {
    return (
      <div className="bg-card p-3">
        <p className="text-[11.5px] text-muted-foreground">{t("metrics.waiting")}</p>
      </div>
    )
  }

  const cpu = metrics.cpu
  const memory = metrics.memory
  const disk = metrics.disk

  const rows = [
    {
      key: "cpu",
      label: t("metrics.cpu"),
      value: cpu as MetricValue,
      left: [cpu.cores ? t("metrics.cores", { count: cpu.cores }) : null, cpu.model].filter(Boolean).join(" "),
      right: cpu.mhz ? `${(cpu.mhz / 1000).toFixed(2)} GHz` : "—",
    },
    {
      key: "memory",
      label: t("metrics.memory"),
      value: memory as MetricValue,
      left: memory.cache !== null ? t("metrics.cache", { size: formatBytes(memory.cache) }) : "—",
      right:
        metrics.swap && metrics.swap.percent !== null
          ? t("metrics.swapLine", { detail: metrics.swap.detail })
          : t("metrics.noSwap"),
    },
    {
      key: "disk",
      label: t("metrics.disk"),
      value: disk as MetricValue,
      left: disk.used !== null ? t("metrics.used", { size: formatBytes(disk.used) }) : "—",
      right: disk.total !== null ? formatBytes(disk.total) : "—",
    },
  ]

  return (
    <div className="flex flex-col gap-3 bg-card px-3 pt-2 pb-1">
      <section className="flex flex-col gap-1.5 rounded-lg border border-border p-2.5">
        <header className="flex items-center gap-1.5 border-b border-border pb-1.5">
          <ServerIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold">{t("metrics.host")}</h3>
        </header>
        <dl className="flex flex-col text-[13px]">
          <HostRow label={t("metrics.hostname")} value={metrics.host.hostname} first />
          <HostRow label={t("metrics.os")} value={metrics.host.os} />
          <HostRow label={t("metrics.kernel")} value={metrics.host.kernel} />
          <HostRow label={t("metrics.uptime")} value={formatUptime(metrics.host.uptimeSeconds, t)} />
        </dl>
      </section>

      <section className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
        <header className="flex items-center gap-1.5 border-b border-border pb-1.5">
          <Gauge className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <h3 className="text-[13px] font-semibold">{t("metrics.usageCard")}</h3>
        </header>

        {rows.map((row) => {
          const percent = row.value.percent
          const tone = percent === null ? null : toneOf(percent)
          return (
            <div key={row.key} className="flex flex-col gap-1">
              {/* four corners, as the reference lays each metric out */}
              <div className="flex items-center justify-between font-mono text-[13px]">
                <span className="text-muted-foreground">{row.label}</span>
                <span className="font-semibold">
                  {percent !== null && tone ? (
                    <span className={TEXT_TONE[tone]}>{Math.round(percent)}%</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </span>
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full border border-border bg-background">
                {percent !== null && tone && (
                  <div
                    className={`h-full rounded-full ${BAR_TONE[tone]}`}
                    style={{ width: `${percent}%` }}
                    role="img"
                    aria-label={t("metrics.usage", { label: row.label, percent: Math.round(percent) })}
                  />
                )}
              </div>
              <div className="flex items-baseline justify-between gap-3 font-mono text-[11.5px] text-muted-foreground">
                <span className="min-w-0 truncate" title={row.left}>{row.left}</span>
                <span className="shrink-0" title={row.right}>{row.right}</span>
              </div>
            </div>
          )
        })}
      </section>
    </div>
  )
}

function HostRow({ label, value, first }: { label: string; value: string; first?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-3 py-1 ${first ? "" : "border-t border-border pt-2"}`}
    >
      <dt className="shrink-0 font-mono text-[11.5px] text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate font-mono text-[12px]" title={value}>
        {value}
      </dd>
    </div>
  )
}

/** Days and hours for long-lived hosts, minutes for recent boots. */
function formatUptime(seconds: number | null, t: (key: string, options?: Record<string, unknown>) => string): string {
  if (seconds === null) return "—"
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return t("metrics.uptimeDays", { days, hours })
  if (hours > 0) return t("metrics.uptimeHours", { hours, minutes })
  return t("metrics.uptimeMinutes", { minutes })
}
