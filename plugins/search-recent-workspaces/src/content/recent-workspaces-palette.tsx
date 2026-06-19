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
  useActiveWorkspaceId,
} from "@/lib/window-state/active-view"
import { selectWorkspaceInRoot } from "@/lib/window-state/selection"
import { WorkspaceIcon } from "@/components/layout/workspace-icon"
import { useWorkspaceIconUrl } from "@/lib/workspace-icon"
import type { Schema } from "@host/main/schema"

type Workspace = Schema["workspaces"][string]

type WorkspaceRowData = {
  workspace: Workspace
  /** Any chat in any non-archived scope of this workspace has a
   * streaming session. Same predicate the agent sidebar uses for
   * its collapsed-worktree spinner aggregate, just lifted one
   * level so the picker reflects activity per *workspace*. */
  isStreaming: boolean
  /** Any chat in this workspace finished a turn after it was last
   * opened, excluding the currently-active chat. */
  hasUnread: boolean
}

/**
 * Cmd+O recent-workspaces palette.
 *
 * Sorted by our own `lastVisitedAt[workspaceId]`, falling back to
 * `workspace.createdAt` for never-visited workspaces so they still
 * appear (below visited ones). When the top row is the currently
 * active workspace we default-select index 1 — same VSCode Cmd+P
 * trick as `searchRecentAgents`, so Enter pops back to the
 * previously-active workspace.
 *
 * Workspace icons render with the host's `WorkspaceIcon` /
 * `useWorkspaceIconUrl`, matching the workspace rail. We
 * deliberately don't show a relative-time hint here — the row order
 * already communicates recency, and the picker stays visually quiet.
 */
function RecentWorkspacesPalette() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const off = events.searchRecentWorkspaces.togglePalette.subscribe(() => {
      setOpen((o) => !o)
    })
    return () => off()
  }, [events])

  const close = useCallback(() => setOpen(false), [])

  const activeWorkspaceId = useActiveWorkspaceId()
  const activeChatId = useActiveChatId()
  const workspacesById = useDb((root) => root.app.workspaces)
  const scopesById = useDb((root) => root.app.scopes)
  const chatsById = useDb((root) => root.app.chats)
  const sessionsById = useDb((root) => root.pi.sessions)
  const lastVisitedAt = useDb(
    (root) => root.searchRecentWorkspaces.lastVisitedAt,
  )

  const rows = useMemo<WorkspaceRowData[]>(() => {
    // Mirror the workspace rail's filter: hide archived workspaces
    // and the synthetic plugin-kind ones, which aren't addressable
    // through the workspace rail / picker UX.
    const list = Object.values(workspacesById).filter(
      (w) => !w.archived && w.kind !== "plugin",
    )
    list.sort((a, b) => {
      const ta = lastVisitedAt[a.id] ?? null
      const tb = lastVisitedAt[b.id] ?? null
      if (ta !== tb) {
        if (ta == null) return 1
        if (tb == null) return -1
        return tb - ta
      }
      // Same recency bucket (or both never visited): newest
      // workspace first, mirroring the workspace rail's tiebreaker.
      return b.createdAt - a.createdAt
    })

    // Group active scopes by workspace once so we don't rescan
    // `scopesById` per row. Same filter the agent sidebar applies
    // (`!archived`) so the picker mirrors what the sidebar would
    // show after a workspace switch. (The legacy `completed`
    // concept was folded into `archived` upstream.)
    const scopesByWs = new Map<string, string[]>()
    for (const scope of Object.values(scopesById)) {
      if (scope.archived) continue
      const arr = scopesByWs.get(scope.workspaceId) ?? []
      arr.push(scope.id)
      scopesByWs.set(scope.workspaceId, arr)
    }

    return list.map((w) => {
      const scopeIds = new Set(scopesByWs.get(w.id) ?? [])
      let isStreaming = false
      let hasUnread = false
      if (scopeIds.size > 0) {
        for (const chat of Object.values(chatsById)) {
          if (!scopeIds.has(chat.scopeId)) continue
          if (chat.session.kind !== "ready") continue
          const s = sessionsById[chat.session.sessionId]
          if (!s || s.archived) continue
          if (s.isStreaming) isStreaming = true
          if (
            chat.id !== activeChatId &&
            s.lastCompletedAt != null &&
            s.lastCompletedAt > (s.lastOpenedAt ?? 0)
          ) {
            hasUnread = true
          }
          if (isStreaming && hasUnread) break
        }
      }
      return { workspace: w, isStreaming, hasUnread }
    })
  }, [
    workspacesById,
    scopesById,
    chatsById,
    sessionsById,
    activeChatId,
    lastVisitedAt,
  ])

  const onActivate = useCallback(
    (row: WorkspaceRowData) => {
      void dbClient.update((root) => {
        if (activeWorkspaceId === row.workspace.id) return
        selectWorkspaceInRoot(root, windowId, row.workspace.id)
      })
      setOpen(false)
    },
    [dbClient, windowId, activeWorkspaceId],
  )

  // VSCode Cmd+P semantics: when the currently-active workspace is
  // at the top of the list, start the cursor on row 1 so Enter
  // jumps to the previously-active workspace.
  const initialSelectedIndex =
    rows.length >= 2 &&
    activeWorkspaceId != null &&
    rows[0]?.workspace.id === activeWorkspaceId
      ? 1
      : 0

  return (
    <Palette
      open={open}
      onClose={close}
      items={rows}
      onActivate={onActivate}
      getKey={(r) => r.workspace.id}
      getFilterText={(r) => r.workspace.name}
      placeholder="Find workspace..."
      emptyMessage={null}
      initialSelectedIndex={initialSelectedIndex}
      renderRow={({ item, isSelected, rowRef, onMouseMove, onActivate }) => (
        <WorkspaceRow
          key={item.workspace.id}
          workspace={item.workspace}
          isStreaming={item.isStreaming}
          hasUnread={item.hasUnread}
          isSelected={isSelected}
          rowRef={rowRef}
          onMouseMove={onMouseMove}
          onActivate={onActivate}
        />
      )}
    />
  )
}

function WorkspaceRow({
  workspace,
  isStreaming,
  hasUnread,
  isSelected,
  rowRef,
  onMouseMove,
  onActivate,
}: {
  workspace: Workspace
  isStreaming: boolean
  hasUnread: boolean
  isSelected: boolean
  rowRef: React.Ref<HTMLButtonElement>
  onMouseMove: () => void
  onActivate: () => void
}) {
  const iconUrl = useWorkspaceIconUrl({
    icon: workspace.icon ?? null,
    iconAuto: workspace.iconAuto ?? null,
  })
  return (
    <PaletteRow
      isSelected={isSelected}
      rowRef={rowRef}
      onMouseMove={onMouseMove}
      onActivate={onActivate}
    >
      <span className="flex shrink-0 items-center">
        <WorkspaceIcon
          src={iconUrl}
          fallback={workspace.name}
          isActive={isSelected}
          size={18}
        />
      </span>
      <span className="ml-2 flex-1 truncate">{workspace.name}</span>
      {/* Streaming wins over unread — same rule the agent sidebar's
          collapsed-worktree row uses so the two surfaces tell the
          same story. */}
      {isStreaming ? (
        <span
          aria-label="Workspace has a streaming session"
          className="ml-2 flex shrink-0 items-center text-muted-foreground"
        >
          <Spinner />
        </span>
      ) : hasUnread ? (
        <span
          aria-label="Workspace has an unread chat"
          className="ml-2 flex shrink-0 items-center"
        >
          <span className="block h-1.5 w-1.5 rounded-full bg-foreground" />
        </span>
      ) : null}
    </PaletteRow>
  )
}

/* -------------------------------------------------------------------------- */
/*                                  Mount                                     */
/* -------------------------------------------------------------------------- */

function mount() {
  if (document.body?.dataset.recentWorkspacesPaletteMounted === "1") return
  if (document.body)
    document.body.dataset.recentWorkspacesPaletteMounted = "1"

  const host = document.createElement("div")
  host.setAttribute("data-recent-workspaces-palette", "1")
  document.body.appendChild(host)

  createRoot(host).render(
    <StrictMode>
      <ZenbuProvider>
        <RecentWorkspacesPalette />
      </ZenbuProvider>
    </StrictMode>,
  )
}

mount()
