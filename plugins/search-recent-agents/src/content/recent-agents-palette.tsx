import { useCallback, useEffect, useMemo, useState } from "react"
import { useDb, useDbClient, useEvents } from "@zenbujs/core/react"
import { Palette, PaletteRow } from "@zenbu/ui/palette"
import { Spinner } from "@/components/common/spinner"
import { chatLabel, resolveChatLabel } from "@/lib/chat-label"
import { useWindowId } from "@/lib/window-state/window-id"
import { useActiveWorkspaceId } from "@/lib/window-state/active-view"
import { activeChatIdOf } from "@/lib/window-state/derived"
import {
  focusPaneShowingChatInRoot,
  selectChatInRoot,
} from "@/lib/window-state/selection"
import { requestFocusComposer } from "@/lib/focus-composer"
import type { Schema } from "@host/main/schema"

type Chat = Schema["chats"][string]
type Session = Schema["sessions"][string]

/**
 * Cmd+P recent-agents palette.
 *
 * Recency comes for free from `session.lastOpenedAt`, which the
 * host's `SessionActivityService` stamps every time a session
 * enters the active-viewer set in any window. We just sort scope
 * sessions by that timestamp (most recent first) and fall back to
 * `lastActivityAt` / `chat.createdAt` for sessions that have never
 * been opened.
 *
 * Default selection is index 1, so Cmd+P → Enter pops back to the
 * *previously* active agent (VSCode Ctrl+P semantics — the
 * currently-active one is at index 0).
 *
 * Rows carry three pieces of context next to the label:
 *
 *   - The relative-time hint ("5m", "2h") on the far right, matching
 *     the sort order so the order reads as "why this row is here".
 *   - A spinner while the session is streaming.
 *   - A dot when the session finished a turn since the user last
 *     opened it (skipped for the active chat so the row you're
 *     sitting on doesn't dot itself).
 *
 * The global Cmd+Shift+P palette is intentionally label-only; this
 * picker is *not* that palette — it's a typed picker for a single
 * entity kind, and the context next to the name is informative,
 * not chrome.
 */
export function RecentAgentsPalette() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const off = events.app.toggleAgentsPalette.subscribe(() => {
      setOpen(o => !o)
    })
    return off
  }, [events])

  const close = useCallback(() => setOpen(false), [])

  const activeWorkspaceId = useActiveWorkspaceId()
  const chats = useDb(root => Object.values(root.app.chats))
  const scopesById = useDb(root => root.app.scopes)
  const sessionsById = useDb(root => root.app.sessions)
  const activeChatId = useDb(root => activeChatIdOf(root, windowId))

  // Active session id (null for pending / no chat). Used only to
  // decide whether to default-select index 1 (Cmd+P → Enter swap).
  const activeSessionId = useMemo(() => {
    if (!activeChatId) return null
    const chat = chats.find(c => c.id === activeChatId)
    if (!chat || chat.session.kind !== "ready") return null
    return chat.session.sessionId
  }, [activeChatId, chats])

  // One row per session (deduped by sessionId on the oldest chat),
  // workspace-filtered, archived hidden, sorted by
  // `session.lastOpenedAt` desc. Sessions never opened fall through
  // to `lastActivityAt` / `createdAt` so they still appear, just
  // below opened ones.
  const rows = useMemo<Chat[]>(() => {
    if (!activeWorkspaceId) return []
    const scoped = chats.filter(
      c => scopesById[c.scopeId]?.workspaceId === activeWorkspaceId,
    )
    const oldestFirst = scoped.slice().sort((a, b) => a.createdAt - b.createdAt)
    const seen = new Set<string>()
    const bySession = new Map<string, Chat>()
    const pendings: Chat[] = []
    for (const chat of oldestFirst) {
      if (chat.session.kind !== "ready") {
        pendings.push(chat)
        continue
      }
      const sid = chat.session.sessionId
      if (seen.has(sid)) continue
      if (sessionsById[sid]?.archived) continue
      seen.add(sid)
      bySession.set(sid, chat)
    }
    const ready = Array.from(bySession.values())
    ready.sort((a, b) => {
      const sa = a.session.kind === "ready" ? a.session.sessionId : ""
      const sb = b.session.kind === "ready" ? b.session.sessionId : ""
      const oa = sessionsById[sa]?.lastOpenedAt ?? null
      const ob = sessionsById[sb]?.lastOpenedAt ?? null
      if (oa !== ob) {
        if (oa == null) return 1
        if (ob == null) return -1
        return ob - oa
      }
      const ta = sessionsById[sa]?.lastActivityAt ?? a.createdAt
      const tb = sessionsById[sb]?.lastActivityAt ?? b.createdAt
      return tb - ta
    })
    return [...ready, ...pendings]
  }, [activeWorkspaceId, chats, scopesById, sessionsById])

  const onActivate = useCallback(
    (chat: Chat) => {
      void dbClient
        .update(root => {
          if (focusPaneShowingChatInRoot(root, windowId, chat.id)) return
          selectChatInRoot(root, windowId, chat.id)
        })
        .then(() => {
          requestFocusComposer(chat.id)
        })
      setOpen(false)
    },
    [dbClient, windowId],
  )

  // VSCode Cmd+P: when there are at least two rows AND the top one
  // is the currently active session, default the selection to
  // index 1 so Enter jumps to the previously-active agent.
  const initialSelectedIndex =
    rows.length >= 2 &&
    activeSessionId != null &&
    rows[0]?.session.kind === "ready" &&
    rows[0].session.sessionId === activeSessionId
      ? 1
      : 0

  return (
    <Palette
      open={open}
      onClose={close}
      items={rows}
      onActivate={onActivate}
      getKey={chat => chat.id}
      getFilterText={chat => chatLabel(chat, sessionsById)}
      placeholder="Find agent..."
      emptyMessage={null}
      initialSelectedIndex={initialSelectedIndex}
      renderRow={({ item, isSelected, rowRef, onMouseMove, onActivate }) => (
        <AgentRow
          key={item.id}
          chat={item}
          session={
            item.session.kind === "ready"
              ? sessionsById[item.session.sessionId]
              : undefined
          }
          isActive={item.id === activeChatId}
          isSelected={isSelected}
          rowRef={rowRef}
          onMouseMove={onMouseMove}
          onActivate={onActivate}
        />
      )}
    />
  )
}

function AgentRow({
  chat,
  session,
  isActive,
  isSelected,
  rowRef,
  onMouseMove,
  onActivate,
}: {
  chat: Chat
  session: Session | undefined
  isActive: boolean
  isSelected: boolean
  rowRef: React.Ref<HTMLButtonElement>
  onMouseMove: () => void
  onActivate: () => void
}) {
  const sessionId =
    chat.session.kind === "ready" ? chat.session.sessionId : null
  const { label } = resolveChatLabel(chat, session)
  const fallback = chatLabel(chat, { [sessionId ?? ""]: session })
  // Same predicate as `chat-pane-container` / the agent sidebar:
  // a session has unread when its last completed turn is newer
  // than the last time it was opened. Skip the active chat so the
  // palette doesn't dot the row the user is currently sitting on.
  const isStreaming = session?.isStreaming ?? false
  const hasUnread =
    !isActive &&
    session != null &&
    session.lastCompletedAt != null &&
    session.lastCompletedAt > (session.lastOpenedAt ?? 0)
  // Prefer the "opened" timestamp — that's what we sort on, so the
  // hint matches the row order. Fall back to last agent activity
  // for sessions the user has never opened, then to chat creation.
  const ts = session?.lastOpenedAt ?? session?.lastActivityAt ?? chat.createdAt
  return (
    <PaletteRow
      isSelected={isSelected}
      rowRef={rowRef}
      onMouseMove={onMouseMove}
      onActivate={onActivate}
    >
      <span className="flex-1 truncate">{label || fallback}</span>
      {isStreaming ? (
        <span
          aria-label="Agent is streaming"
          className="ml-2 flex shrink-0 items-center text-muted-foreground"
        >
          <Spinner />
        </span>
      ) : hasUnread ? (
        <span
          aria-label="Agent has an unread turn"
          className="ml-2 flex shrink-0 items-center"
        >
          <span className="block h-1.5 w-1.5 rounded-full bg-foreground" />
        </span>
      ) : null}
      <span className="ml-3 shrink-0 text-[11px] tabular-nums text-muted-foreground">
        {formatRelative(ts)}
      </span>
    </PaletteRow>
  )
}

/**
 * Compact relative-time label: "0m / 5m / 2h / 3d / 4w / 6mo / 1y".
 * Truncated to the dominant unit — palette rows are tight and we
 * don't need precision past that.
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
