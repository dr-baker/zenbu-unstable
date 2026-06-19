import { useCallback, useMemo } from "react";
import {
  useDb,
  useDbClient,
  useRpc,
  type ViewComponentProps,
} from "@zenbujs/core/react";
import { HoverTip } from "@zenbu/ui/hover-tip";

/**
 * Component-mode view for the right-sidebar context tab.
 *
 * Resolves the "active session" off the host's DB:
 *  - prefer the chat focused in this window's active pane;
 *  - fall back to a chat visible in another pane of the same
 *    window;
 *  - last-ditch, walk every other window the same way.
 *
 * Renders, top-to-bottom:
 *   - session header (title, model, context-window totals)
 *   - context-window cell grid
 *   - extra-directories list (formerly the `extra-dirs-sidebar`
 *     plugin) — each row shows the directory path with reveal /
 *     copy / remove affordances + an "Add dir to context" button
 *   - session footer (cumulative tokens, cost, leaves, etc.)
 *
 * The extra-dirs section is shown for the active chat's scope:
 * mutations go straight through `useDbClient`, identical to how
 * the standalone sidebar used to do it. The `/add-dir` slash
 * command (registered by this plugin's service) drives the same
 * flow without the user having to open the sidebar.
 *
 * Because this is a component view we share the host's React
 * tree, theme, and CSS scope — no `useThemeSync()` shim needed.
 */

type ContextSidebarArgs = {
  windowId?: string | null;
  scopeId?: string | null;
  directory?: string | null;
};

export default function ContextSidebarView({
  args,
}: ViewComponentProps<ContextSidebarArgs>) {
  const windowId = args?.windowId ?? null;
  // Onboarding special-case: while the tutorial view is active
  // there's no real session, so render a fake context pane.
  // Both hooks run unconditionally to keep hook order stable.
  const tutorialActive = useTutorialViewActive(windowId);
  const active = useActiveChat(windowId);

  if (tutorialActive) {
    return <OnboardingContextPane directory={args?.directory ?? null} />;
  }

  if (!active.sessionId) {
    return (
      <Placeholder>
        No active session. Open a chat to see its context window.
      </Placeholder>
    );
  }

  return (
    <ContextPane
      key={active.sessionId}
      sessionId={active.sessionId}
      scopeId={active.scopeId}
    />
  );
}

/* ---------------------- onboarding (fake) pane -------------------------- */

/** True when the active tab is the `tutorial` view. */
function useTutorialViewActive(windowId: string | null): boolean {
  return useDb((root) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const windows = root.app.windowStates as Record<string, any>;
    const ws = windowId ? windows[windowId] : null;
    if (!ws || ws.activeView?.kind !== "workspace") return false;
    const scopeId = ws.selectedScopeId as string | null;
    const paneState = scopeId ? ws.scopePanes?.[scopeId] : null;
    if (!paneState) return false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activePane =
      paneState.panes.find((p: any) => p.id === paneState.activePaneId) ??
      paneState.panes[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const activeTab =
      activePane?.tabs.find((t: any) => t.id === activePane.activeTabId) ??
      activePane?.tabs[0];
    const content = activeTab?.content;
    return content?.kind === "view" && content.viewType === "tutorial";
  });
}

/**
 * Fake "onboarding agent" context pane. Reuses the real
 * `Header` / `Grid` / `SessionFooter` with a hardcoded session
 * so the surface looks live while the tutorial introduces it.
 */
function OnboardingContextPane({ directory }: { directory: string | null }) {
  const fakeSession: SessionLike = {
    title: "Onboarding",
    model: { provider: "zenbu", id: "guide" },
    stats: {
      contextUsage: { tokens: 18_432, percent: 9, contextWindow: 200_000 },
      tokens: { input: 18_000, output: 432, cacheRead: 12_800, cacheWrite: 5_600 },
      cost: 0,
      autoCompactionEnabled: true,
    },
    leafCount: 1,
    lastActivityAt: Date.now(),
  };
  const fakeModel: ModelLike = { name: "Zenbu Guide", contextWindow: 200_000 };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
      <Header session={fakeSession} model={fakeModel} />
      <Grid session={fakeSession} model={fakeModel} />
      <div className="mt-auto">
        <OnboardingFolders directory={directory} />
        <SessionFooter session={fakeSession} />
      </div>
    </div>
  );
}

/** Read-only folders list for the fake onboarding pane. */
function OnboardingFolders({ directory }: { directory: string | null }) {
  const homeDir = useDb((root) => root.app.env.homeDir);
  const display = (p: string): string =>
    homeDir && p.startsWith(homeDir + "/") ? "~" + p.slice(homeDir.length) : p;
  const rows = directory
    ? [directory, `${directory}/greetings`]
    : ["~/zenbu-playground", "~/zenbu-playground/greetings"];
  return (
    <div className="border-t border-border px-3 py-3">
      <div className="mb-1.5 truncate text-[11px] text-muted-foreground">
        Folders in context
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {rows.map((p) => (
          <div
            key={p}
            className="truncate font-mono text-[11.5px] text-foreground/80"
            title={p}
          >
            {display(p)}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------- pane -------------------------------- */

function ContextPane({
  sessionId,
  scopeId,
}: {
  sessionId: string;
  scopeId: string | null;
}) {
  const session = useDb((root) => root.pi.sessions[sessionId] ?? null);
  const modelInfo = useDb((root) => {
    const s = root.pi.sessions[sessionId];
    if (!s?.model) return null;
    const key = `${s.model.provider}:${s.model.id}`;
    return root.pi.models[key] ?? null;
  });

  if (!session) {
    return <Placeholder>Session not found.</Placeholder>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-y-auto bg-background text-foreground">
      <Header session={session} model={modelInfo} />
      <Grid session={session} model={modelInfo} />
      <div className="mt-auto">
        <ExtraDirectories scopeId={scopeId} />
        <SessionFooter session={session} />
      </div>
    </div>
  );
}

/* --------------------------------- header ------------------------------- */

// Local, structural mirrors of the host's session/model shapes.
// We can't import `Schema` from `plugins/app` because this plugin
// is a separate package; instead we narrow to just the fields
// these helpers actually read off the replica.
type SessionLike = {
  title?: string | null;
  model?: { provider: string; id: string } | null;
  stats: {
    contextUsage?: {
      tokens?: number | null;
      percent?: number | null;
      contextWindow?: number | null;
    } | null;
    tokens: {
      input: number;
      output: number;
      cacheRead?: number | null;
      cacheWrite?: number | null;
    };
    cost: number;
    autoCompactionEnabled: boolean;
  };
  leafCount: number;
  lastActivityAt?: number | null;
};
type ModelLike = { name?: string | null; contextWindow?: number | null };

function Header({
  session,
  model,
}: {
  session: SessionLike;
  model: ModelLike | null;
}) {
  const stats = session.stats;
  const ctx = stats.contextUsage;

  const title = session.title?.trim() || "Untitled session";
  const modelName = model?.name ?? session.model?.id ?? "Unknown model";
  const cw = ctx?.contextWindow ?? model?.contextWindow ?? null;

  const used = ctx?.tokens ?? null;
  const percent = ctx?.percent ?? null;

  let tone: "default" | "warning" | "danger" = "default";
  if (percent != null) {
    if (percent > 90) tone = "danger";
    else if (percent > 70) tone = "warning";
  }

  return (
    <div className="border-b border-border px-3 pt-3 pb-2.5">
      <HoverTip label={title} setAriaLabel={false}>
        <div className="truncate text-[11px] font-medium text-muted-foreground">
          {title}
        </div>
      </HoverTip>
      <div className="mt-0.5 flex items-baseline gap-1.5">
        <HoverTip label={modelName} setAriaLabel={false}>
          <span className="truncate text-[13px] font-semibold text-foreground">
            {modelName}
          </span>
        </HoverTip>
        {cw != null && (
          <span className="text-[10.5px] text-muted-foreground">
            {formatTokens(cw)} ctx
          </span>
        )}
      </div>
      <div className="mt-2 flex items-baseline justify-between gap-2">
        <div className="font-mono text-[11px] text-muted-foreground">
          {used != null && cw != null ? (
            <>
              <span
                className={
                  tone === "danger"
                    ? "font-semibold text-destructive"
                    : tone === "warning"
                      ? "font-semibold text-yellow-500"
                      : "font-semibold text-foreground"
                }
              >
                {used.toLocaleString()}
              </span>
              <span> / {cw.toLocaleString()}</span>
            </>
          ) : (
            <span>— tokens</span>
          )}
        </div>
        <div
          className={
            "font-mono text-[11px] " +
            (tone === "danger"
              ? "text-destructive"
              : tone === "warning"
                ? "text-yellow-500"
                : "text-muted-foreground")
          }
        >
          {percent != null ? `${percent.toFixed(percent < 10 ? 1 : 0)}%` : "—"}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------- grid -------------------------------- */

const GRID_COLS = 22;
const GRID_ROWS = 11;
const GRID_TOTAL = GRID_COLS * GRID_ROWS;

function Grid({
  session,
  model,
}: {
  session: SessionLike;
  model: ModelLike | null;
}) {
  const ctx = session.stats.contextUsage;
  const cw = ctx?.contextWindow ?? model?.contextWindow ?? null;
  const used = ctx?.tokens ?? 0;
  const percent = cw && cw > 0 ? used / cw : 0;

  const usedCells = useMemo(() => {
    if (!cw || cw <= 0 || used <= 0) return 0;
    const exact = percent * GRID_TOTAL;
    return Math.max(1, Math.min(GRID_TOTAL, Math.round(exact)));
  }, [cw, used, percent]);

  const tone =
    percent > 0.9 ? "danger" : percent > 0.7 ? "warning" : "default";
  const fillClass =
    tone === "danger"
      ? "bg-destructive/80"
      : tone === "warning"
        ? "bg-yellow-500/80"
        : "bg-muted-foreground/60";

  return (
    <div className="px-3 py-3">
      <div
        className="grid"
        style={{
          gap: 2,
          gridTemplateColumns: `repeat(${GRID_COLS}, minmax(0, 1fr))`,
        }}
      >
        {Array.from({ length: GRID_TOTAL }).map((_, i) => (
          <div
            key={i}
            className={
              "aspect-square " +
              (i < usedCells ? fillClass : "border border-border/70")
            }
            style={{ borderRadius: 2 }}
          />
        ))}
      </div>
    </div>
  );
}

/* ----------------------------- extra dirs ------------------------------- */

/**
 * Per-scope "extra directories" list. Folded in from the
 * deleted `extra-dirs-sidebar` plugin. Sits directly above the
 * session footer. Reads `scope.extraDirectories` and provides:
 *
 *  - row-level reveal / copy / remove (native context menu)
 *  - inline "Add dir to context" button — opens the native
 *    folder picker via `rpc.app.dialog.pickFolder()` and writes
 *    straight to the replica.
 *
 * The `/add-dir` slash command (registered by this plugin's
 * service) runs the same picker+update through an RPC entry
 * point, so the keyboard flow and the click flow stay in sync.
 */
function ExtraDirectories({ scopeId }: { scopeId: string | null }) {
  const dirs = useDb((root) => {
    if (!scopeId) return null;
    const scope = root.app.scopes[scopeId];
    if (!scope) return null;
    return scope.extraDirectories;
  });
  const dbClient = useDbClient();
  const rpc = useRpc();

  const rows = useMemo(() => dirs ?? [], [dirs]);

  const handleRemove = useCallback(
    async (dir: string) => {
      if (!scopeId) return;
      await dbClient.update((root) => {
        const scope = root.app.scopes[scopeId];
        if (!scope) return;
        scope.extraDirectories = scope.extraDirectories.filter(
          (d) => d !== dir,
        );
      });
    },
    [scopeId, dbClient],
  );

  const handleReveal = useCallback(
    async (dir: string) => {
      try {
        const { error } = await rpc.app.dialog.openInFileBrowser({ path: dir });
        if (error) console.warn("[context-sidebar] openInFileBrowser:", error);
      } catch (err) {
        console.warn("[context-sidebar] openInFileBrowser threw:", err);
      }
    },
    [rpc],
  );

  const handleCopyPath = useCallback(async (dir: string) => {
    try {
      await navigator.clipboard.writeText(dir);
    } catch (err) {
      console.warn("[context-sidebar] clipboard.writeText failed:", err);
    }
  }, []);

  const handleAdd = useCallback(async () => {
    if (!scopeId) return;
    try {
      const result = await rpc.app.dialog.pickFolder();
      if (result.cancelled) return;
      const picked = result.path;
      await dbClient.update((root) => {
        const scope = root.app.scopes[scopeId];
        if (!scope) return;
        if (scope.extraDirectories.includes(picked)) return;
        if (scope.directory === picked) return;
        scope.extraDirectories = [...scope.extraDirectories, picked];
      });
    } catch (err) {
      console.warn("[context-sidebar] pickFolder failed:", err);
    }
  }, [scopeId, dbClient, rpc]);

  // Hide the section entirely if there's no scope to attach to
  // — i.e. no chat in scope yet. The header above is already
  // gated by `sessionId`, but `scopeId` can lag/be missing.
  if (!scopeId) return null;

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="mb-1.5 min-w-0">
        <div className="truncate text-[11px] text-muted-foreground">
          Extra dirs in context
        </div>
      </div>
      <div className="flex min-w-0 flex-col gap-1">
        {rows.map((dir) => (
          <ExtraDirRow
            key={dir}
            path={dir}
            onOpenMenu={async (e) => {
              const rect = (
                e.currentTarget as HTMLButtonElement
              ).getBoundingClientRect();
              const { chosenId } = await rpc.app.contextMenu.show({
                x: Math.round(rect.right),
                y: Math.round(rect.bottom),
                items: [
                  {
                    id: "reveal",
                    label: "Reveal in file browser",
                    enabled: true,
                  },
                  { id: "copy", label: "Copy path", enabled: true },
                  { type: "separator" },
                  {
                    id: "remove",
                    label: "Remove from session",
                    enabled: true,
                  },
                ],
              });
              if (chosenId === "reveal") void handleReveal(dir);
              else if (chosenId === "copy") void handleCopyPath(dir);
              else if (chosenId === "remove") void handleRemove(dir);
            }}
          />
        ))}
        <AddDirRow onClick={handleAdd} />
      </div>
    </div>
  );
}

function AddDirRow({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group relative flex min-h-[28px] min-w-0 cursor-default select-none items-center gap-2 overflow-hidden rounded-md border border-dashed border-border/60 py-1 pl-1.5 pr-2 text-[12px] text-muted-foreground hover:border-border hover:text-foreground"
    >
      <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
        <PlusIcon />
      </span>
      <span className="min-w-0 flex-1 truncate text-left">
        Add dir to context
      </span>
    </button>
  );
}

function ExtraDirRow({
  path,
  onOpenMenu,
}: {
  path: string;
  onOpenMenu: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  const name = basename(path) || path;
  return (
    <HoverTip label={path} setAriaLabel={false}>
      <div className="group relative flex min-h-[28px] min-w-0 items-center gap-2 overflow-hidden rounded-md border border-border/60 bg-foreground/[0.025] py-1 pl-1.5 pr-1 text-muted-foreground">
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-[12px] text-foreground">{name}</span>
          <span className="block min-w-0 truncate text-left font-mono text-[10px] text-muted-foreground">
            {path}
          </span>
        </span>
        <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100">
          <RowActionButton title="Actions" onClick={onOpenMenu}>
            <MoreIcon />
          </RowActionButton>
        </span>
      </div>
    </HoverTip>
  );
}

function RowActionButton({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick(e);
      }}
      onMouseDown={(e) => e.stopPropagation()}
      className="flex h-[20px] w-[20px] items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground"
    >
      {children}
    </button>
  );
}

function basename(p: string): string {
  const trimmed = p.replace(/\/+$/, "");
  const idx = trimmed.lastIndexOf("/");
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

function PlusIcon() {
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
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

function MoreIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      stroke="none"
    >
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
  );
}

/* ---------------------------------- foot -------------------------------- */

function SessionFooter({ session }: { session: SessionLike }) {
  const stats = session.stats;
  const cacheTotal =
    (stats.tokens.cacheRead ?? 0) + (stats.tokens.cacheWrite ?? 0);
  const lines: Array<{ label: string; value: string; title?: string }> = [];
  if (stats.tokens.input > 0)
    lines.push({
      label: "Input (cumulative)",
      value: stats.tokens.input.toLocaleString(),
    });
  if (stats.tokens.output > 0)
    lines.push({
      label: "Output (cumulative)",
      value: stats.tokens.output.toLocaleString(),
    });
  if (cacheTotal > 0)
    lines.push({
      label: "Cache R / W",
      value: `${formatTokens(stats.tokens.cacheRead ?? 0)} / ${formatTokens(stats.tokens.cacheWrite ?? 0)}`,
      title: `Read ${stats.tokens.cacheRead?.toLocaleString() ?? 0}\nWritten ${stats.tokens.cacheWrite?.toLocaleString() ?? 0}`,
    });
  if (stats.cost > 0)
    lines.push({ label: "Cost", value: `$${stats.cost.toFixed(4)}` });
  lines.push({
    label: "Auto-compaction",
    value: stats.autoCompactionEnabled ? "on" : "off",
  });
  if (session.leafCount > 0)
    lines.push({ label: "Leaves", value: String(session.leafCount) });
  if (session.lastActivityAt)
    lines.push({
      label: "Last activity",
      value: formatRelative(session.lastActivityAt),
      title: new Date(session.lastActivityAt).toLocaleString(),
    });

  return (
    <div className="border-t border-border px-3 py-3">
      <div className="mb-1.5 text-[11px] text-muted-foreground">Session</div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11.5px]">
        {lines.map((line) => (
          // `display: contents` so dt/dd participate directly in the
          // parent grid — the wrapping div has no box and can't
          // receive hover, so we wrap dt + dd individually in
          // HoverTip whenever there's an explanatory `line.title`.
          <div key={line.label} className="contents">
            <HoverTip label={line.title} setAriaLabel={false}>
              <dt className="text-muted-foreground">{line.label}</dt>
            </HoverTip>
            <HoverTip label={line.title} setAriaLabel={false}>
              <dd className="text-right font-mono text-foreground">
                {line.value}
              </dd>
            </HoverTip>
          </div>
        ))}
      </dl>
    </div>
  );
}

/* -------------------------------- helpers ------------------------------- */

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-4 text-center text-[12px] text-muted-foreground">
      {children}
    </div>
  );
}

/** Same scheme pi's footer uses (see chat-stats-status-item). */
function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 0) return "just now";
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/* -------------------------- active chat walk ---------------------------- */

type ActiveChat = {
  chatId: string | null;
  sessionId: string | null;
  scopeId: string | null;
};

/**
 * Inlined active-chat resolver. Mirrors the host's
 * `resolveActiveChatIdInAnyWindow`: prefer this window's active
 * chat, then walk panes, then fall back to any window.
 *
 * Returns chat / session / scope ids in one pass so the
 * extra-dirs section can re-use the same active-chat walk the
 * context grid already does. Re-implemented here (rather than
 * imported from `@/lib/...`) because this plugin lives in its
 * own package and doesn't resolve host-internal modules.
 */
function useActiveChat(windowId: string | null): ActiveChat {
  return useDb((root) => {
    const chatId = resolveActiveChatId(root, windowId);
    if (!chatId) return { chatId: null, sessionId: null, scopeId: null };
    const chat = root.app.chats[chatId];
    if (!chat) return { chatId, sessionId: null, scopeId: null };
    const sessionId =
      chat.session.kind === "ready" ? chat.session.sessionId : null;
    return { chatId, sessionId, scopeId: chat.scopeId ?? null };
  });
}

function resolveActiveChatId(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  root: any,
  windowId: string | null,
): string | null {
  const windows = root.app.windowStates as Record<string, any>;
  const order: any[] = [];
  if (windowId && windows[windowId]) order.push(windows[windowId]);
  for (const ws of Object.values(windows)) {
    if (!ws) continue;
    if (windowId && ws === windows[windowId]) continue;
    order.push(ws);
  }
  for (const ws of order) {
    if (!ws || ws.activeView?.kind !== "workspace") continue;
    const scopeId = ws.selectedScopeId as string | null;
    const paneState = scopeId ? ws.scopePanes?.[scopeId] : null;
    if (paneState) {
      const activePane =
        paneState.panes.find((p: any) => p.id === paneState.activePaneId) ??
        paneState.panes[0];
      const activeTab =
        activePane?.tabs.find((t: any) => t.id === activePane.activeTabId) ??
        activePane?.tabs[0];
      const direct = chatIdOf(activeTab);
      if (direct) return direct;
      for (const pane of paneState.panes) {
        const tab =
          pane.tabs.find((t: any) => t.id === pane.activeTabId) ?? pane.tabs[0];
        const id = chatIdOf(tab);
        if (id) return id;
      }
      for (const pane of paneState.panes) {
        for (const tab of pane.tabs) {
          const id = chatIdOf(tab);
          if (id) return id;
        }
      }
    }
    // Last-ditch: newest chat in the workspace.
    const workspaceId = ws.activeView.workspaceId as string | null;
    if (!workspaceId) continue;
    const workspaceScopes = new Set<string>();
    for (const scope of Object.values(root.app.scopes) as any[]) {
      if (scope.workspaceId === workspaceId) workspaceScopes.add(scope.id);
    }
    let latestId: string | null = null;
    let latestAt = -Infinity;
    for (const chat of Object.values(root.app.chats) as any[]) {
      if (!workspaceScopes.has(chat.scopeId)) continue;
      if (chat.createdAt > latestAt) {
        latestAt = chat.createdAt;
        latestId = chat.id;
      }
    }
    if (latestId) return latestId;
  }
  return null;
}

function chatIdOf(tab: any): string | null {
  if (!tab) return null;
  return tab.content?.kind === "chat" ? tab.content.chatId ?? null : null;
}
