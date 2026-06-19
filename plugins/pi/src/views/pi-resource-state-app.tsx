import { useMemo } from "react"
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

  const staticCounts = useMemo(
    () => countStaticEntries(data.staticCatalog?.entries ?? []),
    [data.staticCatalog?.entries],
  )
  const runtimeCounts = useMemo(
    () => countRuntimeEntries(data.snapshot?.resources ?? []),
    [data.snapshot?.resources],
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
            <h2 className="truncate text-sm font-semibold">Pi resources</h2>
            <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
              {active.directory ?? data.staticCatalog?.directory ?? "No directory"}
            </div>
          </div>
          <button
            className="rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            onClick={refreshCatalog}
          >
            Refresh
          </button>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
          <Badge tone={data.snapshot?.active ? "good" : "muted"}>
            {data.snapshot?.active ? "live" : data.snapshot ? "cached" : "no session"}
          </Badge>
          {stale ? <Badge tone="warn">stale activation</Badge> : null}
          <Badge tone={data.staticCatalog?.metadata.status === "error" ? "bad" : "muted"}>
            catalog {data.staticCatalog?.metadata.status ?? "missing"}
          </Badge>
        </div>
        {stale ? (
          <div className="mt-2 rounded border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
            This session loaded a different activation set than the current static catalog.
            {active.sessionId ? (
              <button className="ml-2 underline" onClick={reloadSession}>Reload session</button>
            ) : null}
          </div>
        ) : null}
      </header>

      <section className="space-y-3 p-3">
        <Card title="Runtime snapshot" subtitle={snapshotSubtitle(data.snapshot)}>
          {data.snapshot ? (
            <>
              <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
                <Metric label="resources" value={data.snapshot.resources.length} />
                <Metric label="commands" value={data.snapshot.capabilities.commands.length} />
                <Metric label="tools" value={data.snapshot.capabilities.tools.length} />
                <Metric label="errors" value={data.snapshot.errors.length} tone={data.snapshot.errors.length ? "bad" : "normal"} />
              </div>
              <ResourceCountList counts={runtimeCounts} />
              <CapabilityList
                title="Commands"
                items={data.snapshot.capabilities.commands}
                definitions={data.definitions}
              />
              <ToolList
                title="Tools"
                items={data.snapshot.capabilities.tools}
                definitions={data.definitions}
              />
              <ErrorList errors={data.snapshot.errors} />
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              No runtime snapshot yet. Opening this chat is still cheap; Pi will refresh this when the session activates.
            </p>
          )}
        </Card>

        <Card title="Static catalog" subtitle={catalogSubtitle(data.staticCatalog)}>
          {data.staticCatalog ? (
            <>
              <div className="grid grid-cols-4 gap-2 text-center text-[11px]">
                <Metric label="active" value={staticCounts.active} />
                <Metric label="disabled" value={staticCounts.disabled} />
                <Metric label="suppressed" value={staticCounts.suppressed} />
                <Metric label="missing" value={staticCounts.missing} tone={staticCounts.missing ? "bad" : "normal"} />
              </div>
              <ResourceCountList counts={staticCounts.byType} />
              <StaticEntryList
                entries={data.staticCatalog.entries}
                definitions={data.definitions}
              />
            </>
          ) : (
            <p className="text-[12px] text-muted-foreground">
              Static catalog has not been resolved for this scope yet.
            </p>
          )}
        </Card>
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

function snapshotSubtitle(snapshot: any): string {
  if (!snapshot) return "No cached runtime data"
  const when = new Date(snapshot.capturedAt).toLocaleString()
  return snapshot.active ? `Captured live ${when}` : `Last loaded ${when}`
}

function catalogSubtitle(catalog: any): string {
  if (!catalog) return "Not resolved"
  if (catalog.metadata.error) return catalog.metadata.error
  if (!catalog.metadata.resolvedAt) return catalog.metadata.status
  return `Resolved ${new Date(catalog.metadata.resolvedAt).toLocaleString()}`
}

function Card({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
}) {
  return (
    <div className="rounded-lg border border-border bg-card text-card-foreground">
      <div className="border-b border-border px-3 py-2">
        <div className="text-[12px] font-semibold">{title}</div>
        {subtitle ? <div className="mt-0.5 text-[11px] text-muted-foreground">{subtitle}</div> : null}
      </div>
      <div className="space-y-3 p-3">{children}</div>
    </div>
  )
}

function Metric({
  label,
  value,
  tone = "normal",
}: {
  label: string
  value: number
  tone?: "normal" | "bad"
}) {
  return (
    <div className="rounded border border-border p-2">
      <div className={tone === "bad" ? "font-semibold text-destructive" : "font-semibold"}>{value}</div>
      <div className="text-muted-foreground">{label}</div>
    </div>
  )
}

function ResourceCountList({ counts }: { counts: Map<string, number> }) {
  if (counts.size === 0) return null
  return (
    <div className="flex flex-wrap gap-1 text-[11px]">
      {[...counts.entries()].sort().map(([type, count]) => (
        <Badge key={type} tone="muted">{type}: {count}</Badge>
      ))}
    </div>
  )
}

function CapabilityList({
  title,
  items,
  definitions,
}: {
  title: string
  items: RuntimeCommand[]
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>
}) {
  if (items.length === 0) return null
  return (
    <List title={title}>
      {items.slice(0, 12).map(item => (
        <Row
          key={`${item.source}:${item.name}`}
          title={`/${item.name}`}
          subtitle={item.description ?? definitionLabel(item.resourceId, definitions)}
          meta={item.source}
        />
      ))}
    </List>
  )
}

function ToolList({
  title,
  items,
  definitions,
}: {
  title: string
  items: RuntimeTool[]
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>
}) {
  if (items.length === 0) return null
  return (
    <List title={title}>
      {items.slice(0, 12).map(item => (
        <Row
          key={item.name}
          title={item.name}
          subtitle={item.description ?? definitionLabel(item.resourceId, definitions)}
          meta={item.active ? "active" : "inactive"}
        />
      ))}
    </List>
  )
}

function StaticEntryList({
  entries,
  definitions,
}: {
  entries: ResourceEntry[]
  definitions: Record<string, { label?: string | null; canonicalPath?: string }>
}) {
  const visible = entries.slice(0, 16)
  if (visible.length === 0) return null
  return (
    <List title="Catalog entries">
      {visible.map(entry => (
        <Row
          key={`${entry.resourceType}:${entry.resourceId}:${entry.sourceInfo?.source}`}
          title={definitionLabel(entry.resourceId, definitions) ?? entry.resourceId}
          subtitle={entry.sourceInfo?.path}
          meta={`${entry.resourceType} · ${entry.activationState}`}
        />
      ))}
    </List>
  )
}

function ErrorList({ errors }: { errors: Array<{ path: string; error: string }> }) {
  if (errors.length === 0) return null
  return (
    <List title="Errors">
      {errors.slice(0, 8).map((error, index) => (
        <Row key={`${error.path}:${index}`} title={error.error} subtitle={error.path} meta="error" />
      ))}
    </List>
  )
}

function List({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">{title}</div>
      <div className="space-y-1">{children}</div>
    </div>
  )
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
  children,
}: {
  tone: "good" | "warn" | "bad" | "muted"
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
  return <span className={`rounded border px-1.5 py-0.5 ${cls}`}>{children}</span>
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
