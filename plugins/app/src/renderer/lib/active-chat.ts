import { useDbClient } from "@zenbujs/core/react"
import { isSidebarVisibleChat } from "./window-state/visibility"

/**
 * One authoritative resolver for "which chat does this window
 * currently care about?". Imported by the main renderer
 * (`window-state.ts`) and by iframe views (context-sidebar,
 * pi-event-log) so every consumer agrees on the answer.
 *
 * Background: the agent sidebar, terminal, right sidebar, file
 * tree, git tree, PR view, context sidebar, command palette and a
 * pile of iframe views all want to know "which chat is the user
 * working with right now?". If each one picked a different
 * fallback when the active tab isn't a chat (e.g. a `view` tab
 * like Files, or the onboarding screen) the UI ends up disagreeing
 * with itself: terminal showing one scope, file tree another.
 *
 * Resolution order:
 *   1. Active pane's active tab, if it's a chat. The primary case.
 *   2. Walk panes left → right (panes[0] is the leftmost Allotment
 *      pane in `chats-area.tsx`); first pane whose *active* tab is
 *      a chat wins. Biases toward chats visible in another split.
 *   3. Walk panes left → right again, scanning each tab strip left
 *      → right for any chat tab. Catches the case where every
 *      pane is showing a view but a chat tab is still open
 *      somewhere in the background.
 *   4. Newest sidebar-visible chat in the workspace by `createdAt`.
 *      Last-ditch fallback for windows with no pane state yet, or
 *      whose pane state has zero live chat tabs.
 */

type DbClient = ReturnType<typeof useDbClient>
type UpdateFn = Parameters<DbClient["update"]>[0]
// `Root` is the typed snapshot of the database tree. Pulled off
// `useDbClient` the same way `window-state.ts` does it so we don't
// have to import the schema directly here.
export type Root = Parameters<UpdateFn>[0]
type WindowState = NonNullable<Root["app"]["windowStates"][string]>

/** Tab's chatId, or null if the tab isn't a chat tab. */
function chatIdOf(
  tab:
    | { content: { kind: string; chatId?: string | null } }
    | null
    | undefined,
): string | null {
  if (!tab) return null
  return tab.content.kind === "chat" ? tab.content.chatId ?? null : null
}

/**
 * Returns `null` only when the window isn't on a workspace or the
 * workspace has no chats at all. Reads the active scope's pane
 * layout (`scopePanes[selectedScopeId]`); pane state is per-scope
 * now, so we don't need the workspaceId here — it's only used as
 * the last-ditch "newest chat in workspace" fallback.
 */
export function resolveActiveChatId(
  root: Root,
  ws: WindowState,
  workspaceId: string,
): string | null {
  const scopeId = ws.selectedScopeId
  const paneState = scopeId ? ws.scopePanes?.[scopeId] : null
  if (paneState) {
    const activePane =
      paneState.panes.find(p => p.id === paneState.activePaneId) ??
      paneState.panes[0]
    const activeTab =
      activePane?.tabs.find(t => t.id === activePane.activeTabId) ??
      activePane?.tabs[0]
    const activeChatId = chatIdOf(activeTab)
    if (activeChatId && isSidebarVisibleChat(root, activeChatId)) {
      return activeChatId
    }

    // Active tab isn't a chat. Prefer a chat focused in another
    // pane (visible to the user) over a chat sitting in a
    // background tab strip.
    for (const pane of paneState.panes) {
      const tab =
        pane.tabs.find(t => t.id === pane.activeTabId) ?? pane.tabs[0]
      const chatId = chatIdOf(tab)
      if (chatId && isSidebarVisibleChat(root, chatId)) return chatId
    }
    for (const pane of paneState.panes) {
      for (const tab of pane.tabs) {
        const chatId = chatIdOf(tab)
        if (chatId && isSidebarVisibleChat(root, chatId)) return chatId
      }
    }
  }
  return latestChatIdInWorkspace(root, workspaceId)
}

/**
 * Convenience for iframe views: they don't carry a `windowId` so
 * they pick the first window currently showing a workspace, then
 * resolve from there. Mirrors what `pi-event-log` and
 * `context-sidebar` were doing inline.
 */
export function resolveActiveChatIdInAnyWindow(
  root: Root,
): { chatId: string; workspaceId: string } | null {
  for (const ws of Object.values(root.app.windowStates)) {
    if (!ws || ws.activeView.kind !== "workspace") continue
    const workspaceId = ws.activeView.workspaceId
    if (!workspaceId) continue
    const chatId = resolveActiveChatId(root, ws, workspaceId)
    if (chatId) return { chatId, workspaceId }
  }
  return null
}

function latestChatIdInWorkspace(
  root: Root,
  workspaceId: string,
): string | null {
  // Walk scopes in the workspace, then chats in those scopes,
  // picking the newest by createdAt. Single pass; not hot enough
  // to index.
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
