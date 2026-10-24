/**
 * Resource metrics parsing.
 *
 * The collector runs one command and this module turns its output into numbers.
 * Parsing lives here, apart from the transport, so the shapes OpenSSH hosts
 * actually produce can be tested without a server.
 *
 * Command used by the collector:
 *   cat /proc/loadavg                  -> "0.08 0.03 0.00 1/123 4567"
 *   free -b                            -> header + "Mem:" and "Swap:" rows
 *   df -P -k /                         -> header + one row, 1K blocks
 *   grep -c ^processor /proc/cpuinfo   -> core count, so load can become a ratio
 *   hostname / os-release / uname / uptime -> the host card
 *   model name / cpu MHz / max freq    -> the CPU block's two detail corners
 */

import { simplifyCpuName } from "./cpu-name.ts"

export type MetricValue = {
  /** 0-100, or null when the host cannot report it. */
  percent: number | null
  detail: string
}

export type HostIdentity = {
  hostname: string
  os: string
  kernel: string
  uptimeSeconds: number | null
}

export type CpuMetric = MetricValue & {
  cores: number | null
  model: string
  /** MHz, from /proc/cpuinfo or the cpufreq ceiling. */
  mhz: number | null
}

export type MemoryMetric = MetricValue & {
  used: number | null
  total: number | null
  /** buff/cache, the figure the reference puts bottom-left. */
  cache: number | null
}

export type DiskMetric = MetricValue & {
  used: number | null
  total: number | null
}

export type HostMetrics = {
  host: HostIdentity
  cpu: CpuMetric
  memory: MemoryMetric
  swap: MetricValue | null
  disk: DiskMetric
}

export const METRICS_COMMAND = [
  "LC_ALL=C cat /proc/loadavg 2>/dev/null",
  "echo '---'",
  "LC_ALL=C free -b 2>/dev/null",
  "echo '---'",
  "LC_ALL=C df -P -k / 2>/dev/null",
  "echo '---'",
  "LC_ALL=C grep -c ^processor /proc/cpuinfo 2>/dev/null",
  "echo '---'",
  "LC_ALL=C hostname 2>/dev/null",
  ". /etc/os-release 2>/dev/null && printf '%s\\n' \"$PRETTY_NAME\"",
  "LC_ALL=C uname -r 2>/dev/null",
  "LC_ALL=C cut -d' ' -f1 /proc/uptime 2>/dev/null",
  "echo '---'",
  "LC_ALL=C grep -m1 -E 'model name|Hardware|Processor' /proc/cpuinfo 2>/dev/null | cut -d: -f2-",
  "LC_ALL=C grep -m1 -E 'cpu MHz' /proc/cpuinfo 2>/dev/null | cut -d: -f2-",
  "LC_ALL=C cat /sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_max_freq 2>/dev/null",
].join("; ")

const NUMBER = /(\d+(?:\.\d+)?)/

export function parseMetrics(output: string): HostMetrics {
  const [loadPart = "", freePart = "", dfPart = "", cpuPart = "", hostPart = "", modelPart = ""] = output.split("---")

  return {
    host: parseHost(hostPart),
    cpu: parseLoad(loadPart, cpuPart, modelPart),
    memory: parseMemory(freePart),
    swap: parseSwap(freePart),
    disk: parseDisk(dfPart),
  }
}

/** Four lines: hostname, os name, kernel release, uptime seconds. */
function parseHost(section: string): HostIdentity {
  const lines = section.split("\n").map((line) => line.trim())
  // echo '---' leaves a newline, so the first entry is empty before any field
  while (lines.length > 0 && lines[0] === "") lines.shift()
  const [hostname = "", os = "", kernel = "", uptime = ""] = lines
  const seconds = Number(uptime)
  return {
    hostname: hostname || "—",
    os: os || "—",
    kernel: kernel || "—",
    uptimeSeconds: Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : null,
  }
}

function parseLoad(section: string, cpuSection: string, modelSection: string): CpuMetric {
  const [modelLine = "", mhzLine = "", maxKHz = ""] = modelSection
    .split("\n")
    .map((line) => line.trim())
    .filter((line, index) => index > 0 || line !== "")
  // the raw marketing string is long; the panel has room for a family and a model
  const model = simplifyCpuName(modelLine)
  const mhzFromInfo = Number(mhzLine)
  const mhzFromMax = Number(maxKHz) / 1000
  const mhz = Number.isFinite(mhzFromInfo) && mhzFromInfo > 0
    ? Math.round(mhzFromInfo)
    : Number.isFinite(mhzFromMax) && mhzFromMax > 0
      ? Math.round(mhzFromMax)
      : null

  const match = section.trim().match(/^(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)/)
  const cores = parseCores(cpuSection)
  if (!match) return { percent: null, detail: "不可用", cores, model, mhz }
  const one = Number(match[1])
  const five = Number(match[2])
  const fifteen = Number(match[3])
  const triplet = `${one.toFixed(2)} / ${five.toFixed(2)} / ${fifteen.toFixed(2)}`

  // Load is a queue length, not a percentage. Dividing by the core count turns it
  // into a ratio a person can read, and the raw triplet stays in the detail so the
  // number behind the percentage is never hidden.
  if (cores === null) return { percent: null, detail: triplet, cores, model, mhz }
  return {
    percent: clampPercent((one / cores) * 100),
    detail: `${triplet} · ${cores} 核`,
    cores,
    model,
    mhz,
  }
}

function parseCores(section: string): number | null {
  const cores = Number(section.trim().split(/\s+/)[0])
  return Number.isFinite(cores) && cores > 0 ? cores : null
}

function parseMemory(section: string): MemoryMetric {
  const row = section.split("\n").find((line) => /^Mem:/.test(line.trim()))
  return parseUsageRow(row, "内存")
}

function parseSwap(section: string): MetricValue | null {
  const row = section.split("\n").find((line) => /^Swap:/.test(line.trim()))
  if (!row) return null
  const usage = parseUsageRow(row, "Swap")
  // A host without swap reports 0/0; showing "0%" would be misleading.
  return usage.percent === null ? null : usage
}

function parseUsageRow(row: string | undefined, label: string): MemoryMetric {
  if (!row) return { percent: null, detail: `${label}不可用`, used: null, total: null, cache: null }
  const numbers = row.trim().split(/\s+/).slice(1).map(Number)
  const total = numbers[0]
  const used = numbers[1]
  // free -b: total used free shared buff/cache available
  const cache = Number.isFinite(numbers[4]) ? numbers[4] : null
  if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) {
    return { percent: null, detail: `${label}不可用`, used: null, total: null, cache: null }
  }
  return {
    percent: clampPercent((used / total) * 100),
    detail: `${formatBytes(used)} / ${formatBytes(total)}`,
    used,
    total,
    cache,
  }
}

function parseDisk(section: string): DiskMetric {
  const line = section
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => /^\S+\s+\d+\s+\d+\s+\d+\s+\d+%/.test(entry))
  if (!line) return { percent: null, detail: "磁盘不可用", used: null, total: null }

  const columns = line.split(/\s+/)
  const totalKb = Number(columns[1])
  const usedKb = Number(columns[2])
  if (!Number.isFinite(totalKb) || !Number.isFinite(usedKb) || totalKb <= 0) {
    return { percent: null, detail: "磁盘不可用", used: null, total: null }
  }
  return {
    percent: clampPercent((usedKb / totalKb) * 100),
    detail: `${formatBytes(usedKb * 1024)} / ${formatBytes(totalKb * 1024)}`,
    used: usedKb * 1024,
    total: totalKb * 1024,
  }
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value))
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "—"
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

