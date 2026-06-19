import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useCollection, useDb } from "@zenbujs/core/react"
import { useThemeSync } from "@/lib/theme"
import { resolveActiveChatIdInAnyWindow } from "@/lib/active-chat"
import { HoverTip } from "@zenbu/ui/hover-tip"
/**
 * Right-sidebar view that visualizes the pi `AgentSessionEvent` stream
 * for whichever chat is currently active. Reads
 * `root.pi.sessions[sid].eventLog` directly — no RPC, no polling — so
 * events appear as soon as the main process appends them. Useful as a
 * "what is pi actually emitting right now" debug surface.
 */
export function PiEventLogApp() {
  useThemeSync()
  const sessionId = useActiveSessionId()

  if (!sessionId) {
    return (
      <Placeholder>
        No active session. Open a chat to inspect its pi event log.
      </Placeholder>
    )
  }

  return <PiEventLogPane key={sessionId} sessionId={sessionId} />
}

function PiEventLogPane({ sessionId }: { sessionId: string }) {
  const eventLogRef = useDb(
    root => root.pi.sessions[sessionId]?.eventLog,
  )
  // useCollection happily accepts undefined refs (returns empty) so
  // there's no "ref undefined" branch to guard.
  const { items } = useCollection(eventLogRef)
  const sessionTitle = useDb(
    root => root.pi.sessions[sessionId]?.title ?? null,
  )
  const cwd = useDb(root => {
    const scopeId = root.pi.sessions[sessionId]?.scopeId
    return scopeId ? root.app.scopes[scopeId]?.directory ?? null : null
  })

  const [filter, setFilter] = useState("")
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set())
  const [autoScroll, setAutoScroll] = useState(true)

  const filtered = useMemo(() => {
    if (!filter.trim()) return items
    const needle = filter.trim().toLowerCase()
    return items.filter(ev => {
      if (ev.kind.toLowerCase().includes(needle)) return true
      try {
        const s = JSON.stringify(ev.payload).toLowerCase()
        return s.includes(needle)
      } catch {
        return false
      }
    })
  }, [items, filter])

  // Auto-scroll to the bottom when new events arrive, but only while
  // `autoScroll` is engaged. Detaching mid-stream (by toggling off or
  // scrolling up) leaves the user's scroll position alone.
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    if (!autoScroll) return
    const el = listRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [filtered.length, autoScroll])

  // If the user scrolls away from the bottom themselves, drop out of
  // auto-scroll. If they scroll back to the bottom, re-engage it.
  function onScroll(e: React.UIEvent<HTMLDivElement>) {
    const el = e.currentTarget
    const atBottom =
      el.scrollHeight - el.clientHeight - el.scrollTop < 4
    if (atBottom !== autoScroll) setAutoScroll(atBottom)
  }

  function toggleExpanded(seq: number) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(seq)) next.delete(seq)
      else next.add(seq)
      return next
    })
  }

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <Header
        sessionTitle={sessionTitle}
        cwd={cwd}
        totalCount={items.length}
        filteredCount={filtered.length}
        filter={filter}
        onFilterChange={setFilter}
        autoScroll={autoScroll}
        onToggleAutoScroll={() => setAutoScroll(v => !v)}
        onClearExpanded={() => setExpanded(new Set())}
      />

      <div
        ref={listRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto font-mono text-[11px] leading-[1.45]"
      >
        {filtered.length === 0 ? (
          <Placeholder>
            {items.length === 0
              ? "No events yet. Send a message to start the stream."
              : "No events match this filter."}
          </Placeholder>
        ) : (
          <ul className="divide-y divide-border/60">
            {filtered.map(ev => (
              <EventRow
                key={ev.seq}
                event={ev}
                expanded={expanded.has(ev.seq)}
                onToggle={() => toggleExpanded(ev.seq)}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Header({
  sessionTitle,
  cwd,
  totalCount,
  filteredCount,
  filter,
  onFilterChange,
  autoScroll,
  onToggleAutoScroll,
  onClearExpanded,
}: {
  sessionTitle: string | null
  cwd: string | null
  totalCount: number
  filteredCount: number
  filter: string
  onFilterChange: (s: string) => void
  autoScroll: boolean
  onToggleAutoScroll: () => void
  onClearExpanded: () => void
}) {
  const showFilteredCount = filter.trim().length > 0
  const countLabel = showFilteredCount
    ? `${filteredCount.toLocaleString()} / ${totalCount.toLocaleString()}`
    : totalCount.toLocaleString()

  return (
    <div className="flex shrink-0 flex-col gap-2 border-b border-border bg-muted/30 px-3 py-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[11px] font-medium text-foreground">
            {sessionTitle?.trim() || "Pi event log"}
          </div>
          <div className="text-[10px] text-muted-foreground">
            {countLabel} event{filteredCount === 1 ? "" : "s"}
          </div>
          {cwd && <CwdRow cwd={cwd} />}
        </div>
        <div className="flex items-center gap-1">
          <ToolbarButton
            active={autoScroll}
            title={
              autoScroll
                ? "Auto-scrolling. Click to pin position."
                : "Paused. Click to follow the latest event."
            }
            onClick={onToggleAutoScroll}
          >
            {autoScroll ? "Follow" : "Paused"}
          </ToolbarButton>
          <ToolbarButton title="Collapse all expanded rows" onClick={onClearExpanded}>
            Collapse
          </ToolbarButton>
        </div>
      </div>
      <input
        type="text"
        value={filter}
        onChange={e => onFilterChange(e.target.value)}
        placeholder="Filter by kind or payload…"
        className="h-7 w-full rounded-md border border-border bg-background px-2 text-[11px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
      />
    </div>
  )
}

/**
 * Single-line cwd display + click-to-copy. Uses the modern
 * `navigator.clipboard` API (available in the renderer iframe) and
 * shows a brief "Copied" affordance so the user knows it worked.
 */
function CwdRow({ cwd }: { cwd: string }) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(t)
  }, [copied])

  async function onCopy(e: React.MouseEvent) {
    e.stopPropagation()
    try {
      await navigator.clipboard.writeText(cwd)
      setCopied(true)
    } catch (err) {
      console.error("[pi-event-log] copy cwd failed:", err)
    }
  }

  return (
    <button
      type="button"
      onClick={onCopy}
      aria-label={copied ? "Copied!" : `Click to copy: ${cwd}`}
      className="group mt-1 flex w-full items-center gap-1 rounded-sm text-left text-[10px] text-muted-foreground hover:text-foreground"
    >
      <span className="truncate font-mono" dir="rtl">
        {cwd}
      </span>
      <span
        className={
          "shrink-0 text-[10px] transition-opacity " +
          (copied
            ? "text-primary opacity-100"
            : "opacity-0 group-hover:opacity-100")
        }
      >
        {copied ? "copied" : "copy"}
      </span>
    </button>
  )
}

function ToolbarButton({
  active,
  title,
  onClick,
  children,
}: {
  active?: boolean
  title: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <HoverTip label={title} setAriaLabel={false}>
      <button
        type="button"
        aria-label={title}
        onClick={onClick}
        className={
          "rounded-md border px-1.5 py-0.5 text-[10px] font-medium " +
          (active
            ? "border-primary/40 bg-primary/10 text-primary"
            : "border-border bg-background text-muted-foreground hover:text-foreground")
        }
      >
        {children}
      </button>
    </HoverTip>
  )
}

function EventRow({
  event,
  expanded,
  onToggle,
}: {
  event: { seq: number; kind: string; payload: unknown; timestamp: number }
  expanded: boolean
  onToggle: () => void
}) {
  const summary = useMemo(() => summarizePayload(event.payload), [event.payload])
  const json = useMemo(() => {
    if (!expanded) return ""
    try {
      return JSON.stringify(event.payload, null, 2)
    } catch {
      return String(event.payload)
    }
  }, [event.payload, expanded])

  return (
    <li>
      <button
        type="button"
        onClick={onToggle}
        className="group flex w-full items-baseline gap-2 px-3 py-1.5 text-left hover:bg-muted/50"
      >
        <span className="w-12 shrink-0 text-[10px] tabular-nums text-muted-foreground">
          #{event.seq}
        </span>
        <span
          className="shrink-0 rounded-sm px-1 text-[10px] font-medium"
          style={kindStyle(event.kind)}
        >
          {event.kind}
        </span>
        {summary && (
          <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground/70">
          {formatTime(event.timestamp)}
        </span>
      </button>
      {expanded && (
        <pre className="overflow-x-auto whitespace-pre-wrap break-words bg-muted/40 px-3 py-2 text-[10.5px] leading-[1.5] text-foreground/90">
          {json}
        </pre>
      )}
    </li>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-4 text-center text-[11px] text-muted-foreground">
      {children}
    </div>
  )
}

/**
 * Stable color per event kind. Hashes the kind string into one of a few
 * theme-friendly hues so related events read as a column at a glance
 * without needing a hardcoded palette of every pi event name.
 */
function kindStyle(kind: string): React.CSSProperties {
  let h = 0
  for (let i = 0; i < kind.length; i++) {
    h = (h * 31 + kind.charCodeAt(i)) >>> 0
  }
  const hue = h % 360
  return {
    color: `hsl(${hue} 70% 45%)`,
    backgroundColor: `hsl(${hue} 70% 45% / 0.10)`,
  }
}
/**
 * fixme: claude slop, we should have these typed at the db level
 */

/**
 * Best-effort one-liner for the row. Pulls out a few familiar pi keys
 * (text, toolName, role, message) before falling back to a generic
 * JSON tail. Always one line, always truncated by CSS.
 */
function summarizePayload(payload: unknown): string {
  if (payload == null || typeof payload !== "object") {
    return payload == null ? "" : String(payload)
  }
  const p = payload as Record<string, unknown>
  const candidates: Array<unknown> = [
    p.toolName,
    p.role,
    typeof p.message === "object" && p.message
      ? (p.message as Record<string, unknown>).role
      : undefined,
    p.text,
    typeof p.assistantMessageEvent === "object" && p.assistantMessageEvent
      ? (p.assistantMessageEvent as Record<string, unknown>).type
      : undefined,
  ]
  const parts: string[] = []
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) parts.push(c.trim())
  }
  if (parts.length > 0) return parts.join(" · ")
  try {
    const s = JSON.stringify(payload)
    return s.length > 160 ? s.slice(0, 159) + "…" : s
  } catch {
    return ""
  }
}

function formatTime(ts: number): string {
  if (!Number.isFinite(ts) || ts <= 0) return ""
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  const ms = String(d.getMilliseconds()).padStart(3, "0")
  return `${hh}:${mm}:${ss}.${ms}`
}

/**
 * Resolve the chat the user is working with via the shared
 * `active-chat` resolver, then chain chat → ready session id.
 * Returns null while no chat is selected or while its session is
 * still pending. Using the shared resolver means the event log
 * tracks the same chat as the agent sidebar even when the user
 * focuses a non-chat tab in a split.
 */
function useActiveSessionId(): string | null {
  return useDb(root => {
    const found = resolveActiveChatIdInAnyWindow(root)
    if (!found) return null
    const chat = root.app.chats[found.chatId]
    if (!chat) return null
    return chat.session.kind === "ready" ? chat.session.sessionId : null
  })
}
