/**
 * One Durable Object per SSH session.
 *
 * The object owns the connection so the browser can come and go: a terminal that
 * drops its WebSocket does not tear down the shell, and the object is the only
 * place that ever holds the decrypted credential.
 *
 * Secrets never travel in URLs. The Worker tells the object which server to use
 * through an internal header, and the object loads and decrypts the credential
 * itself.
 */
import { SshConnection, SshConnectionError, SftpError, type SftpService } from "@besh/ssh-core"

import {
  forgetAttachments,
  readAttachmentDataUrl,
  replayAttachments,
  type AttachmentBucket,
  type AttachmentRef,
  type ReplayedAttachment,
} from "../domain/attachments.ts"
import { bytesToBase64 } from "../domain/bytes.ts"
import { readCredentialKey } from "../domain/credential-key.ts"
import { openCredential } from "../domain/credentials.ts"
import {
  buildUserContent,
  chat,
  readCommandProposal,
  type ChatAttachment,
  type ChatConfig,
  type ChatMessage,
  type ChatReply,
} from "../domain/ai-chat.ts"
import {
  claimProposal,
  createProposal,
  pruneProposals,
  rejectProposal,
  type Proposal,
} from "../domain/ai-proposal.ts"
import { readPermission } from "../domain/settings-store.ts"
import { resolveProvider } from "../domain/ai-provider.ts"
import {
  appendEntry,
  clearHistory,
  listConversations,
  listEntries,
  nameIfUntitled,
  titleFromQuestion,
  recordOutcome,
  renameConversation,
} from "../domain/ai-history.ts"
import { readConversationTotals, readDayTotals, recordUsage } from "../domain/ai-usage.ts"
import { METRICS_COMMAND, parseMetrics } from "../domain/metrics.ts"
import { wireEffort } from "../domain/ai-params.ts"
import { fitToWindow, messagesTokens, promptBudget } from "../domain/context-window.ts"
import { ConversationScope, type ConversationToken } from "../domain/ai-conversation-scope.ts"
import { getServerSecret, recordServerOs, recordTrust } from "../domain/server-store.ts"
import { TargetRejectedError, resolvePublicTarget } from "../domain/target.ts"
import { verifyTicket } from "../domain/ticket.ts"
import { checkSessionBinding, SESSION_BINDING_CHECK_INTERVAL_MS, type SessionBinding } from "../domain/session-binding.ts"
import { dohResolver } from "../platform/dns.ts"

export type SessionEnv = {
  DB: D1Database
  CREDENTIAL_KEY: string
  CREDENTIAL_KEY_VERSION?: string
  TICKET_SECRET: string
  /** OpenAI-compatible endpoint; all three are required for the assistant. */
  AI_BASE_URL?: string
  AI_API_KEY?: string
  AI_MODEL?: string
  /** AI attachment bytes, fetched only while a turn is being built. */
  ATTACHMENTS: AttachmentBucket
}

type FsOperation =
  | "list"
  | "read"
  | "stat"
  | "mkdir"
  | "create"
  | "remove"
  | "rename"
  | "upload.begin"
  | "upload.chunk"
  | "upload.end"
  | "upload.abort"

type ClientMessage =
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "close" }
  | {
      type: "fs"
      id: number
      op: FsOperation
      path?: string
      /** rename target */
      to?: string
      /** base64 payload for read results and upload pieces */
      data?: string
      /** how much a read may return, for downloads larger than a preview */
      maxBytes?: number
      /** byte offset for a sliced download */
      offset?: number
      uploadId?: string
    }
  | { type: "metrics"; id: number }
  | {
      type: "ai.ask"
      id: number
      text: string
      /** Files handed to the model as-is; text the user typed is still capped. */
      attachments?: AttachmentRef[]
    }
  | { type: "ai.approve"; id: number; proposalId: string; command?: string }
  | { type: "ai.cancel"; id: number }
  | { type: "ai.reject"; id: number; proposalId: string }
  | { type: "ai.history"; id: number }
  | { type: "ai.clear"; id: number }
  | { type: "ai.conversations"; id: number }
  | { type: "ai.open"; id: number; conversationId: string }
  | { type: "ai.new"; id: number }
  | { type: "ai.remove"; id: number; conversationId: string }
  | { type: "ai.rename"; id: number; conversationId: string; title: string }

/** How much of one command's output the panel and the model are shown. */
const MAX_PANEL_OUTPUT_CHARS = 20_000
const MAX_MODEL_OUTPUT_CHARS = 8_000

/** Marks the cut instead of letting a prefix pass for the whole output. */
function clipOutput(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…（仅显示前 ${maxChars} 字符）`
}

/** Where the assistant talks, and how it was told to answer. */
type ProviderTarget = {
  baseUrl: string
  model: string
  apiKey: string
  maxOutput?: number | null
  contextWindow?: number | null
  effort?: string | null
}

export class SessionOwner implements DurableObject {
  readonly #state: DurableObjectState
  readonly #env: SessionEnv
  #connection: SshConnection | null = null
  #keepalive: ReturnType<typeof setInterval> | null = null
  #socket: WebSocket | null = null
  #usedNonces = new Set<string>()
  #binding: SessionBinding | null = null
  #authorizationTimer: ReturnType<typeof setInterval> | null = null
  #inputQueue: Promise<void> = Promise.resolve()
  #cols = 80
  #rows = 24

  constructor(state: DurableObjectState, env: SessionEnv) {
    this.#state = state
    this.#env = env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required", { status: 426 })
    }
    return await this.#acceptTerminal(request, url)
  }

  async #acceptTerminal(request: Request, url: URL): Promise<Response> {
    const ticket = url.searchParams.get("ticket") ?? ""

    const payload = await verifyTicket(this.#env.TICKET_SECRET, ticket).catch(() => null)
    // The ticket is signed, so the server id inside it is trustworthy; an unsigned
    // header would have been the weaker source of truth.
    if (!payload) {
      return new Response("Invalid or expired session ticket", { status: 401 })
    }
    try {
      if (!await checkSessionBinding(this.#env.DB, payload.auth)) return new Response("Login session expired", { status: 401 })
    } catch {
      return new Response("Session verification unavailable", { status: 503 })
    }
    if (this.#socket) return new Response("Session already connected", { status: 409 })
    if (this.#usedNonces.has(payload.nonce)) {
      return new Response("Session ticket was already used", { status: 401 })
    }
    this.#usedNonces.add(payload.nonce)
    this.#binding = payload.auth

    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket]
    server.accept()
    this.#socket = server
    server.addEventListener("message", (event) => {
      void this.#onMessage(event.data).catch(() => {
        this.#send(server, { type: "error", code: "INTERNAL", message: "操作未完成，请重试" })
      })
    })
    this.#authorizationTimer = setInterval(() => { void this.#ensureAuthorized() }, SESSION_BINDING_CHECK_INTERVAL_MS)
    server.addEventListener("close", () => void this.#close())
    server.addEventListener("error", () => void this.#close())

    // Connect after the upgrade so a slow or failing server still reports through
    // the socket the browser is already listening on.
    this.#serverId = payload.srv
    this.#state.waitUntil(this.#connect(payload.srv, server))
    return new Response(null, { status: 101, webSocket: client })
  }

  async #connect(serverId: string, socket: WebSocket): Promise<void> {
    if (!await this.#ensureAuthorized()) return
    const stored = await getServerSecret(this.#env.DB, serverId)
    if (!stored) {
      this.#send(socket, { type: "error", code: "NOT_FOUND", message: "Server not found" })
      return
    }

    let secret: string
    try {
      secret = await openCredential(readKey(this.#env), stored.credential, {
        serverId,
        kind: stored.server.authMethod === "publickey" ? "privateKey" : "password",
      })
    } catch {
      this.#send(socket, { type: "error", code: "INTERNAL", message: "Credential could not be opened" })
      return
    }

    // Re-validate at dial time: DNS may have changed since the row was saved.
    let host: string
    try {
      const resolution = await resolvePublicTarget(stored.server.host, { resolve: dohResolver })
      host = resolution.addresses[0] ?? stored.server.host
    } catch (error) {
      const code = error instanceof TargetRejectedError ? "TARGET_REJECTED" : "TARGET_UNREACHABLE"
      this.#send(socket, { type: "error", code, message: "Target is not reachable" })
      return
    }

    // Loaded on demand: the sockets API only exists in the Workers runtime, and a
    // static import would make this module unloadable anywhere else (including tests).
    /** Filled when the server presented a key that differs from the stored one. */
    let hostKeyChange: { stored: string; presented: string } | null = null
    const { CloudflareTransportFactory } = await import("../platform/tcp.ts")
    const connection = new SshConnection({
      factory: new CloudflareTransportFactory(),
      host,
      port: stored.server.port,
      connectTimeoutMs: 15_000,
      hostKeyPolicy: async (decision) => {
        // Trust on first use: record it. After that a change is refused, because a
        // silent accept would defeat the point of checking at all — but the refusal
        // says which key it saw, so the browser can ask the administrator to confirm
        // instead of showing a bare disconnect.
        if (!stored.server.fingerprint) {
          await recordTrust(this.#env.DB, serverId, decision.fingerprint, Date.now())
          return true
        }
        if (stored.server.fingerprint === decision.fingerprint) return true
        hostKeyChange = { stored: stored.server.fingerprint, presented: decision.fingerprint }
        return false
      },
    })
    this.#connection = connection

    try {
      await connection.connect()
      if (!await this.#ensureAuthorized()) {
        await connection.close()
        return
      }
      // The stored secret is either a password or a private key; which one it is is
      // decided by the server row, not by inspecting the value.
      const credentials = { username: stored.server.username, secret }
      if (stored.server.authMethod === "publickey") {
        await connection.authenticateWithKey({ username: credentials.username, privateKey: credentials.secret })
      } else {
        await connection.authenticate({ username: credentials.username, password: credentials.secret })
      }
      if (!await this.#ensureAuthorized()) return
      const session = await connection.openSession({ cols: this.#cols, rows: this.#rows })
      session.onData((chunk) => this.#send(socket, { type: "data", data: bytesToBase64(chunk) }))
      session.onExit((code) => this.#send(socket, { type: "exit", code }))
      session.onClose(() => this.#send(socket, { type: "closed" }))
      this.#session = session
      this.#send(socket, { type: "ready" })
      this.#startKeepalive()
    } catch (error) {
      if (hostKeyChange) {
        // The reason matters more than the exception: a reinstall looks exactly like a
        // man in the middle, and only a human can decide which it is.
        this.#send(socket, {
          type: "error",
          code: "HOST_KEY_CHANGED",
          message: "Host key changed",
          hostKey: hostKeyChange,
        })
        await this.#close()
        return
      }
      const code = error instanceof SshConnectionError ? error.code : "INTERNAL"
      const methods = error instanceof SshConnectionError ? error.methods : []
      this.#send(socket, {
        type: "error",
        code,
        message: error instanceof Error ? error.message : "Connect failed",
        // The browser owns the words; the server only knows what it offered.
        ...(methods.length > 0 ? { methods } : {}),
      })
      await this.#close()
    }
  }

  #session: Awaited<ReturnType<SshConnection["openSession"]>> | null = null
  #sftp: SftpService | null = null
  #fsQueue: Promise<void> = Promise.resolve()
  #serverId = ""
  /**
   * Which stored conversation the panel is showing; "default" holds pre-0004 rows.
   *
   * A session object is created per connection (newUniqueId), so its storage is always
   * empty: the browser remembers the id and reopens it. Every ai.messages carries the
   * id, which is how the browser learns the one it did not mint itself.
   */
  #conversationId = "default"
  #proposals = new Map<string, Proposal>()
  /** Which tool call produced each proposal, so its output can be answered. */
  #proposalCalls = new Map<string, string>()
  /**
   * Calls the provider is still waiting on an answer for.
   *
   * A reply may propose several commands at once. Each call needs exactly one tool
   * message before the conversation can continue, so doing so is tracked here: a
   * turn must not be sent while one of them is still unanswered, or the model reads
   * the silence as "the output never came back".
   */
  #openCalls = new Set<string>()

  /**
   * Runs commands one at a time.
   *
   * Bound concurrent exec work from metrics and AI. This queue does not release
   * remote session slots: that requires the reciprocal CHANNEL_CLOSE handshake
   * implemented in SessionChannel.
   */
  #execQueue: Promise<unknown> = Promise.resolve()
  /** Open write handles, keyed by the id the browser sends pieces against. */
  #uploads = new Map<string, Awaited<ReturnType<SftpService["beginWrite"]>>>()
  #uploadTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #history: ChatMessage[] = []
  readonly #aiScope = new ConversationScope()

  async #onMessage(data: unknown): Promise<void> {
    if (typeof data !== "string" || data.length > 2 * 1024 * 1024) return
    let message: ClientMessage
    try {
      message = JSON.parse(data) as ClientMessage
    } catch {
      return
    }

    if (!message || typeof message.type !== "string") return

    // Assign the conversation generation at message arrival, before authorization's
    // asynchronous database read. Otherwise an old approval could resume in a new thread.
    const removesCurrent = message.type === "ai.remove" && message.conversationId === this.#conversationId
    if (message.type === "ai.open" && typeof message.conversationId === "string") {
      this.#resetConversation(message.conversationId)
    } else if (message.type === "ai.new" || removesCurrent) {
      this.#resetConversation(crypto.randomUUID())
    } else if (message.type === "ai.clear" || message.type === "ai.history") {
      this.#resetConversation(this.#conversationId)
    }
    if (message.type === "ai.cancel") {
      // Never queued: a cancel that waited behind the turn it cancels would arrive after
      // the answer had already finished. The same thread stays selected.
      this.#aiScope.interrupt()
      for (const [proposalId, proposal] of this.#proposals) {
        if (proposal.status !== "pending") continue
        this.#proposals.set(proposalId, rejectProposal(proposal))
        this.#answerProposal(proposalId, "not run: the user stopped this task")
      }
      const socket = this.#socket
      if (socket) this.#send(socket, { type: "ai.canceled", id: message.id })
      return
    }

    const receivedScope = this.#aiScope.capture()
    if (message.type.startsWith("ai.")) {
      // Enqueue before the authorization await as well: history loading must precede
      // the next question even when their database checks settle in the reverse order.
      await this.#aiScope.run(async () => {
        if (!await this.#ensureAuthorized() || !this.#aiScope.current(receivedScope)) return
        await this.#onAiMessage(message, removesCurrent)
      })
      return
    }

    if (message.type === "input" && typeof message.data === "string") {
      // Preserve keystroke order even when authorization lookups complete out of order.
      this.#inputQueue = this.#inputQueue.then(async () => {
        if (!await this.#ensureAuthorized()) return
        await this.#session?.write(fromBase64(message.data))
      }).catch(() => undefined)
      return
    }
    if (!await this.#ensureAuthorized()) return
    if (message.type === "resize" && Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      this.#cols = clamp(message.cols, 20, 500)
      this.#rows = clamp(message.rows, 5, 300)
      try {
        await this.#session?.resize(this.#cols, this.#rows)
      } catch {
        // Resizing a dying session is not worth surfacing.
      }
      return
    }
    if (message.type === "close") await this.#close()
    if (message.type === "fs" && typeof message.id === "number") {
      // queued, not awaited: a slow listing must not block terminal input
      this.#fsQueue = this.#fsQueue
        .then(() => this.#handleFs(message))
        .catch(() => undefined)
    }
    if (message.type === "metrics" && typeof message.id === "number") {
      await this.#handleMetrics(message.id)
    }
  }

  async #replyConversations(id: number): Promise<void> {
    const conversations = await listConversations(this.#env.DB, this.#serverId)
    this.#send(this.#socket!, {
      type: "ai.conversationList",
      id,
      current: this.#conversationId,
      conversations,
    })
  }

  async #onAiMessage(message: ClientMessage, removesCurrent: boolean): Promise<void> {
    if (message.type === "ai.ask" || message.type === "ai.approve" || message.type === "ai.reject") {
      const token = this.#aiScope.capture()
      try {
        if (message.type === "ai.ask" && typeof message.text === "string") {
          await this.#handleAsk(message.id, message.text, message.attachments ?? [])
        } else if (message.type === "ai.approve" && typeof message.proposalId === "string") {
          await this.#handleApprove(message.id, message.proposalId, message.command)
        } else if (message.type === "ai.reject" && typeof message.proposalId === "string") {
          await this.#handleReject(message.id, message.proposalId)
        }
      } finally {
        if (this.#socket && this.#aiScope.current(token)) this.#send(this.#socket, { type: "ai.done", id: message.id })
      }
      return
    }
    if (message.type === "ai.conversations" && typeof message.id === "number") {
      await this.#replyConversations(message.id)
    }
    if (message.type === "ai.open" && typeof message.conversationId === "string") {
      await this.#loadSelectedHistory(message.id)
      return
    }
    if (message.type === "ai.rename" && typeof message.conversationId === "string") {
      await renameConversation(this.#env.DB, this.#serverId, message.conversationId, message.title)
      await this.#replyConversations(message.id)
    }
    if (message.type === "ai.remove" && typeof message.conversationId === "string") {
      if (removesCurrent) {
        this.#send(this.#socket!, { type: "ai.messages", id: message.id, conversationId: this.#conversationId, entries: [] })
      }
      await this.#forgetConversation(message.conversationId)
      await clearHistory(this.#env.DB, this.#serverId, message.conversationId)
      await this.#replyConversations(message.id)
    }
    if (message.type === "ai.new" && typeof message.id === "number") {
      this.#send(this.#socket!, { type: "ai.messages", id: message.id, conversationId: this.#conversationId, entries: [] })
      return
    }
    if (message.type === "ai.clear" && typeof message.id === "number") {
      const oldId = this.#conversationId
      const token = this.#aiScope.capture()
      await this.#forgetConversation(oldId)
      await clearHistory(this.#env.DB, this.#serverId, oldId)
      if (this.#aiScope.current(token)) this.#send(this.#socket!, { type: "ai.cleared", id: message.id })
    }
    if (message.type === "ai.history" && typeof message.id === "number") {
      await this.#loadSelectedHistory(message.id)
    }
  }

  /** Drops the stored images of a conversation that is being deleted. */
  async #forgetConversation(conversationId: string): Promise<void> {
    const entries = await listEntries(this.#env.DB, this.#serverId, conversationId)
    await forgetAttachments(this.#env.ATTACHMENTS, entries)
  }

  async #loadSelectedHistory(id: number): Promise<void> {
    const token = this.#aiScope.capture()
    const conversationId = this.#conversationId
    const entries = await listEntries(this.#env.DB, this.#serverId, conversationId)
    if (!this.#aiScope.current(token) || !this.#socket) return
    // The pictures come back from the object store too, so a question asked after a
    // reload still sees them. This runs inside the conversation's own queue, which is
    // what keeps it from overlapping the answer being generated.
    const images = this.#env.ATTACHMENTS
      ? await replayAttachments(this.#env.ATTACHMENTS, entries)
      : new Map<number, ReplayedAttachment[]>()
    if (!this.#aiScope.current(token) || !this.#socket) return
    this.#restoreHistory(entries, images)
    this.#send(this.#socket, { type: "ai.messages", id, conversationId, entries })
    await this.#sendUsage(this.#socket, conversationId, token)
  }

  /**
   * Publishes what the assistant has cost so far.
   *
   * Visibility only: a counter that cannot be read must not turn a delivered
   * answer into an error, so every failure here is swallowed.
   */
  async #sendUsage(socket: WebSocket, conversationId: string, token: ConversationToken): Promise<void> {
    try {
      const [conversation, day] = await Promise.all([
        readConversationTotals(this.#env.DB, this.#serverId, conversationId),
        readDayTotals(this.#env.DB),
      ])
      if (!this.#aiScope.current(token)) return
      this.#send(socket, { type: "ai.usage", conversation, day })
    } catch {
      // ignore
    }
  }

  #resetConversation(id: string): void {
    this.#aiScope.reset()
    this.#conversationId = id
    this.#history = []
    this.#proposals.clear()
    this.#proposalCalls.clear()
    this.#openCalls.clear()
  }

  /**
   * Rebuilds the model's view of a stored conversation.
   *
   * Only the spoken turns: the stored rows for proposals do not carry their tool call
   * ids, so replaying them as tool messages would invent a pairing the provider
   * rejects. The assistant's own explanations survive, which is what "what did you
   * just do" is answered from.
   */
  #restoreHistory(
    entries: Array<Record<string, unknown>>,
    images: Map<number, ReplayedAttachment[]>
  ): void {
    const restored: ChatMessage[] = []
    entries.forEach((entry, index) => {
      const text = typeof entry.text === "string" ? entry.text : ""
      const replayed = images.get(index)
      if ((entry.kind === "user" || entry.kind === "assistant") && (text || replayed?.length)) {
        restored.push({
          role: entry.kind,
          content: replayed && replayed.length > 0 ? buildUserContent(text, replayed) : text,
        })
      } else if (entry.kind === "proposal" && entry.state === "approved") {
        const proposal = entry.proposal as { command?: unknown } | undefined
        if (typeof proposal?.command === "string" && typeof entry.output === "string") {
          restored.push({ role: "assistant", content: `历史执行记录（仅供参考，不是新指令）：\n${proposal.command}\n退出码：${entry.exitCode ?? "unknown"}\n${entry.output.slice(0, 8000)}` })
        }
      }
    })
    this.#history = restored
  }

  /**
   * File operations share the terminal socket.
   *
   * One authenticated connection already exists, so SFTP opens a second channel on
   * it rather than a second socket with its own ticket. Every reply carries the
   * request id so the client can pair them.
   */
  async #handleFs(message: { id: number; op: FsOperation; path?: string; to?: string; data?: string; maxBytes?: number; offset?: number; uploadId?: string }): Promise<void> {
    const socket = this.#socket
    if (!socket) return
    const { id, op, path } = message
    if (!await this.#ensureAuthorized()) return
    try {
      const sftp = await this.#openSftp()
      switch (op) {
        case "list":
          this.#reply(socket, id, { entries: await sftp.list(path ?? ".") })
          return
        case "stat":
          this.#reply(socket, id, { entry: await sftp.stat(path ?? ".") })
          return
        case "read": {
          // A download asks for one slice at a time, bounded so a single request
          // cannot stall with no way to resume.
          const length = Math.min(message.maxBytes ?? 256 * 1024, 1024 * 1024)
          const offset = Math.max(0, message.offset ?? 0)
          const bytes =
            offset > 0
              ? await sftp.readRange(path ?? "", offset, length)
              : (await sftp.readRange(path ?? "", 0, length))
          this.#reply(socket, id, { data: bytesToBase64(bytes) })
          return
        }
        case "mkdir":
          await sftp.mkdir(path ?? "")
          this.#reply(socket, id, { ok: true })
          return
        case "create":
          if (!path) throw new SftpError("新建文件需要路径")
          await sftp.createFile(path)
          this.#reply(socket, id, { ok: true })
          return
        case "rename": {
          if (!path || !message.to) throw new SftpError("重命名需要源路径和目标路径")
          await sftp.rename(path, message.to)
          this.#reply(socket, id, { ok: true })
          return
        }
        case "upload.begin": {
          if (!path) throw new SftpError("上传需要目标路径")
          if (this.#uploads.size >= 4) throw new SftpError("同时上传数量已达上限")
          const uploadId = crypto.randomUUID()
          this.#uploads.set(uploadId, await sftp.beginWrite(path))
          this.#touchUpload(uploadId)
          this.#reply(socket, id, { uploadId })
          return
        }
        case "upload.chunk": {
          const session = message.uploadId ? this.#uploads.get(message.uploadId) : undefined
          if (!session) throw new SftpError("上传会话已失效，请重新上传")
          this.#touchUpload(message.uploadId!)
          await sftp.writeChunk(session, fromBase64(message.data ?? ""))
          this.#reply(socket, id, { ok: true })
          return
        }
        case "upload.abort": {
          if (message.uploadId) await this.#abortUpload(message.uploadId)
          this.#reply(socket, id, { ok: true })
          return
        }
        case "upload.end": {
          const session = message.uploadId ? this.#uploads.get(message.uploadId) : undefined
          if (!session) throw new SftpError("上传会话已失效，提交未确认")
          {
            this.#uploads.delete(message.uploadId!)
            const timer = this.#uploadTimers.get(message.uploadId!)
            if (timer) clearTimeout(timer)
            this.#uploadTimers.delete(message.uploadId!)
            try {
              await sftp.endWrite(session)
            } catch (error) {
              await sftp.abortWrite(session).catch(() => undefined)
              throw error
            }
          }
          this.#reply(socket, id, { ok: true })
          return
        }
        case "remove": {
          const removed = await sftp.removeEntry(path ?? "")
          this.#reply(socket, id, { ok: true, removed })
          return
        }
      }
    } catch (error) {
      if (message.uploadId) await this.#abortUpload(message.uploadId)
      const text =
        error instanceof SftpError || error instanceof SshConnectionError
          ? error.message
          : error instanceof Error
            ? error.message
            : "文件操作失败"
      // The browser names the reason; the server supplies the status it got.
      const code = error instanceof SftpError ? error.code : null
      this.#send(socket, { type: "fs.error", id, message: text, ...(code !== null ? { code } : {}) })
    }
  }

  #touchUpload(id: string): void {
    const old = this.#uploadTimers.get(id)
    if (old) clearTimeout(old)
    this.#uploadTimers.set(id, setTimeout(() => { void this.#abortUpload(id) }, 60_000))
  }

  async #abortUpload(id: string): Promise<void> {
    const timer = this.#uploadTimers.get(id)
    if (timer) clearTimeout(timer)
    this.#uploadTimers.delete(id)
    const upload = this.#uploads.get(id)
    this.#uploads.delete(id)
    if (upload) await this.#sftp?.abortWrite(upload).catch(() => undefined)
  }

  /**
   * Runs the collector command and parses it.
   *
   * One command, one exec channel, no PTY: the numbers come from /proc and df,
   * which exist on every Linux host this targets. Parsing failures degrade to
   * nulls rather than an error the UI has to special-case.
   */
  async #handleMetrics(id: number): Promise<void> {
    const socket = this.#socket
    const connection = this.#connection
    if (!socket || !connection) return
    try {
      const { stdout } = await this.#runExclusive(async () => {
        if (!await this.#ensureAuthorized()) throw new Error("Login session expired")
        return await connection.runCommand(METRICS_COMMAND, { timeoutMs: 8000 })
      })
      const metrics = parseMetrics(stdout)
      // The sidebar wants the distribution before the panel is opened, so it is
      // stored the first time we see it rather than shipped with every poll.
      if (metrics.host.os && metrics.host.os !== "—") {
        void recordServerOs(this.#env.DB, this.#serverId, metrics.host.os)
      }
      this.#send(socket, { type: "metrics.result", id, metrics })
    } catch {
      this.#send(socket, { type: "metrics.error", id, message: "无法读取资源指标" })
    }
  }

  /** The provider: whatever the app has stored, else the deployment's env vars. */
  async #provider(): Promise<ProviderTarget | null> {
    const key = readKey(this.#env)
    if (key) {
      const stored = await resolveProvider(this.#env.DB, key)
      if (stored) {
        return {
          baseUrl: stored.baseUrl,
          model: stored.model,
          apiKey: stored.apiKey,
          maxOutput: stored.params.maxOutput,
          contextWindow: stored.params.contextWindow,
          effort: wireEffort(stored.params.effort),
        }
      }
    }
    if (this.#env.AI_BASE_URL && this.#env.AI_API_KEY && this.#env.AI_MODEL) {
      return { baseUrl: this.#env.AI_BASE_URL, model: this.#env.AI_MODEL, apiKey: this.#env.AI_API_KEY }
    }
    return null
  }

  /**
   * One turn of the conversation.
   *
   * The model may propose a command, but nothing runs here: the proposal is
   * classified, stored and shown. Whether it executes is a separate, explicit step.
   */
  /**
   * One user turn, plus the tool turns that follow it.
   *
   * The model decides what to run, so its results have to come back to it: without
   * a tool message the assistant can only ask the user to paste the output, and
   * asking again produces the same command forever. The loop is bounded so a model
   * that keeps proposing commands cannot run indefinitely.
   */
  async #handleAsk(id: number, text: string, attachments: AttachmentRef[] = []): Promise<void> {
    const socket = this.#socket
    if (!socket) return

    const token = this.#aiScope.capture()
    const conversationId = this.#conversationId
    if (!await this.#ensureAuthorized() || !this.#aiScope.current(token)) return
    const provider = await this.#provider()
    if (!this.#aiScope.current(token)) return
    if (!provider) {
      this.#send(socket, { type: "ai.error", id, code: "NOT_CONFIGURED", message: "未配置模型服务" })
      return
    }

    if (this.#openCalls.size > 0) {
      this.#send(socket, { type: "ai.error", id, code: "INVALID_REQUEST", message: "请先执行或拒绝当前待确认命令，或新建对话" })
      return
    }
    const trimmed = text.trim().slice(0, 4000)
    // An attachment alone is a valid question ("看这张图"), so either will do.
    if (trimmed.length === 0 && attachments.length === 0) return

    // The bytes live in the object store; they are read here, once, and never
    // stored in the conversation row.
    const parts: ChatAttachment[] = []
    for (const attachment of attachments) {
      const dataUrl = await readAttachmentDataUrl(this.#env.ATTACHMENTS, attachment.id, attachment.mime)
      if (!this.#aiScope.current(token)) return
      if (!dataUrl) {
        this.#send(socket, { type: "ai.error", id, code: "ATTACHMENT_MISSING", message: "附件已失效，请重新上传" })
        return
      }
      parts.push({ name: attachment.name, mime: attachment.mime, dataUrl })
    }

    this.#history.push({
      role: "user",
      content: parts.length > 0 ? buildUserContent(trimmed, parts) : trimmed,
    })
    await appendEntry(this.#env.DB, this.#serverId, conversationId, {
      kind: "user",
      text: trimmed,
      attachments: attachments.map((attachment) => ({ id: attachment.id, name: attachment.name, mime: attachment.mime })),
    })
    if (!this.#aiScope.current(token)) return
    // The first question already says what the conversation is about, so the title
    // costs no provider request and survives an answer that never arrives.
    if (this.#history.filter((entry) => entry.role === "user").length === 1) {
      void this.#nameConversation(trimmed)
    }
    if (!this.#aiScope.current(token)) return
    await this.#runTurns(id, provider, MAX_TURNS_PER_MESSAGE)
  }

  /** Asks the model until it answers instead of asking for a command. */
  async #runTurns(id: number, provider: ChatConfig, budget: number): Promise<void> {
    const socket = this.#socket
    if (!socket) return
    const token = this.#aiScope.capture()
    const conversationId = this.#conversationId

    for (let turn = 0; turn < budget; turn++) {
      if (!this.#aiScope.current(token)) return
      if (!await this.#ensureAuthorized() || !this.#aiScope.current(token)) return
      let reply: ChatReply
      try {
        const system: ChatMessage = { role: "system", content: SYSTEM_PROMPT }
        const budget = promptBudget(provider.contextWindow ?? null, provider.maxOutput ?? null)
        const history = fitToWindow(this.#history, Math.max(1, budget - messagesTokens([system])))
        if (messagesTokens([system, ...history]) > budget) {
          throw new Error("当前单轮内容超过模型上下文预算，请缩短内容或新建对话")
        }
        reply = await chat(
          provider,
          [system, ...history],
          {
            // The answer is shown while it is still being written; a provider that
            // cannot stream simply never calls this and the reply arrives whole.
            signal: token.signal,
            onText: (text) => {
              if (this.#aiScope.current(token)) this.#send(socket, { type: "ai.delta", id, text })
            },
          }
        )
      } catch (error) {
        if (!this.#aiScope.current(token)) return
        this.#send(socket, {
          type: "ai.error",
          id,
          code: "INTERNAL",
          message: error instanceof Error ? error.message : "模型调用失败",
        })
        return
      }

      if (!this.#aiScope.current(token)) return
      if (reply.usage) {
        // Accounting must never fail an answer that already arrived.
        await recordUsage(this.#env.DB, this.#serverId, conversationId, reply.usage).catch(() => {})
        if (!this.#aiScope.current(token)) return
        await this.#sendUsage(socket, conversationId, token)
      }
      if (reply.content.trim().length > 0) {
        await appendEntry(this.#env.DB, this.#serverId, conversationId, { kind: "assistant", text: reply.content })
        if (!this.#aiScope.current(token)) return
      }

      if (reply.toolCalls.length === 0) {
        if (reply.content.trim().length > 0) {
          this.#history.push({ role: "assistant", content: reply.content })
        }
        this.#send(socket, { type: "ai.reply", id, content: reply.content, proposals: [] })
        return
      }

      // The assistant turn must carry the calls, or the provider rejects the tool
      // results that answer them.
      this.#history.push({
        role: "assistant",
        content: reply.content,
        toolCalls: reply.toolCalls.map((call) => ({ id: call.id, name: call.name, arguments: call.arguments })),
      })

      // Fresh read: the administrator may have changed the permission since the
      // page loaded, and the browser's copy is not authoritative.
      const permission = await readPermission(this.#env.DB)
      if (!this.#aiScope.current(token)) return
      const proposals: Array<Record<string, unknown>> = []
      const autoRun: string[] = []

      for (const call of reply.toolCalls) {
        const parsed = readCommandProposal(call)
        if (!parsed) {
          // Every call needs an answer, or the next request is malformed.
          this.#history.push({ role: "tool", toolCallId: call.id, content: "error: unreadable arguments" })
          continue
        }

        const result = createProposal(
          { id: crypto.randomUUID(), command: parsed.command, purpose: parsed.purpose, permission },
          Date.now()
        )

        if (!result.accepted) {
          this.#history.push({ role: "tool", toolCallId: call.id, content: `refused: ${result.reason}` })
          proposals.push({ denied: true, command: parsed.command, risk: result.risk, reason: result.reason })
          continue
        }

        this.#proposals.set(result.proposal.id, result.proposal)
        this.#proposalCalls.set(result.proposal.id, call.id)
        this.#openCalls.add(call.id)
        const summary = {
          id: result.proposal.id,
          command: result.proposal.command,
          purpose: result.proposal.purpose,
          risk: result.proposal.risk,
          reason: result.proposal.reason,
          expiresAt: result.proposal.expiresAt,
        }
        await appendEntry(this.#env.DB, this.#serverId, conversationId, {
          kind: "proposal",
          proposal: summary,
          state: "pending",
        })
        if (!this.#aiScope.current(token)) return

        const auto = result.proposal.risk === "read" && permission === "semi-auto"
        if (auto) autoRun.push(result.proposal.id)
        proposals.push({ ...summary, autoRun: auto })
      }

      pruneProposals(this.#proposals, Date.now())
      for (const [proposalId, callId] of this.#proposalCalls) {
        if (this.#proposals.has(proposalId)) continue
        this.#proposalCalls.delete(proposalId)
        this.#openCalls.delete(callId)
        this.#history.push({ role: "tool", toolCallId: callId, content: "not run: the proposal expired" })
      }

      this.#send(socket, { type: "ai.reply", id, content: reply.content, proposals })

      // Nothing left to do without a human, so wait for the approval.
      if (autoRun.length === 0) return

      for (const proposalId of autoRun) {
        if (await this.#execute(id, proposalId, undefined, "automatic")) return
      }
      if (this.#openCalls.size > 0) return
      // The history now ends with tool results, so the loop can continue.
    }
  }

  /**
   * Runs one proposal and reports its output to the model.
   *
   * Returns true when the conversation cannot continue (no socket, no connection,
   * or a failed run), so the caller stops rather than looping on a broken state.
   */
  async #execute(
    id: number,
    proposalId: string,
    command?: string,
    source: "manual" | "automatic" = "manual"
  ): Promise<boolean> {
    const socket = this.#socket
    const connection = this.#connection
    const token = this.#aiScope.capture()
    // A cancelled turn must still report a command it already ran: the cancel stops the
    // assistant, not the shell. Only a conversation switch makes the result irrelevant.
    const conversationId = this.#conversationId
    if (!socket || !connection) return true

    // Consume inside the execution queue, after a fresh permission lookup. Neither a
    // second message nor a permission change during queued metrics may reuse a claim.
    return await this.#runExclusive(async () => {
      if (!this.#aiScope.current(token) || this.#connection !== connection) return true
      if (!await this.#ensureAuthorized()) return true
      const permission = await readPermission(this.#env.DB)
      if (!this.#aiScope.current(token)) return true
      const proposal = this.#proposals.get(proposalId)
      const decision = claimProposal(this.#proposals, proposalId, { permission, command, source, now: Date.now() })
      if (!decision.ok) {
        if (proposal && decision.status !== "pending") {
          this.#proposals.set(proposalId, { ...proposal, status: decision.status })
          this.#answerProposal(proposalId, `not run: ${decision.reason}`)
        }
        this.#send(socket, { type: "ai.error", id, code: "INVALID_REQUEST", message: decision.reason })
        return true
      }

      try {
        const result = await connection.runCommand(decision.command, { timeoutMs: 60_000 })
        // Both readers are told when the text is short: the panel shows the
        // administrator, the tool result feeds the model, and neither should answer
        // about a file it believes it read to the end.
        const notice = result.droppedBytes > 0 ? `\n…（输出过长，后续 ${result.droppedBytes} 字节已丢弃）` : ""
        const output = clipOutput(result.stdout, MAX_PANEL_OUTPUT_CHARS) + notice
        // Recording failure must never turn a completed command into a retryable one.
        await recordOutcome(this.#env.DB, this.#serverId, proposalId, { output, exitCode: result.exitCode }).catch(() => undefined)
        if (this.#conversationId !== conversationId) return true
        this.#send(socket, { type: "ai.result", id, proposalId, command: decision.command, output, exitCode: result.exitCode })
        const forModel = clipOutput(result.stdout, MAX_MODEL_OUTPUT_CHARS) + notice
        this.#answerProposal(proposalId, `exit code: ${result.exitCode ?? "unknown"}\nstdout:\n${forModel}`)
        return false
      } catch (reason) {
        // A lost response is not proof the command did not run. The consumed claim stays
        // consumed; blindly restoring pending could execute a destructive action twice.
        if (!this.#aiScope.current(token)) return true
        // Keep the reason: without it the only trace is "unconfirmed", which cannot tell a
        // channel that never opened from a reply lost after the command had already run.
        const detail = reason instanceof Error ? reason.message : String(reason)
        const output = `执行结果未确认（可能已在服务器执行），请先检查服务器状态，不要重复批准\n原因：${detail}`
        await recordOutcome(this.#env.DB, this.#serverId, proposalId, { output, exitCode: null }).catch(() => undefined)
        if (this.#conversationId !== conversationId) return true
        this.#answerProposal(proposalId, output)
        this.#send(socket, { type: "ai.result", id, proposalId, command: decision.command, output, exitCode: null })
        this.#send(socket, { type: "ai.error", id, code: "EXEC_UNCONFIRMED", message: detail })
        return true
      }
    })
  }

  #answerProposal(proposalId: string, content: string): void {
    const callId = this.#proposalCalls.get(proposalId)
    if (!callId) return
    this.#proposalCalls.delete(proposalId)
    this.#openCalls.delete(callId)
    this.#history.push({ role: "tool", toolCallId: callId, content })
  }

  /** A human approved a proposal: run it, then let the model explain the result. */
  async #handleApprove(id: number, proposalId: string, command?: string): Promise<void> {
    const token = this.#aiScope.capture()
    const stopped = await this.#execute(id, proposalId, command)
    if (stopped || !this.#aiScope.current(token)) return
    // The reply may have proposed more than one command. Continuing now would ask
    // the model to answer while its own calls are still open, which it reads as
    // missing output; the next approval continues the conversation instead.
    if (this.#openCalls.size > 0) return
    const provider = await this.#provider()
    if (this.#aiScope.current(token) && provider) await this.#runTurns(id, provider, MAX_TURNS_AFTER_APPROVAL)
  }

  /** Names a fresh conversation from its first question; a rename always wins. */
  async #nameConversation(question: string): Promise<void> {
    const conversationId = this.#conversationId
    const name = titleFromQuestion(question)
    if (!name) return
    try {
      await nameIfUntitled(this.#env.DB, this.#serverId, conversationId, name)
    } catch {
      // A title is cosmetic; never let it break the conversation.
    }
  }

  async #handleReject(id: number, proposalId: string): Promise<void> {
    const token = this.#aiScope.capture()
    const socket = this.#socket
    const proposal = this.#proposals.get(proposalId)
    if (!socket || !proposal) return
    if (proposal.status !== "pending") {
      this.#send(socket, { type: "ai.error", id, code: "INVALID_REQUEST", message: "提案已处理，不能重复操作" })
      return
    }
    this.#proposals.set(proposalId, rejectProposal(proposal))
    const callId = this.#proposalCalls.get(proposalId)
    if (callId) {
      this.#proposalCalls.delete(proposalId)
      this.#openCalls.delete(callId)
      this.#history.push({ role: "tool", toolCallId: callId, content: "not run: the user rejected this command" })
    }
    this.#send(socket, { type: "ai.rejected", id, proposalId })
    if (this.#openCalls.size === 0) {
      const provider = await this.#provider()
      if (this.#aiScope.current(token) && provider) await this.#runTurns(id, provider, MAX_TURNS_AFTER_APPROVAL)
    }
  }

  /** Serialises command execution against the metrics poll. */
  #runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#execQueue.then(task, task)
    // The queue must survive a rejected task, or one failure would stop every later
    // command from running.
    this.#execQueue = run.catch(() => undefined)
    return run
  }

  async #openSftp(): Promise<SftpService> {
    if (this.#sftp) return this.#sftp
    const connection = this.#connection
    if (!connection) throw new Error("连接尚未建立")
    const sftp = await connection.openSftp()
    this.#sftp = sftp
    return sftp
  }

  #reply(socket: WebSocket, id: number, payload: Record<string, unknown>): void {
    this.#send(socket, { type: "fs.result", id, ...payload })
  }

  /**
   * Keeps an idle terminal from being reaped.
   *
   * Forty-five seconds is inside every common idle deadline (NAT tables, the server's
   * ClientAliveInterval, Cloudflare's own limits) with room to spare, and costs one
   * tiny packet — the request asks for no reply.
   */
  #startKeepalive(): void {
    this.#stopKeepalive()
    this.#keepalive = setInterval(() => {
      const connection = this.#connection
      if (!connection) {
        this.#stopKeepalive()
        return
      }
      // The tick that proves the link is alive is also where the age of the keys is
      // noticed: an idle session would otherwise carry the same keys forever.
      void (async () => {
        try {
          await connection.rekeyIfDue()
          await connection.keepalive()
        } catch {
          // The link is dead even though the socket has not noticed. Tearing it down
          // lets the browser's automatic reconnect take over.
          this.#stopKeepalive()
          void this.#close()
        }
      })()
    }, KEEPALIVE_INTERVAL_MS)
  }

  #stopKeepalive(): void {
    if (this.#keepalive !== null) {
      clearInterval(this.#keepalive)
      this.#keepalive = null
    }
  }

  async #ensureAuthorized(): Promise<boolean> {
    const socket = this.#socket
    const binding = this.#binding
    if (!socket || !binding) return false
    try {
      if (await checkSessionBinding(this.#env.DB, binding)) {
        return this.#socket === socket && this.#binding === binding
      }
    } catch {
      // An unavailable authorization store must not leave a privileged socket usable.
    }
    if (this.#socket === socket) {
      this.#send(socket, { type: "error", code: "AUTH_REQUIRED", message: "登录已失效，请重新登录" })
      await this.#close()
    }
    return false
  }

  async #close(): Promise<void> {
    this.#aiScope.reset()
    this.#stopKeepalive()
    if (this.#authorizationTimer) clearInterval(this.#authorizationTimer)
    this.#authorizationTimer = null
    this.#binding = null
    const connection = this.#connection
    this.#connection = null
    this.#session = null
    const sftp = this.#sftp
    this.#sftp = null
    this.#uploads.clear()
    for (const timer of this.#uploadTimers.values()) clearTimeout(timer)
    this.#uploadTimers.clear()
    const socket = this.#socket
    this.#socket = null
    try { socket?.close(1000, "closed") } catch { /* already closed */ }
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        sftp?.close(),
        new Promise<void>((resolve) => { cleanupTimer = setTimeout(resolve, 2000) }),
      ])
    } catch {
      // A dead transport cannot clean a remote temporary file.
    } finally {
      if (cleanupTimer) clearTimeout(cleanupTimer)
    }
    try {
      await connection?.close()
    } catch {
      // Already gone.
    }

  }

  #send(socket: WebSocket, value: unknown): void {
    try {
      socket.send(JSON.stringify(value))
    } catch {
      // The browser went away; the close handler will clean up.
    }
  }
}

/** Bounded so a model that keeps proposing commands cannot run forever. */
const MAX_TURNS_PER_MESSAGE = 4
const MAX_TURNS_AFTER_APPROVAL = 2

/** Idle terminals are the normal case; this is what keeps them alive. */
const KEEPALIVE_INTERVAL_MS = 45_000

const SYSTEM_PROMPT = [
    "你是 Besh 的服务器助手，通过 SSH 帮助管理员操作 Linux 主机。",
    "需要执行命令时调用 run_command 工具，一次只提议一条命令。",
    "命令会被展示给管理员审批，不要在回复里假装它已经执行。",
    "不要提议交互式命令（如编辑器、需要输入的程序）。",
    "回复使用简体中文，简洁。",
  ].join("\n")

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readKey(env: SessionEnv): Uint8Array {
  const key = readCredentialKey(env)
  if (!key) throw new Error("CREDENTIAL_KEY must be a base64 32-byte key")
  return key
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
