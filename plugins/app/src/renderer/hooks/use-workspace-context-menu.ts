import { useDbClient, useRpc } from "@zenbujs/core/react"
import { useWindowId } from "@/lib/window-state/window-id"
import { activeWorkspaceIdOf } from "@/lib/window-state/derived"
import { useSelectChat, useSetWorkspaceRailOpen } from "@/lib/window-state/active-view"
import { openChatInNewPaneInRoot, openChatInNewTabInRoot } from "@/lib/window-state/panes/tabs"
import {
  useClearWorkspaceIcon,
  useUploadWorkspaceIcon,
} from "@/lib/workspace-icon"
import { openCreateWorktreeDialog } from "@/lib/create-worktree-dialog-store"
import { useStableCallback } from "@/lib/use-stable-callback"
import { useSidebarActions } from "./use-sidebar-actions"
import { getSessionRowsInScope } from "./use-sidebar-selectors"
import type { Schema } from "../../main/schema"

type Chat = Schema["chats"][string]
type Scope = Schema["scopes"][string]

export type WorkspaceContextMenuHandlers = ReturnType<
  typeof useWorkspaceContextMenu
>

/** Native context menus for the workspace rail, worktree group
 * headers, and chat rows. Reads from the live replica at click
 * time — no derived-state dependencies. */
export function useWorkspaceContextMenu() {
  const rpc = useRpc()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const selectChat = useSelectChat()
  const setWorkspaceRailOpen = useSetWorkspaceRailOpen()
  const uploadWorkspaceIcon = useUploadWorkspaceIcon()
  const clearWorkspaceIcon = useClearWorkspaceIcon()
  const actions = useSidebarActions()

  const pickWorkspaceIconFile = (workspaceId: string) => {
    const input = document.createElement("input")
    input.type = "file"
    input.accept =
      "image/png,image/jpeg,image/gif,image/webp,image/svg+xml,image/avif"
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) return
      void uploadWorkspaceIcon(workspaceId, file).catch(err =>
        console.error("[workspace-icon] upload failed:", err),
      )
    }
    input.click()
  }

  // Right-click on the rail background: single-action menu so the
  // user can hide the rail without the default Chromium menu.
  const handleRailBackgroundContextMenu = useStableCallback(
    async (e: React.MouseEvent) => {
      const { chosenId } = await rpc.app.contextMenu.show({
        x: e.clientX,
        y: e.clientY,
        items: [{ id: "hide-rail", label: "Hide (Unhide with ⌘⇧B)" }],
      })
      if (chosenId === "hide-rail") {
        setWorkspaceRailOpen(false)
      }
    },
  )

  const handleWorkspaceContextMenu = useStableCallback(
    async (workspaceId: string, e: React.MouseEvent) => {
      const ws = dbClient.readRoot().app.workspaces[workspaceId]
      const hasIcon = ws?.icon != null
      const { chosenId } = await rpc.app.contextMenu.show({
        x: e.clientX,
        y: e.clientY,
        items: [
          { id: "open-in-new-window", label: "Open in new window" },
          { type: "separator" as const },
          {
            id: "set-icon",
            label: hasIcon ? "Replace icon…" : "Set icon…",
          },
          { id: "clear-icon", label: "Clear icon", enabled: hasIcon },
          { type: "separator" as const },
          {
            id: "archive",
            label: ws?.archived
              ? "Unarchive workspace"
              : "Archive workspace",
          },
          { id: "delete", label: "Delete workspace" },
        ],
      })
      if (chosenId === "open-in-new-window") {
        try {
          await rpc.app.workspaces.openInNewWindow({ workspaceId })
        } catch (err) {
          console.error("[sidebar] workspaces.openInNewWindow failed:", err)
        }
        return
      }
      if (chosenId === "archive") {
        const root = dbClient.readRoot()
        const wsScopeIds = new Set(
          Object.values(root.app.scopes)
            .filter(s => s.workspaceId === workspaceId)
            .map(s => s.id),
        )
        await dbClient.update(r => {
          const target = r.app.workspaces[workspaceId]
          if (!target) return
          const nextArchived = !target.archived
          target.archived = nextArchived
          if (nextArchived) {
            for (const win of Object.values(r.app.windowStates)) {
              if (
                win.selectedScopeId &&
                wsScopeIds.has(win.selectedScopeId)
              ) {
                win.selectedScopeId = null
              }
              // Leave `activeView` alone; App's boot effect
              // auto-selects the next workspace.
            }
          }
        })
        return
      }
      if (chosenId === "set-icon") {
        pickWorkspaceIconFile(workspaceId)
        return
      }
      if (chosenId === "clear-icon") {
        try {
          await clearWorkspaceIcon(workspaceId)
        } catch (err) {
          console.error("[workspace-icon] clear failed:", err)
        }
        return
      }
      if (chosenId === "delete") {
        const root = dbClient.readRoot()
        // Snapshot the workspace's icon blob refs *before* the
        // delete update so we can free them afterward. Both the
        // user-uploaded icon and the auto-derived icon live in
        // blob storage; without this cleanup they'd be orphaned
        // forever.
        const wsForCleanup = root.app.workspaces[workspaceId]
        const orphanedBlobIds: string[] = []
        if (wsForCleanup?.icon?.blobId) {
          orphanedBlobIds.push(wsForCleanup.icon.blobId)
        }
        if (wsForCleanup?.iconAuto?.blobId) {
          orphanedBlobIds.push(wsForCleanup.iconAuto.blobId)
        }
        const wsScopeIds = Object.values(root.app.scopes)
          .filter(s => s.workspaceId === workspaceId)
          .map(s => s.id)
        const wsScopeSet = new Set(wsScopeIds)
        const wsChats = Object.values(root.app.chats).filter(c =>
          wsScopeSet.has(c.scopeId),
        )
        const wsSessionIds = wsChats
          .map(c =>
            c.session.kind === "ready" ? c.session.sessionId : null,
          )
          .filter((id): id is string => id != null)

        for (const sessionId of wsSessionIds) {
          await rpc.pi.sessions
            .deleteSession({ sessionId })
            .catch(err =>
              console.error("[sidebar] deleteSession failed:", err),
            )
        }

        await rpc.app.terminal
          .disposeForScopes({ scopeIds: wsScopeIds })
          .catch(err =>
            console.error("[sidebar] terminal.disposeForScopes failed:", err),
          )

        await dbClient.update(r => {
          delete r.app.workspaces[workspaceId]
          for (const scopeId of wsScopeIds) {
            delete r.app.scopes[scopeId]
          }
          for (const chat of wsChats) {
            delete r.app.chats[chat.id]
          }
          // Cross-plugin cleanup: `worktreeGroupCollapsed` now lives
          // under `root.agentSidebar`, keyed by windowId then
          // scopeId. Sweep it here on workspace delete so stale
          // collapse entries don't accumulate.
          for (const forWindow of Object.values(
            r.agentSidebar.worktreeGroupCollapsed,
          )) {
            for (const scopeId of wsScopeIds) {
              delete forWindow[scopeId]
            }
          }
          for (const ws of Object.values(r.app.windowStates)) {
            for (const scopeId of wsScopeIds) {
              delete ws.scopeLastTerminal[scopeId]
              delete ws.scopePanes[scopeId]
              delete ws.scopeUiStates[scopeId]
            }
            if (
              ws.selectedScopeId &&
              wsScopeSet.has(ws.selectedScopeId)
            ) {
              ws.selectedScopeId = null
            }
            delete ws.workspaceActiveScope[workspaceId]
            delete ws.workspaceUiStates[workspaceId]
          }
        })

        // Best-effort blob cleanup. Failures here are
        // non-fatal — the workspace row is already gone, so the
        // app can't possibly reference the blobs again; this
        // just keeps the blob store from growing unbounded.
        for (const blobId of orphanedBlobIds) {
          try {
            await dbClient.deleteBlob(blobId)
          } catch (err) {
            console.error(
              "[sidebar] workspace icon deleteBlob failed:",
              err,
            )
          }
        }
      }
    },
  )

  /** "Create worktree from this branch", pre-seeded with the
   * group's branch or HEAD as the source ref. */
  const handleWorktreeGroupContextMenu = useStableCallback(
    async (scope: Scope, e: React.MouseEvent) => {
      const root = dbClient.readRoot()
      // Find the repo that owns this scope's worktree.
      let branch: string | null = null
      let headSha: string | null = null
      if (scope.repoId) {
        const repo = root.app.repos[scope.repoId]
        const wt = repo?.worktrees.find(w => w.path === scope.directory)
        branch = wt?.branch ?? null
        headSha = wt?.headSha ?? null
      }
      const { chosenId } = await rpc.app.contextMenu.show({
        x: e.clientX,
        y: e.clientY,
        items: [
          {
            id: "new-worktree",
            label: branch
              ? `New worktree from ${branch}…`
              : "New worktree from this HEAD…",
            enabled: !!(branch || headSha),
          },
        ],
      })
      if (chosenId === "new-worktree") {
        openCreateWorktreeDialog(branch ?? headSha)
      }
    },
  )

  const handleChatContextMenu = useStableCallback(
    async (chat: Chat, e: React.MouseEvent) => {
      const isReady = chat.session.kind === "ready"
      const root = dbClient.readRoot()
      const activeWorkspaceId = activeWorkspaceIdOf(
        root.app.windowStates[windowId],
      )
      const sessionRows = getSessionRowsInScope(
        root,
        activeWorkspaceId,
        chat.scopeId,
      )
      const { chosenId } = await rpc.app.contextMenu.show({
        x: e.clientX,
        y: e.clientY,
        items: [
          { id: "open_in_new_tab", label: "Open in new tab", enabled: true },
          { id: "open_in_new_pane", label: "Open in split", enabled: true },
          {
            id: "open_in_new_window",
            label: "Open in new window",
            enabled: true,
          },
          { type: "separator" },
          {
            id: "branch_last_user",
            label: "Branch from last user message",
            enabled: isReady,
          },
          {
            id: "fork",
            label: "Fork chat from latest entry",
            enabled: isReady,
          },
          { type: "separator" },
          {
            id: "archive",
            label: "Archive session",
            enabled: isReady && sessionRows.length > 1,
          },
        ],
      })
      if (chosenId === "archive") {
        actions.archiveChat(chat)
        return
      }
      if (chosenId === "open_in_new_tab") {
        await dbClient.update(r => {
          openChatInNewTabInRoot(r, windowId, chat.id)
        })
        return
      }
      if (chosenId === "open_in_new_window") {
        try {
          await rpc.app.chatWindow.open({ chatId: chat.id })
        } catch (err) {
          console.error("[sidebar] chatWindow.open failed:", err)
        }
        return
      }
      if (chosenId === "open_in_new_pane") {
        await dbClient.update(r => {
          openChatInNewPaneInRoot(r, windowId, chat.id)
        })
        return
      }
      if (chat.session.kind !== "ready") return
      const sessionId = chat.session.sessionId
      if (chosenId === "branch_last_user") {
        try {
          const result = await rpc.pi.sessions.branchFromLastUserTurn({
            sessionId,
          })
          if (!result.branched) {
            console.warn("[sidebar] nothing to branch from")
          }
        } catch (err) {
          console.error("[sidebar] branch failed:", err)
        }
      } else if (chosenId === "fork") {
        const session = dbClient.readRoot().pi.sessions[sessionId]
        const entryId = session?.currentLeafEntryId
        if (!entryId) {
          console.warn("[sidebar] no leaf entry to fork from")
          return
        }
        try {
          const result = await rpc.pi.sessions.fork({
            sessionId,
            entryId,
            workspaceId: activeWorkspaceId ?? "",
          })
          selectChat(result.chatId)
        } catch (err) {
          console.error("[sidebar] fork failed:", err)
        }
      }
    },
  )

  return {
    handleRailBackgroundContextMenu,
    handleWorkspaceContextMenu,
    handleWorktreeGroupContextMenu,
    handleChatContextMenu,
  }
}
