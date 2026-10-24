import { useRef, useState, type FormEvent } from "react"
import { ArrowUp, FileText, Image as ImageIcon, Paperclip, Square, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { deleteAttachment, uploadAttachment, type AttachmentRef } from "@/lib/api"
import { Hint } from "@/components/hint"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group"

/** Text typed into the box stays bounded; files are not text and are not counted. */
const MAX_MESSAGE_CHARS = 4000
const MAX_FILES = 4
/** Longest edge after downscaling. Vision models do not gain from more pixels. */
const MAX_IMAGE_EDGE = 1200
/** Raw bytes, before base64, which adds a third. */
const MAX_IMAGE_BYTES = 900_000
const MAX_TEXT_BYTES = 64_000
/**
 * What the picker offers.
 *
 * Every picture is re-encoded before upload, so this list names the formats a user may
 * pick, not what is stored. JPG and JPEG are the same type here. GIF is left out: it
 * would be flattened to a single frame, which is worse than saying so.
 */
const IMAGE_INPUT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const

type PendingAttachment = {
  id: string
  name: string
  mime: string
  /** Preview only: the bytes themselves live in the object store. */
  preview: string
  /** Where those bytes are; required for images, absent for inlined text. */
  ref?: AttachmentRef
  kind: "image" | "text"
  /** Only for text files, which are inlined into the message. */
  text?: string
  size: number
}

export function AiComposer({ disabled, busy, imagesAllowed, onSend, onStop }: {
  disabled: boolean
  busy: boolean
  /** False when the chosen model does not read pictures; the picker is then off. */
  imagesAllowed: boolean
  onSend: (text: string, attachments: AttachmentRef[]) => void
  onStop: () => void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [error, setError] = useState<string | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const [reading, setReading] = useState(false)

  async function attach(files: FileList | null) {
    if (!files?.length || !imagesAllowed) return
    setReading(true)
    setError(null)
    try {
      if (attachments.length + files.length > MAX_FILES) throw new Error(t("ai.attachmentLimit"))
      const next: PendingAttachment[] = []
      for (const file of Array.from(files)) {
        next.push(await readAttachment(file, t))
      }
      const combined = [...attachments, ...next]
      if (combineText(draft, combined).length > MAX_MESSAGE_CHARS) throw new Error(t("ai.messageTooLong"))
      setAttachments(combined)
      textarea.current?.focus()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("ai.attachmentFailed"))
    } finally {
      setReading(false)
      if (picker.current) picker.current.value = ""
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (disabled || busy || reading) return
    const text = combineText(draft, attachments)
    const files = attachments
      .filter((item) => item.kind !== "text" && item.ref)
      .map((item) => item.ref as AttachmentRef)
    if (text.trim().length === 0 && files.length === 0) return
    if (text.length > MAX_MESSAGE_CHARS) {
      setError(t("ai.messageTooLong"))
      return
    }
    onSend(text, files)
    setDraft("")
    setAttachments([])
    setError(null)
  }

  return (
    <div className="ai-composer-footer">
      <form className="ai-composer-form" onSubmit={submit} aria-label={t("ai.composerLabel")}>
        {attachments.length > 0 && (
          <ul className="ai-attachments" aria-label={t("ai.attachments")}>
            {attachments.map((file) => (
              <li key={file.id} className="ai-attachment-chip">
                {file.kind === "image" ? <ImageIcon aria-hidden="true" /> : <FileText aria-hidden="true" />}
                <span className="max-w-[132px] truncate" title={file.name}>{file.name}</span>
                <button
                  type="button"
                  className="ai-attachment-remove"
                  aria-label={t("ai.removeAttachment", { name: file.name })}
                  disabled={busy}
                  onClick={() => {
                    setAttachments((current) => current.filter((item) => item.id !== file.id))
                    // The upload is already stored; removing the chip should not leave it behind.
                    if (file.ref) void deleteAttachment(file.ref.id).catch(() => undefined)
                    if (file.preview) URL.revokeObjectURL(file.preview)
                  }}
                >
                  <X aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <InputGroup className="ai-composer-group">
          <InputGroupTextarea
            ref={textarea}
            value={draft}
            rows={4}
            disabled={disabled || busy || reading}
            placeholder={t("ai.placeholder")}
            aria-label={t("ai.composerLabel")}
            className="ai-composer-textarea"
            onChange={(event) => { setDraft(event.target.value); setError(null) }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return
              // Enter sends; Shift+Enter is the newline. The composition guard above keeps a
              // Chinese IME's confirmation Enter from sending a half-written message.
              if (event.key === "Enter" && !event.shiftKey) submit(event)
            }}
          />
          <InputGroupAddon align="block-end" className="ai-composer-actions">
            <Hint label={t("ai.attach")} side="top">
              <InputGroupButton
                size="icon-sm"
                variant="ghost"
                className="ai-composer-attach"
                aria-label={t("ai.attach")}
                aria-disabled={!imagesAllowed}
                disabled={disabled || busy || reading || !imagesAllowed}
                onClick={() => picker.current?.click()}
              >
                <Paperclip aria-hidden="true" />
              </InputGroupButton>
            </Hint>
            {busy ? (
              // While an answer is being written the send button becomes a stop: it is
              // the one control a waiting user reaches for, so it takes the same corner
              // rather than adding a second button beside it.
              <Hint label={t("ai.stop")} side="top">
                <InputGroupButton
                  type="button"
                  size="icon-sm"
                  variant="destructive"
                  className="ai-composer-stop"
                  aria-label={t("ai.stop")}
                  onClick={onStop}
                >
                  <Square className="fill-current" aria-hidden="true" />
                </InputGroupButton>
              </Hint>
            ) : (
              <Hint label={t("ai.sendShortcut")} side="top">
                <InputGroupButton
                  type="submit"
                  size="icon-sm"
                  variant="default"
                  className="ai-composer-send"
                  aria-label={t("ai.send")}
                  aria-disabled={disabled || reading || (!draft.trim() && attachments.length === 0)}
                  disabled={disabled || reading || (!draft.trim() && attachments.length === 0)}
                >
                  <ArrowUp aria-hidden="true" />
                </InputGroupButton>
              </Hint>
            )}
          </InputGroupAddon>
        </InputGroup>
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          accept="image/png,image/jpeg,image/webp,text/*,.log,.conf,.json,.yaml,.yml,.md,.sh,.txt"
          onChange={(event) => void attach(event.target.files)}
        />
        {error && <p className="text-xs text-danger" role="alert">{error}</p>}
      </form>
    </div>
  )
}

/**
 * Reads one file the way the model needs it.
 *
 * Images are downscaled in the browser — a phone photo is megabytes of pixels
 * nobody needs — and sent as an image part. A PDF goes as it is, within the message
 * size. Plain text is kept inline so it works on endpoints without file support.
 */
async function readAttachment(
  file: File,
  t: (key: string, options?: Record<string, unknown>) => string
): Promise<PendingAttachment> {
  const base = { id: crypto.randomUUID(), name: file.name, size: file.size }

  if (file.type.startsWith("image/")) {
    if (!(IMAGE_INPUT_TYPES as readonly string[]).includes(file.type)) {
      throw new Error(file.type === "image/gif" ? t("ai.attachmentGif") : t("ai.attachmentImageUnsupported"))
    }
    // An undecodable image is a user mistake, not a crash: say so in their language.
    const blob = await shrinkImage(file).catch(() => {
      throw new Error(t("ai.attachmentImageInvalid"))
    })
    if (blob.size > MAX_IMAGE_BYTES) throw new Error(t("ai.attachmentTooLarge"))
    // The worker rejects oversized or unsupported files too; one message covers both.
    const ref = await uploadAttachment(blob, file.name).catch(() => {
      throw new Error(t("ai.attachmentFailed"))
    })
    return { ...base, name: ref.name, mime: ref.mime, preview: URL.createObjectURL(blob), ref, kind: "image" }
  }

  // A console is not where documents live. The attachment that makes sense here is a
  // screenshot of the terminal, which the model can actually read.
  if (file.type === "application/pdf") throw new Error(t("ai.attachmentPdf"))

  if (file.size > MAX_TEXT_BYTES) throw new Error(t("ai.attachmentTooLarge"))
  const bytes = new Uint8Array(await file.arrayBuffer())
  let text: string
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
  } catch {
    throw new Error(t("ai.attachmentTextOnly"))
  }
  if (text.includes("\0")) throw new Error(t("ai.attachmentTextOnly"))
  return { ...base, mime: "text/plain", preview: "", kind: "text", text }
}

/**
 * Draws the image into a canvas at a bounded size and exports WebP.
 *
 * WebP is about 40% smaller than JPEG on a screenshot of text, and it keeps glyph
 * edges crisp where JPEG smears them — which matters when the whole point of the
 * picture is that the model can read it. Browsers without a WebP encoder quietly
 * hand back a PNG instead, so the result is checked rather than assumed.
 */
async function shrinkImage(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement("canvas")
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext("2d")
  if (!context) throw new Error("canvas unavailable")
  // White behind, so a transparent PNG does not turn black once flattened.
  context.fillStyle = "#ffffff"
  context.fillRect(0, 0, width, height)
  context.drawImage(bitmap, 0, 0, width, height)
  bitmap.close()
  const webp = await encode(canvas, "image/webp", 0.85)
  const blob = webp?.type === "image/webp" ? webp : await encode(canvas, "image/jpeg", 0.85)
  if (!blob) throw new Error("canvas unavailable")
  return blob
}

function encode(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

/** Text files are inlined; images and documents travel as parts. */
function combineText(draft: string, attachments: PendingAttachment[]): string {
  const inlined = attachments
    .filter((item) => item.kind === "text" && item.text)
    .map((item) => `\n[Attachment: ${item.name}]\n${item.text}\n[/Attachment]`)
  return [draft.trim(), ...inlined].filter(Boolean).join("\n")
}
