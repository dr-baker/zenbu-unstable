import { nanoid } from "nanoid"
import type { OpenMode, Root } from "../types"
import { setActiveScope, setActiveWorkspace } from "../selection"
import { ensureWindowState } from "../ensure"
import {
  ensureScopePanes,
  makeTab,
  setTabContent,
} from "./internal"

export const VIEW_SOURCE_KEY = "__source"

/**
 * Settings-as-an-action entry point. Two routes:
 *  - On a workspace view: append a regular tab in the active pane,
 *    same gesture as any other "open view in new tab" action.
 *  - On anything else (onboarding, or the global settings view is
 *    already up): replace `activeView` with the workspace-less
 *    `{ kind: "view", viewType: "settings" }`, which the sidebar
 *    renders full-area. We deliberately don't fall through to
 *    `openViewInRoot` here because it would call `setActiveScope`
 *    and silently jump us into the last-used workspace.
 *
 * Lives next to the other pane helpers (rather than in the
 * renderer components) so the sidebar click and the
 * `events.app.openSettings` listener can share one implementation.
 */
export function openSettingsInRoot(
  root: Root,
  windowId: string,
  args: Record<string, unknown> = {},
): void {
  // `useActiveView()` falls back to `{ kind: "onboarding" }` when
  // `windowStates[windowId]` is missing, so the UI happily renders
  // the onboarding screen on a fresh launch even though the DB
  // entry has never been created. If we bail here on a missing
  // entry the rail's gear button silently no-ops on first launch
  // (no logs, no DB write, no re-render) until something else —
  // selecting a workspace, hitting the `+` tile — materializes
  // the window state via `ensureWindowState`. Materialize it
  // ourselves so the very first click works.
  const ws = ensureWindowState(root, windowId)
  if (ws.activeView.kind !== "workspace") {
    ws.activeView = { kind: "view", viewType: "settings", args }
    return
  }
  openViewInRoot(root, windowId, "settings", "new-tab", args)
}

/** Open a registered view in the active scope's panes. Returns
 * `false` when there's no active scope (e.g. onboarding). */
export function openViewInRoot(
  root: Root,
  windowId: string,
  viewType: string,
  mode: OpenMode,
  args: Record<string, unknown> = {},
): boolean {
  const ws = root.app.windowStates[windowId]
  if (!ws) return false
  const scopeId = ws.selectedScopeId
  if (!scopeId) return false
  const state = ensureScopePanes(root, windowId, scopeId)
  const activePane =
    state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]
  if (!activePane) return false

  const tabContent = { kind: "view" as const, viewType, args }

  if (mode === "split-right" || mode === "split-left") {
    const paneId = nanoid()
    const tabId = nanoid()
    const newPane = {
      id: paneId,
      tabs: [makeTab(tabId, tabContent)],
      activeTabId: tabId,
    }
    // Insert the new pane either *after* (split-right) or *before*
    // (split-left) the currently-active pane in the row, so the
    // splitview renders it on the correct side. Falling back to
    // append/prepend if the active pane somehow isn't in the list.
    const activeIdx = state.panes.findIndex(p => p.id === activePane.id)
    if (mode === "split-right") {
      const at = activeIdx < 0 ? state.panes.length : activeIdx + 1
      state.panes = [
        ...state.panes.slice(0, at),
        newPane,
        ...state.panes.slice(at),
      ]
    } else {
      const at = activeIdx < 0 ? 0 : activeIdx
      state.panes = [
        ...state.panes.slice(0, at),
        newPane,
        ...state.panes.slice(at),
      ]
    }
    state.activePaneId = paneId
    setActiveScope(root, windowId, scopeId)
    return true
  }

  const paneIdx = state.panes.findIndex(p => p.id === activePane.id)
  if (paneIdx < 0) return false
  const pane = state.panes[paneIdx]!

  if (mode === "new-tab") {
    const tabId = nanoid()
    const activeIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
    const insertAt = activeIdx < 0 ? pane.tabs.length : activeIdx + 1
    state.panes[paneIdx] = {
      ...pane,
      tabs: [
        ...pane.tabs.slice(0, insertAt),
        makeTab(tabId, tabContent),
        ...pane.tabs.slice(insertAt),
      ],
      activeTabId: tabId,
    }
    state.activePaneId = pane.id
    setActiveScope(root, windowId, scopeId)
    return true
  }

  const tabIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
  if (tabIdx < 0) return false
  const tab = pane.tabs[tabIdx]!
  const nextTabs = pane.tabs.slice()
  nextTabs[tabIdx] = setTabContent(tab, tabContent)
  state.panes[paneIdx] = { ...pane, tabs: nextTabs, activeTabId: tab.id }
  state.activePaneId = pane.id
  setActiveScope(root, windowId, scopeId)
  return true
}

/** Open a view, but if a tab tagged with the same `source` already
 * exists in the active scope's panes, navigate that tab instead of
 * spawning a new one.
 *
 * `placement` controls which side of the active pane the new pane
 * lands on for the "no existing tab" fall-through case. Existing
 * callers (file-tree, marketplace, etc.) get the historical
 * right-of-active default; pass `"left"` to flip it. Has no effect
 * when a matching tab already exists — we just navigate that one
 * in place. */
export function openViewBySourceInRoot(
  root: Root,
  windowId: string,
  viewType: string,
  source: string,
  args: Record<string, unknown> = {},
  placement: "left" | "right" | "tab" = "right",
): boolean {
  const ws = root.app.windowStates[windowId]
  if (!ws) return false
  const scopeId = ws.selectedScopeId
  if (!scopeId) return false
  const state = ensureScopePanes(root, windowId, scopeId)

  const taggedArgs = { ...args, [VIEW_SOURCE_KEY]: source }
  const tabContent = { kind: "view" as const, viewType, args: taggedArgs }

  for (let pIdx = 0; pIdx < state.panes.length; pIdx++) {
    const pane = state.panes[pIdx]!
    for (let tIdx = 0; tIdx < pane.tabs.length; tIdx++) {
      const tab = pane.tabs[tIdx]!
      if (tab.content.kind !== "view") continue
      const tagged = tab.content.args?.[VIEW_SOURCE_KEY]
      if (tagged !== source) continue
      const nextTabs = pane.tabs.slice()
      nextTabs[tIdx] = setTabContent(tab, tabContent)
      state.panes[pIdx] = { ...pane, tabs: nextTabs, activeTabId: tab.id }
      state.activePaneId = pane.id
      setActiveScope(root, windowId, scopeId)
      return true
    }
  }

  if (state.panes.length === 0) return false

  const activePane =
    state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]!

  // `placement: "tab"` — no matching source tab exists yet, so open
  // the view as a new tab in the active pane (next to its current
  // tab) instead of spawning a sibling pane / split.
  if (placement === "tab") {
    const paneIdx = state.panes.findIndex(p => p.id === activePane.id)
    if (paneIdx < 0) return false
    const pane = state.panes[paneIdx]!
    const tabId = nanoid()
    const activeTabIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
    const insertAt = activeTabIdx < 0 ? pane.tabs.length : activeTabIdx + 1
    state.panes[paneIdx] = {
      ...pane,
      tabs: [
        ...pane.tabs.slice(0, insertAt),
        makeTab(tabId, tabContent),
        ...pane.tabs.slice(insertAt),
      ],
      activeTabId: tabId,
    }
    state.activePaneId = pane.id
    setActiveScope(root, windowId, scopeId)
    return true
  }

  const paneId = nanoid()
  const tabId = nanoid()
  const newPane = {
    id: paneId,
    tabs: [makeTab(tabId, tabContent)],
    activeTabId: tabId,
  }
  const activeIdx = state.panes.findIndex(p => p.id === activePane.id)
  const insertAt =
    placement === "left"
      ? activeIdx < 0
        ? 0
        : activeIdx
      : activeIdx < 0
        ? state.panes.length
        : activeIdx + 1
  state.panes = [
    ...state.panes.slice(0, insertAt),
    newPane,
    ...state.panes.slice(insertAt),
  ]
  state.activePaneId = paneId
  setActiveScope(root, windowId, scopeId)
  return true
}

/** Like {@link openViewBySourceInRoot}, but with the target workspace
 * and scope passed in explicitly. Used by events that carry their own
 * routing context (e.g. `openDiffInActivePane` from turn-summary
 * cards) so a click from one workspace can open a view in another
 * workspace's scope without forcing the user to navigate first. */
export function openViewBySourceInWorkspaceInRoot(
  root: Root,
  windowId: string,
  workspaceId: string,
  scopeId: string | null,
  viewType: string,
  source: string,
  args: Record<string, unknown> = {},
): boolean {
  if (!root.app.workspaces[workspaceId]) return false
  const ws = ensureWindowState(root, windowId)
  setActiveWorkspace(ws, workspaceId)

  // Resolve the target scope: caller's choice if it exists, else
  // the workspace's last-active scope, else give up.
  const targetScopeId =
    scopeId && root.app.scopes[scopeId]
      ? scopeId
      : ws.workspaceActiveScope[workspaceId] ?? null
  if (!targetScopeId) return false
  setActiveScope(root, windowId, targetScopeId)
  const state = ensureScopePanes(root, windowId, targetScopeId)

  const taggedArgs = { ...args, [VIEW_SOURCE_KEY]: source }
  const tabContent = { kind: "view" as const, viewType, args: taggedArgs }

  for (let pIdx = 0; pIdx < state.panes.length; pIdx++) {
    const pane = state.panes[pIdx]!
    for (let tIdx = 0; tIdx < pane.tabs.length; tIdx++) {
      const tab = pane.tabs[tIdx]!
      if (tab.content.kind !== "view") continue
      const tagged = tab.content.args?.[VIEW_SOURCE_KEY]
      if (tagged !== source) continue
      const nextTabs = pane.tabs.slice()
      nextTabs[tIdx] = setTabContent(tab, tabContent)
      state.panes[pIdx] = { ...pane, tabs: nextTabs, activeTabId: tab.id }
      state.activePaneId = pane.id
      return true
    }
  }

  if (state.panes.length === 0) return false
  const paneId = nanoid()
  const tabId = nanoid()
  state.panes = [
    ...state.panes,
    {
      id: paneId,
      tabs: [makeTab(tabId, tabContent)],
      activeTabId: tabId,
    },
  ]
  state.activePaneId = paneId
  return true
}
