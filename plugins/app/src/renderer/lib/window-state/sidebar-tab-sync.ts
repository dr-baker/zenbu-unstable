import { useEffect } from "react"
import { useDb, useDbClient } from "@zenbujs/core/react"
import type {
  PaneTabView,
  PaneView,
  Root,
  ScopePaneStateView,
  WindowState,
} from "./types"
import {
  isLiveScope,
  isSidebarVisibleChat,
  primaryLiveScopeIdOf,
} from "./visibility"

/**
 * Keeps tab state subordinate to the same visibility rules as the
 * agent sidebar. If a chat disappears from the sidebar because its
 * session, scope, workspace, or chat record was archived/deleted, any
 * tab pointing at it is closed instead of lingering as a stale surface.
 */
export function useSidebarTabSync(): void {
  const dbClient = useDbClient()
  const syncKey = useDb(root => sidebarTabSyncKey(root))

  useEffect(() => {
    if (!syncKey) return
    void dbClient.update(root => {
      reconcileHiddenChatTabsInRoot(root)
    })
  }, [dbClient, syncKey])
}

/** Cheap invalid-reference fingerprint. Empty string means there is
 * nothing for the effect to reconcile, so we avoid issuing no-op DB
 * writes on ordinary chat/session updates. */
export function sidebarTabSyncKey(root: Root): string {
  const parts: string[] = []

  for (const [windowId, ws] of Object.entries(root.app.windowStates)) {
    const selectedScopeId = ws.selectedScopeId
    if (selectedScopeId && !isLiveScope(root, selectedScopeId)) {
      parts.push(`selected:${windowId}:${selectedScopeId}`)
    }

    for (const [workspaceId, scopeId] of Object.entries(
      ws.workspaceActiveScope ?? {},
    )) {
      if (scopeId && !isLiveScope(root, scopeId)) {
        parts.push(`memory:${windowId}:${workspaceId}:${scopeId}`)
      }
    }

    for (const [scopeId, paneState] of Object.entries(ws.scopePanes ?? {})) {
      if (!isLiveScope(root, scopeId)) {
        parts.push(`scope:${windowId}:${scopeId}`)
        continue
      }
      for (const pane of paneState.panes) {
        for (const tab of pane.tabs) {
          if (!shouldKeepTab(root, tab)) {
            parts.push(`tab:${windowId}:${scopeId}:${pane.id}:${tab.id}`)
          }
        }
      }
    }
  }

  for (const [windowId, state] of Object.entries(root.app.chatWindows)) {
    for (const chatId of state.tabs) {
      if (!isSidebarVisibleChat(root, chatId)) {
        parts.push(`chat-window:${windowId}:${chatId}`)
      }
    }
    if (state.activeChatId && !state.tabs.includes(state.activeChatId)) {
      parts.push(`chat-window-active:${windowId}:${state.activeChatId}`)
    }
  }

  return parts.join("|")
}

export function reconcileHiddenChatTabsInRoot(root: Root): boolean {
  let changed = false

  for (const ws of Object.values(root.app.windowStates)) {
    if (reconcileWindowState(root, ws)) changed = true
  }

  for (const state of Object.values(root.app.chatWindows)) {
    if (reconcileChatWindowState(root, state)) changed = true
  }

  return changed
}

function reconcileWindowState(root: Root, ws: WindowState): boolean {
  let changed = false

  for (const [scopeId, paneState] of Object.entries(ws.scopePanes ?? {})) {
    if (!isLiveScope(root, scopeId)) {
      delete ws.scopePanes[scopeId]
      changed = true
      continue
    }

    const result = pruneScopePaneState(root, paneState)
    if (result === "empty") {
      delete ws.scopePanes[scopeId]
      changed = true
    } else if (result === "changed") {
      changed = true
    }
  }

  if (reconcileWorkspaceScopeMemory(root, ws)) changed = true
  return changed
}

function reconcileWorkspaceScopeMemory(root: Root, ws: WindowState): boolean {
  let changed = false

  for (const [workspaceId, scopeId] of Object.entries(
    ws.workspaceActiveScope ?? {},
  )) {
    if (!scopeId || isLiveScope(root, scopeId)) continue
    const replacement = primaryLiveScopeIdOf(root, workspaceId)
    if (replacement) ws.workspaceActiveScope[workspaceId] = replacement
    else delete ws.workspaceActiveScope[workspaceId]
    changed = true
  }

  const selectedScopeId = ws.selectedScopeId
  if (!selectedScopeId || isLiveScope(root, selectedScopeId)) return changed

  const selectedScope = root.app.scopes[selectedScopeId]
  const workspaceId =
    ws.activeView.kind === "workspace"
      ? ws.activeView.workspaceId
      : selectedScope?.workspaceId ?? null
  const replacement = workspaceId
    ? primaryLiveScopeIdOf(root, workspaceId)
    : null

  ws.selectedScopeId = replacement
  if (workspaceId) {
    if (replacement) ws.workspaceActiveScope[workspaceId] = replacement
    else delete ws.workspaceActiveScope[workspaceId]
  }
  return true
}

type PruneResult = "same" | "changed" | "empty"

function pruneScopePaneState(
  root: Root,
  state: ScopePaneStateView,
): PruneResult {
  const activePaneIdx = state.panes.findIndex(p => p.id === state.activePaneId)
  const kept: Array<{ pane: PaneView; index: number }> = []
  let changed = false

  state.panes.forEach((pane, index) => {
    const result = prunePaneTabs(root, pane)
    if (!result) {
      changed = true
      return
    }
    if (result.changed) changed = true
    kept.push({ pane: result.pane, index })
  })

  if (kept.length === 0) return "empty"

  let activePaneId = state.activePaneId
  if (!kept.some(entry => entry.pane.id === activePaneId)) {
    activePaneId = pickNeighbor(kept, activePaneIdx).pane.id
    changed = true
  }

  if (!changed) return "same"
  state.panes = kept.map(entry => entry.pane)
  state.activePaneId = activePaneId
  return "changed"
}

function prunePaneTabs(
  root: Root,
  pane: PaneView,
): { pane: PaneView; changed: boolean } | null {
  const activeTabIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
  const kept: Array<{ tab: PaneTabView; index: number }> = []
  let changed = false

  pane.tabs.forEach((tab, index) => {
    if (shouldKeepTab(root, tab)) {
      kept.push({ tab, index })
    } else {
      changed = true
    }
  })

  if (kept.length === 0) return null

  let activeTabId = pane.activeTabId
  if (!kept.some(entry => entry.tab.id === activeTabId)) {
    activeTabId = pickNeighbor(kept, activeTabIdx).tab.id
    changed = true
  }

  if (!changed) return { pane, changed: false }
  return {
    pane: {
      ...pane,
      tabs: kept.map(entry => entry.tab),
      activeTabId,
    },
    changed: true,
  }
}

function shouldKeepTab(root: Root, tab: PaneTabView): boolean {
  if (tab.content.kind === "view") return true
  // A null chat id is the app's intentional "empty new tab" handle;
  // ChatPaneContainer materializes it into a real chat when shown.
  if (tab.content.chatId == null) return true
  return isSidebarVisibleChat(root, tab.content.chatId)
}

function reconcileChatWindowState(
  root: Root,
  state: Root["app"]["chatWindows"][string],
): boolean {
  let changed = false
  const activeIdx = state.activeChatId
    ? state.tabs.indexOf(state.activeChatId)
    : -1
  const kept: Array<{ chatId: string; index: number }> = []

  state.tabs.forEach((chatId, index) => {
    if (isSidebarVisibleChat(root, chatId)) {
      kept.push({ chatId, index })
    } else {
      changed = true
    }
  })

  const activeKept =
    state.activeChatId != null &&
    kept.some(entry => entry.chatId === state.activeChatId)
  if (!activeKept) {
    state.activeChatId =
      kept.length > 0 ? pickNeighbor(kept, activeIdx).chatId : null
    changed = true
  }

  if (!changed) return false
  state.tabs = kept.map(entry => entry.chatId)
  return true
}

function pickNeighbor<T extends { index: number }>(
  entries: T[],
  removedIndex: number,
): T {
  if (removedIndex >= 0) {
    const right = entries.find(entry => entry.index > removedIndex)
    if (right) return right
    for (let i = entries.length - 1; i >= 0; i--) {
      const left = entries[i]!
      if (left.index < removedIndex) return left
    }
  }
  return entries[0]!
}
