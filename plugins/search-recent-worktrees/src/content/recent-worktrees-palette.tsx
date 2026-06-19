import {
  StrictMode,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import { createRoot } from "react-dom/client"
import {
  useDb,
  useDbClient,
  useEvents,
  ZenbuProvider,
} from "@zenbujs/core/react"
import { Palette, PaletteRow } from "@zenbu/ui/palette"
import { Spinner } from "@/components/common/spinner"
import { useWindowId } from "@/lib/window-state/window-id"
import {
  useActiveChatId,
  useActiveScopeId,
  useActiveWorkspaceId,
} from "@/lib/window-state/active-view"
import {
  focusPaneShowingChatInRoot,
  selectChatInRoot,
} from "@/lib/window-state/selection"
import { requestFocusComposer } from "@/lib/focus-composer"
import { worktreeGroupLabel } from "@/lib/sidebar-helpers"
import type { Schema } from "@host/main/schema"

type Chat = Schema["chats"][string]
type Scope = Schema["scopes"][string]

type WorktreeRow = {
  scope: Scope
  /** The chat we'll jump to when the user activates this row.
   * Selected as the chat in this scope with the largest
   * `session.lastOpenedAt`, falling back to `lastActivityAt` /
   * `chat.createdAt` exactly the way `searchRecentAgents` does. */
  representativeChat: Chat
  /** Recency timestamp used for sort + the "<ago>" hint. Same
   * fallback chain as the representative-chat picker. */
  ts: number
  label: string
  /** Any chat in this worktree has a streaming session. Mirrors
   * the spinner aggregate `WorktreeBranch` computes in the agent
   * sidebar so the picker tells the same story as the sidebar. */
  isStreaming: boolean
  /** Any chat in this worktree finished a turn since it was last
   * opened, excluding the currently-active chat. Same predicate
   * as `ChatSidebarItem.hasUnread` / the sidebar's group
   * aggregate. */
  hasUnread: boolean
}

/**
 * Cmd+; recent-worktrees palette.
 *
 * Same recency mechanic as `searchRecentAgents` but grouped by
 * worktree (scope). For each scope in the active workspace we
 * pick the chat with the largest `session.lastOpenedAt` and use
 * its timestamp to sort the row + render the "<ago>" hint.
 * Activating the row selects that chat — mirroring the agent
 * sidebar's row activation so the user lands on the chat they'd
 * have clicked anyway.
 *
 * Default selection follows the VSCode Cmd+P trick: when the top
 * row is the currently-active scope, the cursor starts on row 1
 * so Enter pops back to the previously-active worktree.
 */
function RecentWorktreesPalette() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const off = events.searchRecentWorktrees.togglePalette.subscribe(() => {
      setOpen((o) => !o)
    })
    return () => off()
  }, [events])

  const close = useCallback(() => setOpen(false), [])

  const activeWorkspaceId = useActiveWorkspaceId()
  const activeScopeId = useActiveScopeId()
  const activeChatId = useActiveChatId()
  const chatsById = useDb((root) => root.app.chats)
  const scopesById = useDb((root) => root.app.scopes)
  const sessionsById = useDb((root) => root.pi.sessions)
  const reposById = useDb((root) => root.app.repos)

  // The repo backing the active workspace (used for nice branch
  // labels). Cheap to derive inline — the active workspace's
  // scopes are already in scope.
  const activeRepo = useMemo(() => {
    if (!activeWorkspaceId) return null
    for (const scope of Object.values(scopesById)) {
      if (scope.workspaceId === activeWorkspaceId && scope.repoId != null) {
        return reposById[scope.repoId] ?? null
      }
    }
    return null
  }, [activeWorkspaceId, scopesById, reposById])

  const rows = useMemo<WorktreeRow[]>(() => {
    if (!activeWorkspaceId) return []

    // Worktrees the agent sidebar would show: same `archived`
    // filter so the picker matches the sidebar.
    const wsScopes = Object.values(scopesById).filter(
      (s) =>
        s.workspaceId === activeWorkspaceId && !s.archived,
    )
    const scopeIds = new Set(wsScopes.map((s) => s.id))

    // Bucket chats per scope, deduped by sessionId, ignoring
    // archived sessions — matches `useSidebarGroups`.
    const buckets = new Map<string, Chat[]>()
    const oldestFirst = Object.values(chatsById).sort(
      (a, b) => a.createdAt - b.createdAt,
    )
    const seenSession = new Set<string>()
    for (const chat of oldestFirst) {
      if (!scopeIds.has(chat.scopeId)) continue
      if (chat.session.kind === "ready") {
        const sid = chat.session.sessionId
        if (seenSession.has(sid)) continue
        if (sessionsById[sid]?.archived) continue
        seenSession.add(sid)
      }
      const arr = buckets.get(chat.scopeId) ?? []
      arr.push(chat)
      buckets.set(chat.scopeId, arr)
    }

    const tsOfChat = (c: Chat): number => {
      if (c.session.kind === "ready") {
        const s = sessionsById[c.session.sessionId]
        return s?.lastOpenedAt ?? s?.lastActivityAt ?? c.createdAt
      }
      return c.createdAt
    }

    const out: WorktreeRow[] = []
    for (const scope of wsScopes) {
      const chats = buckets.get(scope.id) ?? []
      if (chats.length === 0) continue
      // Pick the representative chat — the most-recently-touched
      // one in this scope. Same fallback chain as the
      // `searchRecentAgents` sorter so the two pickers stay in
      // sync about what "recent" means.
      let best = chats[0]!
      let bestTs = tsOfChat(best)
      let isStreaming = false
      let hasUnread = false
      for (let i = 0; i < chats.length; i++) {
        const c = chats[i]!
        if (i > 0) {
          const t = tsOfChat(c)
          if (t > bestTs) {
            best = c
            bestTs = t
          }
        }
        // Same heuristic the agent sidebar uses for the
        // collapsed-worktree indicators: streaming flag from the
        // session, and an unread dot when the session completed a
        // turn after it was last opened. The active chat is
        // excluded from the unread predicate so jumping back to
        // the picker right after closing a chat doesn't show a
        // stale dot on the row you just came from.
        if (c.session.kind !== "ready") continue
        const s = sessionsById[c.session.sessionId]
        if (!s) continue
        if (s.isStreaming) isStreaming = true
        if (
          c.id !== activeChatId &&
          s.lastCompletedAt != null &&
          s.lastCompletedAt > (s.lastOpenedAt ?? 0)
        ) {
          hasUnread = true
        }
      }
      out.push({
        scope,
        representativeChat: best,
        ts: bestTs,
        label: worktreeGroupLabel(scope, activeRepo),
        isStreaming,
        hasUnread,
      })
    }

    out.sort((a, b) => b.ts - a.ts)
    return out
  }, [
    activeWorkspaceId,
    activeChatId,
    scopesById,
    chatsById,
    sessionsById,
    activeRepo,
  ])

  const onActivate = useCallback(
    (row: WorktreeRow) => {
      const chatId = row.representativeChat.id
      void dbClient
        .update((root) => {
          if (focusPaneShowingChatInRoot(root, windowId, chatId)) return
          selectChatInRoot(root, windowId, chatId)
        })
        .then(() => {
          requestFocusComposer(chatId)
        })
      setOpen(false)
    },
    [dbClient, windowId],
  )

  const initialSelectedIndex =
    rows.length >= 2 &&
    activeScopeId != null &&
    rows[0]?.scope.id === activeScopeId
      ? 1
      : 0

  return (
    <Palette
      open={open}
      onClose={close}
      items={rows}
      onActivate={onActivate}
      getKey={(r) => r.scope.id}
      getFilterText={(r) => r.label}
      placeholder="Find worktree..."
      emptyMessage={null}
      initialSelectedIndex={initialSelectedIndex}
      // Label + activity indicator + relative-time hint. This is a
      // typed picker for a single entity kind, not the global
      // command palette — the context to the right of the name
      // (streaming spinner, unread dot, "5m" since last touch) is
      // informative, and mirrors the agent sidebar's
      // collapsed-worktree row chrome so the two surfaces tell
      // the same story.
      renderRow={({ item, isSelected, rowRef, onMouseMove, onActivate }) => (
        <PaletteRow
          key={item.scope.id}
          isSelected={isSelected}
          rowRef={rowRef}
          onMouseMove={onMouseMove}
          onActivate={onActivate}
        >
          <span className="flex-1 truncate">{item.label}</span>
          <ActivityIndicator
            isStreaming={item.isStreaming}
            hasUnread={item.hasUnread}
          />
          <span className="ml-3 shrink-0 text-[11px] tabular-nums text-muted-foreground">
            {formatRelative(item.ts)}
          </span>
        </PaletteRow>
      )}
    />
  )
}

/**
 * Spinner + unread-dot stack matching the agent sidebar's
 * `WorktreeGroupRow` (collapsed) indicators. Streaming always
 * wins over unread — same rule the sidebar uses, so the picker
 * never stacks two indicators in the same slot.
 */
function ActivityIndicator({
  isStreaming,
  hasUnread,
}: {
  isStreaming: boolean
  hasUnread: boolean
}) {
  if (isStreaming) {
    return (
      <span
        aria-label="Worktree has a streaming session"
        className="ml-2 flex shrink-0 items-center text-muted-foreground"
      >
        <Spinner />
      </span>
    )
  }
  if (hasUnread) {
    return (
      <span
        aria-label="Worktree has an unread chat"
        className="ml-2 flex shrink-0 items-center"
      >
        <span className="block h-1.5 w-1.5 rounded-full bg-foreground" />
      </span>
    )
  }
  return null
}

/**
 * Compact relative-time label: "0m / 5m / 2h / 3d / 4w / 6mo / 1y".
 * Truncated to the dominant unit — palette rows are tight and we
 * don't need precision past that. Same shape as
 * `searchRecentAgents`'s helper.
 */
function formatRelative(ts: number | null | undefined): string {
  if (!ts) return ""
  const diff = Math.max(0, Date.now() - ts)
  const min = Math.floor(diff / 60_000)
  if (min < 60) return `${min}m`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.floor(hr / 24)
  if (day < 7) return `${day}d`
  const wk = Math.floor(day / 7)
  if (wk < 5) return `${wk}w`
  const mo = Math.floor(day / 30)
  if (mo < 12) return `${mo}mo`
  const yr = Math.floor(day / 365)
  return `${yr}y`
}

/* -------------------------------------------------------------------------- */
/*                                  Mount                                     */
/* -------------------------------------------------------------------------- */

function mount() {
  if (document.body?.dataset.recentWorktreesPaletteMounted === "1") return
  if (document.body)
    document.body.dataset.recentWorktreesPaletteMounted = "1"

  const host = document.createElement("div")
  host.setAttribute("data-recent-worktrees-palette", "1")
  document.body.appendChild(host)

  createRoot(host).render(
    <StrictMode>
      <ZenbuProvider>
        <RecentWorktreesPalette />
      </ZenbuProvider>
    </StrictMode>,
  )
}

mount()
