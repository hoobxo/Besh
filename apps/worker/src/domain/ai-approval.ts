/**
 * Command risk classification and the approval gate.
 *
 * This is deliberately NOT a shell parser. Automatic execution accepts only a small
 * grammar: one bare command name and plain, unquoted arguments from an explicit policy.
 * Everything else needs confirmation, even when a human could recognise it as harmless.
 * A model's assertion that a command is read-only is never an input here.
 */
export type Risk = "read" | "write" | "destructive"
export type Permission = "readonly" | "confirm" | "semi-auto"

export type Verdict =
  | { action: "run"; risk: Risk }
  | { action: "confirm"; risk: Risk; reason: string }
  | { action: "deny"; risk: Risk; reason: string }

/** These patterns only raise risk; matching them can never authorise execution. */
const DESTRUCTIVE_PATTERNS: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)?\/(\s|$)/, "deletes from the filesystem root"],
  [/\brm\s+-[a-zA-Z]*r[a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*r/, "recursive forced delete"],
  [/\bmkfs(\.|\s)|dd\s+of=/, "formats or overwrites a device"],
  [/\b(shutdown|reboot|halt|poweroff)\b/, "takes the host down"],
  [/\b(iptables|nft)\s+-F|ufw\s+disable/, "drops the firewall"],
  [/>\s*\/dev\/(sd|nvme|vd)/, "writes straight to a block device"],
  [/\bchmod\s+-R\s+777\s+\/|\bchown\s+-R\b.*\s\/\s*$/, "rewrites ownership or modes at the root"],
  [/\bpasswd\b|\buserdel\b|\bgroupdel\b/, "changes account credentials"],
  [/\bhistory\s+-c|\btruncate\b.*\.log/, "destroys audit trails"],
]

/** Plain words only: quotes, expansions, escapes, globs and shell operators need review. */
const PLAIN_WORD = /^[A-Za-z0-9_./:@%+,=-]+$/

type ReadPolicy = {
  /** Whole flag tokens, or an anchored pattern allowing only known short flag letters. */
  flags: readonly (string | RegExp)[]
  /** Whether plain non-option operands are known to be reads for this tool. */
  operands?: boolean
}

/**
 * Explicit command AND argument policies. Being a familiar binary is not sufficient:
 * date can set the clock, hostname can change it, ss -K kills sockets, file -C writes
 * compiled magic, and less can log output/run a shell. Those modes are not authorised.
 *
 * No executable path is accepted, including /bin/ls: stripping a basename made /tmp/ls
 * look trusted. Wrappers such as env, command, sudo and shells also require confirmation.
 */
const READ_POLICIES: Readonly<Record<string, ReadPolicy>> = {
  ls: { flags: [/^-[alhndrtRSFip1]+$/, "--", "--all", "--almost-all", "--human-readable"], operands: true },
  cat: { flags: [/^-[bnsvETuA]+$/, "--"], operands: true },
  head: { flags: [/^-[ncvq](?:[0-9]+)?$/, /^-[0-9]+$/, "--"], operands: true },
  tail: { flags: [/^-[ncvq](?:[0-9]+)?$/, /^-[0-9]+$/, "--"], operands: true },
  df: { flags: [/^-[hHikTPla]+$/, "--"], operands: true },
  du: { flags: [/^-[hskmcaxSL]+$/, "--"], operands: true },
  wc: { flags: [/^-[lwmcL]+$/, "--"], operands: true },
  grep: { flags: [/^-[EinrvHhlcFwoxsqe]+$/, "--"], operands: true },
  stat: { flags: ["-L", "-f", "--", "--file-system"], operands: true },
  file: { flags: ["-b", "-i", "-L", "-h", "--", "--mime", "--mime-type"], operands: true },
  pwd: { flags: ["-L", "-P"] },
  whoami: { flags: [] },
  id: { flags: [/^-[ugGnrz]+$/], operands: true },
  uname: { flags: [/^-[asnrvmopio]+$/] },
  uptime: { flags: ["-p", "-s"] },
  free: { flags: [/^-[bkmgthw]+$/] },
  ps: { flags: ["aux", "ax", "-ef", "-e", "-f", "--forest"] },
  ss: { flags: [/^-[ltupnaerxos46]+$/] },
  netstat: { flags: [/^-[ltupnaerxos46]+$/] },
  lsblk: { flags: [/^-[aflmnpbr]+$/] },
  lscpu: { flags: [] },
  lsmem: { flags: [] },
  // Bare date/hostname read; arbitrary positional arguments can modify system state.
  date: { flags: ["-u", "--utc", "-I", "-R", /^\+[A-Za-z0-9_%:.,/-]+$/] },
  hostname: { flags: ["-f", "-s", "-d", "-i", "-I"] },
  echo: { flags: ["-n"], operands: true },
}

export function classifyRisk(command: string): { risk: Risk; reason: string } {
  const trimmed = command.trim()
  if (!trimmed) return { risk: "destructive", reason: "空命令" }

  for (const [pattern, reason] of DESTRUCTIVE_PATTERNS) {
    if (pattern.test(command)) return { risk: "destructive", reason }
  }

  // Check the original string, not just trim(): even trailing controls/newlines fall
  // outside this tiny language. Never split a shell expression and authorise its pieces.
  if (/[\x00-\x1f\x7f]/.test(command) || /[^\x20-\x7e]/.test(command)) {
    return { risk: "write", reason: "控制字符、换行或特殊字符需要人工确认" }
  }
  if (/[<>]/.test(trimmed)) return { risk: "write", reason: "重定向需要人工确认" }
  const words = trimmed.split(/ +/)
  if (words.some((word) => !PLAIN_WORD.test(word))) {
    return { risk: "write", reason: "Shell 语法、展开或引用需要人工确认" }
  }

  const [binary, ...args] = words
  // Do not interpret paths, environment assignments, wrappers, aliases or shell programs.
  if (!binary || !Object.hasOwn(READ_POLICIES, binary)) {
    return { risk: "write", reason: "命令不在自动只读执行范围内" }
  }
  const policy = READ_POLICIES[binary]!
  for (const arg of args) {
    if (policy.flags.some((flag) => typeof flag === "string" ? flag === arg : flag.test(arg))) continue
    if (policy.operands && !arg.startsWith("-")) continue
    return { risk: "write", reason: "命令参数未被确认为只读，需要人工确认" }
  }
  return { risk: "read", reason: "只读操作" }
}

/** readonly forbids all exec; confirm asks for everything; semi-auto uses the policy above. */
export function decide(permission: Permission, command: string): Verdict {
  const { risk, reason } = classifyRisk(command)
  if (permission === "readonly") {
    return { action: "deny", risk, reason: "当前权限为只读，不执行任何命令" }
  }
  if (permission === "confirm") return { action: "confirm", risk, reason }
  if (risk === "read") return { action: "run", risk }
  return { action: "confirm", risk, reason }
}
