import { useCallback, useEffect, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { useTranslation } from "react-i18next"
import { FitAddon } from "@xterm/addon-fit"
import { Terminal } from "@xterm/xterm"
import "@xterm/xterm/css/xterm.css"

import type { AiErrorCode } from "@besh/contracts"
import { api, trustHostKey, terminalSocket, type FsReply, type FsRequest, type TerminalMessage, type AttachmentRef } from "@/lib/api"
import { PendingRequests, ReconnectLoop, currentSocket, currentAiResponse, finishStreaming, fsReadKey, permanentConnectionError } from "@/lib/connection-lifecycle"
import { AiPanel, type AiProposal, type AiState, type AiUsage } from "@/views/ai-panel"
import { MetricsPanel, MetricsStrip, type HostMetrics } from "@/views/metrics-panel"
import { ClipboardPaste, Copy } from "lucide-react"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/confirm-dialog"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { SftpPanel, type FsOperation } from "@/views/sftp-panel"

/**
 * Attaches an xterm instance to a Besh terminal socket.
 *
 * The socket carries JSON with base64 payloads so the protocol stays textual end
 * to end; the conversion is confined here.
 */
/**
 * The terminal palette for the current theme.
 *
 * The light theme inverts rather than dimming: a dark block on a light page looks
 * like a hole, so the surface becomes light and the text dark. The two whites are
 * remapped as well — a shell that prints white text would otherwise print it on a
 * white background.
 */
function terminalTheme(dark: boolean) {
  if (dark) {
    return {
      background: "#000000",
      foreground: "#e4e4e7",
      cursor: "#e4e4e7",
      selectionBackground: "#3f3f46",
    }
  }
  return {
    background: "#f4f4f5",
    foreground: "#18181b",
    cursor: "#18181b",
    selectionBackground: "#d4d4d8",
    white: "#52525b",
    brightWhite: "#3f3f46",
  }
}

/** The three methods this client implements, in the reader's language. */
function methodName(method: string, t: (key: string) => string): string {
  if (method === "password") return t("server.authPassword")
  if (method === "publickey") return t("server.authKey")
  if (method === "keyboard-interactive") return t("terminal.authKeyboardInteractive")
  return method
}

export function TerminalView({ sessionId, serverId, ticket, onError, onReconnect, onStateChange, permission, aiConfigured, active }: {
  sessionId: string
  serverId: string
  ticket: string
  onReconnect: (signal?: AbortSignal) => Promise<void>
  /** Lets the tab show whether this session is live. */
  onStateChange: (state: "connected" | "disconnected") => void
  onError: (message: string) => void
  permission: "readonly" | "confirm" | "semi-auto"
  aiConfigured: boolean
  active: boolean
}) {
  const { t } = useTranslation()
  const host = useRef<HTMLDivElement>(null)
  const socketRef = useRef<WebSocket | null>(null)
  const requests = useRef(new PendingRequests<FsReply>())
  const ready = useRef(false)
  const activeAiRequest = useRef<number | null>(null)
  const currentConversation = useRef("default")
  const [connected, setConnected] = useState(false)
  /** Set when the user disconnects: the tab stays, the socket is gone. */
  const [detached, setDetached] = useState(false)
  /** Text selected in the terminal when the context menu opened. */
  const [selection, setSelection] = useState("")
  /** Set when the host presented a key that differs from the stored one. */
  const [hostKeyChange, setHostKeyChange] = useState<{ stored: string; presented: string } | null>(null)
  // Whether the chosen model reads pictures. Off until the settings say otherwise:
  // offering an attachment the provider would reject is worse than not offering it.
  const [imagesAllowed, setImagesAllowed] = useState(false)
  const refit = useRef<(() => void) | null>(null)
  /** Created once; reconnecting must not wipe the screen. */
  const fitRef = useRef<FitAddon | null>(null)
  const retry = useRef<ReconnectLoop | null>(null)
  /** Set when the user asked to disconnect: a retry must not fight that. */
  const intentional = useRef(false)
  const onReconnectRef = useRef(onReconnect)
  onReconnectRef.current = onReconnect
  /** Kept so the dock can clear the screen without owning a second instance. */
  const terminalRef = useRef<Terminal | null>(null)
  const translateRef = useRef(t)
  translateRef.current = t
  if (!retry.current) {
    retry.current = new ReconnectLoop({
      connect: (signal) => onReconnectRef.current(signal),
      scheduled: (attempt, wait) => terminalRef.current?.write(
        "\r\n\x1b[2m" + translateRef.current("terminal.reconnecting", { attempt, seconds: wait / 1000 }) + "\x1b[0m\r\n"
      ),
      exhausted: () => terminalRef.current?.write("\r\n\x1b[2m" + translateRef.current("terminal.reconnectFailed") + "\x1b[0m\r\n"),
      permanent: (error) => onErrorRef.current(error instanceof Error ? error.message : translateRef.current("terminal.connectFailed")),
    })
  }

  const [ai, setAi] = useState<AiState>({ entries: [], busy: false, configured: aiConfigured, usage: null })
  const [metrics, setMetrics] = useState<HostMetrics | null>(null)
  const [inspector, setInspector] = useState<HTMLElement | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)

  // the shell renders the column; rendering into it keeps this component the
  // owner of the socket while the column spans the full window height
  useEffect(() => {
    setInspector(document.getElementById("besh-inspector"))
  }, [])
  const aiId = useRef(1)

  /** Sends one assistant action; stale replies cannot re-open a finished stream. */
  const sendAi = useCallback((payload: Record<string, unknown>): boolean => {
    const socket = socketRef.current
    if (!ready.current || !socket || socket.readyState !== WebSocket.OPEN) {
      onErrorRef.current(translateRef.current("files.notConnected"))
      return false
    }
    const removesOther = payload.type === "ai.remove" && payload.conversationId !== currentConversation.current
    // A cancel must not look like a new request: it has to leave the thread and its
    // in-flight answer alone, and the server's answer is what clears the busy state.
    const bookkeeping = ["ai.conversations", "ai.rename", "ai.cancel"].includes(String(payload.type))
    if (!removesOther && !bookkeeping && typeof payload.id === "number") {
      activeAiRequest.current = payload.id
      setAi((current) => ({ ...current, busy: false, entries: finishStreaming(current.entries) }))
    }
    if (payload.type === "ai.open" && typeof payload.conversationId === "string") currentConversation.current = payload.conversationId
    socket.send(JSON.stringify(payload))
    return true
  }, [])

  const request = useCallback((op: FsOperation, path: string, extra: FsRequest = {}): Promise<FsReply> => {
    const socket = socketRef.current
    if (!ready.current || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(translateRef.current("files.notConnected")))
    }
    return requests.current.request(
      fsReadKey(op, path, extra),
      (id) => socket.send(JSON.stringify({ type: "fs", id, op, path, ...extra })),
      new Error(translateRef.current("files.timeout")),
    )
  }, [])
  const append = useCallback((entry: AiState["entries"][number]) => {
    setAi((current) => ({ ...current, entries: [...current.entries, entry] }))
  }, [])

  const askAi = useCallback(
    (text: string, attachments: AttachmentRef[] = []) => {
      if (!sendAi({ type: "ai.ask", id: aiId.current++, text, attachments })) return
      // The ids ride along with the turn, so the bubble can show the picture now and
      // after a reload; the bytes themselves never enter the session socket.
      append({ kind: "user", text, attachments })
      setAi((current) => ({ ...current, busy: true }))
    },
    [append, sendAi]
  )

  /** Stops the answer being written; the question and anything already shown stay. */
  const stopAi = useCallback(() => {
    sendAi({ type: "ai.cancel", id: aiId.current++ })
  }, [sendAi])

  const approveAi = useCallback(
    (proposalId: string, command: string) => {
      if (!sendAi({ type: "ai.approve", id: aiId.current++, proposalId, command })) return
      setAi((current) => ({ ...current, busy: true }))
    },
    [sendAi]
  )

  const [conversations, setConversations] = useState<Array<{ id: string; title: string; updatedAt: number }>>([])

  const clearAi = useCallback(() => {
    setAi((current) => ({ ...current, entries: [] }))
    sendAi({ type: "ai.clear", id: aiId.current++ })
  }, [sendAi])

  const listConversations = useCallback(() => {
    sendAi({ type: "ai.conversations", id: aiId.current++ })
  }, [sendAi])

  const openConversation = useCallback((conversationId: string) => {
    sendAi({ type: "ai.open", id: aiId.current++, conversationId })
  }, [sendAi])

  const newConversation = useCallback(() => {
    sendAi({ type: "ai.new", id: aiId.current++ })
  }, [sendAi])

  const renameConversation = useCallback((conversationId: string, title: string) => {
    sendAi({ type: "ai.rename", id: aiId.current++, conversationId, title })
  }, [sendAi])

  const removeConversation = useCallback((conversationId: string) => {
    sendAi({ type: "ai.remove", id: aiId.current++, conversationId })
  }, [sendAi])

  const rejectAi = useCallback(
    (proposalId: string) => {
      setAi((current) => ({
        ...current,
        entries: current.entries.map((entry) =>
          entry.kind === "proposal" && entry.proposal.id === proposalId
            ? { ...entry, state: "rejected" as const }
            : entry
        ),
      }))
      sendAi({ type: "ai.reject", id: aiId.current++, proposalId })
    },
    [sendAi]
  )

  const copySelection = useCallback(async () => {
    const text = terminalRef.current?.getSelection() ?? ""
    if (!text) return
    try {
      await navigator.clipboard.writeText(text)
      toast.success(t("terminal.copied"))
    } catch {
      toast.error(t("terminal.copyFailed"))
    }
    terminalRef.current?.clearSelection()
  }, [t])

  const pasteIntoTerminal = useCallback(async () => {
    const socket = socketRef.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    try {
      const text = await navigator.clipboard.readText()
      if (!text) return
      socket.send(JSON.stringify({ type: "input", data: encodeBase64(text) }))
      terminalRef.current?.focus()
    } catch {
      toast.error(t("terminal.pasteFailed"))
    }
  }, [t])

  useEffect(() => {
    let cancelled = false
    void api
      .settings()
      .then((settings) => {
        if (!cancelled) setImagesAllowed(settings.aiProvider.params.inputs.image)
      })
      .catch(() => {
        // An unreadable setting leaves the picker off; the dialog is where it is set.
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!active) return
    // the hidden tab could not measure itself, so re-fit before drawing into it
    const frame = requestAnimationFrame(() => refit.current?.())
    return () => cancelAnimationFrame(frame)
  }, [active])

  useEffect(() => {
    if (!connected) return
    const request = () => {
      const socket = socketRef.current
      if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "metrics", id: 0 }))
    }
    request()
    const timer = setInterval(request, 15_000)
    return () => clearInterval(timer)
  }, [connected])

  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  // The effect below must not re-run when the parent re-renders with a new callback.
  const onStateChangeRef = useRef(onStateChange)
  onStateChangeRef.current = onStateChange

  useEffect(() => {
    const apply = () => {
      const terminal = terminalRef.current
      if (!terminal) return
      terminal.options.theme = terminalTheme(document.documentElement.classList.contains("dark"))
    }
    apply()
    const observer = new MutationObserver(apply)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const element = host.current
    if (!element) return

    let terminal = terminalRef.current
    let fit = fitRef.current
    if (!terminal || !fit) {
      terminal = new Terminal({
        cursorBlink: true,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        fontSize: 13,
        theme: terminalTheme(document.documentElement.classList.contains("dark")),
      })
      fit = new FitAddon()
      terminal.loadAddon(fit)
      terminal.open(element)
      terminalRef.current = terminal
      fitRef.current = fit
    }
    fit.fit()

    const socket = terminalSocket(sessionId, ticket)
    socketRef.current = socket
    ready.current = false
    let disposed = false
    let closed = false
    const isCurrent = () => currentSocket(socketRef.current, socket, disposed, closed)

    socket.addEventListener("open", () => {
      if (!isCurrent()) return
      socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
    })
    const settleDisconnected = () => {
      ready.current = false
      requests.current.cancelAll(new Error(translateRef.current("files.notConnected")))
      activeAiRequest.current = null
      setAi((current) => ({ ...current, busy: false, entries: finishStreaming(current.entries) }))
      setConnected(false)
      setDetached(true)
    }
    const markClosed = () => {
      if (!isCurrent()) return
      closed = true
      terminal.options.disableStdin = true
      terminal.write("\r\n\x1b[2m" + t("files.connectionClosed") + "\x1b[0m\r\n\x1b[?25l")
      settleDisconnected()
      onStateChangeRef.current("disconnected")
      if (!intentional.current) retry.current?.failed()
    }
    socket.addEventListener("close", (event) => {
      if (!isCurrent()) return
      if (event.code === 1008 || event.code === 4001 || event.code === 4003) retry.current?.stop()
      markClosed()
    })
    socket.addEventListener("message", (event) => {
      if (!isCurrent()) return
      let message: TerminalMessage
      try { message = JSON.parse(String(event.data)) as TerminalMessage } catch { return }
      if (["ai.delta", "ai.reply", "ai.result", "ai.error", "ai.messages", "ai.cleared", "ai.rejected"].includes(message.type)) {
        if (!("id" in message) || !currentAiResponse(activeAiRequest.current, message.id)) return
      }
      if (message.type === "ready") {
        const reconnected = (retry.current?.attempt ?? 0) > 0
        retry.current?.ready()
        ready.current = true
        terminal.options.disableStdin = false
        terminal.write("\x1b[?25h")
        setConnected(true)
        setDetached(false)
        onStateChangeRef.current("connected")
        if (reconnected) terminal.write("\r\n\x1b[2m" + t("terminal.reconnected") + "\x1b[0m\r\n")
        // A session object is minted per connection, so it cannot remember which
        // conversation this tab was on; the browser does, and reopens it. Without
        // this a reload dropped the assistant back on an older conversation.
        const remembered = localStorage.getItem(`besh.ai.conversation.${serverId}`)
        currentConversation.current = remembered ?? "default"
        const restoreId = aiId.current++
        activeAiRequest.current = restoreId
        socket.send(JSON.stringify(remembered
          ? { type: "ai.open", id: restoreId, conversationId: remembered }
          : { type: "ai.history", id: restoreId }))
      }
      if (message.type === "data") terminal.write(decodeBase64(message.data))
      if (message.type === "error") {
        if (permanentConnectionError(message)) retry.current?.stop()
        // A changed host key is not a failure to report and forget: it needs a decision,
        // and only the administrator can tell a reinstall from an impersonation.
        if (message.code === "HOST_KEY_CHANGED" && message.hostKey) {
          setHostKeyChange(message.hostKey)
          markClosed()
        } else if (message.code === "AUTH_METHOD_UNSUPPORTED" && message.methods?.length) {
          // "Wrong password" and "this server does not take passwords" need different
          // fixes, and the server told us which one it is.
          const names = message.methods.map((method) => methodName(method, t)).join(t("app.listSeparator"))
          onErrorRef.current(t("terminal.authMethodUnsupported", { methods: names }))
        } else onErrorRef.current(message.message)
        markClosed()
        socket.close()
      }
      if (message.type === "closed") markClosed()
      if (message.type === "fs.result") {
        requests.current.resolve(message.id, message)
      }
      if (message.type === "fs.error") {
        const failure = new Error(message.message) as Error & { status?: number }
        failure.status = message.code
        requests.current.reject(message.id, failure)
      }
      if (message.type === "ai.conversationList") {
        const list = message as unknown as {
          current: string
          conversations: Array<{ id: string; title: string; updatedAt: number }>
        }
        setConversations(list.conversations)
      }
      if (message.type === "ai.usage") {
        const reported = message as unknown as AiUsage
        setAi((current) => ({ ...current, usage: reported }))
      }
      if (message.type === "ai.cleared") {
        setAi((current) => ({ ...current, entries: [], usage: null }))
      }
      if (message.type === "ai.canceled") {
        // The partial answer stays on screen: it is what the model had written and
        // deleting it would look like the question was never asked.
        setAi((current) => ({
          ...current,
          busy: false,
          entries: [...finishStreaming(current.entries), { kind: "note", text: t("ai.stopped") }],
        }))
      }
      if (message.type === "ai.messages") {
        const history = message as unknown as { conversationId?: string; entries: AiState["entries"] }
        // The server mints new ids (ai.new), so the reply is where the browser learns
        // which conversation it is looking at.
        if (history.conversationId) {
          currentConversation.current = history.conversationId
          localStorage.setItem(`besh.ai.conversation.${serverId}`, history.conversationId)
        }
        // Always replace the thread, including with nothing: switching to a new or
        // cleared conversation has to empty the panel, not leave the old turns up.
        setAi((current) => ({
          ...current,
          busy: false,
          entries: (history.entries ?? []).map((entry) =>
            entry.kind === "proposal" && entry.state === "pending"
              ? { ...entry, state: "expired" as const }
              : entry
          ),
        }))
      }
      if (message.type === "ai.delta") {
        const delta = message as unknown as { text: string }
        setAi((current) => {
          const entries: AiState["entries"] = [...current.entries]
          const last = entries.at(-1)
          // Fragments belong to the message being written now; once finalised the
          // marker is gone and the next fragment starts a new entry.
          if (last?.kind === "assistant" && last.streaming) {
            entries[entries.length - 1] = { ...last, text: last.text + delta.text }
          } else {
            entries.push({ kind: "assistant", text: delta.text, streaming: true })
          }
          return { ...current, entries, busy: true }
        })
      }
      if (message.type === "ai.reply") {
        const reply = message as unknown as { content: string; proposals: Array<AiProposal> }
        setAi((current) => {
          const entries: AiState["entries"] = [...current.entries]
          const last = entries.at(-1)
          if (last?.kind === "assistant" && last.streaming) {
            // The text already arrived as fragments; only its final state is missing.
            entries[entries.length - 1] = { kind: "assistant", text: last.text }
          } else if (reply.content?.trim()) {
            entries.push({ kind: "assistant", text: reply.content })
          }
          for (const item of reply.proposals ?? []) {
            if ((item as unknown as { denied?: boolean }).denied) {
              entries.push({ kind: "denied", denial: item as unknown as never })
            } else {
              entries.push({ kind: "proposal", proposal: item, state: "pending" })
            }
          }
          return { ...current, entries, busy: false }
        })
      }
      if (message.type === "ai.result") {
        const result = message as unknown as {
          proposalId?: string
          command: string
          output: string
          exitCode: number | null
        }
        setAi((current) => {
          const target = current.entries.findIndex(
            (entry) => entry.kind === "proposal" && entry.proposal.id === result.proposalId
          )
          if (target < 0) {
            return {
              ...current,
              busy: false,
              entries: [
                ...current.entries,
                { kind: "result", command: result.command, output: result.output, exitCode: result.exitCode },
              ],
            }
          }
          const entries = current.entries.map((entry, index) =>
            index === target && entry.kind === "proposal"
              ? { ...entry, state: "approved" as const, output: result.output, exitCode: result.exitCode }
              : entry
          )
          return { ...current, busy: false, entries }
        })
      }
      if (message.type === "metrics.result") {
        setMetrics((message as unknown as { metrics: HostMetrics }).metrics)
      }
      if (message.type === "ai.rejected") {
        const { proposalId } = message as unknown as { proposalId: string }
        setAi((current) => ({
          ...current,
          entries: current.entries.map((entry) =>
            entry.kind === "proposal" && entry.proposal.id === proposalId
              ? { ...entry, state: "rejected" as const }
              : entry
          ),
        }))
      }
      if (message.type === "ai.error") {
        const failure = message as unknown as { code: AiErrorCode; message: string }
        if (failure.code === "NOT_CONFIGURED") {
          setAi((current) => ({ ...current, configured: false, busy: false, entries: finishStreaming(current.entries) }))
        } else {
          toast.error(failure.message)
          setAi((current) => ({ ...current, busy: false, entries: finishStreaming(current.entries) }))
        }
        activeAiRequest.current = null
      }
    })
    socket.addEventListener("error", () => {
      if (!isCurrent()) return
      markClosed()
      socket.close()
    })

    refit.current = () => {
      fit.fit()
      if (isCurrent() && ready.current && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
      }
    }

    const disposable = terminal.onData((input) => {
      if (isCurrent() && ready.current && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "input", data: encodeBase64(input) }))
      }
    })

    const observer = new ResizeObserver(() => {
      if (disposed) return
      fit.fit()
      if (isCurrent() && ready.current && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows }))
      }
    })
    observer.observe(element)

    return () => {
      refit.current = null
      disposed = true
      observer.disconnect()
      disposable.dispose()
      requests.current.cancelAll(new Error(translateRef.current("files.notConnected")))
      activeAiRequest.current = null
      ready.current = false
      setConnected(false)
      setDetached(true)
      setAi((current) => ({ ...current, busy: false, entries: finishStreaming(current.entries) }))
      if (socketRef.current === socket) socketRef.current = null
      socket.close()
      // The terminal survives: a reconnect writes into the same screen.
    }
  }, [sessionId, ticket])

  useEffect(
    () => () => {
      retry.current?.stop()
      requests.current.cancelAll(new Error(translateRef.current("files.notConnected")))
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitRef.current = null
    },
    []
  )

  return (
    <div className="flex h-full min-h-0">
      <ConfirmDialog
        open={hostKeyChange !== null}
        title={t("terminal.hostKeyTitle")}
        description={
          hostKeyChange
            ? `${t("terminal.hostKeyStored")} ${hostKeyChange.stored}\n${t("terminal.hostKeyPresented")} ${hostKeyChange.presented}\n\n${t("terminal.hostKeyBody")}`
            : ""
        }
        confirmLabel={t("terminal.hostKeyTrust")}
        onOpenChange={(open) => !open && setHostKeyChange(null)}
        onConfirm={() => {
          const change = hostKeyChange
          setHostKeyChange(null)
          if (!change) return
          void trustHostKey(serverId, change.presented)
            .then(async () => {
              intentional.current = false
              retry.current?.reset()
              try { await onReconnectRef.current() } catch (error) { retry.current?.failed(error) }
            })
            .catch((reason: unknown) => toast.error(reason instanceof Error ? reason.message : t("terminal.hostKeyFailed")))
        }}
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              ref={host}
              className="min-h-0 flex-2 overflow-hidden bg-[var(--terminal-bg)] p-2"
              onContextMenu={() => setSelection(terminalRef.current?.getSelection() ?? "")}
            />
          </ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            <ContextMenuItem disabled={selection.length === 0} onSelect={() => void copySelection()}>
              <Copy data-icon="inline-start" />
              {t("terminal.copy")}
            </ContextMenuItem>
            <ContextMenuItem disabled={!connected} onSelect={() => void pasteIntoTerminal()}>
              <ClipboardPaste data-icon="inline-start" />
              {t("terminal.paste")}
            </ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden border-t border-border">
          <SftpPanel
            request={request}
            enabled={connected}
            detached={detached}
            onClearScreen={() => terminalRef.current?.clear()}
            onDisconnect={() => {
              intentional.current = true
              retry.current?.stop()
              ready.current = false
              requests.current.cancelAll(new Error(translateRef.current("files.notConnected")))
              activeAiRequest.current = null
              setAi((current) => ({ ...current, busy: false, entries: finishStreaming(current.entries) }))
              socketRef.current?.close()
              setConnected(false)
              setDetached(true)
            }}
            onReconnect={() => {
              // The user asked, so this attempt is not automatic any more.
              intentional.current = false
              retry.current?.reset()
              retry.current?.failed()
            }}
          />
        </div>
      </div>

      {inspector && active &&
        createPortal(
          <div className="flex min-h-0 flex-1 flex-col">
            <MetricsStrip metrics={metrics} open={detailsOpen} onToggle={() => setDetailsOpen((value) => !value)} />
            {detailsOpen && (
              <div className="shrink-0 border-b border-border">
                <MetricsPanel metrics={metrics} />
              </div>
            )}
            <div className="flex min-h-0 min-w-0 flex-1 flex-col border-t border-border">
              <AiPanel
              imagesAllowed={imagesAllowed}
                state={ai}
                onAsk={askAi}
                onStop={stopAi}
                onApprove={approveAi}
                onReject={rejectAi}
                onClear={clearAi}
                conversations={conversations}
                onListConversations={listConversations}
                onOpenConversation={openConversation}
                onNewConversation={newConversation}
                onRemoveConversation={removeConversation}
                onRenameConversation={renameConversation}
                permission={permission}
              />
            </div>
          </div>,
          inspector
        )}
    </div>
  )
}

function encodeBase64(value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(value)))
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
