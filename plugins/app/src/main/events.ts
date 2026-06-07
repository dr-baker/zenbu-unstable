export type Events = {
  /** Toggle general command palette (Cmd+Shift+P) */
  toggleCommandPalette: { source: string };
  /** Toggle agents palette (Cmd+P) */
  toggleAgentsPalette: { source: string };
  /** Toggle terminal (Cmd+J) */
  toggleTerminal: { source: string };
  /** Split pane, same session (Cmd+/) */
  splitPaneSameSession: { source: string };
  /** Split pane, new chat/session (Cmd+Shift+/) */
  splitPaneNewChat: { source: string };
  /** Close active pane (Cmd+W, no-op on last pane) */
  closeActivePane: { source: string };
  /** Toggle left sidebar (Cmd+B) */
  toggleSidebar: { source: string };
  /** Toggle right sidebar (Cmd+G) */
  toggleRightSidebar: { source: string };
  /** Toggle workspace rail (Cmd+Shift+B) */
  toggleWorkspaceRail: { source: string };
  /** New chat in current pane (Cmd+T) */
  newChatInCurrentPane: { source: string };
  /** Replace active tab with new chat/session (Cmd+N, or sidebar's New Chat) */
  newChatReplaceActive: { source: string };
  /** Terminal stdout chunk with sequence number for deduping */
  terminalData: { terminalId: string; data: string; seq: number };
  /** Terminal session ended */
  terminalExit: { terminalId: string; exitCode: number; signal: number };
  /** create-app stdout/stderr line */
  createAppProgress: {
    runId: string;
    line: string;
    stream: "stdout" | "stderr";
  };
  /** create-app finished; ok on exit code 0 */
  createAppDone: {
    runId: string;
    ok: boolean;
    error?: string;
    /** Absolute app path on success */
    appPath?: string;
  };
  /** create-plugin progress line (git worktree, scaffold, prelude) */
  createPluginProgress: {
    runId: string;
    line: string;
    stream: "stdout" | "stderr" | "step";
  };
  /** create-plugin finished; provides next focus info on success */
  createPluginDone: {
    runId: string;
    ok: boolean;
    error?: string;
    pluginName?: string;
    /** Absolute path of the scaffolded plugin source
     * (`~/.zenbu/plugins/<name>`). The marketplace sidebar opens the
     * new window at this path. */
    pluginPath?: string;
  };
  /**
   * `plugin-dev` runtime events. The title-bar "Run in Dev" button
   * spawns a fresh Electron instance of the host with
   * `--plugin=<manifest>` so the user's in-progress plugin loads
   * alongside the configured set. These events let the renderer
   * surface success / failure toasts without polling.
   */
  pluginDevRunStart: { runId: string; pluginPath: string };
  pluginDevRunError: {
    runId: string;
    pluginPath: string;
    message: string;
  };
  pluginDevRunExit: { runId: string; exitCode: number | null };
  /** Result of `installLocal` (writing the path into `zenbu.plugins.local.jsonc`). */
  pluginDevInstallDone: {
    pluginPath: string;
    ok: boolean;
    error?: string;
  };
  /** File clicked in sidebar; opens file view in active pane */
  openFileInActivePane: {
    directory: string;
    path: string;
  };
  /** File diff clicked; opens git-diff view in proper workspace/scope */
  openDiffInActivePane: {
    workspaceId: string;
    scopeId: string;
    directory: string;
    path: string;
  };
  /** Tool-call output preview clicked; opens tool output view in side pane */
  openToolOutputInActivePane: {
    workspaceId: string;
    scopeId: string;
    sessionId: string;
    toolCallId: string;
  };
  /** Plugin asks shell to open one of its views in active pane.
   *
   * `placement` controls which side of the active pane the new
   * pane lands on the *first* time this `source` is opened
   * (subsequent opens with the same `source` just navigate the
   * existing tab in place). Defaults to `"right"` so legacy
   * callers (file-tree, plan, etc.) keep their historical
   * "appears to the right" behavior.
   *
   * `placement: "tab"` opens the view as a new tab in the active
   * pane instead of splitting into a sibling pane. Re-opening with
   * the same `source` still navigates the existing tab in place. */
  openViewInActivePane: {
    viewType: string;
    source: string;
    args: Record<string, unknown>;
    placement?: "left" | "right" | "tab";
  };
  /** Open Pull Requests view with mode & routing. openMode: new-tab, split-right, replace */
  openPullRequestsView: {
    mode: "create" | "list" | "detail";
    prNumber: number | null;
    directory: string | null;
    openMode: "new-tab" | "split-right" | "replace";
  };
  /** Append text to a Composer draft. Used for revert flow, etc. */
  appendComposerDraft: {
    composerId: string;
    text: string;
  };
  /** Session completed (not currently viewed); triggers notification toast */
  agentCompletedUnviewed: {
    sessionId: string
    chatId: string | null
    label: string
  }
  // `playExit` also moved to the `play` plugin (see note above).
  /**
   * Cmd+0 — focus the agent sidebar. Fired regardless of context so
   * the user can always pull keyboard focus back to the sidebar.
   * The active left-sidebar plugin view subscribes and routes
   * focus into its own `<ListNav>` scope (`useListNav(id).focus()`),
   * which makes that scope's per-list shortcuts (j/k/h/l/Space…)
   * start firing.
   */
  focusSidebar: { source: string }
  /**
   * Cmd+1…Cmd+9 — focus pane N (1-indexed) in the active scope. If
   * pane N doesn't exist, the renderer creates it via
   * `splitPaneSameSessionInRoot` first, then focuses it. Once
   * focused, the renderer routes DOM focus into the pane's active
   * content (composer for a chat tab; iframe for a view tab).
   */
  focusPane: { index: number; source: string }
  /**
   * Cmd+Shift+[ / Cmd+Shift+] — cycle the active tab in the active
   * pane left/right. Wraps around at the edges. No-op when the
   * active pane only has one tab. Listener lives in the renderer
   * (`useNavigateTabsShortcut`) and updates `activeTabId` in the
   * pane state. Mirrors macOS-native tab navigation in Safari /
   * Chrome / Finder / Terminal.
   */
  navigateTabs: { dir: "prev" | "next"; source: string }
  /**
   * Cmd+L — focus the composer (input) of the chat showing in the
   * active pane. No-op when the active tab isn't a chat. Listener
   * lives in the renderer (`useFocusActiveComposerShortcut`) and
   * dispatches the in-renderer `requestFocusComposer(chatId)`
   * signal.
   */
  focusActiveComposer: { source: string }
  /**
   * Open a plugin-contributed sidebar view by view type. Fired by
   * the auto-registered per-view shortcut/palette action created in
   * `SidebarViewShortcutsService`. The renderer ensures the relevant
   * sidebar is open (left or right depending on `kind`) and selects
   * `viewType` as the active tab. If the view is already the active
   * tab in an open sidebar, the renderer toggles the sidebar closed
   * (VS Code-style press-again-to-hide behaviour).
   *
   * `kind` is determined at registration time from the view's
   * `meta`: `meta.kind === "left-sidebar"` → `"left"`, and the
   * existing `meta.sidebar === true` convention → `"right"`. A
   * view that satisfies both gets two registrations (one per side).
   */
  openSidebarView: { viewType: string; kind: "left" | "right"; source: string }
  /**
   * Terminal-context shortcuts. Gated on the `app.terminal` and
   * `app.terminal.tabs` focus contexts in `ShortcutsService_App`
   * (see `services/shortcuts.ts`). The terminal plugin's
   * `terminal-view.tsx` installs those contexts on its root div
   * and tab strip respectively, and subscribes to these events to
   * drive creation / tab navigation.
   */
  terminalNew: { source: string }
  terminalFocusTabs: { source: string }
  terminalFocusActive: { source: string }
  terminalTabsMove: { dir: "up" | "down"; source: string }
  terminalTabsActivate: { source: string }
  terminalTabsClose: { source: string }
  /**
   * ⌘, — open the settings view in a new tab in the active pane.
   * Renderer subscribes and calls `openViewInRoot("settings", "new-tab")`.
   * Fired by the `app.openSettings` shortcut and the matching
   * palette action (see `services/shortcuts.ts`).
   */
  openSettings: {
    source: string
    /** Settings tab to land on. `"plugins"` pairs with the
     * optional `sectionId` to deep-link into a specific plugin
     * section (e.g. pi-commands' `/settings` slash command). */
    tab?: "general" | "accounts" | "shortcuts" | "plugins"
    sectionId?: string
  }
  /**
   * Generic keyboard-nav events for any `<ListNav>` instance
   * (see `@zenbu/ui/list-nav`). Each event is tagged with the
   * `scopeId` the consumer passed as the `id` prop, which is also
   * the `when:` clause on the underlying shortcuts. The renderer
   * primitive subscribes filtered by its own scopeId so multiple
   * lists on the same screen don't cross-fire.
   */
  listNavMove: { scopeId: string; dir: "up" | "down"; source: string }
  listNavStep: { scopeId: string; dir: "in" | "out"; source: string }
  listNavPage: { scopeId: string; dir: "up" | "down"; source: string }
  /** `alt` is true when fired by the secondary activate binding
   * (Enter by default). Lets consumers branch on "open" vs
   * "open in new tab" semantics without registering a separate
   * scope. */
  listNavActivate: { scopeId: string; alt: boolean; source: string }
  /**
   * Generic main→renderer notification. The renderer
   * (`NotifyListener`) subscribes and routes each event into the
   * sonner toaster with the matching tone. Use this from main‐
   * process services for one-shot user-visible feedback that
   * isn't tied to a specific in-app surface (e.g. "git is not
   * installed", "failed to write file", …). For long-running
   * progress, prefer a domain-specific event so the toast can
   * stay live and update in place.
   */
  notify: {
    tone: "error" | "success" | "info" | "warning"
    title: string
    description?: string
  }
}
