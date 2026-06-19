import { useMemo } from "react"
import { useDb, useInjections } from "@zenbujs/core/react"
import type { WorkspaceRailEntry } from "../components/layout/workspace-rail"
import { useActiveScopeId, useActiveView, useActiveWorkspaceId } from "@/lib/window-state/active-view"
import { scopeForChat } from "@/lib/sidebar-helpers"
import type { Schema } from "../../main/schema"
import type { SelfDbSection as PiSchema } from "../../../.zenbu/types/deps/pi/db-sections"

type Chat = Schema["chats"][string]
type Scope = Schema["scopes"][string]
type Workspace = Schema["workspaces"][string]
type Repo = Schema["repos"][string]
type Worktree = Repo["worktrees"][number]

export type ScopeRow = {
  /** Stable React key. scope.id when materialized, else worktree.path. */
  key: string
  scopeId: string | null
  directory: string
  worktree: Worktree | null
}

export type SidebarGroup = {
  scope: Scope
  chats: Chat[]
  isStreaming: boolean
}

/** A narrow set of `useDb`-backed hooks. Components call only what
 * they need so unrelated db writes don't trigger re-renders.
 *
 *   - `useActiveScope()` — re-renders when the active scope flips.
 *   - `useActiveWorkspace()` — re-renders when the active workspace
 *     flips or its own fields change.
 *   - `useSidebarGroups()` — re-renders when grouping changes
 *     (new chat, archive, sort flip, streaming flip). Heaviest.
 *
 * Components that need many of these stay narrow; components that
 * only need one (e.g. `WorkspaceTitleBar`) don't subscribe to chat
 * updates at all. */

export function useActiveWorkspace(): Workspace | null {
  const id = useActiveWorkspaceId()
  return useDb(root => (id ? root.app.workspaces[id] ?? null : null))
}

export function useActiveScope(): Scope | null {
  const id = useActiveScopeId()
  return useDb(root => (id ? root.app.scopes[id] ?? null : null))
}

/** The repo backing the active workspace, if any. Picks the first
 * scope in the workspace that has a `repoId`. */
export function useActiveRepo(): Repo | null {
  const workspaceId = useActiveWorkspaceId()
  return useDb(root => {
    if (!workspaceId) return null
    let repoId: string | null = null
    for (const scope of Object.values(root.app.scopes)) {
      if (scope.workspaceId === workspaceId && scope.repoId != null) {
        repoId = scope.repoId
        break
      }
    }
    return repoId ? root.app.repos[repoId] ?? null : null
  })
}

export function useHasAnyWorkspace(): boolean {
  return useDb(root => Object.keys(root.app.workspaces).length > 0)
}

/** Label for workspace-less `{ kind: "view" }` title bars. Same
 * source the command palette uses. */
export function useGlobalViewLabel(): string {
  const activeView = useActiveView()
  const injections = useInjections()
  if (activeView.kind !== "view") return ""
  const entry = injections.find(v => v.name === activeView.viewType)
  const label = entry?.meta?.label
  return typeof label === "string" ? label : activeView.viewType
}

/** Worktree-group listing for the active workspace. Groups follow
 * the rule that a worktree only appears when it has at least one
 * non-archived chat. Inside each group, chats are deduplicated by
 * session and sorted by creation time (oldest first surfaces at
 * the top after the descending sort below). */
export function useSidebarGroups(): SidebarGroup[] {
  const workspaceId = useActiveWorkspaceId()
  const chatsById = useDb(root => root.app.chats)
  const scopesById = useDb(root => root.app.scopes)
  const sessionsById = useDb(root => root.pi.sessions)

  return useMemo<SidebarGroup[]>(() => {
    if (!workspaceId) return []
    const sortKey = (c: Chat) => c.createdAt
    const wsScopes = Object.values(scopesById).filter(
      s => s.workspaceId === workspaceId && !s.archived,
    )
    const scopeById = new Map(wsScopes.map(s => [s.id, s] as const))

    const buckets = new Map<string, Chat[]>()
    const oldestFirstChats = Object.values(chatsById).sort(
      (a, b) => a.createdAt - b.createdAt,
    )
    const seenSessions = new Set<string>()
    for (const chat of oldestFirstChats) {
      if (!scopeById.has(chat.scopeId)) continue
      if (chat.session.kind === "ready") {
        const sid = chat.session.sessionId
        if (seenSessions.has(sid)) continue
        if (sessionsById[sid]?.archived) continue
        seenSessions.add(sid)
      }
      const arr = buckets.get(chat.scopeId) ?? []
      arr.push(chat)
      buckets.set(chat.scopeId, arr)
    }

    const out: SidebarGroup[] = []
    for (const [scopeId, groupChats] of buckets) {
      const scope = scopeById.get(scopeId)
      if (!scope) continue
      const isStreaming = groupChats.some(
        c =>
          c.session.kind === "ready" &&
          sessionsById[c.session.sessionId]?.isStreaming,
      )
      const sorted = groupChats.slice().sort((a, b) => sortKey(b) - sortKey(a))
      out.push({ scope, chats: sorted, isStreaming })
    }

    // Pinned scopes first by `pinnedAt`, then unpinned by
    // `max(unpinnedAt ?? 0, createdAt)` so a freshly-unpinned scope
    // stays near the top instead of dropping to the bottom.
    const pinnedKey = (s: Scope) => s.pinnedAt ?? 0
    const unpinnedKey = (s: Scope) => Math.max(s.unpinnedAt ?? 0, s.createdAt)
    out.sort((a, b) => {
      const aPinned = a.scope.pinnedAt != null
      const bPinned = b.scope.pinnedAt != null
      if (aPinned !== bPinned) return aPinned ? -1 : 1
      const keyA = aPinned ? pinnedKey(a.scope) : unpinnedKey(a.scope)
      const keyB = bPinned ? pinnedKey(b.scope) : unpinnedKey(b.scope)
      if (keyA !== keyB) return keyB - keyA
      return a.scope.directory.localeCompare(b.scope.directory)
    })
    return out
  }, [
    workspaceId,
    chatsById,
    scopesById,
    sessionsById,
  ])
}

/** Used by `archiveChat` to decide whether to refuse archiving the
 * last row in scope. Read on-demand at the moment of click. */
export function getSessionRowsInScope(
  root: { app: Schema; pi: PiSchema },
  workspaceId: string | null,
  scopeId: string | null,
): Chat[] {
  if (!workspaceId || !scopeId) return []
  const scope = root.app.scopes[scopeId]
  if (!scope || scope.archived) return []
  const seen = new Set<string>()
  const out: Chat[] = []
  for (const chat of Object.values(root.app.chats)) {
    if (chat.scopeId !== scopeId) continue
    if (chat.session.kind === "ready") {
      const sid = chat.session.sessionId
      if (seen.has(sid)) continue
      if (root.pi.sessions[sid]?.archived) continue
      seen.add(sid)
    }
    out.push(chat)
  }
  return out
}

export function useWorkspaceRailEntries(): WorkspaceRailEntry[] {
  const workspacesById = useDb(root => root.app.workspaces)
  const scopesById = useDb(root => root.app.scopes)
  const reposById = useDb(root => root.app.repos)
  const chatsById = useDb(root => root.app.chats)
  const sessionsById = useDb(root => root.pi.sessions)

  return useMemo(() => {
    const workspaces = Object.values(workspacesById)
    const scopes = Object.values(scopesById)
    const chats = Object.values(chatsById)
    // Pick a representative path for the rail's hover popover.
    // Prefer the main worktree of the workspace's repo so users
    // see e.g. `~/code/myproj` instead of a random worktree dir
    // like `~/code/myproj-feature-x`. Falls back to the earliest
    // scope's `directory` when there's no repo link yet, and to
    // null when the workspace has no scopes at all.
    const pathFor = (workspaceId: string): string | null => {
      const wsScopes = scopes
        .filter(s => s.workspaceId === workspaceId && !s.archived)
        .sort((a, b) => a.createdAt - b.createdAt)
      for (const s of wsScopes) {
        if (s.repoId) {
          const repo = reposById[s.repoId]
          if (repo?.mainWorktreePath) return repo.mainWorktreePath
        }
      }
      return wsScopes[0]?.directory ?? null
    }
    const railEntry = (w: Workspace): WorkspaceRailEntry => ({
      id: w.id,
      label: w.name,
      icon: w.icon ?? null,
      iconAuto: w.iconAuto ?? null,
      path: pathFor(w.id),
      hasActivity: chats.some(
        c =>
          scopeForChat(c.scopeId, scopes)?.workspaceId === w.id &&
          c.session.kind === "ready" &&
          sessionsById[c.session.sessionId]?.isStreaming,
      ),
    })
    // Plugin-kind workspaces are an implementation detail of the
    // plugins root view (they back the per-plugin "Edit in
    // workspace" windows). They're addressable through the
    // plugins sidebar, not the workspace rail, so they're filtered
    // out here.
    return workspaces
      .filter(w => !w.archived && w.kind !== "plugin")
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(railEntry)
  }, [workspacesById, scopesById, reposById, chatsById, sessionsById])
}

export function useScopeRows(): ScopeRow[] {
  const workspaceId = useActiveWorkspaceId()
  const activeRepo = useActiveRepo()
  const scopesById = useDb(root => root.app.scopes)

  return useMemo<ScopeRow[]>(() => {
    if (!workspaceId) return []
    const scopesInWorkspace = Object.values(scopesById)
      .filter(s => s.workspaceId === workspaceId)
      .sort((a, b) => b.createdAt - a.createdAt)
    const scopeByDir = new Map<string, Scope>(
      scopesInWorkspace.map(s => [s.directory, s]),
    )
    const out: ScopeRow[] = []
    const consumed = new Set<string>()
    if (activeRepo) {
      for (const wt of activeRepo.worktrees) {
        const scope = scopeByDir.get(wt.path) ?? null
        out.push({
          key: wt.path,
          scopeId: scope?.id ?? null,
          directory: wt.path,
          worktree: wt,
        })
        if (scope) consumed.add(scope.id)
      }
    }
    for (const scope of scopesInWorkspace) {
      if (consumed.has(scope.id)) continue
      out.push({
        key: scope.id,
        scopeId: scope.id,
        directory: scope.directory,
        worktree: null,
      })
    }
    return out
  }, [workspaceId, activeRepo, scopesById])
}
