import type { Root } from "./types"
import {
  isSidebarVisibleChat,
  latestSidebarVisibleChatIdInScope,
  primaryLiveScopeIdOf,
} from "./visibility"

/** Pull the active workspace id out of `activeView`. `null` when the
 * window isn't showing a workspace (e.g. onboarding). */
export function activeWorkspaceIdOf(
  ws: { activeView: { kind: string; workspaceId?: string } } | null | undefined,
): string | null {
  if (!ws) return null
  return ws.activeView.kind === "workspace" && ws.activeView.workspaceId
    ? ws.activeView.workspaceId
    : null
}

/** Active chat id for a window. Mirrors `useActiveChatId()` but
 * callable from imperative handlers (no hook). Falls through to
 * "any chat tab visible somewhere" if the active pane's active tab
 * isn't a chat — same heuristic the hook uses. */
export function activeChatIdOf(
  root: Root,
  windowId: string,
): string | null {
  const ws = root.app.windowStates[windowId]
  if (!ws) return null
  const scopeId = ws.selectedScopeId
  if (!scopeId) return null
  const paneState = ws.scopePanes?.[scopeId]
  if (!paneState) return null
  const pane =
    paneState.panes.find(p => p.id === paneState.activePaneId) ??
    paneState.panes[0]
  const tab =
    pane?.tabs.find(t => t.id === pane.activeTabId) ?? pane?.tabs[0]
  if (
    tab?.content.kind === "chat" &&
    tab.content.chatId &&
    isSidebarVisibleChat(root, tab.content.chatId)
  ) {
    return tab.content.chatId
  }
  for (const p of paneState.panes) {
    const active = p.tabs.find(t => t.id === p.activeTabId) ?? p.tabs[0]
    if (
      active?.content.kind === "chat" &&
      active.content.chatId &&
      isSidebarVisibleChat(root, active.content.chatId)
    ) {
      return active.content.chatId
    }
  }
  for (const p of paneState.panes) {
    for (const t of p.tabs) {
      if (
        t.content.kind === "chat" &&
        t.content.chatId &&
        isSidebarVisibleChat(root, t.content.chatId)
      ) {
        return t.content.chatId
      }
    }
  }
  return null
}

/** Earliest-created live scope in a workspace. Fallback target when no
 * scope is otherwise selected. */
export function primaryScopeIdOf(
  root: Root,
  workspaceId: string,
): string | null {
  return primaryLiveScopeIdOf(root, workspaceId)
}

/** Most recent sidebar-visible chat in a live scope (used to seed a
 * fresh pane layout). */
export function latestChatIdInScope(
  root: Root,
  scopeId: string,
): string | null {
  return latestSidebarVisibleChatIdInScope(root, scopeId)
}

/** Most recent chat across every scope in a workspace. */
export function latestChatIdInWorkspace(
  root: Root,
  workspaceId: string,
): string | null {
  const workspaceScopes = new Set<string>()
  for (const scope of Object.values(root.app.scopes)) {
    if (scope.workspaceId === workspaceId) workspaceScopes.add(scope.id)
  }
  let latestId: string | null = null
  let latestAt = -Infinity
  for (const chat of Object.values(root.app.chats)) {
    if (!workspaceScopes.has(chat.scopeId)) continue
    if (!isSidebarVisibleChat(root, chat.id)) continue
    if (chat.createdAt > latestAt) {
      latestAt = chat.createdAt
      latestId = chat.id
    }
  }
  return latestId
}
