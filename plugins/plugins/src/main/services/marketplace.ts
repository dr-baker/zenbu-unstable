import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Service } from "@zenbujs/core/runtime"
import {
  DbService,
  PluginManagerService,
  RpcService,
} from "@zenbujs/core/services"

const SIDEBAR_NAME = "marketplace"
const DETAIL_NAME = "plugin-detail"
const MARKETPLACE_API_BASE = process.env.ZENBU_MARKETPLACE_URL || "https://zenbu-app.vercel.app"
const PLUGINS_HOME = path.join(os.homedir(), ".zenbu", "plugins")
const FEED_REFRESH_MS = 5 * 60 * 1000

export type MarketplaceListing = {
  id: string
  name: string
  description: string
  version: string | null
  author: string
  tags: string[]
  downloadCount: number
  reviewStatus: string
  minHostVersion: string | null
  updatedAt: string
  // Only returned by the detail endpoint (/plugins/:id), so it's
  // optional/nullable everywhere else.
  readme: string | null
}

type MarketplaceListResponse = {
  plugins: MarketplaceListing[]
}

type MarketplacePluginResponse = {
  plugin: MarketplaceListing
}

type MarketplaceDownloadResponse = {
  plugin: MarketplaceListing
  source: {
    type: "code-storage"
    remoteUrl: string
    ref?: string
    commitSha: string
  }
}

type PackageMeta = {
  version: string | null
  description: string | null
  author: string | null
}

type PluginInstallerService = {
  install(args: {
    url: string
    name?: string
    commitSha?: string
    ref?: string
  }): Promise<{ ok: true; name: string; path: string }>
}

export class MarketplaceService extends Service.create({
  key: "marketplace",
  deps: {
    rpc: RpcService,
    pluginInstaller: "pluginInstaller",
    pluginManager: PluginManagerService,
    db: DbService,
  },
}) {
  evaluate() {
    this.setup("inject-sidebar-view", () =>
      this.inject({
        name: SIDEBAR_NAME,
        modulePath: "./src/views/marketplace-sidebar-view.tsx",
        meta: {
          kind: "left-sidebar",
          label: "Plugins",
          order: 30,
          shortcut: { mod: true, shift: true, key: "x" },
        },
      }),
    )

    this.setup("inject-detail-view", () =>
      this.inject({
        name: DETAIL_NAME,
        modulePath: "./src/views/plugin-detail-view.tsx",
        meta: { kind: "embed", label: "Plugin" },
      }),
    )

    // Keep the browse feed warm: refresh on a background interval and
    // whenever the marketplace is enabled. The sidebar reads the feed
    // collection straight from the local replica, so this is what
    // makes navigating back instant (no per-mount refetch).
    this.setup("feed-refresh", () => {
      let stopped = false
      const refresh = () => {
        if (stopped) return
        void this.refreshFeed().catch(err =>
          console.error("[marketplace] feed refresh failed:", err),
        )
      }
      refresh()
      const timer = setInterval(refresh, FEED_REFRESH_MS)
      // Refresh as soon as the marketplace is turned on.
      let wasEnabled = this.ctx.db.client.readRoot().plugins.enabled
      const off = this.ctx.db.client.plugins.enabled.subscribe(
        (enabled: boolean) => {
          if (enabled && !wasEnabled) refresh()
          wasEnabled = enabled
        },
      )
      return () => {
        stopped = true
        clearInterval(timer)
        off()
      }
    })
  }

  /**
   * Fetch the browse list and swap it into the `feed` collection.
   * Rotate-and-swap: populate a fresh collection, then point the
   * schema ref at it in one update, so readers jump straight from the
   * old full list to the new one with no empty window. No-op while the
   * marketplace is disabled.
   */
  private async refreshFeed(): Promise<void> {
    if (!this.ctx.db.client.readRoot().plugins.enabled) return
    const { plugins } = await this.listMarketplace({})
    const prevRef =
      this.ctx.db.client.readRoot().plugins.feed ?? null
    const newRef = {
      collectionId: randomUUID(),
      debugName: "marketplace-feed",
    }
    await this.ctx.db.client.update(root => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      root.plugins.feed = newRef as any
    })
    await this.ctx.db.client.plugins.feed.concat(plugins)
    if (prevRef && prevRef.collectionId !== newRef.collectionId) {
      await removeCollectionDir(this.ctx.db.dbPath, prevRef.collectionId)
    }
  }

  async openDetailInPane(args: { pluginId: string }): Promise<{ ok: true }> {
    this.ctx.rpc.emit.app.openViewInActivePane({
      viewType: DETAIL_NAME,
      source: "marketplace",
      args: { pluginId: args.pluginId },
      placement: "tab",
    })
    return { ok: true }
  }

  async listMarketplace(args: {
    query?: string
    tag?: string
  } = {}): Promise<MarketplaceListResponse> {
    const url = marketplaceUrl("/plugins")
    const query = args.query?.trim()
    const tag = args.tag?.trim()
    if (query) url.searchParams.set("q", query)
    if (tag) url.searchParams.set("tag", tag)
    const body = await fetchJson(url, "Failed to load marketplace plugins")
    const parsed = parseMarketplaceListResponse(body)
    // Warm the cache so opening any of these plugins is instant.
    await this.cacheListings(parsed.plugins)
    return parsed
  }

  async getMarketplacePlugin(args: {
    id: string
  }): Promise<{ plugin: MarketplaceListing | null }> {
    // A missing plugin is a normal outcome (stale pane, unpublished,
    // renamed), not an error — return null instead of throwing so it
    // doesn't surface as a failed RPC.
    const res = await fetch(
      marketplaceUrl(`/plugins/${encodeURIComponent(args.id)}`),
    )
    if (res.status === 404) return { plugin: null }
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const error = readErrorMessage(body)
      throw new Error(
        error
          ? `Failed to load marketplace plugin "${args.id}": ${error}`
          : `Failed to load marketplace plugin "${args.id}"`,
      )
    }
    const parsed = parseMarketplacePluginResponse(body)
    await this.cacheListings([parsed.plugin])
    return parsed
  }

  /** Upsert listings into the replicated `catalog` cache. */
  private async cacheListings(
    listings: MarketplaceListing[],
  ): Promise<void> {
    if (listings.length === 0) return
    await this.ctx.db.client.update(root => {
      if (!root.plugins.catalog) root.plugins.catalog = {}
      for (const listing of listings) {
        root.plugins.catalog[listing.id] = listing
      }
    })
  }

  async setPluginEnabled(args: {
    pluginFile: string
    enabled: boolean
  }): Promise<{ ok: true }> {
    await this.ctx.pluginManager.setEnabled({
      path: args.pluginFile,
      enabled: args.enabled,
    })
    return { ok: true }
  }

  async deleteInstalledPlugin(args: {
    pluginFile: string
    directory: string
  }): Promise<{ ok: true }> {
    const pluginFile = path.resolve(args.pluginFile)
    const directory = path.resolve(args.directory)
    if (path.dirname(pluginFile) !== directory) {
      throw new Error("Plugin file must be inside the plugin directory.")
    }
    if (!isInsideDirectory(directory, PLUGINS_HOME)) {
      throw new Error("Only marketplace-installed plugins can be deleted.")
    }
    await this.ctx.pluginManager.removePlugin({ path: pluginFile })
    await fs.rm(directory, { recursive: true, force: true })
    return { ok: true }
  }

  async installMarketplacePlugin(args: { id: string }): Promise<{
    ok: true
    name: string
    path: string
    plugin: MarketplaceListing
  }> {
    const body = await fetchJson(
      marketplaceUrl(`/plugins/${encodeURIComponent(args.id)}/download`),
      `Failed to download marketplace plugin "${args.id}"`,
    )
    const download = parseMarketplaceDownloadResponse(body)
    const installer = this.ctx.pluginInstaller as PluginInstallerService
    const installed = await installer.install({
      url: download.source.remoteUrl,
      name: download.plugin.id,
      commitSha: download.source.commitSha,
      ref: download.source.ref,
    })
    // Cache the listing (keyed by id == install dir basename) so the
    // installed row can keep showing the marketplace-only fields
    // (downloads/tags) that no config file carries.
    await this.cacheListings([download.plugin])
    return { ...installed, plugin: download.plugin }
  }

  async readPluginDetail(args: { directory: string }): Promise<{
    readme: string | null
    pkg: PackageMeta | null
  }> {
    const readme = await readOptional(
      path.join(args.directory, "README.md"),
    )
    const pkgRaw = await readOptional(
      path.join(args.directory, "package.json"),
    )
    return { readme, pkg: parsePackageMeta(pkgRaw) }
  }

}

// Drop a rotated-out collection's on-disk data. Best-effort.
async function removeCollectionDir(
  dbPath: string,
  collectionId: string,
): Promise<void> {
  if (!collectionId) return
  await fs
    .rm(path.join(dbPath, "collections", collectionId), {
      recursive: true,
      force: true,
    })
    .catch(() => {})
}

function marketplaceUrl(pathname: string): URL {
  const base = MARKETPLACE_API_BASE.endsWith("/")
    ? MARKETPLACE_API_BASE.slice(0, -1)
    : MARKETPLACE_API_BASE
  return new URL(`${base}${pathname}`)
}

async function fetchJson(url: URL, message: string): Promise<unknown> {
  const res = await fetch(url)
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const error = readErrorMessage(body)
    throw new Error(error ? `${message}: ${error}` : message)
  }
  return body
}

function readErrorMessage(value: unknown): string | null {
  if (!isRecord(value)) return null
  return typeof value.error === "string" ? value.error : null
}

function parseMarketplaceListResponse(
  value: unknown,
): MarketplaceListResponse {
  if (!isRecord(value) || !Array.isArray(value.plugins)) {
    throw new Error("Marketplace plugins response was invalid")
  }
  return { plugins: value.plugins.map(parseMarketplaceListing) }
}

function parseMarketplacePluginResponse(
  value: unknown,
): MarketplacePluginResponse {
  if (!isRecord(value)) {
    throw new Error("Marketplace plugin response was invalid")
  }
  return { plugin: parseMarketplaceListing(value.plugin) }
}

function parseMarketplaceDownloadResponse(
  value: unknown,
): MarketplaceDownloadResponse {
  if (!isRecord(value) || !isRecord(value.source)) {
    throw new Error("Marketplace download response was invalid")
  }
  const plugin = parseMarketplaceListing(value.plugin)
  const { type, remoteUrl, ref, commitSha } = value.source
  if (
    type !== "code-storage" ||
    typeof remoteUrl !== "string" ||
    typeof commitSha !== "string" ||
    (ref !== undefined && typeof ref !== "string")
  ) {
    throw new Error("Marketplace download source was invalid")
  }
  return { plugin, source: { type, remoteUrl, ref, commitSha } }
}

function parseMarketplaceListing(value: unknown): MarketplaceListing {
  if (!isRecord(value)) {
    throw new Error("Marketplace plugin record was invalid")
  }
  const tags = value.tags
  if (!Array.isArray(tags) || !tags.every(tag => typeof tag === "string")) {
    throw new Error("Marketplace plugin tags were invalid")
  }
  const listing = {
    id: requireString(value.id, "id"),
    name: requireString(value.name, "name"),
    description: requireString(value.description, "description"),
    version: requireNullableString(value.version, "version"),
    author: requireString(value.author, "author"),
    tags,
    downloadCount: requireNumber(value.downloadCount, "downloadCount"),
    reviewStatus: requireString(value.reviewStatus, "reviewStatus"),
    minHostVersion: requireNullableString(
      value.minHostVersion,
      "minHostVersion",
    ),
    updatedAt: requireString(value.updatedAt, "updatedAt"),
    // Absent on list responses; present (string|null) on detail.
    readme: typeof value.readme === "string" ? value.readme : null,
  }
  return listing
}

function isInsideDirectory(child: string, parent: string): boolean {
  const relative = path.relative(parent, child)
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Marketplace plugin field "${field}" was invalid`)
  }
  return value
}

function requireNullableString(value: unknown, field: string): string | null {
  if (value === null || typeof value === "string") return value
  throw new Error(`Marketplace plugin field "${field}" was invalid`)
}

function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number") {
    throw new Error(`Marketplace plugin field "${field}" was invalid`)
  }
  return value
}

async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8")
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR") {
      return null
    }
    throw err
  }
}

function parsePackageMeta(raw: string | null): PackageMeta | null {
  if (raw == null) return null
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    return {
      version:
        typeof parsed.version === "string" ? parsed.version : null,
      description:
        typeof parsed.description === "string"
          ? parsed.description
          : null,
      author: extractAuthor(parsed.author),
    }
  } catch {
    return null
  }
}

function extractAuthor(raw: unknown): string | null {
  if (typeof raw === "string") return raw
  if (raw && typeof raw === "object") {
    const name = (raw as { name?: unknown }).name
    if (typeof name === "string") return name
  }
  return null
}
