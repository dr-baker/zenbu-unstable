import { useDbClient } from "@zenbujs/core/react"
import { useWindowId } from "@/lib/window-state/window-id"
import { activeChatIdOf, activeWorkspaceIdOf } from "@/lib/window-state/derived"
import { reconcileHiddenChatTabsInRoot } from "@/lib/window-state/sidebar-tab-sync"
import { useSelectWorkspace, useShowOnboardingView } from "@/lib/window-state/active-view"
import { focusPaneShowingChatInRoot, selectChatInRoot } from "@/lib/window-state/selection"
import { ensureScopePanes } from "@/lib/window-state/panes/internal"
import { addTabInRoot } from "@/lib/window-state/panes/tabs"
import { useImportWorktrees } from "./use-import-worktrees"
import { requestFocusComposer } from "@/lib/focus-composer"
import { isChatActiveForSession } from "@/lib/sidebar-helpers"
import { useStableCallback } from "@/lib/use-stable-callback"
import { getSessionRowsInScope } from "./use-sidebar-selectors"
import type { Schema } from "../../main/schema"

type Chat = Schema["chats"][string]

export type SidebarActions = ReturnType<typeof useSidebarActions>

/** Imperative action API. Pure handlers, no subscriptions — every
 * handler reads from the live replica via `dbClient.readRoot()` at
 * the moment of invocation, so the hook can be called from any
 * component without coupling that component to derived state. */
export function useSidebarActions() {
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const selectWorkspace = useSelectWorkspace()
  const showOnboardingView = useShowOnboardingView()
  const importWorktrees = useImportWorktrees()

  /** Pick the scope a new chat from the sidebar should land in.
   * Prefers the active worktree, then the workspace's earliest
   * scope as a fallback. */
  const resolveNewChatScopeId = (
    preferScopeId?: string | null,
  ): string | null => {
    const root = dbClient.readRoot()
    const win = root.app.windowStates[windowId]
    const activeScopeId = win?.selectedScopeId ?? null
    const activeWorkspaceId = activeWorkspaceIdOf(win)
    if (preferScopeId) return preferScopeId
    if (activeScopeId) return activeScopeId
    if (!activeWorkspaceId) return null
    let earliest: { id: string; createdAt: number } | null = null
    for (const s of Object.values(root.app.scopes)) {
      if (s.workspaceId !== activeWorkspaceId) continue
      if (!earliest || s.createdAt < earliest.createdAt) {
        earliest = { id: s.id, createdAt: s.createdAt }
      }
    }
    return earliest?.id ?? null
  }

  const createChatInScope = useStableCallback((scopeId: string) => {
    let targetComposerId: string | null = null
    void dbClient
      .update(root => {
        const state = ensureScopePanes(root, windowId, scopeId)
        const pane =
          state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]
        if (!pane) return
        const result = addTabInRoot(root, windowId, scopeId, pane.id)
        targetComposerId = result?.composerId ?? null
      })
      .then(() => {
        if (targetComposerId) requestFocusComposer(targetComposerId)
      })
  })

  // Sidebar "New Chat" (and ⌘N): append an unmaterialized chat draft
  // tab. The real chat row + pi session are created only when the
  // user sends.
  const handleNewChat = useStableCallback(() => {
    const scopeId = resolveNewChatScopeId()
    if (!scopeId) return
    createChatInScope(scopeId)
  })

  // Click a chat in the sidebar. Prefer focusing an existing tab
  // that already shows this chat; otherwise replace the active tab.
  // Only refocus the composer when the destination has a draft.
  const handleSelectChat = useStableCallback((id: string) => {
    void dbClient
      .update(root => {
        if (focusPaneShowingChatInRoot(root, windowId, id)) return
        selectChatInRoot(root, windowId, id)
      })
      .then(() => {
        requestFocusComposer(id)
      })
  })

  /** Archive a sidebar row. Selects the row below the archived one
   * (or above if at the bottom). Refuses to archive the last row
   * in scope. */
  const archiveChat = useStableCallback((chatOrId: Chat | string) => {
    const root = dbClient.readRoot()
    const chat =
      typeof chatOrId === "string" ? root.app.chats[chatOrId] : chatOrId
    if (!chat) return
    const win = root.app.windowStates[windowId]
    const activeWorkspaceId = activeWorkspaceIdOf(win)
    const rows = getSessionRowsInScope(
      root,
      activeWorkspaceId,
      chat.scopeId,
    )
    if (rows.length <= 1) return
    const activeChatId = activeChatIdOf(root, windowId)
    const idx = rows.findIndex(c => c.id === chat.id)
    const isActive = isChatActiveForSession(
      chat,
      activeChatId,
      Object.values(root.app.chats),
    )
    let nextChatId: string | null = null
    if (isActive && idx >= 0) {
      const next = rows[idx + 1] ?? (idx > 0 ? rows[idx - 1] : undefined)
      nextChatId = next?.id ?? null
    }
    void dbClient
      .update(r => {
        if (chat.session.kind === "ready") {
          const session = r.pi.sessions[chat.session.sessionId]
          if (session) session.archived = true
        } else {
          delete r.app.chats[chat.id]
        }
        if (nextChatId) {
          selectChatInRoot(r, windowId, nextChatId)
        }
        reconcileHiddenChatTabsInRoot(r)
      })
      .then(() => {
        if (nextChatId) requestFocusComposer(nextChatId)
      })
  })

  const archiveWorktreeScope = useStableCallback((scopeId: string) => {
    void dbClient.update(root => {
      const scope = root.app.scopes[scopeId]
      if (!scope) return
      scope.archived = true
      scope.archivedAt = Date.now()
      reconcileHiddenChatTabsInRoot(root)
    })
  })

  // Pinning stamps `pinnedAt = now`; unpinning stamps `unpinnedAt`
  // so the row stays near the top of the unpinned section instead
  // of falling to the bottom.
  const toggleWorktreeScopePin = useStableCallback((scopeId: string) => {
    void dbClient.update(root => {
      const scope = root.app.scopes[scopeId]
      if (!scope) return
      const now = Date.now()
      if (scope.pinnedAt != null) {
        scope.pinnedAt = null
        scope.unpinnedAt = now
      } else {
        scope.pinnedAt = now
      }
    })
  })

  const handleSelectWorkspace = useStableCallback((workspaceId: string) => {
    selectWorkspace(workspaceId)
  })

  /** The rail's "+" routes the window to the onboarding view, which
   * owns the open / clone-from-URL flow. */
  const handleAddWorkspace = useStableCallback(() => {
    showOnboardingView()
  })

  const handleImportWorktrees = useStableCallback(async () => {
    const root = dbClient.readRoot()
    const win = root.app.windowStates[windowId]
    const activeWorkspaceId = activeWorkspaceIdOf(win)
    if (!activeWorkspaceId) return
    const workspace = root.app.workspaces[activeWorkspaceId]
    if (!workspace) return
    let repo: Schema["repos"][string] | null = null
    for (const scope of Object.values(root.app.scopes)) {
      if (scope.workspaceId === activeWorkspaceId && scope.repoId != null) {
        repo = root.app.repos[scope.repoId] ?? null
        break
      }
    }
    if (!repo) return
    try {
      await importWorktrees(workspace, repo)
    } catch (err) {
      console.error("[sidebar] import worktrees failed:", err)
    }
  })

  return {
    createChatInScope,
    handleNewChat,
    handleSelectChat,
    archiveChat,
    archiveWorktreeScope,
    toggleWorktreeScopePin,
    handleSelectWorkspace,
    handleAddWorkspace,
    handleImportWorktrees,
  }
}
