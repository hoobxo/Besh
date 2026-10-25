import { useCallback, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Bot, Contrast, Eye, Info, Network, Palette, Settings, ShieldCheck, X, Zap } from "lucide-react"
import type { LucideIcon } from "lucide-react"

import { Check, ChevronDown, Circle, Lock, RefreshCw } from "lucide-react"
import { toast } from "sonner"

import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Toggle } from "@/components/ui/toggle"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import appIcon from "@/assets/web/icon.webp"
import { GithubMark } from "@/components/github-mark"
import { PROJECT_URL, PROJECT_VERSION } from "@/lib/project"
import { formatTokenCount, parseTokenCount } from "@/lib/tokens"
import { api, ApiError, listAiModels, type Group, type Permission, type ReasoningEffort as AiEffort } from "@/lib/api"
import { cn } from "@/lib/utils"
import { setLanguage } from "@/i18n"
import { useThemeChoice } from "@/views/theme-toggle"

/** One nav row: 40 tall, filled when active, no line indicator. */
const TAB =
  "h-10 flex-none justify-start gap-2.5 rounded-[9.6px] px-3 text-[13px] after:hidden data-[state=active]:bg-card data-[state=active]:text-foreground data-[state=active]:shadow-none"

/**
 * Settings, sized and sectioned like the design: a 248px section list beside one
 * pane, with theme, group and assistant choices as selectable cards.
 *
 * Two things are additions rather than design: the assistant's configuration state
 * (the design assumes a model exists) and a fourth account section, because the
 * design has nowhere to change the password.
 */
/**
 * Why the model list came back empty.
 *
 * The endpoint answers 404 when it has no /models route and 400 when no provider is
 * stored yet; both are expected states rather than failures, so they get their own
 * wording instead of the server's English message.
 */
function modelListError(reason: unknown, t: (key: string) => string): string {
  if (!(reason instanceof ApiError)) return t("settings.providerModelsFailed")
  if (reason.status === 404) return t("settings.providerModelsUnsupported")
  if (reason.status === 400) return t("settings.providerModelsUnconfigured")
  return t("settings.providerModelsFailed")
}

export function SettingsDialog({ open, onOpenChange, onPermissionChange }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPermissionChange?: (permission: Permission) => void
}) {
  const { t, i18n } = useTranslation()
  const { choice, setChoice } = useThemeChoice()
  const language = i18n.resolvedLanguage ?? "zh-CN"

  function switchLanguage(next: "zh-CN" | "en-US") {
    setLanguage(next)
  }

  const [groups, setGroups] = useState<Group[] | null>(null)
  const [name, setName] = useState("")
  const [permission, setPermission] = useState<Permission>("confirm")
  const [configured, setConfigured] = useState(false)
  // True once an endpoint and a key are stored; listing models needs both.
  const [providerReady, setProviderReady] = useState(false)
  const [baseUrl, setBaseUrl] = useState("")
  const [model, setModel] = useState("")
  // Generation settings: the provider will not tell us these, so the administrator does.
  const [contextWindow, setContextWindow] = useState("")
  const [maxOutput, setMaxOutput] = useState("")
  const [readsImages, setReadsImages] = useState(false)
  const [effort, setEffort] = useState<AiEffort>("default")
  const [models, setModels] = useState<string[] | null>(null)
  // Cloudflare Turnstile in front of the login form.
  const [gateOn, setGateOn] = useState(false)
  const [gateSiteKey, setGateSiteKey] = useState("")
  const [gateSecret, setGateSecret] = useState("")
  const [gateHasSecret, setGateHasSecret] = useState(false)
  const [modelPickerOpen, setModelPickerOpen] = useState(false)
  // Collapsed, the card is one line: the model in use. Its limits are noise until
  // someone wants to change them.
  const [paramsOpen, setParamsOpen] = useState(false)
  const [apiKey, setApiKey] = useState("")
  const [hasKey, setHasKey] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [currentPassword, setCurrentPassword] = useState("")
  const [nextPassword, setNextPassword] = useState("")

  const load = useCallback(async () => {
    try {
      const [nextGroups, settings] = await Promise.all([api.groups(), api.settings()])
      setGroups(nextGroups)
      setPermission(settings.aiPermission)
      setConfigured(settings.aiConfigured)
      setProviderReady(settings.aiProvider.configured)
      setHasKey(settings.aiProvider.hasKey)
      setBaseUrl(settings.aiProvider.baseUrl)
      setModel(settings.aiProvider.model)
      setContextWindow(formatTokenCount(settings.aiProvider.params.contextWindow))
      setMaxOutput(formatTokenCount(settings.aiProvider.params.maxOutput))
      setGateOn(settings.turnstile.enabled)
      setGateSiteKey(settings.turnstile.siteKey)
      setGateHasSecret(settings.turnstile.hasSecret)
      setReadsImages(settings.aiProvider.params.inputs.image)
      setEffort(settings.aiProvider.params.effort)
      setError(null)
    } catch {
      setError(t("settings.loadFailed"))
    }
  }, [t])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  async function addGroup(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    setError(null)
    try {
      await api.createGroup(trimmed)
      setName("")
      await load()
    } catch (reason) {
      setError(
        reason instanceof ApiError && reason.status === 400 ? t("settings.duplicate") : t("settings.createFailed")
      )
    } finally {
      setBusy(false)
    }
  }

  async function removeGroup(group: Group) {
    setBusy(true)
    try {
      await api.deleteGroup(group.id)
      await load()
    } catch {
      setError(t("settings.deleteFailed"))
    } finally {
      setBusy(false)
    }
  }

  async function saveProvider(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const saved = await api.saveSettings({
        aiProvider: {
          baseUrl,
          model,
          apiKey,
          params: {
            contextWindow: parseTokenCount(contextWindow),
            maxOutput: parseTokenCount(maxOutput),
            inputs: { text: true, image: readsImages },
            effort,
          },
        },
      })
      setConfigured(saved.aiProvider.configured)
      setProviderReady(saved.aiProvider.configured)
      setHasKey(saved.aiProvider.hasKey)
      setModels(null)
      setBaseUrl(saved.aiProvider.baseUrl)
      setModel(saved.aiProvider.model)
      setReadsImages(saved.aiProvider.params.inputs.image)
      setEffort(saved.aiProvider.params.effort)
      setApiKey("")
      toast.success(t("settings.providerSaved"))
    } catch (reason) {
      toast.error(
        reason instanceof ApiError && reason.code === "INVALID_REQUEST"
          ? t("settings.providerInvalid")
          : t("settings.saveFailed")
      )
    } finally {
      setBusy(false)
    }
  }

  async function changePermission(next: Permission) {
    const previous = permission
    setPermission(next)
    setBusy(true)
    try {
      const saved = await api.saveSettings({ aiPermission: next })
      setPermission(saved.aiPermission)
      onPermissionChange?.(saved.aiPermission)
    } catch {
      setPermission(previous)
      setError(t("settings.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  async function saveGate(event: React.FormEvent) {
    event.preventDefault()
    setBusy(true)
    try {
      const saved = await api.saveSettings({
        turnstile: { enabled: gateOn, siteKey: gateSiteKey, secret: gateSecret },
      })
      setGateOn(saved.turnstile.enabled)
      setGateSiteKey(saved.turnstile.siteKey)
      setGateHasSecret(saved.turnstile.hasSecret)
      setGateSecret("")
      toast.success(t("settings.gateSaved"))
    } catch (reason) {
      toast.error(reason instanceof ApiError ? reason.message : t("settings.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  async function changePassword(event: React.FormEvent) {
    event.preventDefault()
    if (nextPassword.length < 8) return
    setBusy(true)
    try {
      await api.changePassword(currentPassword, nextPassword)
      setCurrentPassword("")
      setNextPassword("")
      toast.success(t("settings.passwordChanged"))
    } catch (reason) {
      toast.error(
        reason instanceof ApiError && reason.status === 401
          ? t("settings.passwordWrong")
          : reason instanceof ApiError && reason.code === "INVALID_REQUEST"
            ? t("settings.passwordInvalid")
            : t("settings.saveFailed")
      )
    } finally {
      setBusy(false)
    }
  }

  const themeOptions = [
    { value: "dark" as const, icon: Contrast, label: t("theme.dark"), hint: t("settings.theme.darkHint") },
    { value: "light" as const, icon: Palette, label: t("theme.light"), hint: t("settings.theme.lightHint") },
    { value: "system" as const, icon: Eye, label: t("theme.system"), hint: t("settings.theme.systemHint") },
  ]

  const permissionOptions = [
    { value: "readonly" as const, icon: Eye, label: t("ai.permission.readonly"), hint: t("settings.scope.readonlyHint") },
    { value: "confirm" as const, icon: ShieldCheck, label: t("ai.permission.confirm"), hint: t("settings.scope.confirmHint") },
    { value: "semi-auto" as const, icon: Zap, label: t("ai.permission.semi-auto"), hint: t("settings.scope.semiAutoHint") },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[min(720px,88vh)] w-[min(1080px,94vw)] max-w-none flex-col gap-0 overflow-hidden p-0 sm:max-w-none"
        showCloseButton={false}
      >
        <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border bg-card px-4">
          <Settings className="size-[18px] text-muted-foreground" aria-hidden="true" />
          <span className="text-[13px] font-semibold">{t("settings.title")}</span>
          <span className="flex-1" />
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-danger"
            aria-label={t("settings.close")}
            onClick={() => onOpenChange(false)}
          >
            <X />
          </Button>
        </div>

        <Tabs orientation="vertical" defaultValue="appearance" className="min-h-0 flex-1 gap-0">
          <TabsList
            variant="line"
            className="min-h-full w-[248px] shrink-0 flex-col items-stretch justify-start gap-0 border-r border-border bg-card p-2"
          >
            <TabsTrigger value="appearance" className={TAB}>
              <Palette className="size-[18px]" aria-hidden="true" />
              {t("settings.sections.appearance")}
            </TabsTrigger>
            <TabsTrigger value="groups" className={TAB}>
              <Network className="size-[18px]" aria-hidden="true" />
              {t("settings.sections.groups")}
            </TabsTrigger>
            <TabsTrigger value="ai" className={TAB}>
              <Bot className="size-[18px]" aria-hidden="true" />
              {t("settings.sections.ai")}
            </TabsTrigger>
            <TabsTrigger value="security" className={TAB}>
              <Lock className="size-[18px]" aria-hidden="true" />
              {t("settings.sections.security")}
            </TabsTrigger>
            <TabsTrigger value="account" className={TAB}>
              <ShieldCheck className="size-[18px]" aria-hidden="true" />
              {t("settings.sections.account")}
            </TabsTrigger>
            <TabsTrigger value="about" className={TAB}>
              <Info className="size-[18px]" aria-hidden="true" />
              {t("settings.sections.about")}
            </TabsTrigger>
          </TabsList>

          <div className="min-h-0 flex-1 overflow-y-auto p-6">
            <TabsContent value="appearance" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold">{t("settings.sections.appearance")}</h3>
              <p className="-mt-1 text-[12.5px] text-muted-foreground">{t("settings.appearanceHint")}</p>
              <ToggleGroup
                type="single"
                value={choice}
                onValueChange={(value) => value && setChoice(value as "dark" | "light" | "system")}
                className="mt-2 grid w-full grid-cols-3 gap-3"
                aria-label={t("settings.sections.appearance")}
              >
                {themeOptions.map((option) => (
                  <ChoiceCard key={option.value} option={option} selected={choice === option.value} />
                ))}
              </ToggleGroup>

              {/* the design has no language switch; it is needed all the same */}
              <div className="mt-4 flex items-center justify-between gap-3">
                <span className="text-[12.5px] text-muted-foreground">{t("settings.language")}</span>
                <div className="flex gap-2">
                  <Button
                    variant={language === "zh-CN" ? "outline" : "ghost"}
                    size="sm"
                    className="h-8 px-3 text-[12px]"
                    onClick={() => void switchLanguage("zh-CN")}
                  >
                    中文
                  </Button>
                  <Button
                    variant={language === "en-US" ? "outline" : "ghost"}
                    size="sm"
                    className="h-8 px-3 text-[12px]"
                    onClick={() => void switchLanguage("en-US")}
                  >
                    English
                  </Button>
                </div>
              </div>
            </TabsContent>

            <TabsContent value="groups" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold">{t("settings.sections.groups")}</h3>
              <p className="-mt-1 text-[12.5px] text-muted-foreground">{t("settings.description")}</p>

              <form onSubmit={addGroup} className="mt-1">
                <div className="flex items-end gap-3">
                  <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                    <label htmlFor="new-group-name" className="text-[12.5px] font-medium">
                      {t("settings.newGroup")}
                    </label>
                    <Input
                      id="new-group-name"
                      value={name}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={t("settings.groupPlaceholder")}
                      maxLength={60}
                      className="h-9"
                    />
                  </div>
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-9 shrink-0 px-3.5 text-[12.5px]"
                    disabled={busy || name.trim().length === 0}
                  >
                    {t("settings.add")}
                  </Button>
                </div>
              </form>
              <p className="-mt-1 text-[11.5px] text-muted-foreground">{t("settings.groupHint")}</p>

              <div className="mt-1 grid grid-cols-2 gap-2" role="list" aria-label={t("settings.sections.groups")}>
                {groups === null && <p className="text-[12.5px] text-muted-foreground">{t("app.loading")}</p>}
                {groups?.length === 0 && <p className="text-[12.5px] text-muted-foreground">{t("settings.noGroups")}</p>}
                {groups?.map((group) => (
                  <div
                    key={group.id}
                    role="listitem"
                    className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-2"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-[12.5px] font-medium">{group.name}</div>
                      <div className="text-[11px] text-muted-foreground">
                        {t("settings.serverCount", { count: group.serverCount })}
                      </div>
                    </div>
                    <Button
                        variant="ghost"
                        size="icon-sm"
                        className="text-muted-foreground hover:text-danger"
                        aria-label={t("settings.deleteGroup", { name: group.name })}
                        disabled={busy}
                        onClick={() => void removeGroup(group)}
                      >
                      <X />
                    </Button>
                  </div>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="ai" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold">{t("settings.sections.ai")}</h3>
              <p className="-mt-1 text-[12.5px] text-muted-foreground">{t("settings.aiHint")}</p>

              <ToggleGroup
                type="single"
                value={permission}
                onValueChange={(value) => value && void changePermission(value as Permission)}
                className="mt-2 grid w-full grid-cols-3 gap-3"
                aria-label={t("settings.aiPermission")}
              >
                {permissionOptions.map((option) => (
                  <ChoiceCard key={option.value} option={option} selected={permission === option.value} />
                ))}
              </ToggleGroup>

              <Separator className="my-2" />

              <form onSubmit={saveProvider}>
                <FieldGroup>
                  <h4 className="text-[13px] font-medium">{t("settings.provider")}</h4>
                  <p className="-mt-1 text-[11.5px] text-muted-foreground">{t("settings.providerHint")}</p>
                  <div className="flex flex-col gap-3 rounded-[12px] border border-border p-3">
                    <Field>
                      <FieldLabel htmlFor="ai-base-url">{t("settings.providerBaseUrl")}</FieldLabel>
                      <Input
                        id="ai-base-url"
                        value={baseUrl}
                        onChange={(event) => setBaseUrl(event.target.value)}
                        placeholder="https://api.openai.com/v1"
                        autoComplete="off"
                        className="h-9"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="ai-key">{t("settings.providerKey")}</FieldLabel>
                      <Input
                        id="ai-key"
                        type="password"
                        value={apiKey}
                        onChange={(event) => setApiKey(event.target.value)}
                        placeholder={hasKey ? t("settings.providerKeyKeep") : t("settings.providerKeyNeeded")}
                        autoComplete="off"
                        className="h-9"
                      />
                    </Field>
                    <div className="flex justify-end">
                      <Button
                        type="submit"
                        variant="outline"
                        className="h-9 px-3.5 text-[12.5px]"
                        disabled={busy || baseUrl.trim().length === 0}
                      >
                        {t("settings.providerSave")}
                      </Button>
                    </div>
                  </div>
                  <div className="rounded-[12px] border border-border">
                    <button
                      type="button"
                      onClick={() => setParamsOpen((open) => !open)}
                      aria-expanded={paramsOpen}
                      className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
                    >
                      <span className="shrink-0 text-[12.5px] font-medium">{t("settings.modelAdvanced")}</span>
                      <span className="min-w-0 flex-1 truncate text-right font-mono text-[12px] text-muted-foreground">
                        {model || t("settings.modelNotSet")}
                      </span>
                      <ChevronDown
                        className={`size-3.5 shrink-0 text-muted-foreground transition-transform ${paramsOpen ? "rotate-180" : ""}`}
                        aria-hidden="true"
                      />
                    </button>
                    {paramsOpen && (
                      <div className="flex flex-col gap-3 border-t border-border px-3 py-3">
                  <Field>
                    <FieldLabel htmlFor="ai-model">{t("settings.providerModel")}</FieldLabel>
                    <div className="flex gap-2">
                      <Input
                        id="ai-model"
                        value={model}
                        onChange={(event) => setModel(event.target.value)}
                        placeholder="gpt-4o-mini"
                        autoComplete="off"
                        className="h-9"
                      />
                      <Select value={effort} onValueChange={(value) => setEffort(value as AiEffort)}>
                        <SelectTrigger
                          aria-label={t("settings.modelEffort")}
                          title={t("settings.modelEffort")}
                          className="h-9 w-[104px] shrink-0 justify-between px-3 text-[12.5px]"
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent
                          position="popper"
                          align="start"
                          sideOffset={4}
                          className="w-[var(--radix-select-trigger-width)] min-w-0"
                        >
                          {(["default", "low", "medium", "high", "xhigh", "max"] as const).map((level) => (
                            <SelectItem key={level} value={level}>
                              {t(`settings.effort.${level}`)}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Popover
                        open={modelPickerOpen}
                        onOpenChange={(next) => {
                          if (next && !providerReady) {
                            toast.error(t("settings.providerModelsUnconfigured"))
                            return
                          }
                          setModelPickerOpen(next)
                          // Ask the endpoint what it offers the first time the list is
                          // opened; a saved list would go stale without anyone noticing.
                          if (next && models === null) {
                            void listAiModels()
                              .then(setModels)
                              .catch((reason: unknown) => {
                                setModels([])
                                toast.error(modelListError(reason, t))
                              })
                          }
                        }}
                      >
                        <PopoverTrigger asChild>
                          <Button type="button" variant="outline" className="h-9 shrink-0 gap-1.5 px-3 text-[12.5px]">
                            <RefreshCw className="size-3.5" aria-hidden="true" />
                            {t("settings.providerModels")}
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent align="end" className="w-[320px] p-0">
                          <Command>
                            <CommandInput placeholder={t("settings.providerModelsSearch")} />
                            <CommandList>
                              <CommandEmpty>{t("settings.providerModelsEmpty")}</CommandEmpty>
                              <CommandGroup>
                                {(models ?? []).map((id) => (
                                  <CommandItem
                                    key={id}
                                    value={id}
                                    onSelect={() => {
                                      setModel(id)
                                      setModelPickerOpen(false)
                                    }}
                                  >
                                    {id}
                                  </CommandItem>
                                ))}
                              </CommandGroup>
                            </CommandList>
                          </Command>
                        </PopoverContent>
                      </Popover>
                    </div>
                  </Field>
                  <div className="grid grid-cols-3 gap-3">
                    <Field>
                      <FieldLabel htmlFor="ai-context">{t("settings.modelContext")}</FieldLabel>
                      <Input
                        id="ai-context"
                        inputMode="numeric"
                        value={contextWindow}
                        onChange={(event) => setContextWindow(event.target.value.replace(/[^0-9.kKmM]/g, ""))}
                        placeholder="128K"
                        className="h-9"
                      />
                    </Field>
                    <Field>
                      <FieldLabel htmlFor="ai-output">{t("settings.modelOutput")}</FieldLabel>
                      <Input
                        id="ai-output"
                        inputMode="numeric"
                        value={maxOutput}
                        onChange={(event) => setMaxOutput(event.target.value.replace(/[^0-9.kKmM]/g, ""))}
                        placeholder="8K"
                        className="h-9"
                      />
                    </Field>
                    <Field>
                      <FieldLabel>{t("settings.modelInputs")}</FieldLabel>
                      <div className="flex h-9 items-center gap-1.5">
                        {/* Text is not optional: the assistant answers in text and runs tools. */}
                        <Toggle size="sm" pressed disabled className="h-9 gap-1 px-2 text-[12px] opacity-70">
                          <Check aria-hidden="true" />
                          {t("settings.modelInputText")}
                        </Toggle>
                        <Toggle
                          size="sm"
                          pressed={readsImages}
                          onPressedChange={setReadsImages}
                          className="h-9 gap-1 px-2 text-[12px]"
                          aria-label={t("settings.modelInputImage")}
                        >
                          {readsImages ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
                          {t("settings.modelInputImage")}
                        </Toggle>
                      </div>
                    </Field>
                  </div>

                  <p className="text-[11.5px] text-muted-foreground">{t("settings.modelHints")}</p>

                      </div>
                    )}
                  </div>

                </FieldGroup>
              </form>
            </TabsContent>

            <TabsContent value="security" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold">{t("settings.sections.security")}</h3>
              <p className="-mt-1 text-[12.5px] text-muted-foreground">{t("settings.gateHint")}</p>
              <form onSubmit={saveGate} className="mt-1">
                <FieldGroup>
                  <Field>
                    <FieldLabel>{t("settings.gateEnable")}</FieldLabel>
                    <div className="flex items-center gap-2">
                      <Toggle
                        size="sm"
                        pressed={gateOn}
                        onPressedChange={setGateOn}
                        className="h-8 gap-1.5 px-3 text-[12px]"
                        aria-label={t("settings.gateEnable")}
                      >
                        {gateOn ? <Check aria-hidden="true" /> : <Circle aria-hidden="true" />}
                        {gateOn ? t("settings.gateOn") : t("settings.gateOff")}
                      </Toggle>
                      <span className="text-[11.5px] text-muted-foreground">{t("settings.gateHintShort")}</span>
                    </div>
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="gate-site">{t("settings.gateSiteKey")}</FieldLabel>
                    <Input
                      id="gate-site"
                      value={gateSiteKey}
                      onChange={(event) => setGateSiteKey(event.target.value)}
                      placeholder="0x4AAAAAAA…"
                      autoComplete="off"
                      className="h-9 font-mono text-[12px]"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="gate-secret">{t("settings.gateSecret")}</FieldLabel>
                    <Input
                      id="gate-secret"
                      type="password"
                      value={gateSecret}
                      onChange={(event) => setGateSecret(event.target.value)}
                      placeholder={gateHasSecret ? t("settings.gateSecretKeep") : "0x4AAAAAAA…"}
                      autoComplete="off"
                      className="h-9 font-mono text-[12px]"
                    />
                  </Field>
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-9 self-start px-3.5 text-[12.5px]"
                    disabled={busy}
                  >
                    {t("settings.gateSave")}
                  </Button>
                </FieldGroup>
              </form>
            </TabsContent>

            <TabsContent value="account" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold">{t("settings.sections.account")}</h3>
              <p className="-mt-1 text-[12.5px] text-muted-foreground">{t("settings.accountHint")}</p>
              <form onSubmit={changePassword} className="mt-1">
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="current-password">{t("settings.currentPassword")}</FieldLabel>
                    <Input
                      id="current-password"
                      type="password"
                      autoComplete="current-password"
                      value={currentPassword}
                      onChange={(event) => setCurrentPassword(event.target.value)}
                      className="h-9"
                    />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="new-password">{t("settings.newPassword")}</FieldLabel>
                    <Input
                      id="new-password"
                      type="password"
                      autoComplete="new-password"
                      value={nextPassword}
                      onChange={(event) => setNextPassword(event.target.value)}
                      className="h-9"
                    />
                    <p className="text-[11.5px] text-muted-foreground">{t("auth.passwordHint")}</p>
                  </Field>
                  <Button
                    type="submit"
                    variant="outline"
                    className="h-9 self-start px-3.5 text-[12.5px]"
                    disabled={busy || currentPassword.length === 0 || nextPassword.length < 8}
                  >
                    {t("settings.changePassword")}
                  </Button>
                </FieldGroup>
              </form>
            </TabsContent>

            <TabsContent value="about" className="flex flex-col gap-3">
              <h3 className="text-[15px] font-semibold">{t("settings.sections.about")}</h3>
              <p className="-mt-1 text-[12.5px] text-muted-foreground">{t("settings.aboutHint")}</p>

              <div className="mt-1 flex items-center gap-3 rounded-lg border border-border bg-card p-4">
                <img src={appIcon} alt="" aria-hidden="true" className="size-10 rounded-[10px]" />
                <div className="flex flex-col gap-0.5">
                  <span className="text-[14px] font-semibold">{t("app.brand")}</span>
                  <span className="text-[12px] tabular-nums text-muted-foreground">{PROJECT_VERSION}</span>
                </div>
              </div>

              <a
                href={PROJECT_URL}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 rounded-lg border border-border bg-card p-4 transition-colors hover:bg-accent"
              >
                <GithubMark className="size-[18px] shrink-0" />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13px] font-medium">{t("settings.repository")}</span>
                  <span className="truncate text-[12px] text-muted-foreground">{PROJECT_URL}</span>
                </span>
              </a>
            </TabsContent>

            {error && (
              <p className="mt-4 text-[12px] text-danger" role="alert">
                {error}
              </p>
            )}
          </div>
        </Tabs>

        <DialogTitle className="sr-only">{t("settings.title")}</DialogTitle>
      </DialogContent>
    </Dialog>
  )
}

/**
 * One card in a three-way choice group.
 *
 * The appearance and AI permission tabs use the same 92px card; keeping one
 * copy means a styling change cannot reach only one of them.
 */
function ChoiceCard({
  option,
  selected,
}: {
  option: { value: string; label: string; hint: string; icon: LucideIcon }
  selected: boolean
}) {
  return (
    <ToggleGroupItem
      value={option.value}
      variant="outline"
      className="h-[92px] flex-col items-start gap-3 rounded-lg p-4 text-left whitespace-normal data-[state=on]:border-foreground/60 data-[state=on]:bg-accent"
    >
      <span className="flex w-full flex-col gap-1.5 pt-0.5">
        <span className="flex items-center gap-2">
          <option.icon
            className={cn("size-[18px] shrink-0", selected ? "text-foreground" : "text-muted-foreground")}
            aria-hidden="true"
          />
          <span className="text-[13px] font-medium">{option.label}</span>
        </span>
        <span className="text-[11.5px] font-normal text-muted-foreground">{option.hint}</span>
      </span>
    </ToggleGroupItem>
  )
}
