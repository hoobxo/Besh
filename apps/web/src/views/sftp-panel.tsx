import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"
import { ArrowUp, ChevronRight, Copy, Download, Eraser, File as FileIcon, FilePlus2, Folder, FolderOpen, FolderPlus, Link2, Loader2, Pencil, Plug, RefreshCw, Save, Trash2, Unplug, Upload, UploadCloud } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { toast } from "sonner"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { PromptDialog } from "@/components/prompt-dialog"
import { Hint } from "@/components/hint"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/format"
import { decodeTextFile, encodeTextFile, formatByteLimit, isWritableMode, MAX_EDITABLE_BYTES, sameVersion, type TextFile } from "@/lib/text-file"
import { TransferQueue, type TransferItem } from "@/lib/transfer-queue"
import { TransferCard } from "@/views/transfer-card"
import type { FsReply, SftpEntry } from "@/lib/api"

/**
 * The file dock: a directory tree, a dense five-column table and a toolbar, laid
 * out like the design (175px tree, 29px rows, 39px toolbar).
 *
 * Directory navigation, tree expansion and file actions share an operation lock.
 * Cached listings keep the tree and table in sync without duplicate requests.
 */
export type FsOperation =
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

const FileEditor = lazy(() => import("@/views/file-editor").then((module) => ({ default: module.FileEditor })))

/** Chunk size for uploads: base64 grows by a third, and a frame has a size budget. */
const UPLOAD_CHUNK = 160 * 1024
/** A transfer is held in memory on both sides, so it has to stop somewhere. */
const MAX_TRANSFER = 8 * 1024 * 1024
/** Small enough that one slice always answers, large enough to be quick. */
const DOWNLOAD_SLICE = 256 * 1024
/** Previewing decodes the whole buffer, so it stops earlier than a download does. */
const PREVIEW_LIMIT = 1024 * 1024
/** Fixed id, so a new file updates the card instead of stacking another toast. */
const TRANSFER_TOAST = "besh-transfers"

/** Decodes the base64 a `read` reply carries back into bytes. */
function fromBase64(data: string): Uint8Array {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export function SftpPanel({ request, enabled, onClearScreen, onDisconnect, onReconnect, detached }: {
  request: (
    op: FsOperation,
    path: string,
    extra?: { to?: string; data?: string; maxBytes?: number; offset?: number; uploadId?: string }
  ) => Promise<FsReply>
  enabled: boolean
  onClearScreen: () => void
  /** Ends the socket but leaves the tab in place. */
  onDisconnect: () => void
  /** Starts a fresh session for this tab after a disconnect. */
  onReconnect: () => void
  /** True while the tab is showing a closed connection. */
  detached: boolean
}) {
  const { t } = useTranslation()
  const [path, setPath] = useState("/root")
  // Editing only touches a draft: the breadcrumb always names the directory whose
  // listing is on screen, even when a typed path fails to load.
  const [editingPath, setEditingPath] = useState(false)
  const [draft, setDraft] = useState("/root")
  const pathInput = useRef<HTMLInputElement>(null)
  const [entries, setEntries] = useState<SftpEntry[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  // State controls the visuals; the ref closes the gap before React rerenders.
  const busyRef = useRef(false)
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const [listings, setListings] = useState<Record<string, SftpEntry[] | null>>({})

  const beginOperation = useCallback(() => {
    if (!enabledRef.current || busyRef.current) return false
    busyRef.current = true
    setBusy(true)
    return true
  }, [])
  const finishOperation = useCallback(() => {
    busyRef.current = false
    setBusy(false)
  }, [])
  const isBlocked = useCallback(() => !enabledRef.current || busyRef.current, [])
  const [edit, setEdit] = useState<EditSession | null>(null)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [discarding, setDiscarding] = useState(false)
  const dirty = edit !== null && edit.text !== edit.original
  const [menuTarget, setMenuTarget] = useState<SftpEntry | null>(null)
  /** Which modal is open, and what it is about. */
  const [asking, setAsking] = useState<
    | { kind: "mkdir" }
    | { kind: "newFile" }
    | { kind: "rename"; entry: SftpEntry }
    | { kind: "delete"; entry: SftpEntry }
    | null
  >(null)
  const uploadPicker = useRef<HTMLInputElement>(null)
  // Drag depth: children fire enter/leave as the pointer crosses them, so a plain
  // boolean flickers the overlay off while the file is still over the dock.
  const dragDepth = useRef(0)
  const [dropping, setDropping] = useState(false)
  /**
   * Transfers run through a queue that owns its own request stream, so a slow file
   * no longer freezes browsing and a dropped chunk resumes instead of restarting.
   */
  const queueRef = useRef<TransferQueue | null>(null)
  const requestRef = useRef(request)
  requestRef.current = request
  if (queueRef.current === null) {
    queueRef.current = new TransferQueue({
      beginUpload: async (target) => {
        const begun = await requestRef.current("upload.begin", target)
        if (!begun.uploadId) throw new Error("upload.begin returned no id")
        return begun.uploadId
      },
      writeChunk: (target, uploadId, offset, data) =>
        requestRef.current("upload.chunk", target, { uploadId, data: toBase64(data), offset }).then(() => undefined),
      endUpload: (target, uploadId) => requestRef.current("upload.end", target, { uploadId }).then(() => undefined),
      abortUpload: (target, uploadId) => requestRef.current("upload.abort", target, { uploadId }).then(() => undefined),
      readRange: async (target, offset, length) => {
        const reply = await requestRef.current("read", target, { maxBytes: length, offset })
        return fromBase64(reply.data ?? "")
      },
    }, { onSettled: (item) => void onTransferSettled(item) })
  }
  const queue = queueRef.current
  useEffect(() => {
    // One toast owns the whole queue: re-creating it per chunk would restart its
    // animation, so it is created once and the card subscribes to the queue itself.
    let shown = false
    const show = () => {
      if (queue.items.length === 0) {
        if (shown) toast.dismiss(TRANSFER_TOAST)
        shown = false
        return
      }
      if (shown) return
      shown = true
      toast.custom(() => <TransferCard queue={queue} />, { id: TRANSFER_TOAST, duration: Infinity, dismissible: false })
    }
    show()
    const unsubscribe = queue.subscribe(show)
    return () => {
      unsubscribe()
      if (shown) toast.dismiss(TRANSFER_TOAST)
    }
  }, [queue])

  /** Saves a finished download, and refreshes the listing after an upload lands. */
  async function onTransferSettled(item: TransferItem) {
    if (item.status === "failed") {
      // The queue keeps the raw error, so a server status code still maps to its own text.
      toast.error(describeFsError(item.reason ?? new Error(item.error ?? ""), t, t(item.direction === "upload" ? "files.uploadFailed" : "files.downloadFailed")))
      return
    }
    if (item.status !== "done") return
    if (item.direction === "download") {
      const bytes = TransferQueue.bytes(item)
      const url = URL.createObjectURL(new Blob([bytes as BlobPart]))
      const anchor = document.createElement("a")
      anchor.href = url
      anchor.download = item.name
      anchor.click()
      URL.revokeObjectURL(url)
      return
    }
    if (enabledRef.current) {
      await readDirectory(path).then(setEntries).catch(() => undefined)
    }
  }

  /** Queues the chosen files; each one keeps its place if the link drops mid-way. */
  async function transferFiles(files: File[]) {
    if (!enabledRef.current) return
    const rejected: string[] = []
    const accepted: { name: string; path: string; bytes: Uint8Array }[] = []
    for (const file of files) {
      if (file.size > MAX_TRANSFER) {
        rejected.push(file.name)
        continue
      }
      accepted.push({ name: file.name, path: join(path, file.name), bytes: new Uint8Array(await file.arrayBuffer()) })
    }
    if (rejected.length > 0) toast.error(t("files.tooLarge", { limit: formatByteLimit(MAX_TRANSFER) }))
    if (accepted.length > 0) queue.addUploads(accepted)
  }

  // A file dropped anywhere else in the app would make the browser open it and
  // throw the session away, so file drags are swallowed window-wide.
  useEffect(() => {
    const swallow = (event: DragEvent) => {
      if (event.dataTransfer && Array.from(event.dataTransfer.types).includes("Files")) event.preventDefault()
    }
    window.addEventListener("dragover", swallow)
    window.addEventListener("drop", swallow)
    return () => {
      window.removeEventListener("dragover", swallow)
      window.removeEventListener("drop", swallow)
    }
  }, [])

  /** A drag only counts when it carries files, not when it carries text or a row. */
  function carriesFiles(event: React.DragEvent<HTMLElement>) {
    return Array.from(event.dataTransfer.types).includes("Files")
  }

  function onDragEnter(event: React.DragEvent<HTMLElement>) {
    if (!carriesFiles(event) || isBlocked()) return
    dragDepth.current += 1
    setDropping(true)
  }

  function onDragOver(event: React.DragEvent<HTMLElement>) {
    if (!carriesFiles(event) || isBlocked()) return
    // Without this the browser refuses the drop and opens the file instead.
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }

  function onDragLeave(event: React.DragEvent<HTMLElement>) {
    if (!carriesFiles(event)) return
    dragDepth.current = Math.max(0, dragDepth.current - 1)
    if (dragDepth.current === 0) setDropping(false)
  }

  function onDrop(event: React.DragEvent<HTMLElement>) {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dragDepth.current = 0
    setDropping(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) void transferFiles(files)
  }

  /** Queues a download; the bytes arrive in slices and are saved when the last one lands. */
  function downloadEntry(entry: SftpEntry) {
    if (!enabledRef.current) return
    const size = entry.size ?? 0
    if (size > MAX_TRANSFER) {
      toast.error(t("files.tooLarge", { limit: formatByteLimit(MAX_TRANSFER) }))
      return
    }
    queue.addDownload({ name: entry.name, path: entry.path, size })
  }

  // Table navigation and tree expansion use the same listing and operation lock.
  // A tree click must not open a second directory request behind the busy overlay.
  const readDirectory = useCallback(async (target: string) => {
    const reply = await request("list", target)
    const next = sortEntries(reply.entries ?? [])
    setListings((current) => ({ ...current, [target]: next }))
    return next
  }, [request])

  const load = useCallback(async (target: string) => {
    if (!beginOperation()) return
    try {
      const next = await readDirectory(target)
      setEntries(next)
      setPath(target)
      setSelected(null)
    } catch (reason) {
      setListings((current) => ({ ...current, [target]: current[target] ?? null }))
      toast.error(describeFsError(reason, t, t("files.loadFailed")))
    } finally {
      finishOperation()
    }
  }, [beginOperation, finishOperation, readDirectory, t])

  const loadChildren = useCallback(async (target: string) => {
    if (!beginOperation()) return
    try {
      await readDirectory(target)
    } catch (reason) {
      // null marks a failed fetch, not an empty folder. Do not spin retrying from
      // the effect; selecting the node or refreshing can explicitly retry it.
      setListings((current) => ({ ...current, [target]: null }))
      toast.error(describeFsError(reason, t, t("files.loadFailed")))
    } finally {
      finishOperation()
    }
  }, [beginOperation, finishOperation, readDirectory, t])

  useEffect(() => {
    if (!enabled) return
    void load("/root")
  }, [enabled, load])

  async function createFolder(name: string) {
    if (!beginOperation()) return
    try {
      await request("mkdir", join(path, name))
      setEntries(await readDirectory(path))
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.mkdirFailed")))
    } finally {
      finishOperation()
    }
  }

  async function createFile(name: string) {
    if (!beginOperation()) return
    try {
      await request("create", join(path, name))
      setEntries(await readDirectory(path))
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.newFileFailed")))
    } finally {
      finishOperation()
    }
  }

  async function removeEntry(entry: SftpEntry) {
    if (!beginOperation()) return
    try {
      const reply = await request("remove", entry.path)
      setEntries(await readDirectory(path))
      // A folder goes with everything inside it; saying how much went is the difference
      // between "it worked" and "it worked, and here is what it took".
      const removed = reply.removed
      if (entry.kind === "directory" && removed) {
        toast.success(t("files.deletedFolder", { files: removed.files, dirs: removed.dirs }))
      }
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.deleteFailed")))
    } finally {
      finishOperation()
    }
  }

  async function renameEntry(entry: SftpEntry, next: string) {
    if (next === entry.name) return
    const target = join(path, next)
    if (!beginOperation()) return
    try {
      await request("rename", entry.path, { to: target })
      setEntries(await readDirectory(path))
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.renameFailed")))
    } finally {
      finishOperation()
    }
  }

  const blocked = !enabled || busy
  const parent = path === "/" ? "/" : path.replace(/\/[^/]+$/, "") || "/"

  /** Reads a whole file in slices; `stalled` names where the server went quiet. */
  async function readBytes(target: string, limit: number, stalled: (offset: number) => string): Promise<Uint8Array<ArrayBuffer>> {
    const pieces: Uint8Array[] = []
    let offset = 0
    for (;;) {
      const reply = await request("read", target, { maxBytes: DOWNLOAD_SLICE, offset }).catch(() => {
        throw new Error(stalled(Math.round(offset / 1024)))
      })
      const chunk = fromBase64(reply.data ?? "")
      if (chunk.length === 0) break
      pieces.push(chunk)
      offset += chunk.length
      if (chunk.length < DOWNLOAD_SLICE || offset >= limit) break
    }
    const bytes = new Uint8Array(offset)
    let at = 0
    for (const piece of pieces) {
      bytes.set(piece, at)
      at += piece.length
    }
    return bytes
  }

  function toBase64(bytes: Uint8Array): string {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }

  async function openEditor(entry: SftpEntry) {
    if (isBlocked()) return
    if (entry.kind === "directory") {
      await load(entry.path)
      return
    }
    const size = entry.size ?? 0
    if (size > PREVIEW_LIMIT) {
      toast.error(t("files.editTooLarge", { limit: formatByteLimit(PREVIEW_LIMIT) }))
      return
    }
    // Past the editable ceiling the same frame still opens, just without a cursor.
    const tooBigToEdit = size > MAX_EDITABLE_BYTES
    if (!beginOperation()) return
    try {
      const bytes = await readBytes(entry.path, tooBigToEdit ? PREVIEW_LIMIT : MAX_EDITABLE_BYTES, (offset) => t("files.readStalled", { offset }))
      const decoded = decodeTextFile(bytes)
      if (!decoded) {
        toast.error(t("files.editBinary"))
        return
      }
      const fresh = (await request("stat", entry.path)).entry ?? entry
      setConflict(false)
      setEdit({
        path: entry.path,
        text: decoded.text,
        original: decoded.text,
        eol: decoded.eol,
        size: fresh.size ?? bytes.length,
        modifiedAt: fresh.modifiedAt ?? null,
        readOnly: !isWritableMode(fresh.mode ?? null) || tooBigToEdit,
        readOnlyReason: tooBigToEdit ? "size" : "mode",
      })
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.readFailed")))
    } finally {
      finishOperation()
    }
  }

  /** Re-reads the server copy and drops the buffer on top of it. */
  async function reloadEditor() {
    if (!edit) return
    const target = edit.path
    setConflict(false)
    try {
      const bytes = await readBytes(target, MAX_EDITABLE_BYTES, (offset) => t("files.readStalled", { offset }))
      const decoded = decodeTextFile(bytes)
      if (!decoded) {
        toast.error(t("files.editBinary"))
        return
      }
      const fresh = (await request("stat", target)).entry
      setEdit({
        path: target,
        text: decoded.text,
        original: decoded.text,
        eol: decoded.eol,
        size: fresh?.size ?? bytes.length,
        modifiedAt: fresh?.modifiedAt ?? null,
        readOnly: edit.readOnly || (fresh ? !isWritableMode(fresh.mode ?? null) : false),
        readOnlyReason: edit.readOnlyReason,
      })
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.readFailed")))
    }
  }

  async function saveEditor(force = false) {
    if (!edit || edit.readOnly || saving) return
    setSaving(true)
    try {
      // mtime has one-second resolution, so this also catches same-size rewrites only
      // when the second differs; anything else is accepted as the reader's version.
      if (!force) {
        const fresh = (await request("stat", edit.path)).entry
        if (fresh && !sameVersion({ size: edit.size, modifiedAt: edit.modifiedAt }, { size: fresh.size ?? 0, modifiedAt: fresh.modifiedAt ?? null })) {
          setConflict(true)
          return
        }
      }
      const bytes = encodeTextFile(edit.text, edit.eol)
      const begun = await request("upload.begin", edit.path)
      if (!begun.uploadId) throw new Error(t("files.uploadFailed"))
      const uploadId = begun.uploadId
      try {
        for (let offset = 0; offset < bytes.length; offset += UPLOAD_CHUNK) {
          const slice = bytes.subarray(offset, Math.min(offset + UPLOAD_CHUNK, bytes.length))
          await request("upload.chunk", edit.path, { uploadId, data: toBase64(slice) })
        }
        await request("upload.end", edit.path, { uploadId })
      } catch (error) {
        // The staged temporary file stays server-side until aborted; never leave it behind.
        void request("upload.abort", edit.path, { uploadId }).catch(() => {})
        throw error
      }
      const fresh = (await request("stat", edit.path)).entry
      setConflict(false)
      setEdit({ ...edit, original: edit.text, size: fresh?.size ?? bytes.length, modifiedAt: fresh?.modifiedAt ?? null })
      toast.success(t("files.saved"))
      setEntries(await readDirectory(path))
    } catch (reason) {
      toast.error(describeFsError(reason, t, t("files.saveFailed")))
    } finally {
      setSaving(false)
    }
  }

  function closeEditor() {
    if (saving) return
    if (dirty) {
      setDiscarding(true)
      return
    }
    setConflict(false)
    setEdit(null)
  }

  const startPathEdit = useCallback(() => {
    setDraft(path)
    setEditingPath(true)
  }, [path])
  /** Leave edit mode first: the breadcrumb keeps naming the listing until the load lands. */
  const submitPath = useCallback(async () => {
    const target = draft.trim() || "/"
    setEditingPath(false)
    await load(target)
  }, [draft, load])
  useEffect(() => {
    if (!editingPath) return
    pathInput.current?.focus()
    pathInput.current?.select()
  }, [editingPath])

  /**
   * Deep paths keep the root and the two nearest hops; the ellipsis is the way back into
   * the editor, so a long path can never squeeze the toolbar out of shape.
   */
  const crumbs = useMemo<Crumb[]>(() => {
    const names = path.split("/").filter(Boolean)
    const trail: Crumb[] = [
      { label: "/", path: "/" },
      ...names.map((name, index) => ({ label: name, path: `/${names.slice(0, index + 1).join("/")}` })),
    ]
    if (trail.length <= 4) return trail
    return [trail[0]!, { label: "…", path: null }, trail[trail.length - 2]!, trail[trail.length - 1]!]
  }, [path])

  /** One description per prompt keeps its three strings from drifting apart. */
  const prompt =
    asking?.kind === "rename"
      ? { title: t("files.rename"), label: t("files.renamePrompt", { name: asking.entry.name }), confirm: t("files.rename") }
      : asking?.kind === "newFile"
        ? { title: t("files.newFile"), label: t("files.newFilePrompt"), confirm: t("files.newFile") }
        : { title: t("files.newFolder"), label: t("files.newFolderPrompt"), confirm: t("files.newFolder") }

  /**
   * Copies through the clipboard API. It needs a secure context and a user gesture, so
   * every caller runs from a click; a plain http deployment would land in the catch.
   */
  async function copyText(value: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(t("files.copied"))
    } catch {
      toast.error(t("files.copyFailed"))
    }
  }

  // The menu changes shape with the target, so it is assembled from the groups that
  // apply and a divider only ever sits between groups that actually render.
  const menuGroups: ReactNode[][] = []

  if (menuTarget) {
    menuGroups.push([
      <ContextMenuItem key="open" disabled={blocked} onSelect={() => void openEditor(menuTarget)}>
        {menuTarget.kind === "directory" ? (
          <FolderOpen data-icon="inline-start" />
        ) : (
          <FileIcon data-icon="inline-start" />
        )}
        {t("files.open")}
      </ContextMenuItem>,
      <ContextMenuItem key="copyPath" onSelect={() => void copyText(menuTarget.path)}>
        <Copy data-icon="inline-start" />
        {t("files.copyPath")}
      </ContextMenuItem>,
      <ContextMenuItem
        key="rename"
        disabled={blocked}
        onSelect={() => setAsking({ kind: "rename", entry: menuTarget })}
      >
        <Pencil data-icon="inline-start" />
        {t("files.rename")}
      </ContextMenuItem>,
    ])
  }

  // Creating always lands in the directory on screen, never inside the clicked row,
  // so a folder offers no create action at all.
  if (menuTarget?.kind !== "directory") {
    menuGroups.push([
      <ContextMenuSub key="create">
        <ContextMenuSubTrigger disabled={blocked}>
          <FilePlus2 data-icon="inline-start" />
          {t("files.newMenu")}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent className="w-40">
          <ContextMenuItem disabled={blocked} onSelect={() => setAsking({ kind: "newFile" })}>
            <FilePlus2 data-icon="inline-start" />
            {t("files.newFile")}
          </ContextMenuItem>
          <ContextMenuItem disabled={blocked} onSelect={() => setAsking({ kind: "mkdir" })}>
            <FolderPlus data-icon="inline-start" />
            {t("files.newFolder")}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>,
    ])
  }

  // A folder row is not a transfer target here either: uploading always means "into the
  // directory on screen", and reading that from a folder row is exactly the ambiguity
  // the row is dropped to avoid. Enter the folder to upload into it.
  if (menuTarget?.kind !== "directory") {
    menuGroups.push([
      ...(menuTarget?.kind === "file"
        ? [
            <ContextMenuItem key="download" disabled={blocked} onSelect={() => void downloadEntry(menuTarget)}>
              <Download data-icon="inline-start" />
              {t("files.download")}
            </ContextMenuItem>,
          ]
        : []),
      <ContextMenuItem key="upload" disabled={blocked} onSelect={() => uploadPicker.current?.click()}>
        <Upload data-icon="inline-start" />
        {t("files.upload")}
      </ContextMenuItem>,
    ])
  }

  if (path !== "/" || menuTarget) {
    menuGroups.push([
      ...(path !== "/"
        ? [
            <ContextMenuItem key="up" disabled={blocked} onSelect={() => void load(parent)}>
              <ArrowUp data-icon="inline-start" />
              {t("files.up")}
            </ContextMenuItem>,
          ]
        : []),
      ...(menuTarget
        ? [
            <ContextMenuItem
              key="delete"
              disabled={blocked}
              variant="destructive"
              onSelect={() => setAsking({ kind: "delete", entry: menuTarget })}
            >
              <Trash2 data-icon="inline-start" />
              {t("files.delete")}
            </ContextMenuItem>,
          ]
        : []),
    ])
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar: 39px */}
      <div className="flex h-[39px] shrink-0 items-center gap-1 border-b border-border px-2">
        {editingPath ? (
          /* The pill becomes a pill-shaped field holding the current path, already
             selected, so typing replaces it and Enter jumps straight there. */
          <form
            className="flex min-w-0 max-w-[45%] flex-1 items-center"
            onSubmit={(event) => {
              event.preventDefault()
              if (!isBlocked()) void submitPath()
            }}
          >
            <Input
              ref={pathInput}
              id="path-input"
              value={draft}
              disabled={blocked}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault()
                  setEditingPath(false)
                }
              }}
              onBlur={() => setEditingPath(false)}
              aria-label={t("files.path")}
              className="h-7 w-full min-w-0 rounded-full border-border/70 bg-background/60 px-3 font-mono text-[11px]"
            />
          </form>
        ) : (
          <div
            role="navigation"
            aria-label={t("files.path")}
            title={t("files.editPath")}
            onDoubleClick={startPathEdit}
            className="flex h-7 w-fit max-w-[45%] items-center gap-0.5 overflow-hidden rounded-full border border-border/70 bg-background/60 px-2.5 font-mono text-[11px]"
          >
            {crumbs.map((crumb, index) => {
              const current = index === crumbs.length - 1
              return (
                <span key={`${crumb.path ?? "gap"}-${index}`} className="flex min-w-0 items-center gap-0.5">
                  {index > 0 && (
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground/40" aria-hidden="true" />
                  )}
                  <button
                    type="button"
                    disabled={blocked}
                    aria-current={current ? "page" : undefined}
                    onClick={() => {
                      // The gap stands in for the hops the pill had to drop, so it opens
                      // the editor rather than pretending to be a directory.
                      if (crumb.path === null) startPathEdit()
                      else if (!current) void load(crumb.path)
                    }}
                    className={cn(
                      "max-w-[12ch] truncate rounded-full px-1.5 py-0.5 transition-colors duration-150 ease-[var(--ease-out-soft)]",
                      current
                        ? "bg-muted text-foreground"
                        : "text-muted-foreground hover:bg-muted hover:text-foreground",
                      "disabled:pointer-events-none disabled:opacity-60"
                    )}
                  >
                    {crumb.label}
                  </button>
                </span>
              )
            })}
          </div>
        )}
        <span className="flex-1" />
        <Hint label={t("files.up")}>
          <Button variant="ghost" size="icon-sm" aria-label={t("files.up")} disabled={blocked || path === "/"} onClick={() => void load(parent)}>
            <ArrowUp />
          </Button>
        </Hint>
        <Hint label={t("files.refresh")}>
          <Button variant="ghost" size="icon-sm" aria-label={t("files.refresh")} disabled={blocked} onClick={() => void load(path)}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          </Button>
        </Hint>
        <span className="mx-0.5 h-5 w-px shrink-0 bg-border" role="separator" aria-orientation="vertical" />
        <Hint label={t("files.clearScreen")}>
          <Button variant="ghost" size="icon-sm" aria-label={t("files.clearScreen")} onClick={onClearScreen}>
            <Eraser />
          </Button>
        </Hint>
        {detached ? (
          <Hint label={t("files.reconnect")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("files.reconnect")}
              className="text-ok"
              onClick={onReconnect}
            >
              <Plug />
            </Button>
          </Hint>
        ) : (
          <Hint label={t("files.disconnect")}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("files.disconnect")}
              className="text-muted-foreground hover:text-danger"
              onClick={onDisconnect}
            >
              <Unplug />
            </Button>
          </Hint>
        )}
      </div>

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Directory tree: 175px */}
        <div
        className={cn("w-[220px] shrink-0 overflow-auto border-r border-border p-2 transition-opacity", busy && "opacity-50")} aria-busy={busy}>
          <TreeBranch
            label="/"
            path="/"
            depth={0}
            current={path}
            listings={listings}
            enabled={!blocked && entries !== null}
            isBlocked={isBlocked}
            onLoadChildren={loadChildren}
            onOpen={(target) => void load(target)}
          />
        </div>

        {/* File table */}
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className={cn("relative min-w-0 flex-1 overflow-auto transition-opacity", busy && "opacity-60")}
              aria-busy={busy}
              onDragEnter={onDragEnter}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onDrop={onDrop}
              onContextMenuCapture={(event) => {
                if (isBlocked()) { event.preventDefault(); event.stopPropagation() }
              }}
              onContextMenu={(event) => {
                // a row sets its own target first; reaching here means empty space
                if (!(event.target as HTMLElement).closest("[data-entry-row]")) setMenuTarget(null)
              }}
            >
          <Table className="text-[11px]">
            <TableHeader className="sticky top-0 z-10 bg-background">
              <TableRow className="border-b border-border hover:bg-transparent">
                <TableHead className="h-[29px] px-3 py-0 text-[11px] font-medium text-muted-foreground">{t("files.name")}</TableHead>
                <TableHead className="h-[29px] px-3 py-0 text-[11px] font-medium text-muted-foreground">{t("files.size")}</TableHead>
                <TableHead className="h-[29px] px-3 py-0 text-[11px] font-medium text-muted-foreground">{t("files.kind")}</TableHead>
                <TableHead className="h-[29px] px-3 py-0 text-[11px] font-medium text-muted-foreground">{t("files.modified")}</TableHead>
                <TableHead className="h-[29px] px-3 py-0 text-[11px] font-medium text-muted-foreground">{t("files.mode")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/* A skeleton keeps the table's shape while the listing arrives, so the
                  panel does not look frozen at one grey line. */}
              {entries === null &&
                enabled &&
                Array.from({ length: 6 }).map((_, index) => (
                  <TableRow key={`skeleton-${index}`} className="border-b border-border/60">
                    {Array.from({ length: 5 }).map((__, cell) => (
                      <TableCell key={cell} className="h-[29px] px-3 py-0">
                        <span className="block h-2 animate-pulse rounded bg-muted" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              {entries === null && !enabled && (
                <TableRow>
                  <TableCell colSpan={5} className="px-3 py-6 text-center text-muted-foreground">
                    {t("files.notConnected")}
                  </TableCell>
                </TableRow>
              )}
              {entries?.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="px-3 py-8 text-center">
                    <Folder className="mx-auto mb-2 size-6 text-muted-foreground" aria-hidden="true" />
                    <p className="text-[12px] font-medium">{t("files.emptyTitle")}</p>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">{t("files.emptyHint")}</p>
                  </TableCell>
                </TableRow>
              )}
              {entries?.map((entry) => (
                <TableRow
                  key={entry.path}
                  data-entry-row
                  data-selected={selected === entry.path}
                  onClick={() => { if (!isBlocked()) setSelected(entry.path) }}
                  aria-disabled={blocked}
                  onContextMenu={(event) => {
                    if (isBlocked()) { event.preventDefault(); return }
                    setSelected(entry.path)
                    setMenuTarget(entry)
                  }}
                  onDoubleClick={() => void openEditor(entry)}
                  className={cn(
                    "cursor-pointer border-b border-border/60 transition-colors duration-150 ease-[var(--ease-out-soft)] hover:bg-muted/60",
                    selected === entry.path && "bg-accent"
                  )}
                >
                  <TableCell className="h-[29px] px-3 py-0">
                    <span className="flex items-center gap-2">
                      <EntryIcon kind={entry.kind} />
                      <Hint label={entry.name}>
                        <span className="truncate">{entry.name}</span>
                      </Hint>
                    </span>
                  </TableCell>
                  <TableCell className="h-[29px] px-3 py-0 text-muted-foreground">
                    {entry.kind === "directory" || entry.size === undefined ? "" : formatBytes(entry.size)}
                  </TableCell>
                  <TableCell className="h-[29px] px-3 py-0 text-muted-foreground">
                    {t(entry.kind === "directory" ? "files.kindDirectory" : entry.kind === "symlink" ? "files.kindLink" : "files.kindFile")}
                  </TableCell>
                  <TableCell className="h-[29px] px-3 py-0 text-muted-foreground">{formatDate(entry.modifiedAt)}</TableCell>
                  <TableCell className="h-[29px] px-3 py-0 font-mono text-muted-foreground">{formatMode(entry)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
      {/* Dropping onto the list is the only drop zone: the caret sits on the
          directories the files will actually land in. */}
      {dropping && (
        <div
          className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-background/85 backdrop-blur-[2px]"
          role="status"
          aria-live="polite"
        >
          <div className="mx-6 flex w-full max-w-md flex-col items-center gap-2 rounded-xl border-2 border-dashed border-primary/50 bg-background px-6 py-8 text-center">
            <UploadCloud className="size-7 text-primary" aria-hidden="true" />
            <p className="text-[13px] font-medium">{t("files.dropTitle")}</p>
            <p className="break-all text-[11px] text-muted-foreground">{t("files.dropHint", { path })}</p>
          </div>
        </div>
      )}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent className="w-40">
            {menuGroups.flatMap((group, index) =>
              index === 0 ? group : [<ContextMenuSeparator key={`separator-${index}`} />, ...group]
            )}
          </ContextMenuContent>
        </ContextMenu>
      </div>


      <PromptDialog
        open={asking?.kind === "mkdir" || asking?.kind === "newFile" || asking?.kind === "rename"}
        title={prompt.title}
        label={prompt.label}
        defaultValue={asking?.kind === "rename" ? asking.entry.name : ""}
        confirmLabel={prompt.confirm}
        onOpenChange={(open) => !open && setAsking(null)}
        onSubmit={(value) => {
          if (asking?.kind === "rename") void renameEntry(asking.entry, value)
          else if (asking?.kind === "newFile") void createFile(value)
          else void createFolder(value)
          setAsking(null)
        }}
      />

      <ConfirmDialog
        open={asking?.kind === "delete"}
        title={t("files.deleteEntryTitle", { name: asking?.kind === "delete" ? asking.entry.name : "" })}
        description={
          asking?.kind === "delete" && asking.entry.kind === "directory"
            ? t("files.deleteDirectoryHint")
            : t("files.deleteEntryHint")
        }
        confirmLabel={t("files.delete")}
        onOpenChange={(open) => !open && setAsking(null)}
        onConfirm={() => {
          if (asking?.kind === "delete") void removeEntry(asking.entry)
          setAsking(null)
        }}
      />

      <input
        ref={uploadPicker}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          if (files.length > 0) void transferFiles(files)
          if (uploadPicker.current) uploadPicker.current.value = ""
        }}
      />

      <Dialog
        open={edit !== null}
        onOpenChange={(open) => {
          if (!open) closeEditor()
        }}
      >
        <DialogContent
          className="flex h-[80vh] flex-col sm:max-w-4xl"
          // Same reason as the preview: focus the surface, not the save button, so its
          // tooltip does not open the moment the editor appears.
          tabIndex={-1}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            ;(event.currentTarget as HTMLElement).focus()
          }}
        >
          <DialogHeader>
            <DialogTitle className="pr-24 font-mono text-[13px] font-normal">
              <span className="block truncate" title={edit?.path ?? ""}>
                {edit?.path ?? ""}
              </span>
            </DialogTitle>
            <DialogDescription className="text-[11px]">
              {edit?.readOnly
                ? t(edit.readOnlyReason === "size" ? "files.editReadOnlySize" : "files.editReadOnly")
                : t("files.editHint", { eol: edit?.eol.length === 2 ? "CRLF" : "LF" })}
            </DialogDescription>
          </DialogHeader>
          <Hint label={t("files.save")}>
            <Button
              variant="ghost"
              size="icon-sm"
              className={dirty && !edit?.readOnly ? "absolute top-2 right-10 text-primary" : "absolute top-2 right-10"}
              aria-label={t("files.save")}
              disabled={!dirty || saving || edit?.readOnly === true}
              onClick={() => void saveEditor()}
            >
              {saving ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Save className="size-4" aria-hidden="true" />}
            </Button>
          </Hint>
          {conflict && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-[6px] border border-danger/30 bg-danger/10 px-3 py-2">
              <span className="text-[12px] text-danger">{t("files.editConflict")}</span>
              <div className="flex gap-2">
                <Button variant="ghost" size="xs" onClick={() => void saveEditor(true)}>
                  {t("files.editOverwrite")}
                </Button>
                <Button variant="ghost" size="xs" onClick={() => void reloadEditor()}>
                  {t("files.editReload")}
                </Button>
              </div>
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden rounded-[6px] bg-muted/40">
            {edit && (
              <Suspense fallback={<div className="h-full w-full" />}>
                <FileEditor
                  path={edit.path}
                  value={edit.text}
                  readOnly={edit.readOnly || saving}
                  onSave={() => void saveEditor()}
                  onChange={(text) => setEdit((current) => (current === null ? current : { ...current, text }))}
                />
              </Suspense>
            )}
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={discarding}
        title={t("files.discardTitle")}
        description={t("files.discardHint")}
        confirmLabel={t("files.discard")}
        onOpenChange={setDiscarding}
        onConfirm={() => {
          setDiscarding(false)
          setConflict(false)
          setEdit(null)
        }}
      />

    </div>
  )
}

/** A breadcrumb hop; `null` marks the collapsed middle of a deep path. */
type Crumb = { label: string; path: string | null }

/** An editor buffer plus the server version it was read from. */
type EditSession = {
  path: string
  text: string
  original: string
  eol: TextFile["eol"]
  size: number
  modifiedAt: number | null
  readOnly: boolean
  readOnlyReason: "mode" | "size"
}

/** What a failed file operation means, in the reader's language. */
function describeFsError(reason: unknown, t: (key: string) => string, fallback: string): string {
  // SSH_FX_* status codes, which are the only thing the server really knows.
  const status = (reason as { status?: number } | null)?.status
  switch (status) {
    case 2:
      return t("files.errNotFound")
    case 3:
      return t("files.errPermission")
    case 4:
      return t("files.errRefused")
    case 5:
      return t("files.errUnsupported")
    case 8:
      return t("files.errRejected")
    case 11:
      return t("files.errExists")
    default:
      // Not a status: the message is specific ("File exceeds the 8 MB read limit") and
      // worth keeping over a generic sentence.
      return reason instanceof Error && reason.message ? reason.message : fallback
  }
}

/** One directory level; children load on expand so a huge tree stays cheap. */
function TreeBranch({ label, path, depth, current, listings, enabled, isBlocked, onLoadChildren, onOpen }: {
  label: string
  path: string
  depth: number
  current: string
  listings: Record<string, SftpEntry[] | null>
  enabled: boolean
  isBlocked: () => boolean
  onLoadChildren: (path: string) => Promise<void>
  onOpen: (path: string) => void
}) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(depth === 0)
  const nodeRef = useRef<HTMLDivElement>(null)
  const isSelf = current === path
  const holdsCurrent = current.startsWith(path === "/" ? "//" : `${path}/`)
  // The user's collapse wins. An ancestor opens when the path moves into it, and stays
  // shut after a deliberate collapse until the path changes again.
  const expanded = open
  const children = listings[path]

  useEffect(() => {
    if (isSelf) setOpen(true)
  }, [isSelf])

  useEffect(() => {
    if (holdsCurrent) setOpen(true)
  }, [holdsCurrent])

  useEffect(() => {
    if (!expanded || !enabled || children !== undefined) return
    void onLoadChildren(path)
  }, [expanded, enabled, children, path, onLoadChildren])

  useEffect(() => {
    if (current !== path) return
    nodeRef.current?.scrollIntoView({ block: "nearest" })
  }, [current, path])

  return (
    <div>
      {/* Two targets, two meanings: the caret opens and closes the branch, the name
          goes there. One target doing both is what made moving to another directory
          collapse the branch you were leaving. */}
      <div
        ref={nodeRef}
        className={cn(
          "flex h-7 w-full items-center rounded-[9.6px]",
          current === path ? "border border-border bg-accent font-medium text-foreground" : "text-muted-foreground"
        )}
      >
        <button
          type="button"
          disabled={!enabled}
          onClick={() => {
            if (!enabled || isBlocked()) return
            setOpen((value) => !value)
          }}
          aria-expanded={expanded}
          aria-label={expanded ? t("files.collapseBranch") : t("files.expandBranch")}
          className="flex size-5 shrink-0 items-center justify-center rounded-[6px] text-muted-foreground hover:text-foreground disabled:pointer-events-none disabled:cursor-wait"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", expanded && "rotate-90")}
            aria-hidden="true"
          />
        </button>
        <button
          type="button"
          disabled={!enabled}
          onClick={() => {
            if (!enabled || isBlocked() || current === path) return
            setOpen(true)
            onOpen(path)
          }}
          aria-current={current === path ? "true" : undefined}
          className="flex h-7 min-w-0 flex-1 items-center gap-1 pr-1.5 text-left text-[13px] disabled:pointer-events-none disabled:cursor-wait"
        >
          <EntryIcon kind="directory" open={expanded} />
          <Hint label={label} side="right">
            <span className="truncate">{label}</span>
          </Hint>
        </button>
      </div>

      {expanded && children && children.length > 0 && (
        <div className="ml-1.5 border-l border-border pl-2">
          {children.filter((entry) => entry.kind === "directory").map((child) => (
            <TreeBranch
              key={child.path}
              label={child.name}
              path={child.path}
              depth={depth + 1}
              current={current}
              listings={listings}
              enabled={enabled}
              isBlocked={isBlocked}
              onLoadChildren={onLoadChildren}
              onOpen={onOpen}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function EntryIcon({ kind, open = false }: { kind: SftpEntry["kind"]; open?: boolean }) {
  const className = "size-[14px] shrink-0 text-muted-foreground"
  if (kind === "directory") {
    return open ? <FolderOpen className={className} aria-hidden="true" /> : <Folder className={className} aria-hidden="true" />
  }
  if (kind === "symlink") return <Link2 className={className} aria-hidden="true" />
  return <FileIcon className={className} aria-hidden="true" />
}

/** Folders first, each group by name — readdir order means nothing to a user. */
function sortEntries(entries: SftpEntry[]): SftpEntry[] {
  return [...entries].sort((left, right) => {
    const leftDir = left.kind === "directory" ? 0 : 1
    const rightDir = right.kind === "directory" ? 0 : 1
    if (leftDir !== rightDir) return leftDir - rightDir
    return left.name.localeCompare(right.name, "en", { sensitivity: "base" })
  })
}


function join(base: string, name: string): string {
  return base.endsWith("/") ? `${base}${name}` : `${base}/${name}`
}

function formatDate(value: number | undefined): string {
  if (!value) return ""
  // tolerate both: SFTP v3 sends seconds, the session object normalises to ms
  const date = new Date(value < 1e12 ? value * 1000 : value)
  const pad = (part: number) => String(part).padStart(2, "0")
  return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function formatMode(entry: SftpEntry): string {
  const mode = entry.mode ?? 0
  const kind = entry.kind === "directory" ? "d" : entry.kind === "symlink" ? "l" : "-"
  const bits = ["r", "w", "x"]
  const flags = [0o400, 0o200, 0o100, 0o040, 0o020, 0o010, 0o004, 0o002, 0o001]
  const letters = flags.map((flag, index) => ((mode & flag) === flag ? bits[index % 3]! : "-")).join("")
  return kind + letters
}
