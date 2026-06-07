import { useEffect, useMemo, useState } from "react"
import { ChevronDownIcon } from "lucide-react"
import { Streamdown } from "streamdown"
import {
  useDb,
  useDbClient,
  useRpc,
  useViewArgs,
} from "@zenbujs/core/react"
import { Button } from "@zenbu/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@zenbu/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@zenbu/ui/dropdown-menu"
import { cn } from "@zenbu/ui/utils"
import type { MarketplaceListing } from "../main/services/marketplace"
import {
  useTogglePlugin,
  useInstalledPlugins,
  type InstalledPluginListing,
} from "../lib/plugin-enabled-store"

export type PluginDetailArgs = {
  pluginId?: string
}

type InstalledPlugin = InstalledPluginListing

type PluginIconRecord = {
  blobId: string
  mime: string
  sourcePath: string
  hash: string
}

export default function PluginDetailView() {
  const { pluginId } = useViewArgs<PluginDetailArgs>() ?? {}
  const rpc = useRpc()

  const installed = useInstalledPlugins()
  const icons = (useDb(root => root.app.pluginIcons) ?? {}) as Record<
    string,
    PluginIconRecord
  >
  const catalog = (useDb(root => root.plugins.catalog) ?? {}) as Record<
    string,
    MarketplaceListing
  >

  // Installed rows pass the plugin name; marketplace rows pass the id
  // (== install-dir basename). Match either so the pane stays on the
  // plugin once it's installed.
  const match = useMemo<InstalledPlugin | null>(() => {
    if (!pluginId) return null
    return (
      installed.find(
        p => p.name === pluginId || dirBasename(p.dir) === pluginId,
      ) ?? null
    )
  }, [installed, pluginId])

  const isPiExtension = match?.kind === "pi-extension"
  const listingId = match ? dirBasename(match.dir) : pluginId
  const listing = (listingId ? catalog[listingId] : undefined) ?? null

  // Installed README + package.json (non-pi only). Skipped when the
  // registry listing already carries the README.
  const dir =
    match && !isPiExtension && listing?.readme == null ? match.dir : null
  const [readme, setReadme] = useState<string | null>(null)
  const [readmeError, setReadmeError] = useState<string | null>(null)
  const [pkg, setPkg] = useState<PackageMeta | null>(null)
  useEffect(() => {
    if (!dir) {
      setReadme(null)
      setReadmeError(null)
      setPkg(null)
      return
    }
    let cancelled = false
    setReadme(null)
    setReadmeError(null)
    setPkg(null)
    void rpc.plugins.marketplace
      .readPluginDetail({ directory: dir })
      .then(res => {
        if (cancelled) return
        setReadme(res.readme ?? "")
        setPkg(res.pkg)
      })
      .catch(err => {
        if (!cancelled)
          setReadmeError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [dir, rpc])

  // Revalidate the marketplace listing while not installed.
  const [loadError, setLoadError] = useState<string | null>(null)
  useEffect(() => {
    if (!pluginId || match) return
    let cancelled = false
    setLoadError(null)
    void rpc.plugins.marketplace
      .getMarketplacePlugin({ id: pluginId })
      .then(res => {
        if (!cancelled && !res.plugin)
          setLoadError("This plugin isn't in the marketplace.")
      })
      .catch(err => {
        if (!cancelled)
          setLoadError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [pluginId, match, rpc])

  const [installing, setInstalling] = useState(false)
  const [installError, setInstallError] = useState<string | null>(null)
  const onInstall = () => {
    if (!pluginId || installing) return
    setInstalling(true)
    setInstallError(null)
    void rpc.plugins.marketplace
      .installMarketplacePlugin({ id: pluginId })
      .catch(err =>
        setInstallError(err instanceof Error ? err.message : String(err)),
      )
      .finally(() => setInstalling(false))
  }

  const onOpenWorkspace = () => {
    if (!match) return
    void rpc.app.pluginsRootView
      .openPluginInNewWindow({ pluginName: match.name, pluginDir: match.dir })
      .catch(err =>
        console.error("[plugin-detail] openPluginInNewWindow failed:", err),
      )
  }

  if (!pluginId) {
    return (
      <EmptyState
        title="No plugin selected"
        body="Pick a plugin from the marketplace sidebar to see its details."
      />
    )
  }

  // Not installed and the listing hasn't loaded yet.
  if (!match && !listing) {
    return (
      <EmptyState
        title={prettify(pluginId)}
        body={loadError ?? "Loading marketplace plugin…"}
      />
    )
  }

  // Header fields prefer the cached listing so they stay identical
  // when the plugin flips marketplace -> installed. Installing only
  // adds (real icon, controls, README); it never swaps the view out.
  const name =
    listing?.name ?? (match ? prettify(match.name) : prettify(pluginId))
  const version = listing?.version ?? pkg?.version ?? match?.version ?? null
  const author = listing?.author ?? pkg?.author ?? match?.author ?? null
  const tagline =
    listing?.description ?? pkg?.description ?? match?.description ?? null

  return (
    <DetailLayout
      header={
        <DetailHeader
          icon={
            match ? (
              <HeaderIcon plugin={match} icon={icons[match.name] ?? null} />
            ) : (
              <HeaderColorTile plugin={listing!} />
            )
          }
          name={name}
          version={version}
          author={author}
          tagline={tagline}
          downloadCount={listing?.downloadCount ?? null}
          tags={listing?.tags ?? []}
          action={
            match ? (
              isPiExtension ? null : (
                <InstalledActions
                  plugin={match}
                  onOpen={onOpenWorkspace}
                  onDeleted={() => {}}
                />
              )
            ) : (
              <InstallButton
                installing={installing}
                installed={false}
                onInstall={onInstall}
              />
            )
          }
        />
      }
    >
      {installError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive whitespace-pre-wrap">
          {installError}
        </div>
      )}
      {isPiExtension && match ? (
        <PiExtensionBody dir={match.dir} />
      ) : (
        // README comes from the registry listing when available (shown
        // pre- and post-install identically); for non-marketplace
        // installs it falls back to the on-disk read.
        (listing?.readme != null || match) && (
          <ReadmeBody
            readme={listing?.readme ?? readme}
            error={readmeError}
          />
        )
      )}
    </DetailLayout>
  )
}

function dirBasename(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir
}

type PackageMeta = {
  version: string | null
  description: string | null
  author: string | null
}

function PiExtensionBody({ dir }: { dir: string }) {
  return (
    <div className="text-[13px] text-muted-foreground">
      Loaded from{" "}
      <code className="rounded bg-muted px-1 py-0.5 text-[12px]">
        {dir}
      </code>
      .
    </div>
  )
}

function ReadmeBody({
  readme,
  error,
}: {
  readme: string | null
  error: string | null
}) {
  let inner: React.ReactNode
  if (error) {
    inner = (
      <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12.5px] text-destructive whitespace-pre-wrap">
        Failed to read README.md: {error}
      </div>
    )
  } else if (readme === null) {
    // Loading: stay blank — no placeholder text. The fetch is short
    // enough that loading text just flickers.
    inner = null
  } else if (readme.trim().length === 0) {
    inner = (
      <div className="text-[12.5px] text-muted-foreground">No README.md</div>
    )
  } else {
    inner = <MarkdownBody source={readme} />
  }
  // GitHub-style README card: a bordered panel with a "README" tab
  // (book glyph + orange active underline) above the content.
  return (
    <div className="overflow-hidden rounded-md border border-border/60 bg-background">
      <div className="flex items-stretch border-b border-border/60 px-2 pt-1.5">
        <span className="inline-flex items-center gap-1.5 border-b-2 border-[#f78166] px-1.5 pb-2 text-[12.5px] font-semibold text-foreground">
          <BookIcon />
          README
        </span>
      </div>
      <div className="px-4 py-3.5">{inner}</div>
    </div>
  )
}

function BookIcon() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-muted-foreground"
      aria-hidden
    >
      <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
      <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
    </svg>
  )
}

function EnableToggleButton({ plugin }: { plugin: InstalledPlugin }) {
  const enabled = plugin.enabled
  const canToggle = plugin.pluginFile !== null
  const toggle = useTogglePlugin()

  const onToggle = () => {
    if (!plugin.pluginFile) return
    toggle({ pluginFile: plugin.pluginFile, enabled: !enabled })
  }
  return (
    <Button
      type="button"
      variant={enabled ? "outline" : "default"}
      onClick={onToggle}
      disabled={!canToggle}
      aria-pressed={enabled}
      className="h-8 w-[76px] justify-center px-3 text-[12px] font-medium"
    >
      {enabled ? "Disable" : "Enable"}
    </Button>
  )
}

function InstalledActions({
  plugin,
  onOpen,
  onDeleted,
}: {
  plugin: InstalledPlugin
  onOpen: () => void
  onDeleted: () => void
}) {
  const rpc = useRpc()
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const canDelete =
    plugin.pluginFile !== null && plugin.dir.includes("/.zenbu/plugins/")

  const onCopyPath = () => {
    try {
      rpc.core.window.copyToClipboard(plugin.dir)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch (err) {
      console.error("[plugin-detail] copyToClipboard failed:", err)
    }
    setOpen(false)
  }

  const onDelete = () => {
    if (!canDelete || deleting) return
    setDeleteError(null)
    setDeleteConfirmOpen(true)
    setOpen(false)
  }

  const onConfirmDelete = () => {
    if (!plugin.pluginFile || deleting) return
    setDeleting(true)
    setDeleteError(null)
    void rpc.plugins.marketplace
      .deleteInstalledPlugin({
        pluginFile: plugin.pluginFile,
        directory: plugin.dir,
      })
      .then(() => {
        setDeleteConfirmOpen(false)
        onDeleted()
      })
      .catch(err => {
        setDeleteError(err instanceof Error ? err.message : String(err))
        console.error("[plugin-detail] deleteInstalledPlugin failed:", err)
      })
      .finally(() => setDeleting(false))
  }

  return (
    <div className="flex items-center gap-2">
      <EnableToggleButton plugin={plugin} />
        <div className="inline-flex h-8 items-stretch overflow-hidden rounded-md border border-border bg-background/40 hover:bg-background/70">
          <button
            type="button"
            onClick={onOpen}
            aria-label="Open in Workspace"
            className="inline-flex items-center px-3 text-[12px] font-medium leading-none text-foreground hover:bg-background/80"
          >
            Open in Workspace
          </button>
          <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="More plugin actions"
                className={cn(
                  "inline-flex items-center justify-center border-l border-border px-2 text-muted-foreground",
                  "hover:bg-background/80 hover:text-foreground",
                  "data-[state=open]:bg-background/80 data-[state=open]:text-foreground",
                )}
              >
                <ChevronDownIcon className="size-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px] p-1">
              <DropdownMenuItem onSelect={onCopyPath} className="gap-2">
                <span className="flex-1 text-[12px]">
                  {copied ? "Copied!" : "Copy path"}
                </span>
              </DropdownMenuItem>
              {canDelete && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    disabled={deleting}
                    onSelect={onDelete}
                    className="gap-2"
                  >
                    <span className="flex-1 text-[12px]">
                      {deleting ? "Uninstalling…" : "Uninstall"}
                    </span>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      <DeletePluginDialog
        open={deleteConfirmOpen}
        plugin={plugin}
        deleting={deleting}
        error={deleteError}
        onOpenChange={setDeleteConfirmOpen}
        onConfirm={onConfirmDelete}
      />
    </div>
  )
}

function DeletePluginDialog({
  open,
  plugin,
  deleting,
  error,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  plugin: InstalledPlugin
  deleting: boolean
  error: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] p-0 gap-0">
        <DialogHeader className="px-5 pt-5 pb-3">
          <DialogTitle className="text-[14px] font-semibold">
            Uninstall {prettify(plugin.name)}?
          </DialogTitle>
        </DialogHeader>
        <div className="px-5 pb-4 text-[13px] leading-relaxed text-muted-foreground">
          This removes the plugin from your local plugin manifest and deletes
          its files from disk.
          {error && (
            <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[12px] text-destructive whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>
        <DialogFooter className="px-5 py-3 border-t border-border bg-muted/30 rounded-b-xl">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={() => onOpenChange(false)}
            className="h-8 text-[13px]"
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={deleting}
            onClick={onConfirm}
            className="h-8 text-[13px]"
          >
            {deleting ? "Uninstalling…" : "Uninstall"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function InstallButton({
  installing,
  installed,
  onInstall,
}: {
  installing: boolean
  installed: boolean
  onInstall: () => void
}) {
  return (
    <Button
      type="button"
      onClick={onInstall}
      disabled={installing || installed}
      className="h-8 px-3 text-[12px] font-medium"
    >
      {installing ? "Installing…" : installed ? "Installed" : "Install"}
    </Button>
  )
}

function DetailLayout({
  header,
  children,
}: {
  header: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background text-foreground">
      <div className="shrink-0 border-b border-border/60">
        <div className="mx-auto w-full max-w-[820px] px-4 py-4">
          {header}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 overflow-y-auto">
          <div className="mx-auto w-full max-w-[820px] px-4 py-5">
            {children}
          </div>
        </div>
      </div>
    </div>
  )
}

function DetailHeader({
  icon,
  name,
  version,
  author,
  tagline,
  downloadCount,
  tags,
  action,
}: {
  icon: React.ReactNode
  name: string
  version: string | null
  author: string | null
  tagline: string | null
  downloadCount: number | null
  tags: string[]
  action: React.ReactNode | null
}) {
  return (
    <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
      <div className="flex min-w-0 grow basis-[220px] items-start gap-3">
        <div className="shrink-0">{icon}</div>
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <h1 className="min-w-0 break-words text-[18px] font-semibold tracking-tight text-foreground">
              {name}
            </h1>
            {version && (
              <span className="text-[12px] tabular-nums text-muted-foreground">
                v{version}
              </span>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[12px] text-muted-foreground">
            {author && <span className="min-w-0 break-words">{author}</span>}
            {downloadCount != null && (
              <span className="inline-flex shrink-0 items-center gap-1 tabular-nums">
                <DownloadIcon />
                {formatCount(downloadCount)}
              </span>
            )}
          </div>
          {tagline && (
            <p className="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-foreground/90">
              {tagline}
            </p>
          )}
          {tags.length > 0 && (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {tags.map(tag => (
                <span
                  key={tag}
                  className="rounded-md border border-border/60 bg-card/40 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  )
}

function DownloadIcon() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="shrink-0"
      aria-hidden
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="15" y2="3" />
    </svg>
  )
}

function HeaderIcon({
  plugin,
  icon,
}: {
  plugin: InstalledPlugin
  icon: PluginIconRecord | null
}) {
  if (icon) {
    return (
      <div
        className={cn(
          "flex h-14 w-14 items-center justify-center overflow-hidden rounded-md",
          "border border-border/60 bg-card/40",
        )}
      >
        <PluginIconImg icon={icon} size={48} />
      </div>
    )
  }
  return (
    <div
      className={cn(
        "grid h-14 w-14 place-items-center rounded-md",
        "border border-border/60 bg-card/40 text-muted-foreground",
      )}
      aria-hidden
    >
      {plugin.kind === "pi-extension" ? <PiGlyph /> : <PuzzleGlyph />}
    </div>
  )
}

function PluginIconImg({
  icon,
  size,
}: {
  icon: PluginIconRecord
  size: number
}) {
  const dbClient = useDbClient()
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setUrl(null)
    void (async () => {
      try {
        const data = await dbClient.getBlobData(icon.blobId)
        if (cancelled || !data) return
        const blob = new Blob([data as BlobPart], { type: icon.mime })
        setUrl(URL.createObjectURL(blob))
      } catch {
      }
    })()
    return () => {
      cancelled = true
    }
  }, [icon.blobId, icon.mime, dbClient])
  if (!url) {
    return <PuzzleGlyph />
  }
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size, objectFit: "contain" }}
      draggable={false}
    />
  )
}

function HeaderColorTile({ plugin }: { plugin: MarketplaceListing }) {
  return (
    <div
      className="grid h-14 w-14 place-items-center rounded-md border border-border/60 bg-card/60 text-[18px] font-semibold text-foreground"
      aria-hidden
    >
      {initials(plugin.name)}
    </div>
  )
}

function MarkdownBody({ source }: { source: string }) {
  return (
    <div className="break-words text-[13.5px] leading-relaxed text-foreground/90">
      <Streamdown>{source}</Streamdown>
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex h-full w-full items-center justify-center bg-background text-foreground">
      <div className="flex max-w-[340px] flex-col items-center gap-2 px-6 text-center">
        <h1 className="text-[15px] font-semibold">{title}</h1>
        <p className="text-[12.5px] text-muted-foreground">{body}</p>
      </div>
    </div>
  )
}

function prettify(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

function initials(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean)
  const first = parts[0]?.[0] ?? "P"
  const second = parts.length > 1 ? parts[1]?.[0] : parts[0]?.[1]
  return `${first}${second ?? ""}`.toUpperCase()
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

function PuzzleGlyph() {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 2 12c0-.617.236-1.234.706-1.704L4.317 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.98.98 0 0 1 .276-.837l1.611-1.61a2.404 2.404 0 0 1 1.704-.707c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
    </svg>
  )
}

function PiGlyph() {
  return (
    <svg width="24" height="24" viewBox="0 0 800 800" fill="currentColor" aria-hidden>
      <path
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  )
}
