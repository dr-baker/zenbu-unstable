import crypto from "node:crypto"

export const RESOURCE_TYPES = ["extension", "skill", "prompt", "theme"] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export type ResourceTier =
  | "zenbu-built-in"
  | "zenbu-plugin"
  | "pi-project"
  | "pi-user"
  | "pi-package"
  | "pi-temporary"
  | "unknown"

export type SourceInfoShape = {
  path: string
  source: string
  scope: "user" | "project" | "temporary"
  origin: "package" | "top-level"
  baseDir?: string
}

export type ResourceObservation = {
  resourceId: string
  resourceType: ResourceType
  canonicalPath: string
  label: string | null
  tier: ResourceTier
  sourceInfo: SourceInfoShape
}

export type StaticCatalogEntryShape = {
  resourceId: string
  resourceType: ResourceType
  enabled: boolean
  activationState: "active" | "disabled" | "suppressed" | "missing"
  order: number
  tier: ResourceTier
  sourceInfo: SourceInfoShape
  suppressedByResourceId: string | null
}

export type ScopePreloadInput = {
  id: string
  archived: boolean
  pinnedAt: number | null
  createdAt: number
}

export type WindowStatePreloadInput = {
  selectedScopeId?: string | null
}

export type SessionStaleness = {
  stale: boolean
  reason: string | null
}

export function applyActivationStates(
  rawEntries: Array<{
    observation: ResourceObservation
    enabled: boolean
    order: number
    missing: boolean
  }>,
): StaticCatalogEntryShape[] {
  const firstActiveByKey = new Map<string, string>()
  const entries: StaticCatalogEntryShape[] = []
  for (const raw of rawEntries) {
    const key = resourceLookupKey(
      raw.observation.resourceType,
      raw.observation.canonicalPath,
    )
    const existingActive = firstActiveByKey.get(key)
    let activationState: StaticCatalogEntryShape["activationState"] = "active"
    let suppressedByResourceId: string | null = null
    if (raw.missing) {
      activationState = "missing"
    } else if (!raw.enabled) {
      activationState = "disabled"
    } else if (existingActive) {
      activationState = "suppressed"
      suppressedByResourceId = existingActive
    } else {
      firstActiveByKey.set(key, raw.observation.resourceId)
    }
    entries.push({
      resourceId: raw.observation.resourceId,
      resourceType: raw.observation.resourceType,
      enabled: raw.enabled,
      activationState,
      order: raw.order,
      tier: raw.observation.tier,
      sourceInfo: raw.observation.sourceInfo,
      suppressedByResourceId,
    })
  }
  return entries
}

export function deriveSessionStaleness(args: {
  activationHashAtLoad: string | null | undefined
  currentActivationHash: string | null | undefined
}): SessionStaleness {
  const { activationHashAtLoad, currentActivationHash } = args
  if (!activationHashAtLoad || !currentActivationHash) {
    return { stale: false, reason: null }
  }
  if (activationHashAtLoad !== currentActivationHash) {
    return { stale: true, reason: "static catalog activation changed" }
  }
  return { stale: false, reason: null }
}

export function selectPreloadScopeIds(args: {
  scopes: ScopePreloadInput[]
  windowStates: WindowStatePreloadInput[]
  max: number
}): string[] {
  const max = Math.max(0, args.max)
  const selected: string[] = []
  const seen = new Set<string>()

  const add = (scopeId: string | null | undefined) => {
    if (!scopeId || seen.has(scopeId) || selected.length >= max) return
    const scope = args.scopes.find(entry => entry.id === scopeId)
    if (!scope || scope.archived) return
    seen.add(scopeId)
    selected.push(scopeId)
  }

  for (const ws of args.windowStates) add(ws.selectedScopeId)

  const ranked = [...args.scopes]
    .filter(scope => !scope.archived)
    .sort((a, b) => {
      const pinnedDelta = (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)
      if (pinnedDelta !== 0) return pinnedDelta
      return b.createdAt - a.createdAt
    })

  for (const scope of ranked) {
    if (selected.length >= max) break
    add(scope.id)
  }

  return selected
}

export function tierFromSourceInfo(sourceInfo: SourceInfoShape): ResourceTier {
  if (sourceInfo.source === "built-in") return "zenbu-built-in"
  if (sourceInfo.source === "plugin") return "zenbu-plugin"
  if (sourceInfo.origin === "package") return "pi-package"
  if (sourceInfo.scope === "project") return "pi-project"
  if (sourceInfo.scope === "user") return "pi-user"
  if (sourceInfo.scope === "temporary") return "pi-temporary"
  return "unknown"
}

export function resourceId(resourceType: ResourceType, canonicalPath: string): string {
  return `pires_${resourceType}_${hashString(canonicalPath).slice(0, 24)}`
}

export function resourceLookupKey(
  resourceType: ResourceType,
  canonicalPath: string,
): string {
  return `${resourceType}\0${canonicalPath}`
}

export function hashJson(value: unknown): string {
  return hashString(stableStringify(value))
}

export function hashString(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex")
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
  return `{${entries
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(",")}}`
}
