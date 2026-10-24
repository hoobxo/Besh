/**
 * Short, readable CPU names.
 *
 * `/proc/cpuinfo` gives a marketing string such as
 * `Intel(R) Xeon(R) Platinum 8269CY CPU @ 2.50GHz`. In a 340px panel the useful
 * part is the family and the model number, so the trademarks, the marketing
 * suffixes and the clock speed (shown separately, bottom-right) are dropped.
 *
 * The result is only ever a label: nothing decides behaviour from it.
 */

const UNKNOWN = "—"

export function simplifyCpuName(name: string | null | undefined): string {
  if (!name) return UNKNOWN

  const cleaned = name
    // trademarks carry no meaning
    .replace(/\(R\)|\(TM\)|®|™/gi, "")
    // generic words every string has
    .replace(/\b(CPU|Processor|APU)\b/gi, "")
    // core counts are shown as "N 核" already
    .replace(/\b\d+[-\s]Core\b/gi, "")
    .replace(/\b\d+Core\b/gi, "")
    // parenthesised codenames
    .replace(/\([^)]*\)/g, "")
    // clock speed lives in its own corner
    .replace(/\s*@\s*[\d.]+\s*(GHz|MHz).*$/i, "")
    // trailing qualifiers
    .replace(/\bwith.*$/i, "")
    .replace(/\b(Gen|Generation)\s*\d+/gi, "")
    .replace(/\s+/g, " ")
    .trim()

  let result = ""

  if (/\bIntel\b/i.test(cleaned)) {
    result = "Intel"
    if (/\bCore\b/i.test(cleaned)) {
      const core = cleaned.match(/\b(i[3579])[-\s]*([\dA-Z]+)/i)
      result = core ? `Intel Core ${core[1]!.toLowerCase()}-${core[2]}` : "Intel Core"
    } else if (/\bXeon\b/i.test(cleaned)) {
      // keep the tier: Platinum and Gold are different machines to an operator
      const tier = cleaned.match(/\bXeon\s+(Platinum|Gold|Silver|Bronze)\b/i)
      const model = cleaned.match(/\bXeon\s+(?:Platinum|Gold|Silver|Bronze)?\s*([A-Z]?-?\d[\dA-Z-]*)/i)
      result = model
        ? `Intel Xeon ${tier ? `${capitalise(tier[1]!)} ` : ""}${model[1]}`
        : tier
          ? `Intel Xeon ${capitalise(tier[1]!)}`
          : "Intel Xeon"
    } else if (/\bPentium\b/i.test(cleaned)) {
      const match = cleaned.match(/\bPentium\s+([\w-]+)/i)
      result = match ? `Intel Pentium ${match[1]}` : "Intel Pentium"
    } else if (/\bCeleron\b/i.test(cleaned)) {
      const match = cleaned.match(/\bCeleron\s+([\w-]+)/i)
      result = match ? `Intel Celeron ${match[1]}` : "Intel Celeron"
    }
  } else if (/\bAMD\b/i.test(cleaned)) {
    result = "AMD"
    if (/\bRyzen\b/i.test(cleaned)) {
      const ryzen = cleaned.match(/\bRyzen\s+(\d)\s+([\dA-Z]+)/i)
      const loose = cleaned.match(/\bRyzen\s+([\w\s-]+?)\s*$/i)
      result = ryzen
        ? `AMD Ryzen ${ryzen[1]} ${ryzen[2]}`
        : loose
          ? `AMD Ryzen ${loose[1]!.trim()}`
          : "AMD Ryzen"
    } else if (/\bThreadripper\b/i.test(cleaned)) {
      const match = cleaned.match(/\bThreadripper\s+([\dA-Z]+)/i)
      result = match ? `AMD Threadripper ${match[1]}` : "AMD Threadripper"
    } else if (/\bEPYC\b/i.test(cleaned)) {
      const match = cleaned.match(/\bEPYC\s+([\dA-Z]+)/i)
      result = match ? `AMD EPYC ${match[1]}` : "AMD EPYC"
    } else if (/\bAthlon\b/i.test(cleaned)) {
      const match = cleaned.match(/\bAthlon\s+([\w\s-]+?)\s*$/i)
      result = match ? `AMD Athlon ${match[1]!.trim()}` : "AMD Athlon"
    }
  } else {
    // Unknown vendor: keep what is there, minus punctuation noise.
    result = cleaned.replace(/\s*,\s*/g, " ").replace(/\s+/g, " ").trim()
  }

  result = result.replace(/\s+/g, " ").trim()
  if (result.length === 0) return UNKNOWN
  // The panel clips anyway; cutting here keeps the ellipsis in the middle of a word
  // rather than letting CSS decide whether to show one at all.
  return result.length > 32 ? `${result.slice(0, 30)}…` : result
}

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
}
