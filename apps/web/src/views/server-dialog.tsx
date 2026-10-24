import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { api, ApiError, type Group, type Server } from "@/lib/api"

const NO_GROUP = "__none__"

type ServerDraft = {
  name: string
  host: string
  port: string
  username: string
  authMethod: "password" | "publickey"
  credential: string
  groupId: string | null
}

function emptyDraft(groupId: string | null = null): ServerDraft {
  return { name: "", host: "", port: "22", username: "root", authMethod: "password", credential: "", groupId }
}

function draftFrom(server: Server): ServerDraft {
  return {
    name: server.name,
    host: server.host,
    port: String(server.port),
    username: server.username,
    authMethod: server.authMethod,
    // Editing never shows the stored secret: it left the vault only to be used.
    credential: "",
    groupId: server.groupId,
  }
}

/**
 * Create or edit a server.
 *
 * On edit the credential field is intentionally empty and labelled as such: the
 * existing secret is never sent to the browser, so leaving it blank means "keep
 * what is stored" rather than "clear it".
 */
export function ServerDialog({ open, server, groups, onOpenChange, onSaved }: {
  open: boolean
  server: Server | null
  groups: Group[]
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}) {
  const [draft, setDraft] = useState<ServerDraft>(() => (server ? draftFrom(server) : emptyDraft()))
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setDraft(server ? draftFrom(server) : emptyDraft(groups[0]?.id ?? null))
    setError(null)
  }, [open, server, groups])

  const port = Number(draft.port)
  const credentialRequired = !server
  const valid =
    draft.name.trim().length > 0 &&
    draft.host.trim().length > 0 &&
    draft.username.trim().length > 0 &&
    Number.isInteger(port) &&
    port >= 1 &&
    port <= 65535 &&
    (!credentialRequired || draft.credential.length > 0)

  function change<K extends keyof ServerDraft>(key: K, value: ServerDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }))
    setError(null)
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid) return
    setBusy(true)
    setError(null)
    try {
      if (server) {
        await api.updateServer(server.id, {
          name: draft.name.trim(),
          host: draft.host.trim(),
          port,
          username: draft.username.trim(),
          authMethod: draft.authMethod,
          credential: draft.credential,
          groupId: draft.groupId,
          version: server.version,
        })
      } else {
        await api.createServer({
          name: draft.name.trim(),
          host: draft.host.trim(),
          port,
          username: draft.username.trim(),
          authMethod: draft.authMethod,
          credential: draft.credential,
          groupId: draft.groupId,
        })
      }
      onSaved()
      onOpenChange(false)
    } catch (reason) {
      setError(messageFor(reason, t))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{server ? t("server.edit") : t("server.add")}</DialogTitle>
          <DialogDescription>
            {t("server.description")}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={submit}>
          <FieldGroup>
            {/* Name and group are both labels for the server, so they share a row. */}
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="srv-name">{t("server.name")}</FieldLabel>
                <Input id="srv-name" value={draft.name} onChange={(event) => change("name", event.target.value)} autoFocus />
              </Field>
              <Field>
                <FieldLabel>{t("server.group")}</FieldLabel>
                <Select
                  value={draft.groupId ?? NO_GROUP}
                  onValueChange={(value) => change("groupId", value === NO_GROUP ? null : value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value={NO_GROUP}>{t("app.ungrouped")}</SelectItem>
                      {groups.map((group) => (
                        <SelectItem key={group.id} value={group.id}>
                          {group.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <div className="grid grid-cols-[1fr_100px] gap-3">
              <Field>
                <FieldLabel htmlFor="srv-host">{t("server.host")}</FieldLabel>
                <Input id="srv-host" value={draft.host} onChange={(event) => change("host", event.target.value)} placeholder="203.0.113.10" />
              </Field>
              <Field>
                <FieldLabel htmlFor="srv-port">{t("server.port")}</FieldLabel>
                <Input id="srv-port" inputMode="numeric" value={draft.port} onChange={(event) => change("port", event.target.value)} />
              </Field>
            </div>

            {/* Who connects, and how: one row, because the method explains the name. */}
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="srv-user">{t("server.user")}</FieldLabel>
                <Input id="srv-user" value={draft.username} onChange={(event) => change("username", event.target.value)} />
              </Field>
              <Field>
                <FieldLabel>{t("server.auth")}</FieldLabel>
                <Select
                  value={draft.authMethod}
                  onValueChange={(value) => {
                    change("authMethod", value as "password" | "publickey")
                    change("credential", "")
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectItem value="password">{t("server.authPassword")}</SelectItem>
                      <SelectItem value="publickey">{t("server.authKey")}</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor="srv-credential">
                {draft.authMethod === "password" ? t("server.credential") : t("server.credentialKey")}
              </FieldLabel>
              {draft.authMethod === "password" ? (
                <Input
                  id="srv-credential"
                  type="password"
                  value={draft.credential}
                  onChange={(event) => change("credential", event.target.value)}
                  autoComplete="new-password"
                />
              ) : (
                <Textarea
                  id="srv-credential"
                  rows={4}
                  className="font-mono text-xs"
                  value={draft.credential}
                  onChange={(event) => change("credential", event.target.value)}
                  placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                />
              )}
              {server && <FieldDescription>{t("server.keepSecret")}</FieldDescription>}
            </Field>

            {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          </FieldGroup>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("server.cancel")}
          </Button>
          <Button onClick={submit} disabled={busy || !valid}>
            {busy ? t("server.saving") : t("server.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function messageFor(reason: unknown, t: (key: string) => string): string {
  if (!(reason instanceof ApiError)) return t("server.saveFailed")
  switch (reason.code) {
    case "TARGET_REJECTED":
      return t("server.targetRejected")
    case "INVALID_REQUEST":
      return reason.message.includes("changed elsewhere") ? t("server.stale") : t("server.invalid")
    case "AUTH_REQUIRED":
      return t("server.sessionExpired")
    default:
      return t("server.saveFailed")
  }
}
