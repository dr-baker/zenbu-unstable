import type { Root } from "./types"

type VisibilityRoot = Pick<Root, "app" | "pi">

/** A scope can back normal sidebar/chat-surface UI only while both
 * the scope and its workspace are live. Archived scopes disappear
 * from the agent sidebar, so any tabs scoped there should be treated
 * as stale UI handles. */
export function isLiveScope(
  root: VisibilityRoot,
  scopeId: string | null | undefined,
): boolean {
  if (!scopeId) return false
  const scope = root.app.scopes[scopeId]
  if (!scope || scope.archived) return false
  const workspace = root.app.workspaces[scope.workspaceId]
  if (!workspace || workspace.archived) return false
  return true
}

/** True when a chat tab still belongs to something the sidebar would
 * surface: a live scope, and either a pending chat or a ready session
 * that has not been archived. Missing ready-session records are left
 * visible to match the sidebar's current fallback behaviour. */
export function isSidebarVisibleChat(
  root: VisibilityRoot,
  chatId: string | null | undefined,
): boolean {
  if (!chatId) return false
  const chat = root.app.chats[chatId]
  if (!chat) return false
  if (!isLiveScope(root, chat.scopeId)) return false
  if (chat.session.kind === "ready") {
    return root.pi.sessions[chat.session.sessionId]?.archived !== true
  }
  return true
}

/** Earliest-created live scope in a workspace. Used as the stable
 * fallback when a remembered/active scope was archived. */
export function primaryLiveScopeIdOf(
  root: VisibilityRoot,
  workspaceId: string,
): string | null {
  let earliest: { id: string; createdAt: number } | null = null
  for (const scope of Object.values(root.app.scopes)) {
    if (scope.workspaceId !== workspaceId) continue
    if (!isLiveScope(root, scope.id)) continue
    if (!earliest || scope.createdAt < earliest.createdAt) {
      earliest = { id: scope.id, createdAt: scope.createdAt }
    }
  }
  return earliest?.id ?? null
}

/** Most recent chat in a live scope that has not disappeared from the
 * sidebar. Returns null when a fresh empty tab should be created by
 * the pane materializer instead. */
export function latestSidebarVisibleChatIdInScope(
  root: VisibilityRoot,
  scopeId: string,
): string | null {
  if (!isLiveScope(root, scopeId)) return null
  let latestId: string | null = null
  let latestAt = -Infinity
  for (const chat of Object.values(root.app.chats)) {
    if (chat.scopeId !== scopeId) continue
    if (!isSidebarVisibleChat(root, chat.id)) continue
    if (chat.createdAt > latestAt) {
      latestAt = chat.createdAt
      latestId = chat.id
    }
  }
  return latestId
}
