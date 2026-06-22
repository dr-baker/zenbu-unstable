import { useMemo, useState } from "react"
import { useDb, useRpc, type ViewComponentProps } from "@zenbujs/core/react"

type PiResourceStateArgs = {
  windowId?: string | null
  scopeId?: string | null
  directory?: string | null
}

type SourceInfo = {
  path?: string
  source?: string
  scope?: string
  origin?: string
  baseDir?: string
} | null

type ResourceEntry = {
  resourceId: string
  resourceType: string
  activationState?: string
  enabled?: boolean
  loaded?: boolean
  tier?: string
  sourceInfo?: SourceInfo
}

type RuntimeCommand = {
  name: string
  description?: string
  source: string
  resourceId?: string | null
  sourceInfo?: SourceInfo
}

type RuntimeTool = {
  name: string
  description?: string
  active: boolean
  resourceId?: string | null
  sourceInfo?: SourceInfo
}

type ActiveContext = {
  scopeId: string | null
  sessionId: string | null
  directory: string | null
}

type DetailMode =
  | { group: "source"; scope: SourceScopeKey }
  | { group: "issues"; type: IssueType }
  | { group: "capabilities"; type: "commands" | "tools" }

type ResourceTypeKey = "extension" | "skill" | "prompt" | "theme"
type IssueType = "missing" | "suppressed" | "errors"
type SourceScopeKey = "project" | "user" | "temporary" | "unknown"

type SourceGroup = {
  key: SourceScopeKey
  label: string
  description: string
  loadedEntries: ResourceEntry[]
  availableEntries: ResourceEntry[]
  typeCounts: Map<string, number>
}

const RESOURCE_TYPES: Array<{ key: ResourceTypeKey; label: string; short: string }> = [
  { key: "extension", label: "Extensions", short: "Ext" },
  { key: "skill", label: "Skills", short: "Skills" },
  { key: "prompt", label: "Prompts", short: "Prompts" },
  { key: "theme", label: "Themes", short: "Themes" },
]

const SOURCE_SCOPES: Array<{ key: SourceScopeKey; label: string; description: string }> = [
  { key: "project", label: "Project", description: "Resources from this workspace/repo" },
  { key: "user", label: "Global (~/.pi)", description: "User-wide Pi resources" },
  { key: "temporary", label: "Session / Zenbu", description: "Injected by Zenbu, plugins, or this live session" },
  { key: "unknown", label: "Other", description: "Resources without source scope metadata" },
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

  const [mode, setMode] = useState<DetailMode>({ group: "source", scope: "project" })
  const sourceGroups = useMemo(
    () => buildSourceGroups({
      availableEntries: data.staticCatalog?.entries ?? [],
      loadedEntries: data.snapshot?.resources ?? [],
    }),
    [data.staticCatalog?.entries, data.snapshot?.resources],
  )
  const selectedSource =
    mode.group === "source"
      ? mode.scope
      : firstPopulatedSource(sourceGroups) ?? "project"
  const issueCounts = useMemo(
    () => ({
      missing: (data.staticCatalog?.entries ?? []).filter(entry => entry.activationState === "missing").length,
      suppressed: (data.staticCatalog?.entries ?? []).filter(entry => entry.activationState === "suppressed").length,
      errors: data.snapshot?.errors.length ?? 0,
    }),
    [data.staticCatalog?.entries, data.snapshot?.errors.length],
  )
  const detail = useMemo(
    () => buildDetail({
      mode,
      snapshot: data.snapshot,
      staticCatalog: data.staticCatalog,
      definitions: data.definitions,
      directory: active.directory,
      sourceGroups,
      selectedSource,
    }),
    [mode, data.snapshot, data.staticCatalog, data.definitions, active.directory, sourceGroups, selectedSource],
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
        <SourceSection
          groups={sourceGroups}
          selected={selectedSource}
          onSelect={scope => setMode({ group: "source", scope })}
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

function buildSourceGroups({
  availableEntries,
  loadedEntries,
}: {
  availableEntries: ResourceEntry[]
  loadedEntries: ResourceEntry[]
}): SourceGroup[] {
  const byScope = new Map<SourceScopeKey, SourceGroup>()
  for (const scope of SOURCE_SCOPES) {
    byScope.set(scope.key, {
      key: scope.key,
      label: scope.label,
      description: scope.description,
      loadedEntries: [],
      availableEntries: [],
      typeCounts: new Map(),
    })
  }

  for (const entry of loadedEntries) {
    byScope.get(sourceScopeKey(entry))?.loadedEntries.push(entry)
  }
  for (const entry of availableEntries) {
    byScope.get(sourceScopeKey(entry))?.availableEntries.push(entry)
  }
  for (const group of byScope.values()) {
    group.typeCounts = countUniqueEntriesByType([...group.loadedEntries, ...group.availableEntries])
  }

  return SOURCE_SCOPES
    .map(scope => byScope.get(scope.key)!)
    .filter(group => group.key !== "unknown" || group.loadedEntries.length || group.availableEntries.length)
}

function sourceScopeKey(entry: ResourceEntry): SourceScopeKey {
  const scope = entry.sourceInfo?.scope
  if (scope === "project" || scope === "user" || scope === "temporary") return scope
  if (entry.tier === "pi-project") return "project"
  if (entry.tier === "pi-user") return "user"
  if (["pi-temporary", "zenbu-built-in", "zenbu-plugin"].includes(entry.tier ?? "")) return "temporary"
  return "unknown"
}

function firstPopulatedSource(groups: SourceGroup[]): SourceScopeKey | null {
  return groups.find(group => group.loadedEntries.length || group.availableEntries.length)?.key ?? null
}

function countUniqueEntriesByType(entries: ResourceEntry[]) {
  const seen = new Set<string>()
  const counts = new Map<string, number>()
  for (const entry of entries) {
    const key = resourceIdentityKey(entry)
    if (seen.has(key)) continue
    seen.add(key)
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

function SourceSection({
  groups,
  selected,
  onSelect,
}: {
  groups: SourceGroup[]
  selected: SourceScopeKey
  onSelect: (scope: SourceScopeKey) => void
}) {
  return (
    <div>
      <div className="mb-2 text-[11px] font-medium text-muted-foreground">Resources by source</div>
      <div className="space-y-2">
        {groups.map(group => {
          const total = uniqueResourceCount(group)
          const active = selected === group.key
          return (
            <button
              key={group.key}
              className={`w-full rounded-lg border px-2.5 py-2 text-left transition-colors ${active ? "border-primary bg-primary/10" : "border-border bg-muted/20 hover:bg-accent/70"}`}
              onClick={() => onSelect(group.key)}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="truncate text-[12px] font-semibold">{group.label}</div>
                <div className="shrink-0 text-[11px] text-muted-foreground">{total}</div>
              </div>
              <div className="mt-0.5 truncate text-[10px] text-muted-foreground">{group.description}</div>
              <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-muted-foreground">
                <span>{group.loadedEntries.length} loaded</span>
                <span>·</span>
                <span>{group.availableEntries.length} inventory</span>
              </div>
              <div className="mt-1.5 flex flex-wrap gap-1">
                {RESOURCE_TYPES.map(type => (
                  <span key={type.key} className="rounded-full bg-background/70 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                    {type.short} {resourceCount(group.typeCounts, type.key)}
                  </span>
                ))}
              </div>
            </button>
          )
        })}
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
  sourceGroups,
  selectedSource,
}: {
  mode: DetailMode
  snapshot: any
  staticCatalog: any
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>
  directory: string | null
  sourceGroups: SourceGroup[]
  selectedSource: SourceScopeKey
}) {
  if (mode.group === "source") {
    const group = sourceGroups.find(item => item.key === selectedSource) ?? sourceGroups[0]
    const rows = group ? sourceRows(group, definitions) : []
    return {
      title: group ? `${group.label} resources` : "Resources",
      subtitle: group
        ? `${group.loadedEntries.length} loaded in chat · ${group.availableEntries.length} in inventory`
        : "No resource sources found",
      emptyText: group ? `No resources found from ${group.label}.` : "No resources found.",
      rows,
    }
  }
  if (mode.group === "issues") {
    if (mode.type === "errors") {
      const rows = (snapshot?.errors ?? []).map((error: { path: string; error: string }, index: number) => ({
        key: `${error.path}:${index}`,
        title: error.error,
        subtitle: error.path,
        meta: "error",
      }))
      return {
        title: "Resource errors",
        subtitle: `${rows.length} runtime errors`,
        emptyText: "No runtime resource errors.",
        rows,
      }
    }
    const rows = (staticCatalog?.entries ?? [])
      .filter((entry: ResourceEntry) => entry.activationState === mode.type)
      .map((entry: ResourceEntry) => resourceRow(entry, definitions, mode.type))
    return {
      title: `${mode.type === "missing" ? "Missing" : "Suppressed"} resources`,
      subtitle: `${rows.length} resources in inventory`,
      emptyText: `No ${mode.type} resources.`,
      rows,
    }
  }
  if (mode.type === "commands") {
    const rows = (snapshot?.capabilities?.commands ?? []).map((item: RuntimeCommand) => ({
      key: `${item.source}:${item.name}`,
      title: `/${item.name}`,
      subtitle: item.description ?? definitionLabel(item.resourceId, definitions),
      meta: [item.source, sourceScopeLabel(item.sourceInfo)].filter(Boolean).join(" · "),
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
    meta: [item.active ? "active" : "inactive", sourceScopeLabel(item.sourceInfo)].filter(Boolean).join(" · "),
  }))
  return {
    title: "Runtime tools",
    subtitle: `${rows.length} loaded in this chat`,
    emptyText: "No runtime tools loaded in this chat.",
    rows,
  }
}

function sourceRows(
  group: SourceGroup,
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>,
) {
  const loadedByKey = new Map(group.loadedEntries.map(entry => [resourceIdentityKey(entry), entry]))
  const availableByKey = new Map(group.availableEntries.map(entry => [resourceIdentityKey(entry), entry]))
  const orderedKeys = [
    ...group.loadedEntries.map(resourceIdentityKey),
    ...group.availableEntries.map(resourceIdentityKey),
  ]
  const seen = new Set<string>()
  const rows = []
  for (const key of orderedKeys) {
    if (seen.has(key)) continue
    seen.add(key)
    const loaded = loadedByKey.get(key)
    const available = availableByKey.get(key)
    const entry = loaded ?? available
    if (!entry) continue
    const state = resourcePresenceLabel({ loaded: Boolean(loaded), available })
    rows.push(resourceRow(entry, definitions, state))
  }
  return rows
}

function resourceRow(
  entry: ResourceEntry,
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>,
  state: string,
) {
  return {
    key: resourceIdentityKey(entry),
    title: definitionLabel(entry.resourceId, definitions) ?? entry.resourceId,
    subtitle: entry.sourceInfo?.path ?? entry.sourceInfo?.origin ?? entry.sourceInfo?.scope,
    meta: [resourceTypeLabel(entry.resourceType), state].filter(Boolean).join(" · ") || entry.resourceType,
  }
}

function resourcePresenceLabel({
  loaded,
  available,
}: {
  loaded: boolean
  available: ResourceEntry | undefined
}): string {
  const states = []
  if (loaded) states.push("loaded")
  if (available) states.push(available.activationState === "active" ? "inventory" : available.activationState ?? "inventory")
  return states.join(" + ") || "seen"
}

function resourceIdentityKey(entry: ResourceEntry): string {
  return [
    entry.resourceType,
    entry.resourceId,
    entry.sourceInfo?.scope ?? "",
    entry.sourceInfo?.source ?? "",
    entry.sourceInfo?.origin ?? "",
    entry.sourceInfo?.path ?? "",
    entry.tier ?? "",
  ].join(":")
}

function uniqueResourceCount(group: SourceGroup): number {
  return new Set([...group.loadedEntries, ...group.availableEntries].map(resourceIdentityKey)).size
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

function resourceTypeLabel(type: string): string {
  const matched = RESOURCE_TYPES.find(item => isResourceType(type, item.key))
  if (!matched) return type
  return matched.label.endsWith("s") ? matched.label.slice(0, -1) : matched.label
}

function sourceScopeLabel(sourceInfo: SourceInfo | undefined): string | null {
  const scope = sourceInfo?.scope
  return SOURCE_SCOPES.find(item => item.key === scope)?.label ?? null
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
