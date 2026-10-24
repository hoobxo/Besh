/**
 * OpenAI-compatible chat client.
 *
 * Deliberately narrow: one POST to `/chat/completions` with the standard schema,
 * so any compatible endpoint (OpenAI, a proxy, a local gateway) works by changing
 * the base URL. The API key is read per call from the environment and never
 * logged, never included in an error message, and never returned to the browser.
 *
 * The model proposes; it never decides whether a command runs. That decision lives
 * in `ai-approval.ts` and takes only the command text as input.
 */

import { readProviderUsage, type TokenUsage } from "./ai-usage.ts"

export type ChatToolCall = { id: string; name: string; arguments: string }

/**
 * One entry of the conversation. A tool result carries the id of the call it
 * answers, which is how the provider matches it to the assistant turn that asked.
 */
/** A file the model reads itself rather than a transcription of it. */
export type ChatAttachment = {
  name: string
  /** MIME type, e.g. image/png or application/pdf. */
  mime: string
  /** data: URL, so the payload never leaves the request body. */
  dataUrl: string
}

export type ChatContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } }


export type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string | ChatContentPart[]; toolCalls?: ChatToolCall[] }
  | { role: "tool"; toolCallId: string; content: string }

/**
 * Turns typed text and attachments into one content array.
 *
 * Images go as image parts so a vision model reads them directly; other documents
 * go as file parts, which is how an OpenAI-compatible endpoint receives a PDF.
 */
export function buildUserContent(text: string, attachments: ChatAttachment[]): ChatContentPart[] {
  const parts: ChatContentPart[] = []
  if (text.trim().length > 0) parts.push({ type: "text", text })
  for (const attachment of attachments) {
    // Only images travel as parts. Text is inlined into the message by the composer.
    // Anything else is a client that disagrees with this contract: refuse it here
    // rather than send a part the provider will reject with an opaque 400.
    if (!attachment.mime.startsWith("image/")) {
      throw new Error(`unsupported attachment type: ${attachment.mime}`)
    }
    parts.push({ type: "image_url", image_url: { url: attachment.dataUrl } })
  }
  return parts
}

/**
 * How this project identifies itself to a model gateway.
 *
 * Several OpenAI-compatible gateways log an application title, which is the only way
 * an operator can tell whose traffic a request is when one key serves many clients.
 * Sent on every call that leaves the worker, including the title suggestion.
 */
const APP_TITLE = "Besh"

/**
 * Two deadlines, because they answer different questions.
 *
 * The total one bounds the whole request. The idle one catches a stream that opened and
 * then went silent — a provider that stops sending holds the turn open for minutes and
 * the answer never arrives. Every chunk resets the idle timer, so an answer that is
 * merely long is never cut for being long.
 */
const DEFAULT_TOTAL_TIMEOUT_MS = 600_000
const DEFAULT_IDLE_TIMEOUT_MS = 90_000
/**
 * The gateway's session field. `X-Title` only names the client; a gateway that
 * reports "未提供会话标识" is asking for a session, so the project name doubles as one:
 * every request from this deployment lands in the same row, which is what an
 * operator wants when a single key serves several clients.
 */
const APP_HEADERS: Record<string, string> = {
  "X-Title": APP_TITLE,
  "X-Session-Id": APP_TITLE,
  "User-Agent": APP_TITLE,
}

export type ChatConfig = {
  /** e.g. https://api.openai.com/v1 — trailing slash is tolerated. */
  baseUrl: string
  apiKey: string
  model: string
  /** Caller-side prompt budget metadata; never sent as a provider request field. */
  contextWindow?: number | null
  /** Omitted when unset; the provider then uses its own default. */
  maxOutput?: number | null
  /** Already mapped: null means "say nothing about reasoning". */
  effort?: string | null
  timeoutMs?: number
}

export type ToolCall = {
  id: string
  name: string
  /** Raw JSON string as returned by the provider; parsed by the caller. */
  arguments: string
}

export type ChatReply = {
  content: string
  toolCalls: ToolCall[]
  /** What the provider says the call cost, or null when it does not say. */
  usage: TokenUsage | null
}

export class ChatError extends Error {
  readonly status: number | null

  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = "ChatError"
    this.status = status
  }
}

/** The one tool the assistant is allowed to propose. */
export const RUN_COMMAND_TOOL = {
  type: "function" as const,
  function: {
    name: "run_command",
    description:
      "Propose one shell command to run on the connected server. The command is shown to the administrator for approval before it runs; do not assume it has run.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "A single shell command. No chaining tricks." },
        purpose: { type: "string", description: "One short sentence: why this command is needed." },
      },
      required: ["command", "purpose"],
      additionalProperties: false,
    },
  },
}

export type ChatOptions = {
  /**
   * Called with each text fragment as the provider emits it.
   *
   * Passing it turns on streaming; a provider that ignores `stream` answers with plain
   * JSON and is read as before, so this never depends on the provider's behaviour.
   */
  onText?: (delta: string) => void
  /** Cancels fetch and body consumption when the owning turn is no longer active. */
  signal?: AbortSignal
  /** How long the stream may go without producing a byte before the call fails. */
  idleTimeoutMs?: number
}

export async function chat(
  config: ChatConfig,
  messages: ChatMessage[],
  options: ChatOptions = {}
): Promise<ChatReply> {
  if (!config.apiKey) throw new ChatError("The model provider key is not configured")
  if (!config.model) throw new ChatError("No model name is configured")

  const endpoint = `${config.baseUrl.replace(/\/+$/, "")}/chat/completions`
  const controller = new AbortController()
  let timedOut = false
  let stalled = false
  const abortFromCaller = () => controller.abort()
  options.signal?.addEventListener("abort", abortFromCaller, { once: true })
  if (options.signal?.aborted) controller.abort()
  const idleMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  const touch = (): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      stalled = true
      controller.abort()
    }, idleMs)
  }
  touch()
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, config.timeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS)
  let response: Response | undefined
  let fetching = true

  try {
    throwIfAborted(controller.signal)
    const pendingResponse = fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
        ...APP_HEADERS,
      },
      body: JSON.stringify({
        model: config.model,
        messages: toWire(messages),
        tools: [RUN_COMMAND_TOOL],
        ...(config.maxOutput ? { max_tokens: config.maxOutput } : {}),
        ...(config.effort ? { reasoning_effort: config.effort } : {}),
        // Asking for usage on a stream is what makes the counters work at all: the
        // numbers arrive in a final event whose choices array is empty.
        ...(options.onText ? { stream: true, stream_options: { include_usage: true } } : {}),
      }),
      signal: controller.signal,
    })
    // Real fetch observes its signal. This also releases a late response from an
    // adapter that settles after cancellation rather than honouring it immediately.
    void pendingResponse.then((late) => {
      if (controller.signal.aborted && !late.body?.locked) cancelBody(late)
    }, () => {})
    response = await abortable(pendingResponse, controller.signal)
    fetching = false
    throwIfAborted(controller.signal)
    if (!response.ok) {
      // Never surface the provider's body: a proxy may quote credentials in it.
      throw new ChatError(`模型服务返回 ${response.status}`, response.status)
    }

    let reply: ChatReply
    if (options.onText && (response.headers.get("content-type") ?? "").toLowerCase().includes("text/event-stream")) {
      reply = await readStreamedReply(response, options.onText, controller.signal, touch)
    } else {
      // Providers may ignore stream=true. JSON gets the same deadline, cancellation
      // and reader cleanup as SSE, including a body that stalls after its headers.
      const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
      let text = ""
      for await (const chunk of bodyChunks(response, controller.signal, touch)) {
        text += decoder.decode(chunk, { stream: true })
      }
      text += decoder.decode()
      reply = parseJsonReply(text)
    }
    throwIfAborted(controller.signal)
    return reply
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ChatError(stalled ? "模型服务长时间没有响应" : timedOut ? "模型请求超时" : "模型请求已取消")
    }
    if (error instanceof ChatError) throw error
    // Neither network errors nor caller abort reasons may disclose request details.
    throw new ChatError(fetching ? "无法连接模型服务" : "模型响应读取失败")
  } finally {
    clearTimeout(timeout)
    if (idleTimer !== undefined) clearTimeout(idleTimer)
    options.signal?.removeEventListener("abort", abortFromCaller)
    if (response && !response.body?.locked) cancelBody(response)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new ChatError("模型请求已取消")
}

/** A deadline must work even if a fetch adapter or a custom stream ignores abort. */
function abortable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => {})
    return Promise.reject(new ChatError("模型请求已取消"))
  }
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(new ChatError("模型请求已取消"))
    signal.addEventListener("abort", aborted, { once: true })
    operation.then(
      (value) => { signal.removeEventListener("abort", aborted); resolve(value) },
      (error) => { signal.removeEventListener("abort", aborted); reject(error) }
    )
  })
}

function cancelBody(response: Response): void {
  // Cancellation is best-effort: a broken underlying source must not delay the
  // rejection or keep a completed [DONE] reply waiting for its cancel promise.
  void response.body?.cancel().catch(() => {})
}

/** The reader is cancelled and unlocked on EOF, [DONE], abort and parsing errors. */
async function* bodyChunks(
  response: Response,
  signal: AbortSignal,
  onChunk?: () => void
): AsyncGenerator<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) throw new ChatError("模型没有返回可读的响应")
  try {
    for (;;) {
      throwIfAborted(signal)
      const result = await abortable(reader.read(), signal)
      throwIfAborted(signal)
      if (result.done) return
      onChunk?.()
      yield result.value
    }
  } finally {
    void reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function parseJsonReply(text: string): ChatReply {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new ChatError("模型返回了无法解析的响应")
  }
  const usage = readProviderUsage((body as { usage?: unknown } | null)?.usage)
  const choice = (body as { choices?: Array<{ message?: Record<string, unknown> }> } | null)?.choices?.[0]
  const message = choice?.message
  if (!message) throw new ChatError("模型响应里没有消息")
  const content = typeof message.content === "string" ? message.content : ""
  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : []
  const toolCalls: ToolCall[] = []
  for (const raw of rawCalls) {
    const call = raw as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
    if (call?.function?.name !== RUN_COMMAND_TOOL.function.name) continue
    toolCalls.push({
      id: typeof call.id === "string" ? call.id : crypto.randomUUID(),
      name: call.function.name,
      arguments: typeof call.function.arguments === "string" ? call.function.arguments : "{}",
    })
  }
  return { content, toolCalls, usage }
}

/** SSE framing is independent of UTF-8 and transport chunk boundaries. */
async function readStreamedReply(
  response: Response,
  onText: (delta: string) => void,
  signal: AbortSignal,
  onChunk?: () => void
): Promise<ChatReply> {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false })
  const calls = new Map<number, { id: string; name: string; arguments: string }>()
  let content = ""
  let buffer = ""
  let data: string[] = []
  let completed = false
  let terminalChoice = false
  let sawChoice = false
  let usage: TokenUsage | null = null

  const malformed = () => new ChatError("模型返回了畸形的流式响应")
  const dispatch = (): void => {
    if (data.length === 0) return
    const payload = data.join("\n")
    data = []
    if (payload.trim() === "[DONE]") { completed = true; return }
    let event: { choices?: unknown; error?: unknown }
    try {
      event = JSON.parse(payload)
    } catch {
      // Comments and empty events are filtered before here; broken data JSON is
      // never a keep-alive and must not turn partial commands into a success.
      throw malformed()
    }
    if (!event || typeof event !== "object" || event.error || !Array.isArray(event.choices)) throw malformed()
    const choice = event.choices.find((raw) => raw && (raw.index === undefined || raw.index === 0)) as
      { delta?: Record<string, unknown>; finish_reason?: unknown } | undefined
    // The usage-only event carries no choice; a provider may also attach the block
    // to its last content event, so read it wherever it appears.
    const reported = readProviderUsage((event as { usage?: unknown }).usage)
    if (reported) usage = reported
    // OpenAI's final usage-only event has an empty choices array.
    if (!choice) return
    sawChoice = true
    if (choice.finish_reason != null) {
      if (choice.finish_reason !== "stop" && choice.finish_reason !== "tool_calls" && choice.finish_reason !== "function_call") {
        throw new ChatError("模型响应被截断，未完成的工具调用不会执行")
      }
      terminalChoice = true
    }
    const delta = choice.delta
    if (!delta || typeof delta !== "object" || Array.isArray(delta)) throw malformed()
    if (delta.content != null && typeof delta.content !== "string") throw malformed()
    if (typeof delta.content === "string" && delta.content.length > 0) {
      content += delta.content
      throwIfAborted(signal)
      onText(delta.content)
      throwIfAborted(signal)
    }
    if (delta.tool_calls != null && !Array.isArray(delta.tool_calls)) throw malformed()
    for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const fragment = raw as { index?: unknown; id?: unknown; type?: unknown; function?: { name?: unknown; arguments?: unknown } }
      if (!fragment || !Number.isInteger(fragment.index) || (fragment.index as number) < 0) throw malformed()
      if (fragment.function != null && (typeof fragment.function !== "object" || Array.isArray(fragment.function))) throw malformed()
      if (fragment.function?.name != null && typeof fragment.function.name !== "string") throw malformed()
      if (fragment.function?.arguments != null && typeof fragment.function.arguments !== "string") throw malformed()
      if (fragment.id != null && typeof fragment.id !== "string") throw malformed()
      const index = fragment.index as number
      const entry = calls.get(index) ?? { id: "", name: "", arguments: "" }
      if (typeof fragment.id === "string") entry.id += fragment.id
      if (typeof fragment.function?.name === "string") entry.name += fragment.function.name
      if (typeof fragment.function?.arguments === "string") entry.arguments += fragment.function.arguments
      calls.set(index, entry)
    }
  }

  const line = (value: string): void => {
    if (value === "") { dispatch(); return }
    if (value.startsWith(":")) return
    const colon = value.indexOf(":")
    const field = colon < 0 ? value : value.slice(0, colon)
    let text = colon < 0 ? "" : value.slice(colon + 1)
    if (text.startsWith(" ")) text = text.slice(1)
    if (field === "data") {
      // DONE is a transport sentinel, not JSON. Honour it as soon as its line is
      // complete, including gateways that omit the final empty event separator.
      if (data.length === 0 && text.trim() === "[DONE]") completed = true
      else data.push(text)
    }
  }
  const drain = (eof = false): void => {
    while (!completed) {
      const end = buffer.search(/[\r\n]/)
      if (end < 0) break
      // A CRLF can itself straddle chunks. Keep a trailing CR until the next read.
      if (!eof && buffer[end] === "\r" && end === buffer.length - 1) break
      const width = buffer[end] === "\r" && buffer[end + 1] === "\n" ? 2 : 1
      const value = buffer.slice(0, end)
      buffer = buffer.slice(end + width)
      line(value)
    }
    if (eof && !completed) {
      if (buffer.length > 0) { line(buffer); buffer = "" }
      dispatch()
    }
  }

  for await (const chunk of bodyChunks(response, signal, onChunk)) {
    buffer += decoder.decode(chunk, { stream: true })
    drain()
    if (completed) break
  }
  if (!completed) {
    buffer += decoder.decode() // flush, rejecting an incomplete final UTF-8 code point
    drain(true)
  }
  throwIfAborted(signal)
  if (!sawChoice || (!completed && !terminalChoice)) throw new ChatError("模型响应流意外中断，未完成的工具调用不会执行")

  const toolCalls: ToolCall[] = []
  for (const [, call] of [...calls].sort((left, right) => left[0] - right[0])) {
    if (!call.name || !call.id) throw malformed()
    if (call.name !== RUN_COMMAND_TOOL.function.name) continue
    let args: unknown
    try { args = JSON.parse(call.arguments) } catch { throw malformed() }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw malformed()
    toolCalls.push({ id: call.id, name: call.name, arguments: call.arguments })
  }
  return { content, toolCalls, usage }
}

/** Extracts `command` and `purpose` from a tool call, tolerating bad JSON. */
export function readCommandProposal(call: ToolCall): { command: string; purpose: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(call.arguments)
  } catch {
    return null
  }
  const value = parsed as { command?: unknown; purpose?: unknown }
  if (typeof value.command !== "string" || value.command.trim().length === 0) return null
  return {
    command: value.command.trim(),
    purpose: typeof value.purpose === "string" ? value.purpose.trim() : "",
  }
}

/** Maps history entries onto the provider's schema. */
function toWire(messages: ChatMessage[]): unknown[] {
  return messages.map((message) => {
    if (message.role === "tool") {
      return { role: "tool", tool_call_id: message.toolCallId, content: message.content }
    }
    if (message.toolCalls?.length) {
      return {
        role: message.role,
        content: message.content,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        })),
      }
    }
    return { role: message.role, content: message.content }
  })
}

