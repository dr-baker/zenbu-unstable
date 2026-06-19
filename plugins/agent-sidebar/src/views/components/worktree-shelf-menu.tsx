import { useMemo, useRef } from "react"
import { ArchiveIcon, ArchiveRestoreIcon } from "lucide-react"
import { useDb, useDbClient } from "@zenbujs/core/react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@zenbu/ui/dropdown-menu"
import { Button } from "@zenbu/ui/button"
import { HoverTip } from "@zenbu/ui/hover-tip"
import { useActiveWorkspaceId } from "@/lib/window-state/active-view"
import type { Schema } from "@host/main/schema"
import type { SelfDbSection as PiSchema } from "../../../.zenbu/types/deps/pi/db-sections"

type Scope = Schema["scopes"][string]
type Repo = Schema["repos"][string]
type Session = PiSchema["sessions"][string]
type Chat = Schema["chats"][string]

/**
 * Bottom-of-sidebar entrypoint into the "archived" bucket.
 * Renders nothing when the active workspace has no archived
 * worktrees and no archived chats; otherwise an abstract
 * stacked-layers icon appears in the footer slot.
 *
 * UI shape: a single `DropdownMenu` whose root contains up to
 * two `DropdownMenuSub` entries — "Archived Worktrees" and
 * "Archived Chats". Empty buckets are omitted entirely so the
 * user never sees a dead sub-trigger; if only one bucket has
 * anything in it, only that one renders. Hovering a category
 * opens a flyout sub-menu with one row per archived item;
 * clicking a row flips the relevant `archived` flag back to
 * false, popping it back into the regular sidebar.
 *
 * The trigger itself shows no count badge — the icon's presence
 * is the signal.
 */
export function WorktreeShelfMenu() {
  const activeWorkspaceId = useActiveWorkspaceId()
  const dbClient = useDbClient()
  const buttonRef = useRef<HTMLButtonElement>(null)

  // Subscribe to raw db slices. The selectors here MUST return
  // identities the db replica owns (not freshly-allocated arrays
  // of object literals) — `useDb` compares the returned value
  // across renders with shallow equality, so synthesizing a brand
  // new array of `{ id, label, … }` literals every selector run
  // would cause an infinite re-render loop.
  // (See zenbu-labs/zenbu.js#11.)
  const scopesById = useDb(root => root.app.scopes)
  const reposById = useDb(root => root.app.repos)
  const sessionsById = useDb(root => root.pi.sessions)
  const chatsById = useDb(root => root.app.chats)

  type ShelfEntry = {
    id: string
    label: string
    timestamp: number | null
  }

  // Archived worktrees in the active workspace, newest-archived
  // first. The `archivedAt` stamp drives the order; legacy
  // entries without a timestamp fall to the bottom but stay
  // grouped by id so the order is still deterministic.
  const worktreeEntries = useMemo<ShelfEntry[]>(() => {
    if (!activeWorkspaceId) return []
    const out: ShelfEntry[] = []
    for (const scope of Object.values(scopesById)) {
      if (scope.workspaceId !== activeWorkspaceId) continue
      if (!scope.archived) continue
      const repoId = scope.repoId
      const repo: Repo | undefined = repoId
        ? reposById[repoId]
        : undefined
      out.push({
        id: scope.id,
        label: labelForScope(scope, repo ?? null),
        timestamp: scope.archivedAt,
      })
    }
    out.sort(
      (a, b) =>
        (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
        a.id.localeCompare(b.id),
    )
    return out
  }, [activeWorkspaceId, scopesById, reposById])

  // Archived chats = archived sessions whose owning chat lives in
  // a scope inside the active workspace. The session itself is
  // the unit of archiving; we pick one chat to identify it for
  // the unarchive click target. Sessions carry no `archivedAt`
  // stamp, so we lean on `lastActivityAt` for ordering.
  const chatEntries = useMemo<ShelfEntry[]>(() => {
    if (!activeWorkspaceId) return []
    const scopeIdsInWorkspace = new Set<string>()
    for (const scope of Object.values(scopesById)) {
      if (scope.workspaceId !== activeWorkspaceId) continue
      scopeIdsInWorkspace.add(scope.id)
    }
    if (scopeIdsInWorkspace.size === 0) return []
    const out: ShelfEntry[] = []
    const seen = new Set<string>()
    for (const chat of Object.values(chatsById) as Chat[]) {
      if (chat.session.kind !== "ready") continue
      if (!scopeIdsInWorkspace.has(chat.scopeId)) continue
      const sid = chat.session.sessionId
      if (seen.has(sid)) continue
      const session: Session | undefined = sessionsById[sid]
      if (!session || !session.archived) continue
      seen.add(sid)
      out.push({
        id: sid,
        label: labelForSession(session),
        timestamp: session.lastActivityAt ?? null,
      })
    }
    out.sort(
      (a, b) =>
        (b.timestamp ?? 0) - (a.timestamp ?? 0) ||
        a.id.localeCompare(b.id),
    )
    return out
  }, [
    activeWorkspaceId,
    scopesById,
    chatsById,
    sessionsById,
  ])

  const unarchiveWorktree = (scopeId: string) => {
    void dbClient.update(root => {
      const scope = root.app.scopes[scopeId]
      if (!scope) return
      scope.archived = false
      scope.archivedAt = null
    })
  }

  const unarchiveChat = (sessionId: string) => {
    void dbClient.update(root => {
      const session = root.pi.sessions[sessionId]
      if (!session) return
      session.archived = false
    })
  }

  // Hide the whole control when there's nothing in either
  // bucket. An always-on icon would be visually noisy on a fresh
  // workspace.
  if (worktreeEntries.length === 0 && chatEntries.length === 0) return null

  return (
    <DropdownMenu>
      <HoverTip label="Archived" setAriaLabel={false}>
        <DropdownMenuTrigger asChild>
          <Button
            ref={buttonRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            className="hg-icon size-[22px] rounded bg-transparent text-muted-foreground hover:bg-transparent"
            aria-label="Archived"
          >
            <ArchiveIcon size={13} />
          </Button>
        </DropdownMenuTrigger>
      </HoverTip>
      <DropdownMenuContent
        align="start"
        side="top"
        sideOffset={6}
        className="w-56"
      >
        {worktreeEntries.length > 0 ? (
          <BucketSub
            label="Archived Worktrees"
            entries={worktreeEntries}
            onPick={unarchiveWorktree}
          />
        ) : null}
        {chatEntries.length > 0 ? (
          <BucketSub
            label="Archived Chats"
            entries={chatEntries}
            onPick={unarchiveChat}
          />
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type BucketSubProps = {
  label: string
  entries: ReadonlyArray<{
    id: string
    label: string
    timestamp: number | null
  }>
  onPick: (id: string) => void
}

/**
 * One category row in the root menu, with a hover-flyout
 * sub-menu listing every item in the bucket. Only rendered by
 * the caller when `entries` is non-empty.
 */
function BucketSub({ label, entries, onPick }: BucketSubProps) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <span className="flex-1">{label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[320px] w-64 overflow-y-auto">
        {entries.map(entry => {
          const subtitle =
            entry.timestamp != null ? formatRelative(entry.timestamp) : null
          return (
            <DropdownMenuItem
              key={entry.id}
              onSelect={() => onPick(entry.id)}
              // Hint at the "click to restore" behavior via the
              // row's primary glyph.
              className="gap-2"
            >
              <ArchiveRestoreIcon className="size-3.5 text-muted-foreground" />
              <span className="flex-1 truncate">{entry.label}</span>
              {subtitle ? (
                <span className="text-[10px] tabular-nums text-muted-foreground">
                  {subtitle}
                </span>
              ) : null}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/** Label for a scope row: prefer the worktree branch name, fall
 * back to the directory basename. Mirrors `worktreeGroupLabel` in
 * `agent-sidebar-pane.tsx`; kept inline here so this component
 * doesn't reach into the sidebar module. */
function labelForScope(scope: Scope, repo: Repo | null): string {
  if (repo) {
    const wt = repo.worktrees.find(w => w.path === scope.directory)
    if (wt?.branch) return wt.branch
  }
  const parts = scope.directory.split("/").filter(Boolean)
  return parts[parts.length - 1] ?? scope.directory
}

/** Label for an archived chat row. */
function labelForSession(session: Session): string {
  const title = session.title?.trim()
  return title && title !== "Untitled" ? title : "Untitled chat"
}

/** Tiny relative-time formatter for the detail rows. Stays
 * lightweight (no Intl.RelativeTimeFormat instantiation per row)
 * since the menu can render dozens of entries. */
function formatRelative(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60_000) return "just now"
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d ago`
  const weeks = Math.floor(days / 7)
  if (weeks < 5) return `${weeks}w ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  const years = Math.floor(days / 365)
  return `${years}y ago`
}
