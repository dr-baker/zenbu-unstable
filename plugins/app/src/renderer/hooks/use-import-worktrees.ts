import { useCallback } from "react"
import { nanoid } from "nanoid"
import { useDbClient, useRpc } from "@zenbujs/core/react"
import { useWindowId } from "@/lib/window-state/window-id"
import type { Schema } from "../../main/schema"

type Workspace = Schema["workspaces"][string]
type Repo = Schema["repos"][string]

/**
 * For every worktree of `repo` that doesn't already have a chat in
 * `workspace`, create a scope (if missing) and a fresh pending chat.
 * Returns the list of (scopeId, chatId) pairs we created so the
 * caller can fire `createChatSession` for each one.
 *
 * Sidebar heuristic: worktrees only appear in the worktree-group
 * listing if they have at least one non-archived chat. So "import"
 * = make each worktree visible by seeding it with one chat.
 */
export function useImportWorktrees() {
  const rpc = useRpc()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  void windowId // reserved for future "auto-select first imported chat"

  return useCallback(
    async (workspace: Workspace, repo: Repo) => {
      type Created = { scopeId: string; chatId: string }
      let created: Created[] = []

      await dbClient.update(root => {
        // Index existing scopes in the workspace by directory so we
        // don't double-materialize one when the user's already
        // touched it manually.
        const byDir = new Map<string, string>()
        for (const scope of Object.values(root.app.scopes)) {
          if (scope.workspaceId !== workspace.id) continue
          byDir.set(scope.directory, scope.id)
        }
        // Index which scopes already have a chat (any kind — pending,
        // ready, archived). We don't want to add a second placeholder
        // chat to a worktree the user already populated.
        const scopesWithChats = new Set<string>()
        for (const chat of Object.values(root.app.chats)) {
          scopesWithChats.add(chat.scopeId)
        }

        const now = Date.now()
        const out: Created[] = []
        for (const wt of repo.worktrees) {
          let scopeId = byDir.get(wt.path)
          if (!scopeId) {
            scopeId = nanoid()
            // Pin the repo's main worktree by default. This gives
            // multi-worktree workspaces a stable anchor row at the
            // top of the sidebar; secondary worktrees come in
            // unpinned and sort by createdAt below it.
            const isMain = wt.path === repo.mainWorktreePath
            root.app.scopes[scopeId] = {
              id: scopeId,
              workspaceId: workspace.id,
              directory: wt.path,
              repoId: repo.id,
              extraDirectories: [],
              createdAt: now,
              archived: false,
              archivedAt: null,
              pinnedAt: isMain ? now : null,
              unpinnedAt: null,
              pluginName: null,
            }
            byDir.set(wt.path, scopeId)
          } else {
            // Un-archive an existing soft-hidden scope so it
            // re-appears in the sidebar. Import is the "surface
            // every worktree" action; archived scopes are
            // exactly what the user wants to bring back.
            const existing = root.app.scopes[scopeId]
            if (existing?.archived) {
              existing.archived = false
              existing.archivedAt = null
            }
          }
          if (scopesWithChats.has(scopeId)) continue
          const chatId = nanoid()
          root.app.chats[chatId] = {
            id: chatId,
            scopeId,
            session: { kind: "pending" },
            createdAt: now,
          }
          scopesWithChats.add(scopeId)
          out.push({ scopeId, chatId })
        }
        created = out
      })

      // Fire createChatSession for each new pending chat. Sequential
      // is fine — these are cheap and the user just imported a
      // handful of worktrees, not thousands.
      for (const { scopeId, chatId } of created) {
        try {
          await rpc.pi.sessions.createChatSession({ scopeId, chatId })
        } catch (err) {
          console.error(
            "[import-worktrees] createChatSession failed:",
            err,
          )
        }
      }

      return { createdCount: created.length }
    },
    [dbClient, rpc],
  )
}
