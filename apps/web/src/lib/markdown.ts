/**
 * The subset of Markdown an assistant actually emits.
 *
 * A model writes fenced code, headings, lists, quotes and the odd link; it does not
 * write raw HTML. Parsing stops at that boundary on purpose: nothing here produces
 * markup the panel did not ask for, so a reply cannot inject anything.
 */

export type InlineToken =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "bold"; text: string }
  | { type: "link"; text: string; href: string }

type Block =
  | { type: "paragraph"; tokens: InlineToken[] }
  | { type: "heading"; level: 1 | 2 | 3; tokens: InlineToken[] }
  | { type: "list"; ordered: boolean; items: InlineToken[][] }
  | { type: "quote"; tokens: InlineToken[] }
  | { type: "code"; language: string; text: string }
  | { type: "table"; header: InlineToken[][]; rows: InlineToken[][][] }
  | { type: "rule" }

const FENCE = /^\s*```(\S*)\s*$/
const HEADING = /^(#{1,3})\s+(.*)$/
const RULE = /^\s*(-{3,}|\*{3,}|_{3,})\s*$/
const BULLET = /^\s*[-*+]\s+(.*)$/
const ORDERED = /^\s*\d+[.)]\s+(.*)$/
const QUOTE = /^\s*>\s?(.*)$/
// | a | b |  followed by |---|---|
const TABLE_ROW = /^\s*\|(.+)\|\s*$/
const TABLE_RULE = /^\s*\|?[\s:-]*-[\s:|-]*\|?\s*$/

export function parseBlocks(source: string): Block[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
  const blocks: Block[] = []
  let paragraph: string[] = []

  const flush = () => {
    if (paragraph.length === 0) return
    blocks.push({ type: "paragraph", tokens: parseInline(paragraph.join("\n")) })
    paragraph = []
  }

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!

    const fence = line.match(FENCE)
    if (fence) {
      flush()
      const language = fence[1] ?? ""
      const body: string[] = []
      index += 1
      // An unterminated fence keeps what it has rather than swallowing the thread.
      while (index < lines.length && !FENCE.test(lines[index]!)) {
        body.push(lines[index]!)
        index += 1
      }
      blocks.push({ type: "code", language, text: body.join("\n") })
      continue
    }

    if (line.trim().length === 0) {
      flush()
      continue
    }

    if (RULE.test(line)) {
      flush()
      blocks.push({ type: "rule" })
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      flush()
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3,
        tokens: parseInline(heading[2]!),
      })
      continue
    }

    if (TABLE_ROW.test(line) && TABLE_RULE.test(lines[index + 1] ?? "")) {
      flush()
      const header = cellsOf(line)
      const rows: InlineToken[][][] = []
      let next = index + 2
      while (next < lines.length && TABLE_ROW.test(lines[next]!)) {
        rows.push(cellsOf(lines[next]!).map((cell) => parseInline(cell)))
        next += 1
      }
      index = next - 1
      blocks.push({ type: "table", header: header.map((cell) => parseInline(cell)), rows })
      continue
    }

    const quote = line.match(QUOTE)
    if (quote) {
      flush()
      blocks.push({ type: "quote", tokens: parseInline(quote[1]!) })
      continue
    }

    const bullet = line.match(BULLET)
    const ordered = line.match(ORDERED)
    if (bullet ?? ordered) {
      flush()
      const isOrdered = ordered !== null
      const items: InlineToken[][] = [parseInline((bullet ?? ordered)![1]!)]
      // consecutive items of the same kind join one list
      let next = index + 1
      while (next < lines.length) {
        const candidate = lines[next]!
        const match = isOrdered ? candidate.match(ORDERED) : candidate.match(BULLET)
        if (!match) break
        items.push(parseInline(match[1]!))
        next += 1
      }
      index = next - 1
      blocks.push({ type: "list", ordered: isOrdered, items })
      continue
    }

    paragraph.push(line)
  }

  flush()
  return blocks
}

/** Splits | a | b | into its cells, dropping the empty edges. */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim())
}

const INLINE = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)\s]+\))/g
const LINK = /^\[([^\]]+)\]\(([^)\s]+)\)$/

/** Inline code, bold and links. Anything else stays text, byte for byte. */
export function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = []
  let last = 0
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0
    if (index > last) tokens.push({ type: "text", text: text.slice(last, index) })
    const piece = match[0]

    if (piece.startsWith("`") && piece.length > 2) {
      tokens.push({ type: "code", text: piece.slice(1, -1) })
    } else if (piece.startsWith("**") && piece.length > 4) {
      tokens.push({ type: "bold", text: piece.slice(2, -2) })
    } else {
      const link = piece.match(LINK)
      const href = link?.[2] ?? ""
      // Only real web links become anchors; a model must not hand us javascript:.
      if (link && /^https?:\/\//i.test(href)) {
        tokens.push({ type: "link", text: link[1]!, href })
      } else {
        tokens.push({ type: "text", text: piece })
      }
    }
    last = index + piece.length
  }
  if (last < text.length) tokens.push({ type: "text", text: text.slice(last) })
  return tokens
}
