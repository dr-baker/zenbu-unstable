import fs, { watch, type FSWatcher } from "node:fs"
import os from "node:os"
import path from "node:path"

import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"
import {
  DefaultPackageManager,
  SettingsManager,
  getAgentDir,
  type AgentSession,
  type Extension,
  type ExtensionFlag,
  type ExtensionShortcut,
  type ResolvedPaths,
  type ResolvedResource,
  type SlashCommandInfo,
  type SourceInfo,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent"

import { PiRuntimeService } from "./pi-runtime"
import {
  RESOURCE_TYPES,
  applyActivationStates,
  deriveSessionStaleness,
  hashJson,
  hashString,
  resourceId,
  resourceLookupKey,
  selectPreloadScopeIds,
  tierFromSourceInfo,
  type ResourceObservation,
  type ResourceTier,
  type ResourceType,
  type SourceInfoShape,
} from "./pi-resource-registry-helpers"
import type { LiveSession } from "./sessions/live-session"
import type { Schema } from "../schema"

const RESOLVER_VERSION = "pi-resource-registry-v1"
const STATIC_RESOURCE_KEYS = [
  "extensions",
  "skills",
  "prompts",
  "themes",
] as const
const DIRTY_REFRESH_DEBOUNCE_MS = 250
const WATCH_DEBOUNCE_MS = 250
const PI_RESOURCE_WATCH_NAMES = new Set([
  "settings.json",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "npm",
  "git",
])
const RESOURCE_LAST_SEEN_WRITE_INTERVAL_MS = 60_000

type StaticResourceKey = (typeof STATIC_RESOURCE_KEYS)[number]
type ResourceDefinition = Schema["piResourceDefinitions"][string]
type ResourceDiscovery = ResourceDefinition["discovery"]
type StaticCatalogEntry = Schema["piResourceStaticCatalogs"][string]["entries"][number]
type RuntimeResourceEntry = Schema["sessionRuntimeSnapshots"][string]["resources"][number]
type RuntimeCapabilities = Schema["sessionRuntimeSnapshots"][string]["capabilities"]
type RuntimeError = Schema["sessionRuntimeSnapshots"][string]["errors"][number]

type ZenbuExtensionRecord = Schema["extensions"][string]
type AppScope = {
  id: string
  workspaceId: string
  directory: string
  archived: boolean
  pinnedAt: number | null
  createdAt: number
}

type RuntimeExtensionResult = ReturnType<AgentSession["resourceLoader"]["getExtensions"]>

export class PiResourceRegistryService extends Service.create({
  key: "piResourceRegistry",
  deps: { db: DbService, piRuntime: PiRuntimeService },
}) {
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly pendingRefreshReasons = new Map<string, Set<string>>()
  private readonly watchers = new Map<string, FSWatcher>()
  private readonly watchTimers = new Map<string, NodeJS.Timeout>()
  private refreshTimer: NodeJS.Timeout | null = null

  async evaluate() {
    const bootedAt = Date.now()
    await this.ctx.db.client.update(root => {
      for (const snapshot of Object.values(root.pi.sessionRuntimeSnapshots)) {
        snapshot.active = false
        snapshot.disposedAt ??= bootedAt
      }
    })

    this.setup("pi-resource-static-catalogs", () => {
      void this.refreshPreloadedStaticCatalogs("boot")
      const unsubScopes = this.ctx.db.client.app.scopes.subscribe(() => {
        void this.reconcileStaticCatalogRecords()
        this.schedulePreloadedRefresh("scope-change")
      })
      const unsubExtensions = maybeSubscribe(
        this.ctx.db.client.pi.extensions,
        () => this.markAllStaticCatalogsDirty("zenbu-extension-change"),
      )
      let selectedScopesKey = selectedWindowScopesKey(this.ctx.db.client.readRoot())
      const unsubWindows = this.ctx.db.client.app.windowStates.subscribe(() => {
        const nextKey = selectedWindowScopesKey(this.ctx.db.client.readRoot())
        if (nextKey === selectedScopesKey) return
        selectedScopesKey = nextKey
        this.schedulePreloadedRefresh("focus-change")
      })
      return () => {
        unsubScopes()
        unsubExtensions?.()
        unsubWindows()
        if (this.refreshTimer) clearTimeout(this.refreshTimer)
        this.refreshTimer = null
        this.closeWatchers()
      }
    })
  }

  async refreshStaticCatalog(args: {
    scopeId: string
    reason?: string
  }): Promise<void> {
    if (args.reason === "session-activate" && this.isStaticCatalogFresh(args.scopeId)) {
      return
    }
    const existing = this.refreshing.get(args.scopeId)
    if (existing) return existing
    const p = this.doRefreshStaticCatalog(args).finally(() => {
      this.refreshing.delete(args.scopeId)
      const pendingReasons = this.pendingRefreshReasons.get(args.scopeId)
      if (pendingReasons) {
        this.pendingRefreshReasons.delete(args.scopeId)
        void this.refreshStaticCatalog({
          scopeId: args.scopeId,
          reason: Array.from(pendingReasons).join(", "),
        })
      }
    })
    this.refreshing.set(args.scopeId, p)
    return p
  }

  private isStaticCatalogFresh(scopeId: string): boolean {
    const root = this.ctx.db.client.readRoot()
    const scope = root.app.scopes[scopeId]
    const catalog = root.pi.piResourceStaticCatalogs[scopeId]
    return (
      !!scope &&
      !!catalog &&
      catalog.directory === scope.directory &&
      catalog.workspaceId === scope.workspaceId &&
      catalog.metadata.status === "idle" &&
      catalog.metadata.resolverVersion === RESOLVER_VERSION &&
      !!catalog.metadata.activationHash &&
      !!catalog.metadata.staticCatalogHash
    )
  }

  async markStaticCatalogDirty(args: {
    scopeId: string
    reason: string
  }): Promise<void> {
    const now = Date.now()
    await this.ctx.db.client.update(root => {
      const catalog = root.pi.piResourceStaticCatalogs[args.scopeId]
      if (!catalog) return
      catalog.metadata.status = "dirty"
      catalog.metadata.markedDirtyAt = now
      if (!catalog.metadata.dirtyReasons.includes(args.reason)) {
        catalog.metadata.dirtyReasons.push(args.reason)
      }
    })
    this.notePendingRefresh(args.scopeId, args.reason)
  }

  async markRuntimeSnapshotInactive(args: {
    sessionId: string
    disposedAt?: number
  }): Promise<void> {
    const disposedAt = args.disposedAt ?? Date.now()
    await this.ctx.db.client.update(root => {
      const snapshot = root.pi.sessionRuntimeSnapshots[args.sessionId]
      if (!snapshot) return
      snapshot.active = false
      snapshot.disposedAt = disposedAt
    })
  }

  getSessionStaleness(args: { sessionId: string }): {
    stale: boolean
    reason: string | null
  } {
    const root = this.ctx.db.client.readRoot()
    const snapshot = root.pi.sessionRuntimeSnapshots[args.sessionId]
    if (!snapshot) return { stale: false, reason: null }
    const catalog = root.pi.piResourceStaticCatalogs[snapshot.scopeId]
    return deriveSessionStaleness({
      activationHashAtLoad: snapshot.activationHashAtLoad,
      currentActivationHash: catalog?.metadata.activationHash,
    })
  }

  async captureRuntimeSnapshot(args: {
    live: LiveSession
    active?: boolean
    disposedAt?: number | null
  }): Promise<void> {
    const { live } = args
    const now = Date.now()
    const root = this.ctx.db.client.readRoot()
    const session = root.pi.sessions[live.sessionId]
    if (!session) return
    const scope = root.app.scopes[session.scopeId]
    if (!scope) return

    const staticCatalog = root.pi.piResourceStaticCatalogs[scope.id]
    const staticResourceIds = new Set(
      staticCatalog?.entries.map(entry => entry.resourceId) ?? [],
    )
    const activationHashAtLoad =
      staticCatalog?.metadata.activationHash ?? null
    const staticCatalogHashAtLoad =
      staticCatalog?.metadata.staticCatalogHash ?? null

    const extensionResult = live.pi.resourceLoader.getExtensions()
    const observations: ResourceObservation[] = []
    const resources: RuntimeResourceEntry[] = []
    const resourceIdByTypeAndCanonical = new Map<string, string>()

    const addRuntimeResource = (observation: ResourceObservation) => {
      const key = resourceLookupKey(
        observation.resourceType,
        observation.canonicalPath,
      )
      if (resourceIdByTypeAndCanonical.has(key)) return
      resourceIdByTypeAndCanonical.set(key, observation.resourceId)
      observations.push(observation)
      resources.push({
        resourceId: observation.resourceId,
        resourceType: observation.resourceType,
        discovery: staticResourceIds.has(observation.resourceId)
          ? "both"
          : "runtime",
        loaded: true,
        order: resources.length,
        tier: observation.tier,
        sourceInfo: observation.sourceInfo,
      })
    }

    for (const extension of extensionResult.extensions) {
      addRuntimeResource(
        observeResource({
          resourceType: "extension",
          path: extension.resolvedPath || extension.path,
          sourceInfo: normalizeSourceInfo(
            extension.sourceInfo,
            extension.resolvedPath || extension.path,
          ),
          label: extensionLabel(extension.resolvedPath || extension.path),
        }),
      )
    }

    const skillResult = live.pi.resourceLoader.getSkills()
    for (const skill of skillResult.skills) {
      const filePath = skill.filePath || skill.sourceInfo?.path
      if (!filePath) continue
      addRuntimeResource(
        observeResource({
          resourceType: "skill",
          path: filePath,
          sourceInfo: normalizeSourceInfo(skill.sourceInfo, filePath),
          label: skill.name || path.basename(filePath),
        }),
      )
    }

    const promptResult = live.pi.resourceLoader.getPrompts()
    for (const prompt of promptResult.prompts) {
      const filePath = prompt.filePath || prompt.sourceInfo?.path
      if (!filePath) continue
      addRuntimeResource(
        observeResource({
          resourceType: "prompt",
          path: filePath,
          sourceInfo: normalizeSourceInfo(prompt.sourceInfo, filePath),
          label: prompt.name || path.basename(filePath),
        }),
      )
    }

    const themeResult = live.pi.resourceLoader.getThemes()
    for (const theme of themeResult.themes) {
      const filePath = theme.sourcePath || theme.sourceInfo?.path
      if (!filePath) continue
      addRuntimeResource(
        observeResource({
          resourceType: "theme",
          path: filePath,
          sourceInfo: normalizeSourceInfo(theme.sourceInfo, filePath),
          label: theme.name || path.basename(filePath),
        }),
      )
    }

    const capabilities = buildRuntimeCapabilities({
      pi: live.pi,
      extensionResult,
      resourceIdByTypeAndCanonical,
    })

    const errors = buildRuntimeErrors({
      extensionResult,
      skillDiagnostics: skillResult.diagnostics,
      promptDiagnostics: promptResult.diagnostics,
      themeDiagnostics: themeResult.diagnostics,
      resourceIdByTypeAndCanonical,
    })

    const capabilityHash = hashJson({
      resources: resources.map(entry => ({
        resourceId: entry.resourceId,
        resourceType: entry.resourceType,
        discovery: entry.discovery,
        loaded: entry.loaded,
        order: entry.order,
        sourceInfo: entry.sourceInfo,
      })),
      capabilities,
      errors,
    })
    const systemPromptHash = hashString(live.pi.systemPrompt)

    await this.ctx.db.client.update(root => {
      upsertDefinitions(root.pi.piResourceDefinitions, observations, now, "runtime")
      root.pi.sessionRuntimeSnapshots[live.sessionId] = {
        sessionId: live.sessionId,
        scopeId: scope.id,
        workspaceId: scope.workspaceId,
        directory: scope.directory,
        active: args.active ?? true,
        capturedAt: now,
        disposedAt: args.disposedAt ?? null,
        activationHashAtLoad,
        staticCatalogHashAtLoad,
        resources,
        capabilities,
        errors,
        capabilityHash,
        systemPromptHash,
      }
    })
  }

  private async doRefreshStaticCatalog(args: {
    scopeId: string
    reason?: string
  }): Promise<void> {
    const requestedAt = Date.now()
    const root = this.ctx.db.client.readRoot()
    const scope = root.app.scopes[args.scopeId]
    if (!scope) return

    await this.ctx.db.client.update(root => {
      root.pi.piResourceStaticCatalogs[scope.id] ??= emptyStaticCatalog({
        scopeId: scope.id,
        workspaceId: scope.workspaceId,
        directory: scope.directory,
      })
      const catalog = root.pi.piResourceStaticCatalogs[scope.id]
      catalog.directory = scope.directory
      catalog.workspaceId = scope.workspaceId
      catalog.metadata.status = "resolving"
      catalog.metadata.requestedAt = requestedAt
      catalog.metadata.error = null
    })

    try {
      const result = await buildStaticCatalog({
        scope,
        zenbuExtensions: this.ctx.db.client.readRoot().pi.extensions,
      })
      const resolvedAt = Date.now()
      await this.ctx.db.client.update(root => {
        upsertDefinitions(
          root.pi.piResourceDefinitions,
          result.observations,
          resolvedAt,
          "staticCatalog",
        )
        const previous = root.pi.piResourceStaticCatalogs[scope.id]
        const dirtiedDuringRefresh =
          previous?.metadata.status === "dirty" &&
          previous.metadata.markedDirtyAt != null &&
          previous.metadata.markedDirtyAt >= requestedAt
        root.pi.piResourceStaticCatalogs[scope.id] = {
          scopeId: scope.id,
          workspaceId: scope.workspaceId,
          directory: scope.directory,
          metadata: {
            status: dirtiedDuringRefresh ? "dirty" : "idle",
            requestedAt,
            resolvedAt,
            markedDirtyAt: dirtiedDuringRefresh
              ? (previous?.metadata.markedDirtyAt ?? null)
              : null,
            dirtyReasons: dirtiedDuringRefresh
              ? (previous?.metadata.dirtyReasons ?? [])
              : [],
            inputHash: result.inputHash,
            activationHash: result.activationHash,
            staticCatalogHash: result.staticCatalogHash,
            resolverVersion: RESOLVER_VERSION,
            error: null,
          },
          entries: result.entries,
          packages: result.packages,
          diagnostics: result.diagnostics,
        }
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      await this.ctx.db.client.update(root => {
        const catalog = root.pi.piResourceStaticCatalogs[scope.id]
        if (!catalog) return
        catalog.metadata.status = "error"
        catalog.metadata.error = message
        catalog.metadata.resolverVersion = RESOLVER_VERSION
      })
    }
  }

  private async refreshPreloadedStaticCatalogs(reason: string): Promise<void> {
    await this.reconcileStaticCatalogRecords()
    const root = this.ctx.db.client.readRoot()
    const max = Math.max(
      0,
      root.pi.resourceRegistrySettings.maxPreloadedStaticCatalogScopes,
    )
    const scopeIds = selectPreloadScopeIds({
      max,
      scopes: Object.values(root.app.scopes).map(scope => ({
        id: scope.id,
        archived: scope.archived,
        pinnedAt: scope.pinnedAt,
        createdAt: scope.createdAt,
      })),
      windowStates: Object.values(root.app.windowStates).map(ws => ({
        selectedScopeId: ws?.selectedScopeId ?? null,
      })),
    })

    this.reconcileWatchers(scopeIds)
    for (const scopeId of scopeIds) {
      await this.refreshStaticCatalog({ scopeId, reason })
    }
  }

  private schedulePreloadedRefresh(reason: string) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer)
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null
      void this.refreshPreloadedStaticCatalogs(reason)
    }, DIRTY_REFRESH_DEBOUNCE_MS)
  }

  private async markAllStaticCatalogsDirty(reason: string): Promise<void> {
    const now = Date.now()
    await this.ctx.db.client.update(root => {
      for (const catalog of Object.values(root.pi.piResourceStaticCatalogs)) {
        catalog.metadata.status = "dirty"
        catalog.metadata.markedDirtyAt = now
        if (!catalog.metadata.dirtyReasons.includes(reason)) {
          catalog.metadata.dirtyReasons.push(reason)
        }
        this.notePendingRefresh(catalog.scopeId, reason)
      }
    })
    this.schedulePreloadedRefresh(reason)
  }

  private notePendingRefresh(scopeId: string, reason: string) {
    if (!this.refreshing.has(scopeId)) return
    let reasons = this.pendingRefreshReasons.get(scopeId)
    if (!reasons) {
      reasons = new Set<string>()
      this.pendingRefreshReasons.set(scopeId, reasons)
    }
    reasons.add(reason)
  }

  private reconcileWatchers(scopeIds: string[]) {
    const root = this.ctx.db.client.readRoot()
    const nextKeys = new Set<string>()
    const add = (
      key: string,
      targetPath: string,
      scopeId: string | null,
      options?: { childNames?: Set<string>; reason?: string },
    ) => {
      nextKeys.add(key)
      if (this.watchers.has(key)) return
      if (!fs.existsSync(targetPath)) return
      try {
        const watcher = watch(
          targetPath,
          { persistent: false },
          (_event, filename) => {
            if (
              options?.childNames &&
              !watchedChildMatches(filename, options.childNames)
            ) {
              return
            }
            this.scheduleWatcherDirty(
              scopeId,
              options?.reason ??
                (scopeId ? "project-pi-files" : "user-pi-files"),
            )
          },
        )
        this.watchers.set(key, watcher)
      } catch (err) {
        console.warn("[pi-resource-registry] failed to watch", targetPath, err)
      }
    }

    for (const target of globalWatchTargets()) {
      add(`global:${target.path}`, target.path, null, target.options)
    }

    for (const scopeId of scopeIds) {
      const scope = root.app.scopes[scopeId]
      if (!scope) continue
      for (const target of projectWatchTargets(scope.directory)) {
        add(`scope:${scopeId}:${target.path}`, target.path, scopeId, target.options)
      }
    }

    for (const [key, watcher] of this.watchers) {
      if (nextKeys.has(key)) continue
      watcher.close()
      this.watchers.delete(key)
    }
  }

  private scheduleWatcherDirty(scopeId: string | null, reason: string) {
    const key = scopeId ?? "global"
    const existing = this.watchTimers.get(key)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      this.watchTimers.delete(key)
      if (scopeId) {
        void this.markStaticCatalogDirty({ scopeId, reason }).then(() => {
          this.schedulePreloadedRefresh(reason)
        })
      } else {
        void this.markAllStaticCatalogsDirty(reason)
      }
    }, WATCH_DEBOUNCE_MS)
    this.watchTimers.set(key, timer)
  }

  private closeWatchers() {
    for (const watcher of this.watchers.values()) watcher.close()
    this.watchers.clear()
    for (const timer of this.watchTimers.values()) clearTimeout(timer)
    this.watchTimers.clear()
    this.pendingRefreshReasons.clear()
  }

  private async reconcileStaticCatalogRecords(): Promise<void> {
    const now = Date.now()
    await this.ctx.db.client.update(root => {
      const liveScopeIds = new Set(Object.keys(root.app.scopes))
      for (const scope of Object.values(root.app.scopes)) {
        const existing = root.pi.piResourceStaticCatalogs[scope.id]
        if (!existing) continue
        if (
          existing.directory !== scope.directory ||
          existing.workspaceId !== scope.workspaceId
        ) {
          existing.directory = scope.directory
          existing.workspaceId = scope.workspaceId
          existing.metadata.status = "dirty"
          existing.metadata.markedDirtyAt = now
          if (!existing.metadata.dirtyReasons.includes("scope-change")) {
            existing.metadata.dirtyReasons.push("scope-change")
          }
        }
      }
      for (const scopeId of Object.keys(root.pi.piResourceStaticCatalogs)) {
        if (!liveScopeIds.has(scopeId)) {
          delete root.pi.piResourceStaticCatalogs[scopeId]
        }
      }
    })
  }
}

async function buildStaticCatalog(args: {
  scope: AppScope
  zenbuExtensions: Schema["extensions"]
}): Promise<{
  observations: ResourceObservation[]
  entries: StaticCatalogEntry[]
  packages: Schema["piResourceStaticCatalogs"][string]["packages"]
  diagnostics: Schema["piResourceStaticCatalogs"][string]["diagnostics"]
  inputHash: string
  activationHash: string
  staticCatalogHash: string
}> {
  const agentDir = getAgentDir()
  const settingsManager = SettingsManager.create(args.scope.directory, agentDir)
  const packageManager = new DefaultPackageManager({
    cwd: args.scope.directory,
    agentDir,
    settingsManager,
  })
  const resolved = await packageManager.resolve(async () => "skip")
  const configuredPackages = packageManager.listConfiguredPackages()

  const observations: ResourceObservation[] = []
  const rawEntries: Array<{
    observation: ResourceObservation
    enabled: boolean
    order: number
    missing: boolean
  }> = []

  let order = 0
  for (const extension of Object.values(args.zenbuExtensions)) {
    const observation = observeZenbuExtension(extension)
    observations.push(observation)
    rawEntries.push({
      observation,
      enabled: extension.enabled,
      order: order++,
      missing: !fs.existsSync(extension.path),
    })
  }

  for (const key of STATIC_RESOURCE_KEYS) {
    const resourceType = resourceTypeFromResolvedKey(key)
    for (const resource of resolved[key]) {
      const sourceInfo = normalizeSourceInfo(resource.metadata, resource.path)
      const observation = observeResource({
        resourceType,
        path: resource.path,
        sourceInfo,
        label: path.basename(resource.path),
      })
      observations.push(observation)
      rawEntries.push({
        observation,
        enabled: resource.enabled,
        order: order++,
        missing: !fs.existsSync(resource.path),
      })
    }
  }

  const entries = applyActivationStates(rawEntries)
  const packages = configuredPackages.map(pkg => ({
    source: pkg.source,
    scope: pkg.scope,
    filtered: pkg.filtered,
    installedPath: pkg.installedPath ?? null,
    status: pkg.installedPath ? "installed" as const : "missing" as const,
  }))
  const diagnostics = buildStaticDiagnostics(resolved)
  const inputHash = hashJson({
    resolverVersion: RESOLVER_VERSION,
    cwd: args.scope.directory,
    settings: {
      global: pickResourceSettings(settingsManager.getGlobalSettings()),
      project: pickResourceSettings(settingsManager.getProjectSettings()),
    },
    zenbuExtensions: Object.values(args.zenbuExtensions)
      .map(extension => ({
        id: extension.id,
        path: normalizePath(extension.path),
        enabled: extension.enabled,
        source: extension.source,
        pluginName: extension.pluginName,
        label: extension.label,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  })
  const activationHash = hashJson(
    entries
      .filter(entry => entry.enabled && entry.activationState === "active")
      .map(entry => ({
        resourceId: entry.resourceId,
        resourceType: entry.resourceType,
        order: entry.order,
        sourceInfo: entry.sourceInfo,
      })),
  )
  const staticCatalogHash = hashJson({ entries, packages, diagnostics })

  return {
    observations,
    entries,
    packages,
    diagnostics,
    inputHash,
    activationHash,
    staticCatalogHash,
  }
}

function buildRuntimeCapabilities(args: {
  pi: AgentSession
  extensionResult: RuntimeExtensionResult
  resourceIdByTypeAndCanonical: Map<string, string>
}): RuntimeCapabilities {
  const commands = readPiRuntimeCommands(args.pi).map((command, index) => {
    const normalized = normalizeOptionalSourceInfo(command.sourceInfo)
    return {
      id: `command:${command.source}:${command.name}:${index}`,
      name: command.name,
      description: command.description,
      source: command.source,
      resourceId: normalized
        ? findResourceIdForSource({
            sourceInfo: normalized,
            preferredType: commandResourceType(command.source),
            resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
          })
        : null,
      sourceInfo: normalized,
    }
  })

  const activeToolNames = new Set(args.pi.getActiveToolNames())
  const tools = args.pi.getAllTools().map((tool: ToolInfo, index) => {
    const normalized = normalizeOptionalSourceInfo(tool.sourceInfo)
    return {
      id: `tool:${tool.name}:${index}`,
      name: tool.name,
      description: tool.description,
      active: activeToolNames.has(tool.name),
      resourceId: normalized
        ? findResourceIdForSource({
            sourceInfo: normalized,
            preferredType: "extension",
            resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
          })
        : null,
      sourceInfo: normalized,
      promptGuidelines: tool.promptGuidelines ?? [],
    }
  })

  const flagValues = args.extensionResult.runtime.flagValues
  const flags = collectExtensionMapItems<ExtensionFlag>(
    args.extensionResult.extensions,
    "flags",
  ).map(({ extension, item }, index) => {
    const sourceInfo = normalizeSourceInfo(extension.sourceInfo, extension.resolvedPath || extension.path)
    return {
      id: `flag:${item.name}:${index}`,
      name: item.name,
      description: item.description,
      type: item.type,
      default: item.default,
      value: flagValues.get(item.name),
      resourceId: findResourceIdForSource({
        sourceInfo,
        preferredType: "extension",
        resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
      }),
      sourceInfo,
    }
  })

  const shortcuts = collectExtensionMapItems<ExtensionShortcut>(
    args.extensionResult.extensions,
    "shortcuts",
  ).map(({ extension, item }, index) => {
    const sourceInfo = normalizeSourceInfo(extension.sourceInfo, extension.resolvedPath || extension.path)
    return {
      id: `shortcut:${String(item.shortcut)}:${index}`,
      shortcut: String(item.shortcut),
      description: item.description,
      resourceId: findResourceIdForSource({
        sourceInfo,
        preferredType: "extension",
        resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
      }),
      sourceInfo,
    }
  })

  return { commands, tools, flags, shortcuts }
}

function buildRuntimeErrors(args: {
  extensionResult: RuntimeExtensionResult
  skillDiagnostics: Array<{ message?: string; path?: string } | unknown>
  promptDiagnostics: Array<{ message?: string; path?: string } | unknown>
  themeDiagnostics: Array<{ message?: string; path?: string } | unknown>
  resourceIdByTypeAndCanonical: Map<string, string>
}): RuntimeError[] {
  const errors: RuntimeError[] = []
  for (const err of args.extensionResult.errors) {
    const pathValue = err.path
    errors.push({
      path: pathValue,
      error: err.error,
      resourceId: findResourceIdForPath({
        path: pathValue,
        preferredType: "extension",
        resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
      }),
    })
  }
  for (const diagnostic of [
    ...args.skillDiagnostics,
    ...args.promptDiagnostics,
    ...args.themeDiagnostics,
  ]) {
    const d = diagnostic as { message?: string; path?: string }
    if (!d.message) continue
    const pathValue = d.path ?? ""
    errors.push({
      path: pathValue,
      error: d.message,
      resourceId: pathValue
        ? findResourceIdForPath({
            path: pathValue,
            resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
          })
        : null,
    })
  }
  return errors
}

function collectExtensionMapItems<T>(
  extensions: Extension[],
  key: "flags" | "shortcuts",
): Array<{ extension: Extension; item: T }> {
  const result: Array<{ extension: Extension; item: T }> = []
  for (const extension of extensions) {
    const map = extension[key] as Map<unknown, T>
    for (const item of map.values()) result.push({ extension, item })
  }
  return result
}

function buildStaticDiagnostics(
  _resolved: ResolvedPaths,
): Schema["piResourceStaticCatalogs"][string]["diagnostics"] {
  // Pi's passive resolver does not currently expose collision diagnostics for
  // paths it suppresses internally. Keep the field in the model so UI and later
  // resolver APIs have a stable place to report them.
  return []
}

function observeZenbuExtension(extension: ZenbuExtensionRecord): ResourceObservation {
  const sourceInfo: SourceInfoShape = {
    path: extension.path,
    source: extension.source,
    scope: "temporary",
    origin: "top-level",
    baseDir: path.dirname(extension.path),
  }
  return observeResource({
    resourceType: "extension",
    path: extension.path,
    sourceInfo,
    label: extension.label ?? extensionLabel(extension.path),
  })
}

function observeResource(args: {
  resourceType: ResourceType
  path: string
  sourceInfo: SourceInfoShape
  label: string | null
}): ResourceObservation {
  const canonicalPath = canonicalizePath(args.path)
  return {
    resourceId: resourceId(args.resourceType, canonicalPath),
    resourceType: args.resourceType,
    canonicalPath,
    label: args.label,
    tier: tierFromSourceInfo(args.sourceInfo),
    sourceInfo: args.sourceInfo,
  }
}

function upsertDefinitions(
  definitions: Schema["piResourceDefinitions"],
  observations: ResourceObservation[],
  now: number,
  discovery: ResourceDiscovery,
) {
  const uniqueObservations = new Map<string, ResourceObservation>()
  for (const observation of observations) {
    uniqueObservations.set(observation.resourceId, observation)
  }

  for (const observation of uniqueObservations.values()) {
    const existing = definitions[observation.resourceId]
    if (existing) {
      const nextDiscovery = mergeDiscovery(existing.discovery, discovery)
      if (existing.discovery !== nextDiscovery) existing.discovery = nextDiscovery
      const nextLabel = observation.label ?? existing.label
      if (existing.label !== nextLabel) existing.label = nextLabel
      // `lastSeenAt` is informational. Writing it on every static/runtime
      // observation turns otherwise-idempotent catalog refreshes into hundreds
      // of replica updates, which can starve chat rendering while an agent is
      // active. Throttle the timestamp so real resource facts still update
      // immediately while repeated scans stay cheap.
      if (now - existing.lastSeenAt >= RESOURCE_LAST_SEEN_WRITE_INTERVAL_MS) {
        existing.lastSeenAt = now
      }
      continue
    }
    definitions[observation.resourceId] = {
      id: observation.resourceId,
      resourceType: observation.resourceType,
      discovery,
      canonicalPath: observation.canonicalPath,
      label: observation.label,
      firstSeenAt: now,
      lastSeenAt: now,
    } satisfies ResourceDefinition
  }
}

function mergeDiscovery(
  existing: ResourceDiscovery | undefined,
  next: ResourceDiscovery,
): ResourceDiscovery {
  if (!existing || existing === next) return next
  if (existing === "both" || next === "both") return "both"
  return "both"
}

function emptyStaticCatalog(args: {
  scopeId: string
  workspaceId: string | null
  directory: string
}): Schema["piResourceStaticCatalogs"][string] {
  return {
    scopeId: args.scopeId,
    workspaceId: args.workspaceId,
    directory: args.directory,
    metadata: {
      status: "idle",
      requestedAt: null,
      resolvedAt: null,
      markedDirtyAt: null,
      dirtyReasons: [],
      inputHash: null,
      activationHash: null,
      staticCatalogHash: null,
      resolverVersion: RESOLVER_VERSION,
      error: null,
    },
    entries: [],
    packages: [],
    diagnostics: [],
  }
}

function readPiRuntimeCommands(pi: AgentSession): SlashCommandInfo[] {
  const candidate = pi as unknown as {
    getCommands?: () => SlashCommandInfo[]
    _extensionRunner?: {
      runtime?: { getCommands?: () => SlashCommandInfo[] }
    }
  }
  if (typeof candidate.getCommands === "function") return candidate.getCommands()
  const getCommands = candidate._extensionRunner?.runtime?.getCommands
  if (typeof getCommands !== "function") return []
  return getCommands()
}

function normalizeOptionalSourceInfo(value: unknown): SourceInfoShape | null {
  const maybe = value as Partial<SourceInfo> | undefined
  const fallbackPath = typeof maybe?.path === "string" ? maybe.path : ""
  if (!fallbackPath) return null
  return normalizeSourceInfo(value, fallbackPath)
}

function normalizeSourceInfo(value: unknown, fallbackPath: string): SourceInfoShape {
  const maybe = value as Partial<SourceInfo> | undefined
  const scope =
    maybe?.scope === "user" ||
    maybe?.scope === "project" ||
    maybe?.scope === "temporary"
      ? maybe.scope
      : "temporary"
  const origin = maybe?.origin === "package" ? "package" : "top-level"
  const source = typeof maybe?.source === "string" ? maybe.source : "unknown"
  const pathValue = typeof maybe?.path === "string" ? maybe.path : fallbackPath
  const baseDir = typeof maybe?.baseDir === "string" ? maybe.baseDir : undefined
  return baseDir
    ? { path: pathValue, source, scope, origin, baseDir }
    : { path: pathValue, source, scope, origin }
}

function commandResourceType(source: SlashCommandInfo["source"]): ResourceType {
  if (source === "prompt") return "prompt"
  if (source === "skill") return "skill"
  return "extension"
}

function resourceTypeFromResolvedKey(key: StaticResourceKey): ResourceType {
  switch (key) {
    case "extensions":
      return "extension"
    case "skills":
      return "skill"
    case "prompts":
      return "prompt"
    case "themes":
      return "theme"
  }
}

function findResourceIdForSource(args: {
  sourceInfo: SourceInfoShape
  preferredType?: ResourceType
  resourceIdByTypeAndCanonical: Map<string, string>
}): string | null {
  return findResourceIdForPath({
    path: args.sourceInfo.path,
    preferredType: args.preferredType,
    resourceIdByTypeAndCanonical: args.resourceIdByTypeAndCanonical,
  })
}

function findResourceIdForPath(args: {
  path: string
  preferredType?: ResourceType
  resourceIdByTypeAndCanonical: Map<string, string>
}): string | null {
  const canonicalPath = canonicalizePath(args.path)
  if (args.preferredType) {
    const direct = args.resourceIdByTypeAndCanonical.get(
      resourceLookupKey(args.preferredType, canonicalPath),
    )
    if (direct) return direct
  }
  for (const resourceType of RESOURCE_TYPES) {
    const found = args.resourceIdByTypeAndCanonical.get(
      resourceLookupKey(resourceType, canonicalPath),
    )
    if (found) return found
  }
  return null
}

function canonicalizePath(input: string): string {
  const resolved = normalizePath(input)
  try {
    return fs.realpathSync.native(resolved)
  } catch {
    return resolved
  }
}

function normalizePath(input: string): string {
  return path.resolve(input.replace(/^~(?=$|\/|\\)/, osHome()))
}

type WatchTarget = {
  path: string
  options?: { childNames?: Set<string>; reason?: string }
}

function globalWatchTargets(): WatchTarget[] {
  const agentDir = getAgentDir()
  const homeAgentsDir = path.join(os.homedir(), ".agents")
  return [
    // Watch the broad Pi config roots only as filtered parent directories.
    // The agent dir also contains hot files such as run-history/session logs;
    // reacting to every write there creates a refresh loop that floods the DB
    // replica and can starve the chat composer.
    { path: agentDir, options: { childNames: PI_RESOURCE_WATCH_NAMES } },
    { path: path.join(agentDir, "settings.json") },
    { path: path.join(agentDir, "extensions") },
    { path: path.join(agentDir, "skills") },
    { path: path.join(agentDir, "prompts") },
    { path: path.join(agentDir, "themes") },
    { path: path.join(agentDir, "npm") },
    { path: path.join(agentDir, "git") },
    { path: homeAgentsDir, options: { childNames: new Set(["skills"]) } },
    { path: path.join(homeAgentsDir, "skills") },
  ]
}

function projectWatchTargets(directory: string): WatchTarget[] {
  const piDir = path.join(directory, ".pi")
  const agentsDir = path.join(directory, ".agents")
  return [
    { path: piDir, options: { childNames: PI_RESOURCE_WATCH_NAMES } },
    { path: path.join(piDir, "settings.json") },
    { path: path.join(piDir, "extensions") },
    { path: path.join(piDir, "skills") },
    { path: path.join(piDir, "prompts") },
    { path: path.join(piDir, "themes") },
    { path: path.join(piDir, "npm") },
    { path: path.join(piDir, "git") },
    { path: agentsDir, options: { childNames: new Set(["skills"]) } },
    { path: path.join(agentsDir, "skills") },
  ]
}

function watchedChildMatches(
  filename: string | Buffer | null,
  childNames: Set<string>,
): boolean {
  if (filename == null) return true
  return childNames.has(path.basename(filename.toString()))
}

function selectedWindowScopesKey(root: {
  app?: { windowStates?: Record<string, { selectedScopeId?: string | null }> }
}): string {
  return Object.values(root.app?.windowStates ?? {})
    .map(ws => ws?.selectedScopeId ?? "")
    .sort()
    .join("\0")
}

function osHome(): string {
  return process.env.HOME || process.env.USERPROFILE || ""
}

function extensionLabel(filePath: string): string {
  return path.basename(filePath).replace(/\.[cm]?[tj]sx?$/, "")
}

function pickResourceSettings(settings: {
  packages?: unknown
  extensions?: unknown
  skills?: unknown
  prompts?: unknown
  themes?: unknown
}) {
  return {
    packages: settings.packages ?? [],
    extensions: settings.extensions ?? [],
    skills: settings.skills ?? [],
    prompts: settings.prompts ?? [],
    themes: settings.themes ?? [],
  }
}

function maybeSubscribe(
  ref: { subscribe?: (fn: () => void) => () => void } | undefined,
  fn: () => void,
): (() => void) | undefined {
  if (!ref || typeof ref.subscribe !== "function") return undefined
  return ref.subscribe(fn)
}
