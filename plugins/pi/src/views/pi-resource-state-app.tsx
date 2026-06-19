import { useMemo, useState } from "react"
import { useDb, useRpc, type ViewComponentProps } from "@zenbujs/core/react"

type PiResourceStateArgs = {
  windowId?: string | null
  scopeId?: string | null
  directory?: string | null
}

type ResourceEntry = {
  resourceId: string
  resourceType: string
  activationState?: string
  enabled?: boolean
  loaded?: boolean
  tier?: string
  sourceInfo?: { path?: string; source?: string; scope?: string; origin?: string } | null
}

type RuntimeCommand = {
  name: string
  description?: string
  source: string
  resourceId?: string | null
}

type RuntimeTool = {
  name: string
  description?: string
  active: boolean
  resourceId?: string | null
}

type ActiveContext = {
  scopeId: string | null
  sessionId: string | null
  directory: string | null
}

type DetailMode =
  | { group: "loaded"; type: ResourceTypeKey }
  | { group: "workspace"; type: ResourceTypeKey }
  | { group: "issues"; type: IssueType }
  | { group: "capabilities"; type: "commands" | "tools" }

type ResourceTypeKey = "extension" | "skill" | "prompt" | "theme"
type IssueType = "missing" | "suppressed" | "errors"

const RESOURCE_TYPES: Array<{ key: ResourceTypeKey; label: string }> = [
  { key: "extension", label: "Extensions" },
  { key: "skill", label: "Skills" },
  { key: "prompt", label: "Prompts" },
  { key: "theme", label: "Themes" },
]

export function PiResourceStateApp({ args }: ViewComponentProps<PiResourceStateArgs>) {
  const rpc = useRpc()
  const active = useActiveContext(args)
  const data = useDb(root => {
    const scopeId = active.scopeId
    const sessionId = active.sessionId
    const staticCatalog = scopeId ? root.pi.piResourceStaticCatalogs[scopeId] ?? null : null
    const snapshot = sessionId ? root.pi.sessionRuntimeSnapshots[sessionId] ?? null : null
    const definitions = root.pi.piResourceDefinitions
    const session = sessionId ? root.pi.sessions[sessionId] ?? null : null
    return { staticCatalog, snapshot, definitions, session }
  })

  const stale = isActivationStale({
    activationHashAtLoad: data.snapshot?.activationHashAtLoad,
    currentActivationHash: data.staticCatalog?.metadata.activationHash,
  })

  const [mode, setMode] = useState<DetailMode>({ group: "loaded", type: "extension" })
  const workspaceStaticEntries = useMemo(
    () => (data.staticCatalog?.entries ?? []).filter(isWorkspaceSpecificResource),
    [data.staticCatalog?.entries],
  )
  const workspaceRuntimeEntries = useMemo(
    () => (data.snapshot?.resources ?? []).filter(isWorkspaceSpecificResource),
    [data.snapshot?.resources],
  )
  const workspaceErrors = useMemo(
    () =>
      (data.snapshot?.errors ?? []).filter((error: { path?: string }) =>
        isWorkspaceSpecificError(error, active.directory),
      ),
    [data.snapshot?.errors, active.directory],
  )
  const staticCounts = useMemo(
    () => countStaticEntries(workspaceStaticEntries),
    [workspaceStaticEntries],
  )
  const runtimeCounts = useMemo(
    () => countRuntimeEntries(workspaceRuntimeEntries),
    [workspaceRuntimeEntries],
  )
  const issueCounts = useMemo(
    () => ({
      missing: workspaceStaticEntries.filter(entry => entry.activationState === "missing").length,
      suppressed: workspaceStaticEntries.filter(entry => entry.activationState === "suppressed").length,
      errors: workspaceErrors.length,
    }),
    [workspaceStaticEntries, workspaceErrors.length],
  )
  const detail = useMemo(
    () => buildDetail({
      mode,
      snapshot: data.snapshot,
      staticCatalog: data.staticCatalog,
      definitions: data.definitions,
      directory: active.directory,
    }),
    [mode, data.snapshot, data.staticCatalog, data.definitions, active.directory],
  )

  if (!active.scopeId) {
    return <Placeholder>No active workspace.</Placeholder>
  }

  const refreshCatalog = () => {
    if (!active.scopeId) return
    void rpc.pi.piResourceRegistry.refreshStaticCatalog({
      scopeId: active.scopeId,
      reason: "manual",
    })
  }
  const reloadSession = () => {
    if (!active.sessionId) return
    void rpc.pi.sessions.reload({ sessionId: active.sessionId })
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
      <header className="border-b border-border px-3 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Pi Resources</h2>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {active.directory ?? data.staticCatalog?.directory ?? "No directory"}
            </div>
          </div>
          <button
            className="rounded-full border border-border px-2.5 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={refreshCatalog}
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
          <Badge tone={data.snapshot?.active ? "good" : data.snapshot ? "muted" : "warn"} title={statusTitle(data.snapshot, data.staticCatalog, active.directory)}>
            {data.snapshot?.active ? "live" : data.snapshot ? "cached" : "no session"}
          </Badge>
          {stale ? <Badge tone="warn" title={statusTitle(data.snapshot, data.staticCatalog, active.directory)}>stale</Badge> : null}
          <Badge tone={data.staticCatalog?.metadata.status === "error" ? "bad" : "muted"} title={statusTitle(data.snapshot, data.staticCatalog, active.directory)}>
            inventory {data.staticCatalog?.metadata.status ?? "missing"}
          </Badge>
          {stale && active.sessionId ? (
            <button className="ml-auto text-[11px] text-amber-700 underline dark:text-amber-300" onClick={reloadSession}>
              Reload
            </button>
          ) : null}
        </div>
      </header>

      <section className="space-y-4 p-3">
        <OverviewSection
          title="Loaded from workspace"
          counts={runtimeCounts}
          selected={mode.group === "loaded" ? mode.type : null}
          onSelect={type => setMode({ group: "loaded", type })}
        />
        <OverviewSection
          title="Available from workspace"
          counts={staticCounts.byType}
          selected={mode.group === "workspace" ? mode.type : null}
          onSelect={type => setMode({ group: "workspace", type })}
        />
        {(issueCounts.missing || issueCounts.suppressed || issueCounts.errors) ? (
          <IssueSection counts={issueCounts} selected={mode.group === "issues" ? mode.type : null} onSelect={type => setMode({ group: "issues", type })} />
        ) : null}
        {data.snapshot ? (
          <div className="border-t border-border pt-3">
            <div className="mb-2 text-[11px] font-medium text-muted-foreground">Capabilities</div>
            <div className="flex flex-wrap gap-1.5">
              <SelectorPill active={mode.group === "capabilities" && mode.type === "commands"} count={data.snapshot.capabilities.commands.length} onClick={() => setMode({ group: "capabilities", type: "commands" })}>Commands</SelectorPill>
              <SelectorPill active={mode.group === "capabilities" && mode.type === "tools"} count={data.snapshot.capabilities.tools.length} onClick={() => setMode({ group: "capabilities", type: "tools" })}>Tools</SelectorPill>
            </div>
          </div>
        ) : null}
        <DetailPanel detail={detail} />
      </section>
    </div>
  )
}

function useActiveContext(args: PiResourceStateArgs | undefined): ActiveContext {
  return useDb(root => {
    const explicitScopeId = args?.scopeId ?? null
    const explicitScope = explicitScopeId ? root.app.scopes[explicitScopeId] : null
    if (explicitScope) {
      return {
        scopeId: explicitScope.id,
        sessionId: activeSessionForScope(root, explicitScope.id),
        directory: explicitScope.directory,
      }
    }

    const windows = root.app.windowStates as Record<string, any>
    const preferred = args?.windowId ? windows[args.windowId] : null
    const candidates = preferred ? [preferred, ...Object.values(windows)] : Object.values(windows)
    for (const ws of candidates) {
      if (!ws || ws.activeView?.kind !== "workspace") continue
      const scopeId = ws.selectedScopeId as string | null
      if (!scopeId) continue
      const scope = root.app.scopes[scopeId]
      if (!scope) continue
      const chatId = resolveChatIdFromPaneState(ws.scopePanes?.[scopeId])
      const chat = chatId ? root.app.chats[chatId] : null
      const sessionId = chat?.session?.kind === "ready"
        ? chat.session.sessionId as string
        : activeSessionForScope(root, scopeId)
      return { scopeId, sessionId, directory: scope.directory }
    }
    return { scopeId: null, sessionId: null, directory: args?.directory ?? null }
  })
}

function activeSessionForScope(root: any, scopeId: string): string | null {
  const chats = Object.values(root.app.chats ?? {}) as any[]
  chats.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  for (const chat of chats) {
    if (chat.scopeId !== scopeId) continue
    if (chat.session?.kind === "ready") return chat.session.sessionId
  }
  return null
}

function resolveChatIdFromPaneState(paneState: any): string | null {
  if (!paneState) return null
  const activePane =
    paneState.panes?.find((p: any) => p.id === paneState.activePaneId) ??
    paneState.panes?.[0]
  const activeTab =
    activePane?.tabs?.find((t: any) => t.id === activePane.activeTabId) ??
    activePane?.tabs?.[0]
  if (activeTab?.content?.kind === "chat" && activeTab.content.chatId) {
    return activeTab.content.chatId
  }
  for (const pane of paneState.panes ?? []) {
    const tab =
      pane.tabs?.find((t: any) => t.id === pane.activeTabId) ?? pane.tabs?.[0]
    if (tab?.content?.kind === "chat" && tab.content.chatId) return tab.content.chatId
  }
  return null
}

function isWorkspaceSpecificResource(entry: ResourceEntry): boolean {
  return entry.sourceInfo?.scope === "project" || entry.tier === "pi-project"
}

function isWorkspaceSpecificError(
  error: { path?: string | null },
  directory: string | null | undefined,
): boolean {
  if (!directory || !error.path) return true
  return error.path === directory || error.path.startsWith(`${directory}/`)
}

function countStaticEntries(entries: ResourceEntry[]) {
  const counts = {
    active: 0,
    disabled: 0,
    suppressed: 0,
    missing: 0,
    byType: new Map<string, number>(),
  }
  for (const entry of entries) {
    if (entry.activationState === "active") counts.active++
    else if (entry.activationState === "disabled") counts.disabled++
    else if (entry.activationState === "suppressed") counts.suppressed++
    else if (entry.activationState === "missing") counts.missing++
    counts.byType.set(entry.resourceType, (counts.byType.get(entry.resourceType) ?? 0) + 1)
  }
  return counts
}

function countRuntimeEntries(entries: ResourceEntry[]) {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    counts.set(entry.resourceType, (counts.get(entry.resourceType) ?? 0) + 1)
  }
  return counts
}

function isActivationStale(args: {
  activationHashAtLoad: string | null | undefined
  currentActivationHash: string | null | undefined
}): boolean {
  return Boolean(
    args.activationHashAtLoad &&
      args.currentActivationHash &&
      args.activationHashAtLoad !== args.currentActivationHash,
  )
}

function statusTitle(snapshot: any, catalog: any, directory: string | null | undefined): string {
  const runtime = snapshot?.capturedAt
    ? `Runtime captured: ${new Date(snapshot.capturedAt).toLocaleString()}`
    : "Runtime captured: none"
  const inventory = catalog?.metadata?.resolvedAt
    ? `Workspace inventory refreshed: ${new Date(catalog.metadata.resolvedAt).toLocaleString()}`
    : `Workspace inventory: ${catalog?.metadata?.status ?? "missing"}`
  return `${runtime}\n${inventory}\nDirectory: ${directory ?? catalog?.directory ?? "No directory"}`
}

function OverviewSection({
  title,
  counts,
  selected,
  onSelect,
}: {
  title: string
  counts: Map<string, number>
  selected: ResourceTypeKey | null
  onSelect: (type: ResourceTypeKey) => void
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="flex flex-wrap gap-1.5">
        {RESOURCE_TYPES.map(type => (
          <SelectorPill key={type.key} active={selected === type.key} count={resourceCount(counts, type.key)} onClick={() => onSelect(type.key)}>
            {type.label}
          </SelectorPill>
        ))}
      </div>
    </div>
  )
}

function IssueSection({
  counts,
  selected,
  onSelect,
}: {
  counts: Record<IssueType, number>
  selected: IssueType | null
  onSelect: (type: IssueType) => void
}) {
  const issues: Array<{ key: IssueType; label: string }> = [
    { key: "missing", label: "Missing" },
    { key: "suppressed", label: "Suppressed" },
    { key: "errors", label: "Errors" },
  ]
  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">Issues</div>
      <div className="flex flex-wrap gap-1.5">
        {issues.filter(issue => counts[issue.key] > 0).map(issue => (
          <SelectorPill key={issue.key} active={selected === issue.key} count={counts[issue.key]} onClick={() => onSelect(issue.key)}>
            {issue.label}
          </SelectorPill>
        ))}
      </div>
    </div>
  )
}

function SelectorPill({ active, count, onClick, children }: { active: boolean; count: number; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      className={`rounded-full border px-2.5 py-1 text-[11px] transition-colors ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-muted/40 text-muted-foreground hover:bg-accent hover:text-accent-foreground"}`}
      onClick={onClick}
    >
      {children} <span className={active ? "text-primary-foreground/75" : "text-muted-foreground"}>{count}</span>
    </button>
  )
}

function DetailPanel({
  detail,
}: {
  detail: {
    title: string
    subtitle: string
    emptyText?: string
    rows: Array<{ key: string; title: string; subtitle?: string | null; meta?: string | null }>
  }
}) {
  return (
    <div className="border-t border-border pt-3">
      <div className="mb-2">
        <div className="text-[12px] font-semibold">{detail.title}</div>
        <div className="text-[11px] text-muted-foreground">{detail.subtitle}</div>
      </div>
      {detail.rows.length ? (
        <div className="space-y-1.5">
          {detail.rows.map(row => <Row key={row.key} title={row.title} subtitle={row.subtitle} meta={row.meta} />)}
        </div>
      ) : (
        <div className="rounded-md border border-dashed border-border px-3 py-4 text-[12px] text-muted-foreground">
          {detail.emptyText ?? "Nothing to show here yet."}
        </div>
      )}
    </div>
  )
}

function buildDetail({
  mode,
  snapshot,
  staticCatalog,
  definitions,
  directory,
}: {
  mode: DetailMode
  snapshot: any
  staticCatalog: any
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>
  directory: string | null
}) {
  if (mode.group === "loaded") {
    const rows = (snapshot?.resources ?? [])
      .filter(isWorkspaceSpecificResource)
      .filter((entry: ResourceEntry) => isResourceType(entry.resourceType, mode.type))
      .map((entry: ResourceEntry) => resourceRow(entry, definitions, "loaded"))
    return {
      title: `Loaded workspace ${pluralResourceLabel(mode.type).toLowerCase()}`,
      subtitle: `${rows.length} project-scoped resources loaded in this chat`,
      emptyText: "No workspace-specific resources of this type are loaded in the active chat.",
      rows,
    }
  }
  if (mode.group === "workspace") {
    const rows = (staticCatalog?.entries ?? [])
      .filter(isWorkspaceSpecificResource)
      .filter((entry: ResourceEntry) => isResourceType(entry.resourceType, mode.type))
      .map((entry: ResourceEntry) => resourceRow(entry, definitions, entry.activationState ?? "available"))
    return {
      title: `Available workspace ${pluralResourceLabel(mode.type).toLowerCase()}`,
      subtitle: `${rows.length} project-scoped resources in workspace inventory`,
      emptyText: "No workspace-specific resources of this type were found for this workspace.",
      rows,
    }
  }
  if (mode.group === "issues") {
    if (mode.type === "errors") {
      const rows = (snapshot?.errors ?? [])
        .filter((error: { path?: string }) => isWorkspaceSpecificError(error, directory))
        .map((error: { path: string; error: string }, index: number) => ({
        key: `${error.path}:${index}`,
        title: error.error,
        subtitle: error.path,
        meta: "error",
      }))
      return {
        title: "Workspace resource errors",
        subtitle: `${rows.length} project-scoped runtime errors`,
        emptyText: "No workspace-specific runtime resource errors.",
        rows,
      }
    }
    const rows = (staticCatalog?.entries ?? [])
      .filter(isWorkspaceSpecificResource)
      .filter((entry: ResourceEntry) => entry.activationState === mode.type)
      .map((entry: ResourceEntry) => resourceRow(entry, definitions, mode.type))
    return {
      title: `${mode.type === "missing" ? "Missing" : "Suppressed"} workspace resources`,
      subtitle: `${rows.length} project-scoped resources in workspace inventory`,
      emptyText: `No ${mode.type} workspace-specific resources.`,
      rows,
    }
  }
  if (mode.type === "commands") {
    const rows = (snapshot?.capabilities?.commands ?? []).map((item: RuntimeCommand) => ({
      key: `${item.source}:${item.name}`,
      title: `/${item.name}`,
      subtitle: item.description ?? definitionLabel(item.resourceId, definitions),
      meta: item.source,
    }))
    return {
      title: "Runtime commands",
      subtitle: `${rows.length} loaded in this chat`,
      emptyText: "No runtime commands loaded in this chat.",
      rows,
    }
  }
  const rows = (snapshot?.capabilities?.tools ?? []).map((item: RuntimeTool) => ({
    key: item.name,
    title: item.name,
    subtitle: item.description ?? definitionLabel(item.resourceId, definitions),
    meta: item.active ? "active" : "inactive",
  }))
  return {
    title: "Runtime tools",
    subtitle: `${rows.length} loaded in this chat`,
    emptyText: "No runtime tools loaded in this chat.",
    rows,
  }
}

function resourceRow(
  entry: ResourceEntry,
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>,
  state: string,
) {
  return {
    key: `${entry.resourceType}:${entry.resourceId}:${entry.sourceInfo?.source ?? ""}:${entry.sourceInfo?.path ?? ""}`,
    title: definitionLabel(entry.resourceId, definitions) ?? entry.resourceId,
    subtitle: entry.sourceInfo?.path ?? entry.sourceInfo?.origin ?? entry.sourceInfo?.scope,
    meta: [entry.tier, state].filter(Boolean).join(" · ") || entry.resourceType,
  }
}

function resourceCount(counts: Map<string, number>, type: ResourceTypeKey): number {
  let total = 0
  for (const [key, count] of counts) {
    if (isResourceType(key, type)) total += count
  }
  return total
}

function isResourceType(actual: string, expected: ResourceTypeKey): boolean {
  return actual === expected || actual === `${expected}s` || actual.endsWith(`.${expected}`) || actual.endsWith(`.${expected}s`)
}

function pluralResourceLabel(type: ResourceTypeKey): string {
  return RESOURCE_TYPES.find(item => item.key === type)?.label ?? type
}

function Row({
  title,
  subtitle,
  meta,
}: {
  title: string
  subtitle?: string | null
  meta?: string | null
}) {
  return (
    <div className="min-w-0 rounded border border-border/70 px-2 py-1.5 text-[11px]">
      <div className="flex min-w-0 items-center justify-between gap-2">
        <div className="truncate font-medium">{title}</div>
        {meta ? <div className="shrink-0 text-muted-foreground">{meta}</div> : null}
      </div>
      {subtitle ? <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">{subtitle}</div> : null}
    </div>
  )
}

function Badge({
  tone,
  title,
  children,
}: {
  tone: "good" | "warn" | "bad" | "muted"
  title?: string
  children: React.ReactNode
}) {
  const cls =
    tone === "good"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      : tone === "warn"
        ? "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : tone === "bad"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-border bg-muted text-muted-foreground"
  return <span className={`rounded border px-1.5 py-0.5 ${cls}`} title={title}>{children}</span>
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-4 text-center text-[12px] text-muted-foreground">
      {children}
    </div>
  )
}

function definitionLabel(
  resourceId: string | null | undefined,
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>,
): string | null {
  if (!resourceId) return null
  const definition = definitions[resourceId]
  return definition?.label ?? definition?.canonicalPath ?? null
}
