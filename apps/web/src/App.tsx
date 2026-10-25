import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { ChevronDown, ChevronRight, LogOut, MoreVertical, Network, Pencil, Plus, Search, Settings, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Toaster } from "@/components/ui/sonner"
import { toast } from "sonner"
import appIcon from "@/assets/web/icon.webp"
import { PROJECT_URL } from "@/lib/project"
import { GithubMark } from "@/components/github-mark"
import { Hint } from "@/components/hint"
import { OsIcon } from "@/components/os-icon"
import { Turnstile } from "@/components/turnstile"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import { api, turnstileConfig, ApiError, type Group, type Permission, type Server } from "@/lib/api"
const ServerDialog = lazy(() =>
  import("@/views/server-dialog").then((module) => ({ default: module.ServerDialog }))
)
/**
 * Shown while the workspace chunk downloads.
 *
 * It mirrors the columns so the screen does not jump when the real thing arrives: the
 * first connect is the one moment a person waits on a download they did not ask for.
 */
function WorkspaceSkeleton() {
  return (
    // Only the workspace is covered here: the status and assistant column lives outside
    // this boundary, so drawing one would squeeze the workspace and jump when the real
    // panels arrive. Inside the workspace the split is the measured one — terminal above,
    // file browser below.
    <div className="flex h-full min-h-0 flex-col" aria-hidden="true">
      <div className="flex min-h-0 flex-[0.67] flex-col gap-2 p-4">
        {[0, 1, 2, 3].map((index) => (
          <div key={index} className="h-4 animate-pulse rounded bg-muted" style={{ width: `${70 - index * 12}%` }} />
        ))}
      </div>
      <div className="flex min-h-0 flex-[0.33] flex-col border-t border-border">
        <div className="flex h-[39px] shrink-0 items-center gap-2 border-b border-border px-2">
          <div className="h-7 w-[188px] animate-pulse rounded-[6px] bg-muted" />
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[150px] shrink-0 flex-col gap-1.5 border-r border-border p-2">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="h-5 animate-pulse rounded-[6px] bg-muted" />
            ))}
          </div>
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
            {Array.from({ length: 7 }).map((_, index) => (
              <div key={index} className="h-5 animate-pulse rounded-[6px] bg-muted" />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const SettingsDialog = lazy(() =>
  import("@/views/settings-dialog").then((module) => ({ default: module.SettingsDialog }))
)
const TerminalView = lazy(() =>
  import("@/views/terminal-view").then((module) => ({ default: module.TerminalView }))
)

type Screen = { name: "checking" } | { name: "login" } | { name: "setup" } | { name: "app" }

const UNGROUPED = "__ungrouped__"

/**
 * A user name this browser signed in with before.
 *
 * The field used to default to "admin", which told every visitor the user name and left
 * only the password to guess. Remembering it locally keeps the convenience for the person
 * who actually uses this browser, and an incognito window starts genuinely blank.
 */
function readRememberedUsername(): string {
  try {
    return localStorage.getItem("besh:username") ?? ""
  } catch {
    return ""
  }
}

export function App() {
  const { t } = useTranslation()
  const [screen, setScreen] = useState<Screen>({ name: "checking" })

  useEffect(() => {
    void (async () => {
      try {
        if (await api.bootstrapRequired()) {
          setScreen({ name: "setup" })
          return
        }
        setScreen((await api.session()) ? { name: "app" } : { name: "login" })
      } catch {
        setScreen({ name: "login" })
      }
    })()
  }, [])

  if (screen.name === "checking") {
    return <main className="grid min-h-dvh place-items-center text-sm text-muted-foreground">{t("app.checking")}</main>
  }
  if (screen.name === "login") {
    return (
      <>
        <LoginScreen onDone={() => setScreen({ name: "app" })} />
        <Toaster />
      </>
    )
  }
  if (screen.name === "setup") {
    return (
      <>
        <SetupScreen onDone={() => setScreen({ name: "app" })} />
        <Toaster />
      </>
    )
  }
  return (
    <>
      <Shell onSignedOut={() => setScreen({ name: "login" })} />
      <Toaster />
    </>
  )
}

/** Three columns: header, grouped server sidebar, workspace. */
function Shell({ onSignedOut }: { onSignedOut: () => void }) {
  const { t } = useTranslation()
  const [servers, setServers] = useState<Server[] | null>(null)
  const [groups, setGroups] = useState<Group[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  type OpenSession = { key: string; server: Server; sessionId: string; ticket: string }
  const [sessions, setSessions] = useState<OpenSession[]>([])
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const session = sessions.find((item) => item.key === activeKey) ?? null
  /** Read by callbacks that must not re-create themselves on every session change. */
  const sessionsRef = useRef<OpenSession[]>([])
  sessionsRef.current = sessions
  const [connectingId, setConnectingId] = useState<string | null>(null)
  /** Connection state per tab: a session can outlive its socket. */
  const [linkState, setLinkState] = useState<Record<string, "connected" | "disconnected">>({})
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<Server | null>(null)
  /**
   * Reconnecting keeps the tab and swaps its ticket: the session object is bound to
   * a ticket, so a fresh one is the only way back after a disconnect.
   */
  const reconnect = useCallback(async (key: string, signal?: AbortSignal) => {
    const target = sessionsRef.current.find((entry) => entry.key === key)
    if (!target) return
    const { sessionId, ticket } = await api.createSession(target.server.id)
    if (signal?.aborted) return
    // Closing the tab while HTTP is in flight must not recreate it.
    setSessions((current) =>
      signal?.aborted ? current : current.map((entry) => (entry.key === key ? { ...entry, sessionId, ticket } : entry))
    )
  }, [])

  /** Closing a session drops its tab and lets the socket go with the unmounted view. */
  const closeSession = useCallback((key: string) => {
    setLinkState((current) => {
      const next = { ...current }
      delete next[key]
      return next
    })
    setSessions((current) => {
      const rest = current.filter((entry) => entry.key !== key)
      setActiveKey((active) => (active === key ? (rest.at(-1)?.key ?? null) : active))
      return rest
    })
  }, [])

  const [deleting, setDeleting] = useState<Server | null>(null)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /**
   * Whether the workspace has portalled the inspector content in yet.
   *
   * The column exists from the first paint so its width never changes, but until the
   * terminal chunk arrives it is an empty bordered box. Sticky once true: switching tabs
   * remounts the portal, and flashing a placeholder then would be worse than the wait it
   * covers.
   */
  const [inspectorReady, setInspectorReady] = useState(false)
  const inspectorObserver = useRef<MutationObserver | null>(null)

  // A callback ref, not an effect: an effect runs once and by then the column may not be
  // in the document yet, which left the placeholder up for good.
  const attachInspector = useCallback((node: HTMLElement | null) => {
    inspectorObserver.current?.disconnect()
    inspectorObserver.current = null
    if (!node) return
    const update = () =>
      setInspectorReady([...node.children].some((child) => child.id !== "inspector-skeleton"))
    update()
    const observer = new MutationObserver(update)
    observer.observe(node, { childList: true })
    inspectorObserver.current = observer
  }, [])
  const [query, setQuery] = useState("")
  const [permission, setPermission] = useState<Permission>("confirm")
  const [aiConfigured, setAiConfigured] = useState(false)

  const load = useCallback(async () => {
    try {
      const [nextServers, nextGroups, nextSettings] = await Promise.all([
        api.servers(),
        api.groups(),
        api.settings(),
      ])
      setPermission(nextSettings.aiPermission)
      setAiConfigured(nextSettings.aiConfigured || nextSettings.aiProvider.configured)
      setServers(nextServers)
      setGroups(nextGroups)
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 401) {
        onSignedOut()
        return
      }
      toast.error(reason instanceof ApiError ? reason.message : t("app.loadFailed"))
    }
  }, [onSignedOut])

  useEffect(() => {
    void load()
  }, [load])

  /** Servers bucketed by group, with an explicit ungrouped bucket. */
  const buckets = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = (servers ?? []).filter(
      (server) =>
        needle.length === 0 ||
        server.name.toLowerCase().includes(needle) ||
        server.host.toLowerCase().includes(needle) ||
        server.username.toLowerCase().includes(needle)
    )
    const byGroup = new Map<string, Server[]>()
    for (const server of visible) {
      const key = server.groupId ?? UNGROUPED
      byGroup.set(key, [...(byGroup.get(key) ?? []), server])
    }
    const ordered: Array<{ id: string; name: string; servers: Server[] }> = []
    for (const group of groups) {
      const members = byGroup.get(group.id)
      if (members) ordered.push({ id: group.id, name: group.name, servers: members })
    }
    const loose = byGroup.get(UNGROUPED)
    if (loose) ordered.push({ id: UNGROUPED, name: t("app.ungrouped"), servers: loose })
    return ordered
  }, [servers, groups, query])

  async function connect(server: Server) {
    setConnectingId(server.id)
    try {
      const { sessionId, ticket } = await api.createSession(server.id)
      const key = crypto.randomUUID()
      setSessions((current) => [...current, { key, server, sessionId, ticket }])
      setActiveKey(key)
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : t("app.sessionFailed"))
    } finally {
      setConnectingId(null)
    }
  }

  return (
    <div className="flex h-dvh bg-background text-foreground">
      <div className="flex min-w-0 flex-1 flex-col">
      <header className="flex h-11 shrink-0 items-center border-b border-border">
        <div className="flex h-full w-60 shrink-0 items-center justify-between border-r border-border pl-4 pr-[11px]">
          <span className="flex items-center gap-[1px]">
              <img src={appIcon} alt="" aria-hidden="true" className="size-9 rounded-[10px]" />
              <span className="text-[19px] font-bold tracking-[-1px]">{t("app.brand")}</span>
            </span>
          <Hint label={t("app.addServer")}>
            <Button
              variant="outline"
              size="icon-sm"
              className="size-8 rounded-[12px] bg-muted text-muted-foreground hover:text-foreground"
              aria-label={t("app.addServer")}
              onClick={() => {
                setEditing(null)
                setEditorOpen(true)
              }}
            >
              <Plus />
            </Button>
          </Hint>
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto px-2">
          {sessions.map((item) => {
            const isActive = item.key === activeKey
            return (
              <div
                key={item.key}
                role="group"
                aria-label={`${t("app.sessions")}: ${item.server.name}`}
                className="inline-flex h-8 shrink-0 items-stretch"
              >
                <Hint label={`${item.server.username}@${item.server.host}:${item.server.port}`}>
                  <button
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setActiveKey(item.key)}
                  className={cn(
                    "flex h-8 max-w-[185px] items-center gap-1.5 rounded-l-[12px] border-y border-l border-border pl-2.5 pr-2.5 text-[12px] transition-colors duration-150 ease-[var(--ease-out-soft)]",
                    isActive ? "bg-accent text-foreground" : "bg-muted text-muted-foreground hover:text-foreground"
                  )}
                >
                  <span
                    className={cn(
                      "size-2 shrink-0 rounded-full transition-colors duration-200",
                      linkState[item.key] === "disconnected" ? "bg-danger" : "bg-ok"
                    )}
                    aria-hidden="true"
                  />
                    <span className="truncate">{item.server.name}</span>
                  </button>
                </Hint>
                <button
                  type="button"
                  aria-label={t("app.closeSession", { name: item.server.name })}
                  onClick={() => closeSession(item.key)}
                  className={cn(
                    "flex size-8 shrink-0 items-center justify-center rounded-r-[12px] border-y border-r border-border",
                    isActive
                      ? "bg-accent text-foreground hover:bg-danger/15 hover:text-danger"
                      : "bg-muted text-muted-foreground hover:bg-danger/15 hover:text-danger"
                  )}
                >
                  <X className="size-4" />
                </button>
              </div>
            )
          })}
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="flex w-60 shrink-0 flex-col border-r border-border">
          <div className="mx-3 mt-3.5 mb-3 flex h-8 shrink-0 items-center rounded-[12px] border border-border bg-muted focus-within:border-ring">
            <span className="grid size-8 shrink-0 place-items-center text-muted-foreground">
              <Search className="size-4" aria-hidden="true" />
            </span>
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("app.searchServers")}
              aria-label={t("app.searchServers")}
              className="h-8 min-w-0 flex-1 border-0 bg-transparent pr-2.5 text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {servers === null && <p className="px-1 text-xs text-muted-foreground">{t("app.loading")}</p>}
            {servers?.length === 0 && <p className="px-1 text-xs text-muted-foreground">{t("app.noServers")}</p>}

            {query.trim().length > 0 && buckets.length === 0 && (
              <p className="px-1 text-xs text-muted-foreground">{t("app.noMatches")}</p>
            )}

            {buckets.map((bucket) => (
              <section key={bucket.id} className="flex flex-col">
                <button
                  type="button"
                  className="mt-1 flex h-8 items-center gap-1.5 rounded-lg px-1.5 text-left text-[12.5px] font-semibold hover:bg-accent"
                  onClick={() => setCollapsed((current) => ({ ...current, [bucket.id]: !current[bucket.id] }))}
                  aria-expanded={!collapsed[bucket.id]}
                >
                  {collapsed[bucket.id] ? (
                    <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  ) : (
                    <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <Network className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="truncate">{bucket.name}</span>
                  <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                    {bucket.servers.length}
                  </span>
                </button>

                {!collapsed[bucket.id] &&
                  bucket.servers.map((server) => (
                    <div
                      key={server.id}
                      className="group flex items-center gap-1 rounded-[12px] p-0.5 transition-colors hover:bg-accent"
                    >
                      {/* The remark is the whole row: the sidebar is always on screen, and
                          the username alone already says who has root on what. The address
                          stays in the accessible name, and search still matches host and user. */}
                      <button
                        type="button"
                        aria-label={`${server.name} ${server.username}@${server.host}:${server.port}`}
                        onClick={() => void connect(server)}
                        className="flex h-10 min-w-0 flex-1 items-center gap-[7px] rounded-[12px] px-[5px] text-left"
                      >
                        <OsIcon os={server.os} className="h-[24px] w-auto max-w-[28px] shrink-0 object-contain" />
                        <span className="truncate text-[13px] font-medium">{server.name}</span>
                      </button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="sm"
                            className="shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                            aria-label={t("app.serverMenu", { name: server.name })}
                            title={t("app.serverMenu", { name: server.name })}
                          >
                            <MoreVertical className="size-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuGroup>
                            <DropdownMenuItem
                              onSelect={() => {
                                setEditing(server)
                                setEditorOpen(true)
                              }}
                            >
                              <Pencil data-icon="inline-start" />
                              {t("server.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(server)}>
                              <Trash2 data-icon="inline-start" />
                              {t("server.delete")}
                            </DropdownMenuItem>
                          </DropdownMenuGroup>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  ))}
              </section>
            ))}
          </div>

          <div className="mt-auto flex shrink-0 items-center gap-1 border-t border-border p-2">
            <Button
              variant="ghost"
              className="h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-[9.6px] px-2.5 text-[12px]"
              aria-label={t("app.settings")}
              onClick={() => setSettingsOpen(true)}
            >
              <Settings className="size-4" aria-hidden="true" />
              <span className="truncate">{t("app.settings")}</span>
            </Button>
            <Button
              variant="ghost"
              className="h-8 min-w-0 flex-1 justify-start gap-1.5 rounded-[9.6px] px-2.5 text-[12px]"
              aria-label={t("app.signOut")}
              onClick={() => void api.logout().then(() => onSignedOut())}
            >
              <LogOut className="size-4" aria-hidden="true" />
              <span className="truncate">{t("app.signOut")}</span>
            </Button>
          </div>
        </aside>

        <main className="flex min-w-0 flex-1 flex-col">
          {sessions.length > 0 ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {sessions.map((item) => (
                <div key={item.key} className={item.key === activeKey ? "min-h-0 flex-1" : "hidden"}>
                  <Suspense fallback={<WorkspaceSkeleton />}>
          <TerminalView
                    sessionId={item.sessionId}
                    serverId={item.server.id}
                    ticket={item.ticket}
                    onReconnect={(signal) => reconnect(item.key, signal)}
                    onStateChange={(state) =>
                      setLinkState((current) => ({ ...current, [item.key]: state }))
                    }
                    onError={(message) => toast.error(message)}
                    permission={permission}
                    aiConfigured={aiConfigured}
                    active={item.key === activeKey}
                  />
          </Suspense>
                </div>
              ))}
            </div>
          ) : (
            <Empty className="m-auto">
              <EmptyHeader>
                <EmptyTitle>{t("app.emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("app.emptyDescription")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
        </main>
      </div>
      </div>

      {/* the assistant and metrics live here so the column can be full height;
          TerminalView portals them into this node */}
      <aside
        ref={attachInspector}
        id="besh-inspector"
        aria-label={t("app.inspector")}
        className="flex w-[340px] shrink-0 flex-col border-l border-border bg-background"
      >
        {!inspectorReady && sessions.length > 0 && (
          <div id="inspector-skeleton" className="flex flex-col gap-2 p-3" aria-hidden="true">
            <div className="h-4 w-16 animate-pulse rounded bg-muted" />
            <div className="h-9 animate-pulse rounded-[6px] bg-muted" />
            <div className="mt-1 h-4 w-20 animate-pulse rounded bg-muted" />
            <div className="h-64 animate-pulse rounded-[6px] bg-muted" />
          </div>
        )}
      </aside>

      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("server.deleteTitle", { name: deleting?.name ?? "" })}</AlertDialogTitle>
            <AlertDialogDescription>{t("server.deleteHint")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteBusy}>{t("server.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteBusy}
              variant="destructive"
              onClick={async () => {
                if (!deleting) return
                setDeleteBusy(true)
                try {
                  await api.deleteServer(deleting.id)
                  setSessions((current) => current.filter((item) => item.server.id !== deleting.id))
                  setDeleting(null)
                  await load()
                } catch (reason) {
                  toast.error(reason instanceof ApiError ? reason.message : t("server.deleteFailed"))
                } finally {
                  setDeleteBusy(false)
                }
              }}
            >
              {t("server.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {editorOpen && (
      <ServerDialog
        open={editorOpen}
        server={editing}
        groups={groups}
        onOpenChange={setEditorOpen}
        onSaved={() => void load()}
      />
      )}
      {settingsOpen && (
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={(open) => {
          setSettingsOpen(open)
          if (!open) void load()
        }}
        onPermissionChange={setPermission}
      />
      )}
    </div>
  )
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState(readRememberedUsername)
  const [password, setPassword] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The gate is off unless the worker says otherwise, so a deployment without
  // Turnstile configured never even loads the script.
  const [gate, setGate] = useState<{ enabled: boolean; siteKey: string } | null>(null)
  const [token, setToken] = useState("")
  // Bumped to remount the widget: a token is single use, and the challenge behind it
  // is spent once the login attempt fails.
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    void turnstileConfig()
      .then(setGate)
      .catch(() => setGate({ enabled: false, siteKey: "" }))
  }, [])

  const needsToken = gate?.enabled === true



  async function submit(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      await api.login(username, password, needsToken ? token : undefined)
      try {
        localStorage.setItem("besh:username", username)
      } catch {
        // Storage refused; the next visit simply asks again.
      }
      onDone()
    } catch {
      toast.error(t("auth.failed"))
      // Anything may have caused it, but the token is certainly spent now.
      setToken("")
      setAttempt((value) => value + 1)
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          {/* One line, centred: the mark reads as part of the name, not as a separate
              picture above it. */}
          <div className="flex items-center justify-center gap-[1px]">
            <img src={appIcon} alt="" aria-hidden="true" className="size-11 rounded-[11px]" />
            <CardTitle>{t("app.brand")}</CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="username">{t("auth.username")}</FieldLabel>
                <Input
                  id="username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  autoFocus={username.length === 0}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">{t("auth.password")}</FieldLabel>
                <Input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="current-password"
                  autoFocus={username.length > 0}
                />
              </Field>
              {gate?.enabled && (
                <div className="flex justify-center">
                  <Turnstile
                    key={attempt}
                    siteKey={gate.siteKey}
                    onToken={setToken}
                    // Reported as a toast: the failure is an event, not a permanent part
                    // of the form. One id keeps a remount from stacking duplicates.
                    onError={() => toast.error(t("auth.turnstileStalled"), { id: "turnstile-load" })}
                  />
                </div>
              )}
              {error && <p className="text-sm text-danger" role="alert">{error}</p>}
              <Button
                type="submit"
                // Deliberately not disabled when the token is missing: a widget that
                // fails to load would otherwise leave no way to sign in at all. The
                // worker rejects a login without a valid token anyway.
                disabled={busy || password.length === 0}
                className="mx-auto w-40"
              >
                {busy ? t("auth.signingIn") : t("auth.signIn")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  )
}

/**
 * Both auth screens share one frame: the card, then a quiet link to the source.
 *
 * The link sits under the card rather than inside it so the form stays the only
 * thing in the panel; a footer line is enough for "where did this come from".
 */
function AuthShell({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <main className="grid min-h-dvh place-items-center bg-background p-6">
      <div className="flex w-full max-w-sm flex-col items-center gap-5">
        {children}
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <span>{t("auth.footerCopyright")}</span>
          <span aria-hidden="true">·</span>
          <a
            href={PROJECT_URL}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 transition-colors hover:text-foreground"
          >
            <GithubMark className="size-[14px]" />
            GitHub
          </a>
        </div>
      </div>
    </main>
  )
}

function setupErrorText(reason: unknown, t: (key: string) => string): string {
  if (!(reason instanceof ApiError)) return t("auth.setupFailed")
  if (reason.status === 403) return t("auth.setupExists")
  if (reason.code === "INVALID_REQUEST") {
    if (/password/i.test(reason.message)) return t("auth.setupWeakPassword")
    if (/username/i.test(reason.message)) return t("auth.setupBadUsername")
    return t("auth.setupInvalid")
  }
  if (reason.code === "INTERNAL") return t("auth.setupInternal")
  return t("auth.setupFailed")
}

function SetupScreen({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation()
  const [username, setUsername] = useState(readRememberedUsername)
  const [password, setPassword] = useState("")
  const [confirm, setConfirm] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const tooShort = password.length > 0 && password.length < 8
  const mismatch = confirm.length > 0 && confirm !== password

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (password.length < 8 || password !== confirm) return
    setBusy(true)
    try {
      await api.bootstrap(username, password)
      onDone()
    } catch (reason) {
      toast.error(setupErrorText(reason, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{t("auth.setupTitle")}</CardTitle>
          <CardDescription>{t("auth.setupDescription")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="setup-username">{t("auth.username")}</FieldLabel>
                <Input
                  id="setup-username"
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  autoComplete="username"
                  placeholder="admin"
                />
              </Field>
              <Field data-invalid={tooShort}>
                <FieldLabel htmlFor="setup-password">{t("auth.password")}</FieldLabel>
                <Input
                  id="setup-password"
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  aria-invalid={tooShort}
                  autoFocus
                />
                <p className="text-xs text-muted-foreground">{t("auth.passwordHint")}</p>
              </Field>
              <Field data-invalid={mismatch}>
                <FieldLabel htmlFor="setup-confirm">{t("auth.confirmPassword")}</FieldLabel>
                <Input
                  id="setup-confirm"
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  aria-invalid={mismatch}
                />
                {mismatch && <p className="text-xs text-destructive">{t("auth.mismatch")}</p>}
              </Field>
              {error && <p className="text-sm text-danger" role="alert">{error}</p>}
              <Button type="submit" disabled={busy || password.length < 8 || password !== confirm} className="w-full">
                {busy ? t("auth.creating") : t("auth.create")}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </AuthShell>
  )
}
