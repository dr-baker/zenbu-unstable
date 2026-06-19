import type { Root, WindowState } from "./types"
import { ensureWindowState } from "./ensure"
import { activeWorkspaceIdOf, primaryScopeIdOf } from "./derived"
import { isLiveScope, isSidebarVisibleChat } from "./visibility"
import {
  chatIdOf,
  ensureScopePanes,
  setTabContent,
} from "./panes/internal"

/** Switch the window to a workspace view. */
export function setActiveWorkspace(
  ws: WindowState,
  workspaceId: string,
): void {
  ws.activeView = { kind: "workspace", workspaceId }
}

/** Switch the active scope inside the active workspace. Source of
 * truth for "which scope's panes are currently rendered". Updates
 * `selectedScopeId` (denormalized cache) and the workspace's last-
 * used-scope memory, and materializes the scope's pane layout. */
export function setActiveScope(
  root: Root,
  windowId: string,
  scopeId: string,
): void {
  const scope = root.app.scopes[scopeId]
  if (!scope || !isLiveScope(root, scopeId)) return
  const ws = ensureWindowState(root, windowId)
  setActiveWorkspace(ws, scope.workspaceId)
  ws.selectedScopeId = scopeId
  ws.workspaceActiveScope[scope.workspaceId] = scopeId
  ensureScopePanes(root, windowId, scopeId)
}

/** Switch to a workspace. Restores its last-used scope (or its
 * primary scope) and ensures the resulting scope has a pane layout. */
export function selectWorkspaceInRoot(
  root: Root,
  windowId: string,
  workspaceId: string,
): void {
  const ws = ensureWindowState(root, windowId)
  setActiveWorkspace(ws, workspaceId)
  const remembered = ws.workspaceActiveScope[workspaceId] ?? null
  const candidate =
    remembered && isLiveScope(root, remembered)
      ? remembered
      : primaryScopeIdOf(root, workspaceId)
  if (candidate) {
    setActiveScope(root, windowId, candidate)
  } else {
    // No scopes yet; clear the cache so consumers don't see a
    // stale scope id from another workspace.
    ws.selectedScopeId = null
  }
}

/** Public alias for setting the scope from outside this module
 * (e.g. clicking a worktree row in the sidebar). */
export function selectScopeInRoot(
  root: Root,
  windowId: string,
  scopeId: string,
): void {
  setActiveScope(root, windowId, scopeId)
}

/** Focus a chat: switch workspace + scope, then either focus an
 * existing tab in the scope's panes or replace the active tab. */
export function selectChatInRoot(
  root: Root,
  windowId: string,
  chatId: string,
): void {
  const chat = root.app.chats[chatId]
  if (!chat || !isSidebarVisibleChat(root, chatId)) return
  const scope = root.app.scopes[chat.scopeId]
  if (!scope) return
  setActiveScope(root, windowId, chat.scopeId)
  const state = ensureScopePanes(root, windowId, chat.scopeId)

  for (const pane of state.panes) {
    const tab = pane.tabs.find(t => chatIdOf(t) === chatId)
    if (!tab) continue
    state.activePaneId = pane.id
    pane.activeTabId = tab.id
    return
  }

  const pane = state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]!
  const tabIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
  const idx = tabIdx >= 0 ? tabIdx : 0
  const tab = pane.tabs[idx]!
  const nextTabs = pane.tabs.slice()
  nextTabs[idx] = setTabContent(tab, { kind: "chat", chatId })
  const paneIdx = state.panes.findIndex(p => p.id === pane.id)
  if (paneIdx >= 0) {
    state.panes[paneIdx] = { ...pane, tabs: nextTabs, activeTabId: tab.id }
  }
}

/** If a tab already shows this chat in the chat's scope, focus it
 * and return true. Lets the sidebar prefer "reveal existing tab"
 * over "replace active tab". */
export function focusPaneShowingChatInRoot(
  root: Root,
  windowId: string,
  chatId: string,
): boolean {
  const chat = root.app.chats[chatId]
  if (!chat || !isSidebarVisibleChat(root, chatId)) return false
  if (!root.app.scopes[chat.scopeId]) return false
  const ws = root.app.windowStates[windowId]
  const state = ws?.scopePanes?.[chat.scopeId]
  if (!state) return false
  for (const pane of state.panes) {
    const tab = pane.tabs.find(t => chatIdOf(t) === chatId)
    if (!tab) continue
    setActiveScope(root, windowId, chat.scopeId)
    state.activePaneId = pane.id
    pane.activeTabId = tab.id
    return true
  }
  return false
}

export function selectPaneInRoot(
  root: Root,
  windowId: string,
  scopeId: string,
  paneId: string,
): void {
  if (!isLiveScope(root, scopeId)) return
  const state = ensureScopePanes(root, windowId, scopeId)
  if (!state.panes.some(p => p.id === paneId)) return
  state.activePaneId = paneId
  setActiveScope(root, windowId, scopeId)
}

export function selectTabInRoot(
  root: Root,
  windowId: string,
  scopeId: string,
  paneId: string,
  tabId: string,
): void {
  if (!isLiveScope(root, scopeId)) return
  const state = ensureScopePanes(root, windowId, scopeId)
  const pane = state.panes.find(p => p.id === paneId)
  if (!pane) return
  if (!pane.tabs.some(t => t.id === tabId)) return
  pane.activeTabId = tabId
  state.activePaneId = paneId
  setActiveScope(root, windowId, scopeId)
}
