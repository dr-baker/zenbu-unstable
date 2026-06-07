import type { useDbClient } from "@zenbujs/core/react"

export type DbClient = ReturnType<typeof useDbClient>
export type UpdateFn = Parameters<DbClient["update"]>[0]
export type Root = Parameters<UpdateFn>[0]

export type WindowState = NonNullable<Root["app"]["windowStates"][string]>
export type WorkspaceUiStateRecord = WindowState["workspaceUiStates"][string]
export type ScopeUiStateRecord = WindowState["scopeUiStates"][string]

export type PaneTabContent =
  | { kind: "chat"; chatId: string | null }
  | { kind: "view"; viewType: string; args: Record<string, unknown> }

export type PaneTabView = {
  id: string
  content: PaneTabContent
}

export type PaneView = {
  id: string
  tabs: PaneTabView[]
  activeTabId: string
}

export type ScopePaneStateView = {
  panes: PaneView[]
  activePaneId: string
}

export type ActiveView =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "onboarding" }
  // Workspace-less full-area view (e.g. Settings opened while no
  // workspace is active). Kept in sync by hand with the schema's
  // `activeView` discriminated union in `main/schema.ts`.
  | { kind: "view"; viewType: string; args: Record<string, unknown> }

/**
 * The active left-sidebar tab.
 *
 * `"agent"` is the built-in chat list (still rendered in-process by
 * the host shell). Any other string is a view `type` from the view
 * registry tagged `meta.kind = "left-sidebar"` — plugins surface
 * their own tabs by registering such a view (see
 * `plugins/plugins` for a worked example).
 */
export type LeftSidebarTab = string

/**
 * How a view-open request should land relative to the active pane.
 *
 *  - `"new-tab"`     append a tab to the active pane.
 *  - `"replace"`     overwrite the active pane's current tab.
 *  - `"split-right"` create a new pane to the right of the active
 *                    pane and focus it.
 *  - `"split-left"`  same, but insert the new pane *before* the
 *                    active pane in the row, so it visually opens
 *                    on the left side of the splitview.
 */
export type OpenMode =
  | "new-tab"
  | "replace"
  | "split-right"
  | "split-left"

export type SplitPaneResult =
  | {
      kind: "chat"
      scopeId: string
      chatId: string
      paneId: string
      needsSession: boolean
    }
  | {
      kind: "view"
      paneId: string
    }

export type WorkspaceLayoutView = {
  sidebarWidth: number | null
  rightSidebarWidth: number | null
  terminalHeight: number | null
}
