import { useEffect, useMemo, useRef, useState } from "react";
import {
  useCollection,
  useDb,
  useDbClient,
  useEvents,
  useRpc,
} from "@zenbujs/core/react";
import type { DbClient } from "@zenbujs/core/react";
import { Button } from "@zenbu/ui/button";
import { Input } from "@zenbu/ui/input";
import { cn } from "@zenbu/ui/utils";
import type { MarketplaceListing } from "../main/services/marketplace";
import {
  useInstalledPlugins,
  type InstalledPluginListing,
} from "../lib/plugin-enabled-store";

const SIDEBAR_FOOTER_HEIGHT = 44;
const SIDEBAR_FOOTER_FADE = 24;
const BODY_BOTTOM_PAD = SIDEBAR_FOOTER_HEIGHT + SIDEBAR_FOOTER_FADE;

const SWAP_MS = 220;

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;

// View type of the per-plugin detail pane (kept in sync with
// `DETAIL_NAME` in the marketplace service). Used to derive which
// plugin row should read as "active" in the sidebar.
const DETAIL_VIEW_TYPE = "plugin-detail";

// Plugin id shown in an open `plugin-detail` pane, or null. Sidebar
// views get no windowId, so (like git-tree) we walk windowStates and
// take the first window with a detail pane, preferring its active
// pane so the highlight survives focusing a different pane.
function useActiveDetailPluginId(): string | null {
  return useDb((root) => {
    for (const ws of Object.values(root.app.windowStates)) {
      const scopeId = ws?.selectedScopeId;
      const paneState = scopeId ? ws.scopePanes?.[scopeId] : undefined;
      if (!paneState) continue;
      const active = paneState.panes.find(
        (p) => p.id === paneState.activePaneId,
      );
      for (const pane of active
        ? [active, ...paneState.panes]
        : paneState.panes) {
        const tab =
          pane.tabs.find((t) => t.id === pane.activeTabId) ?? pane.tabs[0];
        const content = tab?.content;
        if (content?.kind === "view" && content.viewType === DETAIL_VIEW_TYPE) {
          const id = content.args?.pluginId;
          if (typeof id === "string") return id;
        }
      }
    }
    return null;
  });
}

export default function MarketplaceSidebarView() {
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden text-[13px]">
      <SwapPane active={!creating} side="list">
        <ListPane
          query={query}
          onQueryChange={setQuery}
          onNewPlugin={() => setCreating(true)}
        />
      </SwapPane>
      <SwapPane active={creating} side="create">
        <CreatePluginPane active={creating} onBack={() => setCreating(false)} />
      </SwapPane>
    </div>
  );
}

function SwapPane({
  active,
  side,
  children,
}: {
  active: boolean;
  side: "list" | "create";
  children: React.ReactNode;
}) {
  const offsetPx = 12;
  const translate = active ? 0 : side === "list" ? -offsetPx : offsetPx;
  return (
    <div
      aria-hidden={!active}
      style={{
        transform: `translateX(${translate}px)`,
        opacity: active ? 1 : 0,
        transition: `opacity ${SWAP_MS}ms ease, transform ${SWAP_MS}ms ease`,
        pointerEvents: active ? "auto" : "none",
      }}
      className="absolute inset-0 flex min-h-0 min-w-0 flex-col"
    >
      {children}
    </div>
  );
}

function ListPane({
  query,
  onQueryChange,
  onNewPlugin,
}: {
  query: string;
  onQueryChange: (q: string) => void;
  onNewPlugin: () => void;
}) {
  const lowerQ = query.trim().toLowerCase();
  const activePluginId = useActiveDetailPluginId();

  const marketplaceEnabled = useDb((root) => root.plugins.enabled);

  const installed = useInstalledPlugins();
  const icons = useDb((root) => root.app.pluginIcons) ?? {};
  const catalog = useDb((root) => root.plugins.catalog) ?? {};

  const filteredInstalled = useMemo(() => {
    if (!lowerQ) return installed;
    return installed.filter((p) => p.name.toLowerCase().includes(lowerQ));
  }, [installed, lowerQ]);

  const installedKeys = useMemo(() => {
    const set = new Set<string>();
    for (const p of installed) set.add(p.name.toLowerCase());
    return set;
  }, [installed]);

  // Read the locally-cached browse feed (refreshed by the service).
  // No per-mount fetch -> navigating back is instant, no flash.
  const feed = useMarketplaceFeed(marketplaceEnabled);
  const filteredMarketplace = useMemo<MarketplaceListing[]>(() => {
    return feed.filter((p) => {
      if (
        installedKeys.has(p.id.toLowerCase()) ||
        installedKeys.has(p.name.toLowerCase())
      ) {
        return false;
      }
      if (!lowerQ) return true;
      return (
        p.name.toLowerCase().includes(lowerQ) ||
        p.description.toLowerCase().includes(lowerQ) ||
        p.author.toLowerCase().includes(lowerQ) ||
        p.tags.some((t) => t.toLowerCase().includes(lowerQ))
      );
    });
  }, [feed, installedKeys, lowerQ]);

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <div
        className="flex shrink-0 flex-col gap-1.5 px-1.5 pt-1.5 pb-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <SearchInput value={query} onChange={onQueryChange} autoFocus />
      </div>
      <div
        className="relative min-h-0 flex-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <div
          className="absolute inset-0 overflow-auto px-1.5"
          style={{ paddingBottom: BODY_BOTTOM_PAD }}
        >
          {filteredInstalled.length === 0 &&
          filteredMarketplace.length === 0 ? (
            <div className="px-2 py-6 text-center text-[12px] text-muted-foreground">
              {lowerQ ? "No matches." : "No plugins installed."}
            </div>
          ) : (
            <>
              {filteredMarketplace.length > 0 && (
                <Section label="Marketplace">
                  <MarketplaceResults
                    plugins={filteredMarketplace}
                    activePluginId={activePluginId}
                  />
                </Section>
              )}
              {filteredInstalled.length > 0 && (
                <Section label="Installed">
                  <InstalledList
                    installed={filteredInstalled}
                    icons={icons}
                    catalog={catalog}
                    activePluginId={activePluginId}
                  />
                </Section>
              )}
            </>
          )}
        </div>
        <SidebarFooter>
          <Button
            type="button"
            variant="outline"
            onClick={onNewPlugin}
            className="h-8 w-full justify-center bg-transparent font-medium hover:bg-foreground/[0.04]"
          >
            Create Plugin
          </Button>
        </SidebarFooter>
      </div>
    </div>
  );
}

function Section({
  label,
  defaultOpen = true,
  children,
}: {
  label: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="mt-2 first:mt-0 flex flex-col">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "group flex min-h-[26px] w-full min-w-0 cursor-default select-none items-center gap-1.5",
          "rounded-md px-1.5 py-1 text-left text-sidebar-foreground",
          "hover:bg-foreground/[0.04]",
        )}
      >
        <span className="inline-flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          <SectionChevron open={open} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-foreground">
          {label}
        </span>
      </button>
      {open && <div className="mt-0.5">{children}</div>}
    </div>
  );
}

function SectionChevron({ open }: { open: boolean }) {
  return (
    <svg
      width="11"
      height="11"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 120ms ease",
      }}
    >
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}

// Read the browse feed from the locally-cached collection. The main
// process keeps it fresh; here we just read replicated state, so it's
// instant on mount with no fetch/flash.
function useMarketplaceFeed(enabled: boolean): MarketplaceListing[] {
  const ref = useDb((root) => root.plugins.feed);
  const { items } = useCollection(enabled ? ref : null);
  return (items ?? []) as MarketplaceListing[];
}

type PluginEntry = InstalledPluginListing;

function dirBasename(dir: string): string {
  return dir.split(/[\\/]/).filter(Boolean).at(-1) ?? dir;
}

type PluginIconRecord = {
  blobId: string;
  mime: string;
  sourcePath: string;
  hash: string;
};

function MarketplaceMeta({
  author,
  downloadCount,
}: {
  author: string;
  downloadCount: number;
}) {
  return (
    <>
      <span className="min-w-0 truncate">{author}</span>
      <span className="ml-auto flex shrink-0 items-center gap-1 tabular-nums">
        <svg
          aria-hidden
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="h-3 w-3 text-muted-foreground/70"
        >
          <path d="M12 3v12" />
          <path d="m7 11 5 5 5-5" />
          <path d="M5 21h14" />
        </svg>
        {formatCount(downloadCount)}
      </span>
    </>
  );
}

function InstalledList({
  installed,
  icons,
  catalog,
  activePluginId,
}: {
  installed: PluginEntry[];
  icons: Record<string, PluginIconRecord>;
  catalog: Record<string, MarketplaceListing>;
  activePluginId: string | null;
}) {
  const sorted = useMemo(() => {
    return [...installed].sort((a, b) =>
      prettifyName(a.name).localeCompare(prettifyName(b.name), undefined, {
        sensitivity: "base",
      }),
    );
  }, [installed]);

  // When a plugin newly appears (e.g. just installed), scroll its
  // row into view.
  const [scrollDir, setScrollDir] = useState<string | null>(null);
  const prevDirsRef = useRef<Set<string> | null>(null);
  useEffect(() => {
    const curr = new Set(installed.map((p) => p.dir));
    const prev = prevDirsRef.current;
    prevDirsRef.current = curr;
    if (!prev) return;
    const added = installed.find((p) => !prev.has(p.dir));
    if (added) setScrollDir(added.dir);
  }, [installed]);

  if (sorted.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11.5px] text-muted-foreground">
        No plugins installed.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {sorted.map((plugin) => (
        <InstalledRow
          key={`${plugin.kind ?? "plugin"}:${plugin.name}`}
          plugin={plugin}
          icon={icons[plugin.name] ?? null}
          listing={catalog[dirBasename(plugin.dir)] ?? null}
          enabled={plugin.enabled}
          active={activePluginId === plugin.name}
          scrollTarget={plugin.dir === scrollDir}
        />
      ))}
    </ul>
  );
}

function InstalledRow({
  plugin,
  icon,
  listing,
  enabled,
  active,
  scrollTarget,
}: {
  plugin: PluginEntry;
  icon: PluginIconRecord | null;
  listing: MarketplaceListing | null;
  enabled: boolean;
  active: boolean;
  scrollTarget: boolean;
}) {
  const rpc = useRpc();
  const onClick = () => {
    void rpc.plugins.marketplace
      .openDetailInPane({ pluginId: plugin.name })
      .catch((err) => {
        console.error("[marketplace-sidebar] openDetailInPane failed:", err);
      });
  };
  // Name/description/author come from package.json; downloadCount
  // has no config file, so it's read from the cached listing
  // (written on install) to keep the row identical to its
  // marketplace form.
  const author = plugin.author ?? listing?.author ?? null;
  const meta =
    listing != null ? (
      <MarketplaceMeta
        author={author ?? listing.author}
        downloadCount={listing.downloadCount}
      />
    ) : author ? (
      <span className="min-w-0 truncate">{author}</span>
    ) : undefined;
  return (
    <PluginRow
      thumb={<InstalledThumb plugin={plugin} icon={icon} />}
      title={listing?.name ?? prettifyName(plugin.name)}
      description={plugin.description ?? listing?.description ?? null}
      meta={meta}
      muted={!enabled}
      active={active}
      scrollTarget={scrollTarget}
      onClick={onClick}
    />
  );
}

function InstalledThumb({
  plugin,
  icon,
}: {
  plugin: PluginEntry;
  icon: PluginIconRecord | null;
}) {
  let inner: React.ReactNode;
  if (plugin.kind === "pi-extension") {
    inner = (
      <span className="flex items-center justify-center text-foreground">
        <PiIcon />
      </span>
    );
  } else if (!icon) {
    inner = (
      <span className="flex items-center justify-center text-muted-foreground">
        <PuzzleIcon />
      </span>
    );
  } else {
    inner = <InstalledIconImage icon={icon} size={28} />;
  }
  return <ThumbTile>{inner}</ThumbTile>;
}

const imageCache = new Map<string, string>();
const imageInflight = new Map<string, Promise<string | null>>();

function getCachedImage(blobId: string): string | null {
  return imageCache.get(blobId) ?? null;
}

async function hydratePluginIcon(
  blobId: string,
  mime: string,
  client: DbClient,
): Promise<string | null> {
  const have = imageCache.get(blobId);
  if (have) return have;
  const pending = imageInflight.get(blobId);
  if (pending) return pending;
  const p = (async () => {
    try {
      const data = await client.getBlobData(blobId);
      if (!data) return null;
      const blob = new Blob([data as BlobPart], { type: mime });
      const url = URL.createObjectURL(blob);
      imageCache.set(blobId, url);
      return url;
    } finally {
      imageInflight.delete(blobId);
    }
  })();
  imageInflight.set(blobId, p);
  return p;
}

function InstalledIconImage({
  icon,
  size,
}: {
  icon: PluginIconRecord;
  size: number;
}) {
  const dbClient = useDbClient();
  const [url, setUrl] = useState<string | null>(() =>
    getCachedImage(icon.blobId),
  );
  useEffect(() => {
    let cancelled = false;
    if (url) return;
    void hydratePluginIcon(icon.blobId, icon.mime, dbClient).then((u) => {
      if (!cancelled) setUrl(u);
    });
    return () => {
      cancelled = true;
    };
  }, [icon.blobId, icon.mime, dbClient, url]);
  useEffect(() => {
    setUrl(getCachedImage(icon.blobId));
  }, [icon.blobId]);
  const dim = `${size}px`;
  if (!url) {
    return (
      <span
        className="flex shrink-0 items-center justify-center text-muted-foreground"
        style={{ width: dim, height: dim }}
      >
        <PuzzleIcon />
      </span>
    );
  }
  return (
    <img
      src={url}
      alt=""
      width={size}
      height={size}
      className="shrink-0 rounded-sm"
      style={{ width: dim, height: dim, objectFit: "contain" }}
      draggable={false}
    />
  );
}

function prettifyName(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function initials(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[\s_-]+/)
    .filter(Boolean);
  const first = parts[0]?.[0] ?? "P";
  const second = parts.length > 1 ? parts[1]?.[0] : parts[0]?.[1];
  return `${first}${second ?? ""}`.toUpperCase();
}

function ThumbTile({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid h-9 w-9 shrink-0 place-items-center text-[13px] font-semibold text-foreground"
      aria-hidden
    >
      {children}
    </div>
  );
}

function PluginRow({
  thumb,
  title,
  description,
  meta,
  muted,
  active,
  scrollTarget,
  onClick,
}: {
  thumb: React.ReactNode;
  title: string;
  description?: string | null;
  meta?: React.ReactNode;
  muted?: boolean;
  active?: boolean;
  scrollTarget?: boolean;
  onClick: () => void;
}) {
  const hasDescription = description != null && description !== "";
  const compact = !hasDescription && !meta;
  const buttonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (scrollTarget) {
      buttonRef.current?.scrollIntoView({ block: "center", inline: "nearest" });
    }
  }, [scrollTarget]);
  return (
    <li className="contents">
      <button
        ref={buttonRef}
        type="button"
        onClick={onClick}
        aria-current={active ? "true" : undefined}
        className={cn(
          "group flex w-full min-w-0 cursor-default select-none gap-2.5 overflow-hidden",
          compact ? "items-center" : "items-start",
          "rounded-md p-1.5 text-left text-sidebar-foreground",
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground"
            : "hover:bg-foreground/[0.04]",
          muted && "opacity-60",
        )}
      >
        {thumb}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span
            className={cn(
              "min-w-0 truncate text-[12.5px] font-semibold text-foreground",
              muted && "text-muted-foreground",
            )}
          >
            {title}
          </span>
          {hasDescription && (
            <p className="truncate text-[11.5px] leading-snug text-muted-foreground">
              {description}
            </p>
          )}
          {meta && (
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[10.5px] text-muted-foreground">
              {meta}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}

function MarketplaceResults({
  plugins,
  activePluginId,
}: {
  plugins: MarketplaceListing[];
  activePluginId: string | null;
}) {
  const rpc = useRpc();

  const openDetail = (plugin: MarketplaceListing) => {
    void rpc.plugins.marketplace
      .openDetailInPane({ pluginId: plugin.id })
      .catch((err) => {
        console.error("[marketplace-sidebar] openDetailInPane failed:", err);
      });
  };

  if (plugins.length === 0) {
    return (
      <div className="px-2 py-3 text-center text-[11.5px] text-muted-foreground">
        No matches.
      </div>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {plugins.map((plugin) => (
        <MarketplaceRow
          key={plugin.id}
          plugin={plugin}
          active={activePluginId === plugin.id}
          onClick={() => openDetail(plugin)}
        />
      ))}
    </ul>
  );
}

function MarketplaceRow({
  plugin,
  active,
  onClick,
}: {
  plugin: MarketplaceListing;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <PluginRow
      thumb={<ThumbTile>{initials(plugin.name)}</ThumbTile>}
      title={plugin.name}
      description={plugin.description}
      meta={
        <MarketplaceMeta
          author={plugin.author}
          downloadCount={plugin.downloadCount}
        />
      }
      active={active}
      onClick={onClick}
    />
  );
}

type CreatePhase =
  | { kind: "name" }
  | { kind: "running"; runId: string }
  | { kind: "done"; pluginName: string; pluginDir: string };

function normalizePluginName(raw: string): string {
  return raw.toLowerCase().replace(/\s+/g, "-").replace(/-+/g, "-");
}

function CreatePluginPane({
  active,
  onBack,
}: {
  active: boolean;
  onBack: () => void;
}) {
  const rpc = useRpc();
  const events = useEvents();
  const openedRef = useRef<string | null>(null);
  const [name, setName] = useState("");
  const [phase, setPhase] = useState<CreatePhase>({ kind: "name" });
  const [error, setError] = useState<string | null>(null);
  const currentRunId = useRef<string | null>(null);

  useEffect(() => {
    if (!active) return;
    setName("");
    setPhase({ kind: "name" });
    setError(null);
    openedRef.current = null;
    currentRunId.current = null;
    const t = setTimeout(() => {
      const el = document.getElementById(
        "marketplace-plugin-name",
      ) as HTMLInputElement | null;
      el?.focus();
    }, SWAP_MS);
    return () => clearTimeout(t);
  }, [active]);

  useEffect(() => {
    if (!active) return;
    const offDone = events.app.createPluginDone.subscribe((p) => {
      if (p.runId !== currentRunId.current) return;
      currentRunId.current = null;
      if (!p.ok) {
        setError(p.error ?? "create-plugin failed");
        setPhase({ kind: "name" });
        return;
      }
      if (p.pluginName && p.pluginPath) {
        setPhase({
          kind: "done",
          pluginName: p.pluginName,
          pluginDir: p.pluginPath,
        });
      }
    });
    return () => {
      offDone();
    };
  }, [active, events]);

  useEffect(() => {
    if (phase.kind !== "done") return;
    if (openedRef.current === phase.pluginName) return;
    openedRef.current = phase.pluginName;
    void rpc.app.pluginsRootView
      .openPluginInNewWindow({
        pluginName: phase.pluginName,
        pluginDir: phase.pluginDir,
      })
      .catch((err) => {
        console.error(
          "[marketplace-sidebar] auto openPluginInNewWindow failed:",
          err,
        );
      });
  }, [phase, rpc]);

  const trimmedName = name.replace(/^-+|-+$/g, "");
  const nameValid = PLUGIN_NAME_RE.test(trimmedName);
  const running = phase.kind === "running";
  const done = phase.kind === "done";
  const canSubmit = !running && !done && nameValid;

  const headerLabel = done ? prettifyName(phase.pluginName) : "Create plugin";

  const handleOpenWorkspace = () => {
    if (phase.kind !== "done") return;
    void rpc.app.pluginsRootView
      .openPluginInNewWindow({
        pluginName: phase.pluginName,
        pluginDir: phase.pluginDir,
      })
      .catch((err) => {
        console.error(
          "[marketplace-sidebar] openPluginInNewWindow failed:",
          err,
        );
      });
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!canSubmit) return;
    setError(null);
    try {
      const { runId } = await rpc.app.createPlugin.createPlugin({
        name: trimmedName,
      });
      currentRunId.current = runId;
      setPhase({ kind: "running", runId });
    } catch (err) {
      currentRunId.current = null;
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <button
        type="button"
        onClick={running ? undefined : onBack}
        disabled={running}
        aria-label="Back to plugins"
        className="group grid w-full shrink-0 grid-cols-[20px_1fr_20px] items-center gap-2 px-2 py-2 text-left hover:bg-foreground/[0.04] disabled:opacity-60 disabled:hover:bg-transparent"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center text-muted-foreground group-hover:text-foreground"
          aria-hidden
        >
          <BackIcon />
        </span>
        <div className="flex min-w-0 items-center justify-center gap-2">
          {done && (
            <span
              className="flex h-[18px] w-[18px] shrink-0 items-center justify-center text-muted-foreground"
              aria-hidden
            >
              <PuzzleIcon />
            </span>
          )}
          <span className="min-w-0 truncate font-medium text-foreground">
            {headerLabel}
          </span>
        </div>
        <span aria-hidden />
      </button>

      <div className="relative min-h-0 flex-1">
        <div className="absolute inset-0 flex flex-col gap-3 overflow-auto px-3 pb-3 pt-1">
          {done ? (
            <button
              type="button"
              onClick={handleOpenWorkspace}
              className="flex items-center justify-center rounded-md border border-border/60 px-2.5 py-1.5 font-medium text-foreground hover:bg-foreground/[0.04]"
            >
              Open in Workspace
            </button>
          ) : (
            <form onSubmit={handleSubmit} className="flex flex-col gap-2">
              <label
                htmlFor="marketplace-plugin-name"
                className="px-0.5 text-[11px] font-medium text-muted-foreground"
              >
                Name
              </label>
              <Input
                id="marketplace-plugin-name"
                value={name}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setName(normalizePluginName(e.target.value))
                }
                placeholder="my-plugin"
                disabled={running}
                className="h-8 bg-transparent text-[13px]"
              />
              <Button
                type="submit"
                variant={canSubmit ? "default" : "outline"}
                disabled={!canSubmit}
                className="h-8 w-full justify-center font-medium"
              >
                {running ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner />
                    Creating…
                  </span>
                ) : (
                  "Create"
                )}
              </Button>
            </form>
          )}

          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-2.5 py-1.5 text-[11.5px] text-destructive whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function SidebarFooter({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="pointer-events-none absolute bottom-0 left-0 right-0"
      style={{ height: SIDEBAR_FOOTER_HEIGHT + SIDEBAR_FOOTER_FADE }}
    >
      <div
        aria-hidden
        className="absolute inset-0"
        style={{
          background: `linear-gradient(
            to bottom,
            color-mix(in srgb, var(--sidebar) 0%, transparent) 0%,
            color-mix(in srgb, var(--sidebar) 85%, transparent) ${SIDEBAR_FOOTER_FADE}px,
            var(--sidebar) ${SIDEBAR_FOOTER_FADE + 4}px,
            var(--sidebar) 100%
          )`,
        }}
      />
      <div
        className="absolute bottom-0 left-0 right-0 flex items-end p-2"
        style={
          {
            height: SIDEBAR_FOOTER_HEIGHT,
            pointerEvents: "auto",
            WebkitAppRegion: "no-drag",
          } as React.CSSProperties
        }
      >
        {children}
      </div>
    </div>
  );
}

function SearchInput({
  value,
  onChange,
  autoFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (!autoFocus) return;
    const t = requestAnimationFrame(() => {
      try {
        window.focus();
      } catch {}
      inputRef.current?.focus();
    });
    return () => cancelAnimationFrame(t);
  }, [autoFocus]);
  return (
    <div className="flex h-7 items-center gap-1.5 rounded-md border border-border/60 bg-card/40 px-2 focus-within:bg-card">
      <SearchIcon />
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search"
        className="min-w-0 flex-1 bg-transparent text-foreground outline-none placeholder:text-muted-foreground"
        aria-label="Search"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          aria-label="Clear search"
          className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
        >
          <ClearIcon />
        </button>
      )}
    </div>
  );
}

function formatCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}

function Spinner() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      className="animate-spin"
      aria-hidden
    >
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function SearchIcon() {
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
      className="shrink-0 text-muted-foreground"
      aria-hidden
    >
      <circle cx="11" cy="11" r="7" />
      <path d="m21 21-4.3-4.3" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      width="10"
      height="10"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M18 6 6 18" />
      <path d="m6 6 12 12" />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}

function PiIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 800 800"
      fill="currentColor"
      aria-hidden
    >
      <path
        fillRule="evenodd"
        d="M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z"
      />
      <path d="M517.36 400 H634.72 V634.72 H517.36 Z" />
    </svg>
  );
}

function PuzzleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.968-.925a2.501 2.501 0 1 0-3.214 3.214c.446.166.855.497.925.968a.979.979 0 0 1-.276.837l-1.61 1.61a2.404 2.404 0 0 1-1.705.707 2.402 2.402 0 0 1-1.704-.706l-1.568-1.568a1.026 1.026 0 0 0-.877-.29c-.493.074-.84.504-1.02.968a2.5 2.5 0 1 1-3.237-3.237c.464-.18.894-.527.967-1.02a1.026 1.026 0 0 0-.289-.877l-1.568-1.568A2.402 2.402 0 0 1 2 12c0-.617.236-1.234.706-1.704L4.317 8.685a.98.98 0 0 1 .837-.276c.47.07.802.48.968.925a2.501 2.501 0 1 0 3.214-3.214c-.446-.166-.855-.497-.925-.968a.98.98 0 0 1 .276-.837l1.611-1.61a2.404 2.404 0 0 1 1.704-.707c.617 0 1.234.236 1.704.706l1.568 1.568c.23.23.556.338.877.29.493-.074.84-.504 1.02-.968a2.5 2.5 0 1 1 3.237 3.237c-.464.18-.894.527-.967 1.02Z" />
    </svg>
  );
}
