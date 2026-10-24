/**
 * Target policy: which addresses may an SSH session connect to?
 *
 * A server administrator typing a hostname must not be able to make the Worker
 * dial loopback, RFC 1918 space, cloud metadata endpoints or anything else on
 * the internal network. This matters even with a single trusted admin, because
 * a mistyped or attacker-supplied hostname would otherwise turn the Worker into
 * an SSRF pivot.
 *
 * DNS is injected so the policy can be tested deterministically and so the
 * production resolver can be swapped without touching the rules.
 */

export type AddressResolver = (hostname: string) => Promise<string[]>

export type TargetResolution = {
  /** The hostname that was validated (never an IP literal from a redirect). */
  host: string
  /** Every answer must be public; the caller may dial any of them. */
  addresses: string[]
}

export class TargetRejectedError extends Error {
  readonly reason: TargetRejection

  constructor(reason: TargetRejection, message: string) {
    super(message)
    this.name = "TargetRejectedError"
    this.reason = reason
  }
}

export type TargetRejection =
  | "invalid-host"
  | "invalid-address"
  | "private"
  | "reserved"
  | "unresolvable"
  | "too-many-addresses"
  | "mixed"

const MAX_ADDRESSES = 16

type AddressKind = "public" | "private" | "reserved" | "invalid"
type ParsedAddress = { canonical: string; kind: Exclude<AddressKind, "invalid"> }

function ipv4Octets(value: string): number[] | null {
  const pieces = value.split(".")
  if (pieces.length !== 4 || pieces.some((piece) => !/^(0|[1-9][0-9]{0,2})$/.test(piece))) return null
  const octets = pieces.map(Number)
  return octets.every((octet) => octet <= 255) ? octets : null
}

function ipv4Kind(octets: number[]): Exclude<AddressKind, "invalid"> {
  const [a, b, c] = octets
  if (a === 10 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127)) return "private"
  if (a === 0 || a === 127 || a! >= 224 || (a === 169 && b === 254) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)) return "reserved"
  return "public"
}

/** Strict IPv6 grammar: exactly eight words after expanding at most one ::. */
function ipv6Words(input: string): number[] | null {
  let value = input
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":")
    if (lastColon < 0) return null
    const tail = ipv4Octets(value.slice(lastColon + 1))
    if (!tail) return null
    value = value.slice(0, lastColon + 1) +
      ((tail[0]! << 8) | tail[1]!).toString(16) + ":" + ((tail[2]! << 8) | tail[3]!).toString(16)
  }
  if (!/^[0-9a-f:]+$/i.test(value) || value.split("::").length > 2) return null
  const compressed = value.includes("::")
  const [left = "", right = ""] = value.split("::")
  const before = left ? left.split(":") : []
  const after = right ? right.split(":") : []
  if ([...before, ...after].some((word) => !/^[0-9a-f]{1,4}$/i.test(word))) return null
  const count = before.length + after.length
  if (compressed ? count >= 8 : count !== 8) return null
  return [...before.map((word) => parseInt(word, 16)),
    ...Array<number>(compressed ? 8 - count : 0).fill(0),
    ...after.map((word) => parseInt(word, 16))]
}

/** RFC 5952 form: lower-case, no leading zeroes, longest zero run (leftmost tie). */
function formatIpv6(words: number[]): string {
  let bestStart = -1
  let bestLength = 1
  for (let index = 0; index < words.length;) {
    if (words[index] !== 0) { index++; continue }
    const start = index
    while (index < words.length && words[index] === 0) index++
    if (index - start > bestLength) { bestStart = start; bestLength = index - start }
  }
  if (bestStart < 0) return words.map((word) => word.toString(16)).join(":")
  return words.slice(0, bestStart).map((word) => word.toString(16)).join(":") + "::" +
    words.slice(bestStart + bestLength).map((word) => word.toString(16)).join(":")
}

function parseAddress(address: string): ParsedAddress | null {
  let value = address.trim().toLowerCase()
  // A scope/zone id can change routing; it is not accepted on a public target.
  if (!value || value.includes("%")) return null
  if (value.startsWith("[") || value.endsWith("]")) {
    if (!value.startsWith("[") || !value.endsWith("]")) return null
    value = value.slice(1, -1)
    if (!value.includes(":")) return null
  }
  if (!value.includes(":")) {
    const octets = ipv4Octets(value)
    return octets ? { canonical: octets.join("."), kind: ipv4Kind(octets) } : null
  }
  const words = ipv6Words(value)
  if (!words) return null
  // Hex and dotted IPv4-mapped forms are the same address. Collapse both to IPv4,
  // applying precisely the same policy and returning that address for actual dialing.
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
    const octets = [words[6]! >> 8, words[6]! & 255, words[7]! >> 8, words[7]! & 255]
    return { canonical: octets.join("."), kind: ipv4Kind(octets) }
  }
  const canonical = formatIpv6(words)
  const first = words[0]!
  if ((first & 0xfe00) === 0xfc00) return { canonical, kind: "private" }
  // Only native global unicast is allowed. This excludes unspecified/loopback,
  // IPv4-compatible, link/site local, multicast, NAT64 and discard-only ranges.
  if ((first & 0xe000) !== 0x2000) return { canonical, kind: "reserved" }
  // IANA protocol assignments (including Teredo, benchmarking and ORCHID),
  // documentation and deprecated 6to4 must not tunnel around the IPv4 policy.
  if ((first === 0x2001 && words[1]! < 0x0200) ||
      (first === 0x2001 && words[1] === 0x0db8) || first === 0x2002 ||
      (first === 0x3fff && (words[1]! & 0xf000) === 0)) return { canonical, kind: "reserved" }
  return { canonical, kind: "public" }
}

/** Classifies canonical addresses, not textual prefixes of unexpanded IPv6. */
export function classifyAddress(address: string): AddressKind {
  return parseAddress(address)?.kind ?? "invalid"
}

/**
 * Validates a user-supplied target and every address it resolves to.
 *
 * All answers must be public: one private answer is enough for an attacker to
 * win the race with DNS rebinding, so a mixed set is rejected outright.
 */
export async function resolvePublicTarget(
  host: string,
  options: { resolve: AddressResolver; allowPrivate?: boolean }
): Promise<TargetResolution> {
  const trimmed = host.trim()
  if (trimmed.length === 0 || trimmed.length > 253) {
    throw new TargetRejectedError("invalid-host", "Hostname is empty or too long")
  }
  if (/[\s/@\\%]/.test(trimmed)) {
    throw new TargetRejectedError("invalid-host", "Hostname contains characters that are not allowed")
  }

  // Literal-looking values must parse as literals, never fall back to DNS. This also
  // refuses legacy numeric/octal forms rather than trusting a dialer's interpretation.
  if (/[\[\]:]/.test(trimmed) || /^[0-9.]+$/.test(trimmed) || /^0x[0-9a-f]+$/i.test(trimmed)) {
    const address = parseAddress(trimmed)
    if (!address) throw new TargetRejectedError("invalid-address", "Not a valid IP address")
    if (!options.allowPrivate && address.kind !== "public") {
      throw new TargetRejectedError(address.kind, "Target address is not public")
    }
    return { host: address.canonical, addresses: [address.canonical] }
  }

  const lowered = trimmed.toLowerCase().replace(/\.$/, "")
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(lowered)) {
    throw new TargetRejectedError("invalid-host", "Not a valid hostname")
  }
  if (!options.allowPrivate && (lowered === "localhost" || lowered.endsWith(".localhost") || lowered.endsWith(".internal") || lowered.endsWith(".local"))) {
    throw new TargetRejectedError("private", "Local hostnames are not allowed")
  }

  let answers: string[]
  try {
    answers = await options.resolve(lowered)
  } catch {
    throw new TargetRejectedError("unresolvable", "Hostname could not be resolved")
  }
  if (answers.length === 0) throw new TargetRejectedError("unresolvable", "Hostname resolved to no addresses")
  if (answers.length > MAX_ADDRESSES) {
    throw new TargetRejectedError("too-many-addresses", "Hostname resolves to too many addresses")
  }

  const parsed = answers.map(parseAddress)
  if (parsed.some((entry) => entry === null)) {
    throw new TargetRejectedError("invalid-address", "Resolver returned an address that is not parseable")
  }
  const kinds = parsed as ParsedAddress[]
  if (!options.allowPrivate && kinds.some((entry) => entry.kind !== "public")) {
    const privateOnes = kinds.filter((entry) => entry.kind !== "public")
    throw new TargetRejectedError(
      kinds.length > privateOnes.length ? "mixed" : "private",
      "Hostname resolves to a private or reserved address"
    )
  }

  return { host: lowered, addresses: [...new Set(kinds.map((entry) => entry.canonical))] }
}
