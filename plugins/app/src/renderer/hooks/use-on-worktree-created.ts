import { nanoid } from "nanoid"
import { useDbClient, useRpc } from "@zenbujs/core/react"
import { useWindowId } from "@/lib/window-state/window-id"
import { activeWorkspaceIdOf } from "@/lib/window-state/derived"
import { selectChatInRoot } from "@/lib/window-state/selection"
import { requestFocusComposer } from "@/lib/focus-composer"
import { useStableCallback } from "@/lib/use-stable-callback"

export type WorktreeCreatedPayload = {
  worktreePath: string
  branch: string | null
}

/** `CreateWorktreeDialog#onCreated` handler. Materializes a scope
 * for the new worktree directory and a fresh pending chat in it
 * (worktrees only render as groups when they have at least one
 * chat), then focuses the composer.
 *
 * Reuses an existing soft-hidden (archived) scope if one already
 * maps to this directory, mirroring `useImportWorktrees`. */
export function useOnWorktreeCreated() {
  const rpc = useRpc()
  const dbClient = useDbClient()
  const windowId = useWindowId()

  return useStableCallback(({ worktreePath }: WorktreeCreatedPayload) => {
    const initialRoot = dbClient.readRoot()
    const win = initialRoot.app.windowStates[windowId]
    const workspaceId = activeWorkspaceIdOf(win)
    if (!workspaceId) {
      console.warn(
        "[create-worktree] no active workspace; skipping scope/chat creation",
      )
      return
    }
    // Pick the repo from any scope in the active workspace.
    let repoId: string | null = null
    for (const scope of Object.values(initialRoot.app.scopes)) {
      if (scope.workspaceId === workspaceId && scope.repoId != null) {
        repoId = scope.repoId
        break
      }
    }

    const newScopeId = nanoid()
    const chatId = nanoid()
    const now = Date.now()
    let finalScopeId = newScopeId
    void dbClient
      .update(root => {
        const existing = Object.values(root.app.scopes).find(
          s =>
            s.workspaceId === workspaceId && s.directory === worktreePath,
        )
        finalScopeId = existing?.id ?? newScopeId
        if (!existing) {
          // "New worktree" from the split-button creates a secondary
          // worktree off of an existing branch, never the main one.
          root.app.scopes[finalScopeId] = {
            id: finalScopeId,
            workspaceId,
            directory: worktreePath,
            repoId,
            extraDirectories: [],
            createdAt: now,
            archived: false,
            archivedAt: null,
            pinnedAt: null,
            unpinnedAt: null,
            pluginName: null,
          }
        } else {
          if (existing.archived) {
            existing.archived = false
            existing.archivedAt = null
          }
        }
        root.app.chats[chatId] = {
          id: chatId,
          scopeId: finalScopeId,
          session: { kind: "pending" },
          createdAt: now,
        }
        selectChatInRoot(root, windowId, chatId)
      })
      .then(() => {
        void rpc.pi.sessions
          .createChatSession({ scopeId: finalScopeId, chatId })
          .catch(err =>
            console.error(
              "[create-worktree] createChatSession failed:",
              err,
            ),
          )
        requestFocusComposer(chatId)
      })
  })
}

/** `CreatePluginDialog#onCreated` handler. The service has already
 * materialized the scope + chat; we just select it and refocus the
 * composer. */
export function useOnPluginCreated() {
  const dbClient = useDbClient()
  const windowId = useWindowId()
  return useStableCallback(({ chatId }: { chatId: string }) => {
    void dbClient
      .update(root => {
        selectChatInRoot(root, windowId, chatId)
      })
      .then(() => {
        requestFocusComposer(chatId)
      })
  })
}
