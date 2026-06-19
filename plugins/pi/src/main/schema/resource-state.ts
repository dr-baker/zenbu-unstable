import { z } from "@zenbujs/core/db"

export const piResourceType = z.enum(["extension", "skill", "prompt", "theme"])

export const piResourceDiscovery = z.enum([
  "staticCatalog",
  "runtime",
  "both",
])

export const piResourceTier = z.enum([
  "zenbu-built-in",
  "zenbu-plugin",
  "pi-project",
  "pi-user",
  "pi-package",
  "pi-temporary",
  "unknown",
])

export const piResourceSourceInfo = z.object({
  path: z.string(),
  source: z.string(),
  scope: z.enum(["user", "project", "temporary"]),
  origin: z.enum(["package", "top-level"]),
  baseDir: z.string().optional(),
})

export const piResourceDefinition = z.object({
  id: z.string(),
  resourceType: piResourceType,
  /** Whether this artifact has been observed by non-executing catalog
   * discovery, live runtime snapshots, or both. Source-specific facts live on
   * static catalog/runtime snapshot entries because the same artifact can be
   * observed through different scopes or source tiers over time. */
  discovery: piResourceDiscovery.default("staticCatalog"),
  canonicalPath: z.string(),
  label: z.string().nullable().default(null),
  firstSeenAt: z.number(),
  lastSeenAt: z.number(),
})

export const piStaticCatalogEntry = z.object({
  resourceId: z.string(),
  resourceType: piResourceType,
  enabled: z.boolean(),
  activationState: z.enum(["active", "disabled", "suppressed", "missing"]),
  order: z.number(),
  tier: piResourceTier,
  sourceInfo: piResourceSourceInfo,
  suppressedByResourceId: z.string().nullable().default(null),
})

export const piStaticCatalogPackage = z.object({
  source: z.string(),
  scope: z.enum(["user", "project"]),
  filtered: z.boolean(),
  installedPath: z.string().nullable().default(null),
  status: z.enum(["installed", "missing"]),
})

export const piResourceDiagnostic = z.object({
  type: z.enum(["warning", "error", "collision"]),
  message: z.string(),
  path: z.string().optional(),
})

export const piStaticCatalogMetadata = z.object({
  status: z.enum(["idle", "resolving", "dirty", "error"]).default("idle"),
  requestedAt: z.number().nullable().default(null),
  resolvedAt: z.number().nullable().default(null),
  markedDirtyAt: z.number().nullable().default(null),
  dirtyReasons: z.array(z.string()).default([]),
  inputHash: z.string().nullable().default(null),
  activationHash: z.string().nullable().default(null),
  staticCatalogHash: z.string().nullable().default(null),
  resolverVersion: z.string(),
  error: z.string().nullable().default(null),
})

export const piResourceStaticCatalog = z.object({
  scopeId: z.string(),
  workspaceId: z.string().nullable().default(null),
  directory: z.string(),
  metadata: piStaticCatalogMetadata,
  entries: z.array(piStaticCatalogEntry).default([]),
  packages: z.array(piStaticCatalogPackage).default([]),
  diagnostics: z.array(piResourceDiagnostic).default([]),
})

export const piRuntimeResourceEntry = z.object({
  resourceId: z.string(),
  resourceType: piResourceType,
  discovery: piResourceDiscovery,
  loaded: z.boolean(),
  order: z.number(),
  tier: piResourceTier,
  sourceInfo: piResourceSourceInfo,
})

const runtimeCommandSource = z.enum(["extension", "prompt", "skill"])

export const piRuntimeCommandCapability = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  source: runtimeCommandSource,
  resourceId: z.string().nullable().default(null),
  sourceInfo: piResourceSourceInfo.nullable().default(null),
})

export const piRuntimeToolCapability = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  active: z.boolean(),
  resourceId: z.string().nullable().default(null),
  sourceInfo: piResourceSourceInfo.nullable().default(null),
  promptGuidelines: z.array(z.string()).default([]),
})

export const piRuntimeFlagCapability = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  type: z.enum(["boolean", "string"]),
  default: z.union([z.boolean(), z.string()]).optional(),
  value: z.union([z.boolean(), z.string()]).optional(),
  resourceId: z.string().nullable().default(null),
  sourceInfo: piResourceSourceInfo.nullable().default(null),
})

export const piRuntimeShortcutCapability = z.object({
  id: z.string(),
  shortcut: z.string(),
  description: z.string().optional(),
  resourceId: z.string().nullable().default(null),
  sourceInfo: piResourceSourceInfo.nullable().default(null),
})

export const piRuntimeSnapshotCapabilities = z.object({
  commands: z.array(piRuntimeCommandCapability).default([]),
  tools: z.array(piRuntimeToolCapability).default([]),
  flags: z.array(piRuntimeFlagCapability).default([]),
  shortcuts: z.array(piRuntimeShortcutCapability).default([]),
})

export const piRuntimeSnapshotError = z.object({
  path: z.string(),
  error: z.string(),
  resourceId: z.string().nullable().default(null),
})

export const piSessionRuntimeSnapshot = z.object({
  sessionId: z.string(),
  scopeId: z.string(),
  workspaceId: z.string().nullable().default(null),
  directory: z.string(),
  active: z.boolean(),
  capturedAt: z.number(),
  disposedAt: z.number().nullable().default(null),
  activationHashAtLoad: z.string().nullable().default(null),
  staticCatalogHashAtLoad: z.string().nullable().default(null),
  resources: z.array(piRuntimeResourceEntry).default([]),
  capabilities: piRuntimeSnapshotCapabilities,
  errors: z.array(piRuntimeSnapshotError).default([]),
  capabilityHash: z.string(),
  systemPromptHash: z.string().nullable().default(null),
})

export const piResourceRegistrySettings = z.object({
  maxPreloadedStaticCatalogScopes: z.number().default(10),
})
