/**
 * Upload, read and delete endpoints for AI attachments.
 *
 * An upload travels over HTTP so the bytes are fetched once, when the turn is
 * built: the session socket only ever carries the id. The read side exists so a
 * restored transcript can show the picture again instead of a bare file name.
 */
import { randomBytes } from "../domain/bytes.ts"
import {
  MAX_ATTACHMENT_BYTES,
  attachmentKey,
  isAttachmentMime,
  newAttachmentId,
  readAttachmentId,
  type AttachmentBucket,
} from "../domain/attachments.ts"
import { jsonError } from "./auth.ts"
import { json } from "./response.ts"

export type AttachmentEnv = { ATTACHMENTS: AttachmentBucket }

const MAX_NAME_LENGTH = 120

export async function handleUploadAttachment(
  request: Request,
  env: AttachmentEnv,
  url: URL
): Promise<Response> {
  const mime = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
  if (!isAttachmentMime(mime)) return jsonError("INVALID_REQUEST", "Unsupported attachment type", 415)

  // Checked before reading the body as well: a client that declares too much is
  // refused without the worker buffering it first.
  const declared = Number(request.headers.get("content-length") ?? "0")
  if (Number.isFinite(declared) && declared > MAX_ATTACHMENT_BYTES) {
    return jsonError("INVALID_REQUEST", "Attachment is too large", 413)
  }

  const body = await request.arrayBuffer()
  if (body.byteLength === 0) return jsonError("INVALID_REQUEST", "Attachment is empty", 400)
  if (body.byteLength > MAX_ATTACHMENT_BYTES) {
    return jsonError("INVALID_REQUEST", "Attachment is too large", 413)
  }

  const name = (url.searchParams.get("name") ?? "image").slice(0, MAX_NAME_LENGTH)
  const id = newAttachmentId(randomBytes(16))
  await env.ATTACHMENTS.put(attachmentKey(id), body, {
    httpMetadata: { contentType: mime },
    customMetadata: { name },
  })
  return json({ id, name, mime, size: body.byteLength }, 201)
}

export async function handleDeleteAttachment(env: AttachmentEnv, raw: string): Promise<Response> {
  const id = readAttachmentId(raw)
  if (!id) return jsonError("NOT_FOUND", "Unknown attachment", 404)
  await env.ATTACHMENTS.delete(attachmentKey(id))
  return json({ ok: true })
}

/**
 * Serves one attachment back to the transcript.
 *
 * Ids are random per upload and never reused, so the bytes behind one are
 * immutable: the browser may keep them for as long as it likes. The response is
 * still `private`, and it is served with a locked-down CSP because the only thing
 * this route ever returns is an image the user uploaded.
 */
export async function handleReadAttachment(env: AttachmentEnv, raw: string): Promise<Response> {
  const id = readAttachmentId(raw)
  if (!id) return jsonError("NOT_FOUND", "Unknown attachment", 404)

  const object = await env.ATTACHMENTS.get(attachmentKey(id))
  if (!object) return jsonError("NOT_FOUND", "Unknown attachment", 404)

  const bytes = await object.arrayBuffer()
  const mime = object.httpMetadata?.contentType
  return new Response(bytes, {
    headers: {
      "content-type": mime && isAttachmentMime(mime) ? mime : "application/octet-stream",
      "content-length": String(bytes.byteLength),
      "cache-control": "private, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  })
}
