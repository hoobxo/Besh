/**
 * Keeps a conversation request inside the model's context window.
 *
 * The history grows with every turn, and a command's output can be thousands of
 * characters on its own, so "send the last twenty messages" says nothing about how
 * many tokens that is. This trims by estimated size instead, and only at the boundary
 * between turns: a request must never begin with a tool result whose call was cut
 * away, because the provider rejects that pairing.
 */
import type { ChatMessage } from "./ai-chat.ts"

/**
 * A deliberately rough token estimate.
 *
 * Exact tokenisation needs the model's own vocabulary, which we do not have on this
 * side. CJK runs about one token per character and Latin text about four characters
 * per token; over-estimating is the safe direction, since the cost is dropping an old
 * turn slightly early, not a rejected request.
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0
    if ((code >= 0x3400 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
      cjk += 1
    }
  }
  return cjk + Math.ceil((text.length - cjk) / 4)
}

export function messagesTokens(messages: ChatMessage[]): number {
  let total = 0
  for (const message of messages) {
    if (typeof message.content === "string") total += estimateTokens(message.content)
    else if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === "text") total += estimateTokens(part.text)
        // An image is charged a flat amount: its real cost depends on the model's
        // vision encoder, and a data URL's length is not a useful proxy.
        else total += 850
      }
    }
    if (message.role !== "tool" && message.toolCalls) {
      for (const call of message.toolCalls) total += estimateTokens(call.arguments) + 12
    }
    total += 4
  }
  return total
}

/**
 * The newest whole turns that fit in the budget.
 *
 * Turns begin at a user message, so starting there is what keeps an assistant message
 * and its tool results together. When even the newest turn is over budget it is sent
 * anyway: a request the provider may reject is better than an empty one, and the turn
 * that caused the overflow is usually the one the user is waiting on.
 */
export function fitToWindow(messages: ChatMessage[], budget: number): ChatMessage[] {
  if (messages.length === 0) return messages
  if (messagesTokens(messages) <= budget) return messages

  const starts: number[] = []
  messages.forEach((message, index) => {
    if (message.role === "user") starts.push(index)
  })
  if (starts.length === 0) return messages.slice(-1)

  let chosen = messages.length
  for (const start of [...starts].reverse()) {
    if (messagesTokens(messages.slice(start)) > budget) break
    chosen = start
  }

  // Nothing fit, so keep the last turn rather than sending nothing at all.
  if (chosen === messages.length) return messages.slice(starts[starts.length - 1])
  return messages.slice(chosen)
}

/**
 * How much of the window may be spent on the prompt.
 *
 * The answer needs room of its own, and reasoning models spend tokens before writing
 * anything, so the output allowance is subtracted rather than assumed.
 */
export function promptBudget(contextWindow: number | null, maxOutput: number | null): number {
  const window = contextWindow && contextWindow > 0 ? contextWindow : 32_000
  const output = maxOutput && maxOutput > 0 ? maxOutput : 2_048
  return Math.max(1_000, window - output - 512)
}
