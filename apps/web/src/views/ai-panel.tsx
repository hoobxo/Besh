import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import type { AttachmentRef } from "@/lib/api"

import { Hint } from "@/components/hint"
import { PromptDialog } from "@/components/prompt-dialog"
import { cn } from "@/lib/utils"
import { parseBlocks, type InlineToken } from "@/lib/markdown"

import { Bot, Check, ChevronDown, ChevronUp, Copy, Loader2, Menu, Pencil, Plus, Trash2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { AiComposer } from "@/views/ai-composer"

export type AiProposal = {
  id: string
  command: string
  purpose: string
  risk: "read" | "write" | "destructive"
  reason: string
  expiresAt: number
  autoRun?: boolean
}

type AiDenied = {
  denied: true
  command: string
  risk: "read" | "write" | "destructive"
  reason: string
}

type Entry =
  | { kind: "user"; text: string; attachments?: AttachmentRef[] }
  | { kind: "assistant"; text: string; streaming?: boolean }
  | {
      kind: "proposal"
      proposal: AiProposal
      state: "pending" | "approved" | "rejected" | "expired"
      output?: string
      exitCode?: number | null
    }
  | { kind: "denied"; denial: AiDenied }
  | { kind: "result"; command: string; output: string; exitCode: number | null }
  | { kind: "error"; message: string }
  | { kind: "note"; text: string }

/** Token counts for one scope, exactly as the session object reported them. */
export type TokenTotals = {
  promptTokens: number
  completionTokens: number
  totalTokens: number
  requests: number
}

/** What the session object published: this conversation and the whole day. */
export type AiUsage = {
  conversation: TokenTotals
  day: TokenTotals
}

export type AiState = {
  entries: Entry[]
  busy: boolean
  configured: boolean
  usage: AiUsage | null
}

/**
 * The assistant panel.
 *
 * Presentation only: it renders whatever the session object reported and calls
 * back for actions. Risk labels come from the server, never computed here — the
 * browser must not be the thing deciding how dangerous a command is.
 */
type StoredConversation = { id: string; title: string; updatedAt: number }

export function AiPanel({
  state,
  imagesAllowed,
  onAsk,
  onStop,
  onApprove,
  onReject,
  onClear,
  conversations,
  onListConversations,
  onOpenConversation,
  onNewConversation,
  onRemoveConversation,
  onRenameConversation,
  permission,
}: {
  imagesAllowed: boolean
  state: AiState
  onAsk: (text: string, attachments: AttachmentRef[]) => void
  onStop: () => void
  onApprove: (proposalId: string, command: string) => void
  onReject: (proposalId: string) => void
  onClear: () => void
  conversations: StoredConversation[]
  onListConversations: () => void
  onOpenConversation: (conversationId: string) => void
  onNewConversation: () => void
  onRemoveConversation: (conversationId: string) => void
  onRenameConversation: (conversationId: string, title: string) => void
  permission: "readonly" | "confirm" | "semi-auto"
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState<StoredConversation | null>(null)
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" })
  }, [state.entries.length])

  const disabled = !state.configured || state.busy || permission === "readonly"
  // The answer is arriving; a spinner below it would claim nothing is happening.
  const lastEntry = state.entries.at(-1)
  const streaming = lastEntry?.kind === "assistant" && lastEntry.streaming === true


  return (
    <div className="ai-panel flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-card px-3">
        <Bot className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <span className="text-[13px] font-semibold">{t("ai.title")}</span>
        {/* The permission decides whether a command runs by itself, so it carries the
            same state colours as the rest of the interface: safe, careful, exposed. */}
        <span
          className={`shrink-0 rounded-[4px] border px-1.5 py-0.5 font-mono text-[11px] ${
            permission === "readonly"
              ? "border-ok/40 bg-ok/10 text-ok"
              : permission === "confirm"
                ? "border-warn/40 bg-warn/10 text-warn"
                : "border-danger/40 bg-danger/10 text-danger"
          }`}
        >
          {t(`ai.permission.${permission}`)}
        </span>
        <span className="flex-1" />
        <Hint label={t("ai.clear")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground hover:text-danger"
            aria-label={t("ai.clear")}
            disabled={state.entries.length === 0 || state.busy}
            onClick={() => {
              onClear()
              onListConversations()
            }}
          >
            <Trash2 />
          </Button>
        </Hint>
        <Hint label={t("ai.conversations")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 text-muted-foreground"
            aria-label={t("ai.conversations")}
            aria-expanded={open}
          onClick={() => {
            onListConversations()
            setOpen((value) => !value)
          }}
        >
            <Menu />
          </Button>
        </Hint>
      </div>

      {open && (
        <div className="shrink-0 border-b border-border bg-card">
          <div className="flex max-h-[38vh] flex-col gap-0.5 overflow-y-auto p-1.5" role="list" aria-label={t("ai.conversations")}>
            {conversations.length === 0 && (
              <p className="px-2 py-1.5 text-[13px] text-muted-foreground">{t("ai.noConversations")}</p>
            )}
            {conversations.map((conversation) => (
              <div
            key={conversation.id}
            role="listitem"
            className="group relative flex h-9 w-full shrink-0 items-center rounded-lg pl-2.5 pr-1 hover:bg-muted"
          >
                <button
                  type="button"
                  // The rename and delete buttons sit over the end of this row; the
                  // title stops before them instead of running underneath.
                  className="min-w-0 flex-1 truncate pr-16 text-left text-[13px]"
                  onClick={() => {
                    onOpenConversation(conversation.id)
                    setOpen(false)
                  }}
                >
                  {conversation.title}
                </button>
                <span className="shrink-0 font-mono text-[11px] text-muted-foreground group-hover:opacity-0">
                  {relativeTime(conversation.updatedAt, t)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-events-none absolute right-8 top-1 size-7 text-muted-foreground opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                  aria-label={t("ai.renameConversation")}
                  onClick={() => setRenaming(conversation)}
                >
                  <Pencil />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="pointer-events-none absolute right-1 top-1 size-7 text-muted-foreground opacity-0 hover:text-danger group-hover:pointer-events-auto group-hover:opacity-100 focus-visible:pointer-events-auto focus-visible:opacity-100"
                  aria-label={t("ai.removeConversation", { title: conversation.title })}
                  onClick={() => onRemoveConversation(conversation.id)}
                >
                  <X />
                </Button>
              </div>
            ))}
          </div>
          <div className="flex justify-center p-1.5 pt-0">
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-3 text-[13px]"
              onClick={() => {
                onNewConversation()
                setOpen(false)
              }}
            >
              <Plus className="size-3.5" aria-hidden="true" />
              {t("ai.newConversation")}
            </Button>
          </div>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        <div className="flex min-h-full w-full min-w-0 flex-col gap-3 px-3 py-3">
          {state.entries.length === 0 && (
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {state.configured ? t("ai.hint") : t("ai.notConfigured")}
            </p>
          )}

          {/* A new message rises into place; streaming edits the same node, so the
              animation does not replay on every fragment. */}
          {state.entries.map((entry, index) => (
            <div
              key={index}
              className="min-w-0 animate-in fade-in-0 slide-in-from-bottom-1 duration-200 ease-[var(--ease-out-soft)]"
            >
              {entry.kind === "user" && (
                <div className="ml-auto flex w-fit max-w-[92%] flex-col items-end gap-1.5">
                  {entry.text && (
                    <div className="rounded-lg rounded-br-[3px] border border-border bg-muted px-2.5 py-1.5 text-[13px] leading-relaxed">
                      {entry.text}
                    </div>
                  )}
                  {/* The bytes live in the object store, keyed by the id stored with
                      the turn, so a restored thread shows the same pictures the
                      model saw instead of a file name. */}
                  {entry.attachments && entry.attachments.length > 0 && (
                    <div className="flex flex-wrap justify-end gap-1.5">
                      {entry.attachments.map((file) => (
                        <img
                          key={file.id}
                          src={`/api/attachments/${file.id}`}
                          alt={file.name}
                          title={file.name}
                          loading="lazy"
                          decoding="async"
                          className="h-24 w-24 rounded-md border border-border object-cover"
                        />
                      ))}
                    </div>
                  )}
                </div>
              )}

              {entry.kind === "assistant" && <AssistantReply text={entry.text} streaming={entry.streaming === true} />}

              {entry.kind === "proposal" && (
                <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
                    <span className="shrink-0 font-mono text-[13px] text-muted-foreground" aria-hidden="true">
                      $
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.proposal.command}</code>
                    <RiskBadge risk={entry.proposal.risk} />
                  </div>

                  {entry.state === "pending" ? (
                    <div className="flex items-center gap-2 px-2.5 py-2">
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                        {entry.proposal.purpose || t("ai.state.pending")}
                      </span>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-3 text-[13px] text-danger hover:text-danger"
                        disabled={disabled}
                        onClick={() => onReject(entry.proposal.id)}
                      >
                        {t("ai.reject")}
                      </Button>
                      <Button
                        size="sm"
                        className="h-7 px-3 text-[13px]"
                        disabled={disabled}
                        onClick={() => onApprove(entry.proposal.id, entry.proposal.command)}
                      >
                        {t("ai.approve")}
                      </Button>
                    </div>
                  ) : (
                    <>
                      {entry.output !== undefined && <ToolOutput text={entry.output} />}
                      {/* outcome last: you read the command, then what it did */}
                      <div
                        className={cn(
                          "flex items-center gap-1.5 border-t border-border px-2.5 py-1.5 font-mono text-[11px]",
                          outcomeTone(entry.state, entry.exitCode)
                        )}
                      >
                        <span>{outcomeLabel(entry.state, entry.exitCode, t)}</span>
                        {typeof entry.exitCode === "number" && (
                          <span
                            className={cn(
                              "ml-auto",
                              entry.exitCode === 0 ? "text-muted-foreground" : "text-danger"
                            )}
                          >
                            {t("ai.exitCode", { code: entry.exitCode })}
                          </span>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {entry.kind === "denied" && (
                <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
                    <span className="shrink-0 font-mono text-[13px] text-muted-foreground" aria-hidden="true">
                      $
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-muted-foreground line-through">
                      {entry.denial.command}
                    </code>
                    <RiskBadge risk={entry.denial.risk} />
                  </div>
                  <div className="px-2.5 py-1.5 text-[11px] text-danger">
                    {t("ai.denied")} · {entry.denial.reason}
                  </div>
                </div>
              )}

              {entry.kind === "result" && (
                <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
                  <div className="flex items-center gap-2 border-b border-border px-2.5 py-1.5">
                    <span className="shrink-0 font-mono text-[13px] text-muted-foreground" aria-hidden="true">
                      $
                    </span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[13px]">{entry.command}</code>
                  </div>
                  <div className="flex items-center gap-1.5 px-2.5 py-1.5 font-mono text-[11px] text-muted-foreground">
                    <span>
                      {typeof entry.exitCode === "number"
                        ? t("ai.exitCode", { code: entry.exitCode })
                        : t("ai.state.unconfirmed")}
                    </span>
                  </div>
                  <ToolOutput text={entry.output} />
                </div>
              )}

              {entry.kind === "error" && <p className="text-[13px] text-destructive">{entry.message}</p>}

      {entry.kind === "note" && (
        <p className="mx-auto w-fit rounded-full border border-border/70 px-2 py-0.5 text-[11px] text-muted-foreground">
          {entry.text}
        </p>
      )}
            </div>
          ))}
          {/* While text is streaming, the answer itself is the progress: a spinner under it
          would claim nothing is happening. */}
      {state.busy && !streaming && (
        <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
          {t("ai.thinking")}
        </div>
      )}
          <div ref={bottom} />
        </div>
      </div>

      <PromptDialog
        open={renaming !== null}
        title={t("ai.renameConversation")}
        label={t("ai.renamePrompt")}
        defaultValue={renaming?.title ?? ""}
        confirmLabel={t("ai.renameConversation")}
        onOpenChange={(value) => !value && setRenaming(null)}
        onSubmit={(value) => {
          if (renaming) onRenameConversation(renaming.id, value)
          setRenaming(null)
        }}
      />

      <AiComposer
        imagesAllowed={imagesAllowed}
        disabled={!state.configured || permission === "readonly"}
        busy={state.busy || state.entries.some((entry) => entry.kind === "proposal" && entry.state === "pending")}
        onSend={onAsk}
        onStop={onStop}
      />

      {state.usage && state.usage.conversation.requests > 0 && (
        <p className="pb-1 text-center text-[11px] tabular-nums text-muted-foreground">
          {t("ai.usage", {
            conversation: state.usage.conversation.totalTokens.toLocaleString(),
            day: state.usage.day.totalTokens.toLocaleString(),
          })}
        </p>
      )}
    </div>
  )
}

/** Risk chip on a command card: the level always comes from the server. */
/**
 * An approval whose reply never arrived has no exit status: the command may well have
 * run, so calling it "ran" in green would overstate what we know.
 */
function outcomeTone(state: string, exitCode: number | null | undefined): string {
  if (state !== "approved") return state === "expired" ? "text-warn" : "text-danger"
  return exitCode === null ? "text-warn" : "text-ok"
}

function outcomeLabel(state: string, exitCode: number | null | undefined, t: (key: string) => string): string {
  return state === "approved" && exitCode === null ? t("ai.state.unconfirmed") : t(`ai.state.${state}`)
}

function RiskBadge({ risk }: { risk: "read" | "write" | "destructive" }) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        "shrink-0 rounded border px-1 py-0.5 text-[11px] font-medium",
        risk === "destructive"
          ? "border-danger/40 text-danger"
          : risk === "write"
            ? "border-warn/40 text-warn"
            : "border-ok/40 text-ok"
      )}
    >
      {t(`ai.risk.${risk}`)}
    </span>
  )
}

/** Above this the reply is folded: one long answer used to push everything else away. */
const COLLAPSE_CHARS = 700

/**
 * Tool output is folded sooner than prose: `cat` on a config file is reference
 * material, not something to read, and a hundred lines of it used to leave no room
 * for the answer that follows. Counted, not measured, so it does not depend on
 * layout having run.
 */
const OUTPUT_LINES = 12
const OUTPUT_CHARS = 800

/**
 * The fold control.
 *
 * A bare text link read as a caption and vanished against the card. This is a
 * real button, sits on the fade, and the chevron points the way the content goes.
 */
function FoldButton({ expanded, label, onClick }: { expanded: boolean; label: string; onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="rounded-full bg-card px-2.5 text-[11px] font-medium text-muted-foreground shadow-xs hover:text-foreground"
      onClick={onClick}
      aria-expanded={expanded}
    >
      {expanded ? <ChevronUp data-icon="inline-start" /> : <ChevronDown data-icon="inline-start" />}
      {label}
    </Button>
  )
}

/** A tool's output, folded once it stops being something you can take in at a glance. */
function ToolOutput({ text }: { text: string }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const lines = text.trim().length === 0 ? 0 : text.replace(/\n+$/, "").split("\n").length
  const foldable = lines > OUTPUT_LINES || text.length > OUTPUT_CHARS
  const collapsed = foldable && !expanded
  return (
    <div>
      {/* Even opened, a huge capture gets its own scroll: otherwise the control
          that closes it ends up a screen away from where you clicked. */}
      <div className={cn("relative", collapsed && "max-h-[168px] overflow-hidden", foldable && !collapsed && "max-h-[420px] overflow-y-auto")}>
        <pre className="overflow-x-auto whitespace-pre px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {text || t("ai.noOutput")}
        </pre>
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {foldable && (
        <div className="flex justify-center pb-2 pt-0.5">
          <FoldButton
            expanded={expanded}
            label={expanded ? t("ai.fold") : t("ai.expandOutput", { lines })}
            onClick={() => setExpanded((value) => !value)}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Assistant prose with a fold.
 *
 * A streaming reply is never folded, because the text would jump under the reader
 * while it grows; once it settles, anything tall enough to hide the rest of the
 * conversation collapses.
 */
function AssistantReply({ text, streaming }: { text: string; streaming: boolean }) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const foldable = !streaming && text.length > COLLAPSE_CHARS
  const collapsed = foldable && !expanded
  return (
    <div className="min-w-0">
      <div className={cn("relative min-w-0", collapsed && "max-h-[264px] overflow-hidden")}>
        <AssistantText text={text} />
        {collapsed && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card to-transparent" />
        )}
      </div>
      {foldable && (
        <div className="mt-2 flex justify-center">
          <FoldButton
            expanded={expanded}
            label={expanded ? t("ai.fold") : t("ai.unfold")}
            onClick={() => setExpanded((value) => !value)}
          />
        </div>
      )}
    </div>
  )
}

/**
 * Assistant prose.
 *
 * Blocks come from `parseBlocks`; this only decides how they look. Nothing here
 * builds HTML from the reply, so a model cannot introduce markup.
 */
function AssistantText({ text }: { text: string }) {
  const blocks = parseBlocks(text)
  return (
    <div className="flex min-w-0 flex-col gap-2 text-[13px] leading-relaxed text-muted-foreground">
      {blocks.map((block, index) => {
        switch (block.type) {
          case "code":
            return <CodeBlock key={index} language={block.language} text={block.text} />
          case "table":
            return (
              <div key={index} className="min-w-0 overflow-x-auto rounded-lg border border-border">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-border bg-muted">
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} className="px-2 py-1 text-left font-medium text-foreground">
                          {inline(cell)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex} className="border-b border-border last:border-0">
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} className="px-2 py-1 align-top">
                            {inline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case "heading":
            return (
              <p
                key={index}
                className={cn(
                  "font-semibold text-foreground",
                  block.level === 1 ? "text-[15px]" : block.level === 2 ? "text-[13px]" : "text-[13px]"
                )}
              >
                {inline(block.tokens)}
              </p>
            )
          case "quote":
            return (
              <blockquote key={index} className="border-l-2 border-border pl-2.5">
                {inline(block.tokens)}
              </blockquote>
            )
          case "list":
            return block.ordered ? (
              <ol key={index} className="flex list-decimal flex-col gap-1 pl-5">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </ol>
            ) : (
              <ul key={index} className="flex list-disc flex-col gap-1 pl-4">
                {block.items.map((item, itemIndex) => (
                  <li key={itemIndex}>{inline(item)}</li>
                ))}
              </ul>
            )
          case "rule":
            return <hr key={index} className="border-border" />
          default:
            return (
              <p key={index} className="whitespace-pre-wrap">
                {inline(block.tokens)}
              </p>
            )
        }
      })}
    </div>
  )
}

/** Inline tokens: code, bold, links and plain text. */
function inline(tokens: InlineToken[]): React.ReactNode[] {
  return tokens.map((token, index) => {
    if (token.type === "code") {
      return (
        <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[13px] text-foreground">
          {token.text}
        </code>
      )
    }
    if (token.type === "bold") {
      return (
        <strong key={index} className="font-medium text-foreground">
          {token.text}
        </strong>
      )
    }
    if (token.type === "link") {
      return (
        <a
          key={index}
          href={token.href}
          target="_blank"
          rel="noreferrer noopener"
          className="text-foreground underline decoration-border underline-offset-2"
        >
          {token.text}
        </a>
      )
    }
    return <span key={index}>{token.text}</span>
  })
}

/** Relative label for a conversation row: just now / 14:02 / yesterday / 10/15. */
function relativeTime(timestamp: number, t: (key: string) => string): string {
  const now = new Date()
  const then = new Date(timestamp)
  const minutes = Math.round((now.getTime() - then.getTime()) / 60000)
  if (minutes < 1) return t("ai.timeNow")
  const sameDay = now.toDateString() === then.toDateString()
  if (sameDay) {
    return `${String(then.getHours()).padStart(2, "0")}:${String(then.getMinutes()).padStart(2, "0")}`
  }
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (yesterday.toDateString() === then.toDateString()) return t("ai.timeYesterday")
  return `${then.getMonth() + 1}/${then.getDate()}`
}

/** A fenced block with a copy control, since command output is meant to be reused. */
function CodeBlock({ language, text }: { language: string; text: string }) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard can be refused; the block is still selectable by hand
    }
  }

  return (
    <div className="group/code relative min-w-0">
      <pre className="min-w-0 overflow-x-auto rounded-lg border border-border bg-muted px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground">
        <code>{text}</code>
      </pre>
      <div className="absolute right-1.5 top-1.5 flex items-center gap-1 opacity-0 transition-opacity group-hover/code:opacity-100 focus-within:opacity-100">
        {language && (
          <span className="rounded bg-background/80 px-1 font-mono text-[11px] text-muted-foreground">{language}</span>
        )}
        <Hint label={copied ? t("ai.copied") : t("ai.copy")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="size-6 bg-background/80 text-muted-foreground hover:text-foreground"
            aria-label={copied ? t("ai.copied") : t("ai.copy")}
            onClick={() => void copy()}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
        </Hint>
      </div>
    </div>
  )
}
