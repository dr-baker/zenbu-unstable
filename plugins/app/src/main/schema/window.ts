import { z } from "@zenbujs/core/db";

// Tab id is open: `"agent"` is the built-in chat list; anything
// else is a plugin-contributed view type with
// `meta.kind = "left-sidebar"`. We don't enumerate plugin tabs in
// the schema because plugins come and go without a schema bump.
const leftSidebarTab = z.string();

/**
 * What the window's center pane currently shows. Discriminated so
 * a workspace id only exists when a workspace is actually open.
 *
 *  - `workspace`: a real workspace is open.
 *  - `onboarding`: the onboarding screen (used on first install
 *    and when the user clicks "+" in the workspace rail).
 *  - `view`: a workspace-less full-window view (e.g. Settings).
 *    `viewType` is not enumerated so plugins can plug in without
 *    a schema bump.
 *
 * TODO(zenbu.js): formalize as a core router primitive.
 */
const activeView = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("workspace"),
    workspaceId: z.string(),
  }),
  z.object({ kind: z.literal("onboarding") }),
  z.object({
    kind: z.literal("view"),
    viewType: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
]);

/**
 * Obsidian-style pane layout, persisted per-scope so swapping
 * worktrees inside a workspace also swaps the pane layout.
 *
 * Invariants the UI relies on:
 *  - `panes` is non-empty.
 *  - `activePaneId` names a pane in `panes`.
 *  - every pane's `tabs` is non-empty and `activeTabId` names a tab.
 */
const paneTabContent = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("chat"),
    chatId: z.string().nullable(),
  }),
  z.object({
    kind: z.literal("view"),
    viewType: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
]);

const paneTab = z.object({
  id: z.string(),
  content: paneTabContent,
});

const chatPane = z.object({
  id: z.string(),
  tabs: z.array(paneTab),
  activeTabId: z.string(),
});

const scopePaneState = z.object({
  panes: z.array(chatPane),
  activePaneId: z.string(),
});

/**
 * Per-workspace shell UI state. Holds the things that are truly
 * workspace-wide (don't change as the active worktree changes).
 * Per-scope right-sidebar/bottom-panel state lives on `scopeUiState`.
 *
 * Sizes are absolute pixels; `null` = "never saved, use default".
 */
const workspaceUiState = z.object({
  sidebarWidth: z.number().nullable().default(null),
  leftSidebarOpen: z.boolean().default(true),
  leftSidebarTab: leftSidebarTab.default("agent"),
});

/**
 * Per-scope shell UI state. The right sidebar / bottom panel are
 * already scope-parameterized, so their layout state follows the
 * active worktree the same way their content does.
 *
 * `null` size = "never saved, use default". `null` view selector =
 * "use the first registered view" / "panel is collapsed".
 */
const scopeUiState = z.object({
  rightSidebarWidth: z.number().nullable().default(null),
  terminalHeight: z.number().nullable().default(null),
  bottomPanelOpen: z.boolean().default(false),
  bottomPanelView: z.string().nullable().default(null),
  rightSidebarOpenType: z.string().nullable().default(null),
  rightSidebarLastType: z.string().nullable().default(null),
});

/**
 * Per-window state for the plugins root view
 * (`activeView.viewType === "plugins"`). Lives here rather than
 * on a workspace because the plugins view is workspace-less
 * (full-window), and we want two windows to be able to browse
 * different plugins independently.
 */
const pluginsViewState = z.object({
  /** Name of the plugin currently selected in the left list, or
   * `null` when nothing is selected (main pane falls back to the
   * marketplace view). */
  selectedPluginName: z.string().nullable().default(null),
  /** Whether the plugins-view's own sidebar is visible. Bound to
   * the title-bar sidebar toggle while on the plugins view.
   * Separate from `workspaceUiState.leftSidebarOpen` because the
   * plugins view isn't a workspace. */
  sidebarOpen: z.boolean().default(true),
})

export const windowState = z.object({
  /** Denormalized cache of the active scope id. Source of truth is
   * `workspaceActiveScope[activeView.workspaceId]`. */
  selectedScopeId: z.string().nullable(),
  scopeLastTerminal: z.record(z.string(), z.string()).default({}),
  activeView: activeView.default({ kind: "onboarding" }),
  /** Pane layout per scope. */
  scopePanes: z.record(z.string(), scopePaneState).default({}),
  /** Per-workspace memory of which scope was last active. */
  workspaceActiveScope: z.record(z.string(), z.string()).default({}),
  /** Whether the workspace rail is visible. Toggled with ⌘⇧B.
   * Window-scoped because the rail shows all workspaces. On by
   * default so the project sidebar is visible immediately. */
  workspaceRailOpen: z.boolean().default(true),
  workspaceUiStates: z.record(z.string(), workspaceUiState).default({}),
  scopeUiStates: z.record(z.string(), scopeUiState).default({}),
  /** Plugins-root-view state (selection + sidebar open). Used
   * only while `activeView` is the plugins view; otherwise
   * ignored. */
  pluginsView: pluginsViewState.default({
    selectedPluginName: null,
    sidebarOpen: true,
  }),
  /** Native fullscreen state, synced by `WindowFullscreenService`.
   * Title bar uses it to collapse the traffic-light gutter. */
  fullscreen: z.boolean().default(false),
});
