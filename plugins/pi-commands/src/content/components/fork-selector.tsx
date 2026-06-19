import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useRpc } from "@zenbujs/core/react"
import { cn } from "../lib/utils"
import { ensureRowInView } from "../lib/ensure-row-in-view"
import { useHoverIntent } from "../lib/use-hover-intent"

/**
 * Pi-style fork picker. Distinct from `TreeSelector` on purpose:
 *
 *   - Fork is non-destructive (it just creates a new chat) so there
 *     is no confirm step — pressing Enter / Space on a row fires
 *     `onConfirm` immediately.
 *   - Only `user` messages are listed; the tree's branch/fork
 *     decoration is omitted entirely. The flat view matches pi's
 *     own fork UI: bigger text, each row is the message excerpt.
 *
 * Keyboard model mirrors TreeSelector's browse stage (so muscle
 * memory transfers): j/k or arrows to move, h/l or arrows to page,
 * Ctrl-u/d for half-page, g/G for top/bottom, single chars extend
 * search, Esc clears search or closes.
 */

type EntryNode = {
  id: string
  parentId: string | null
  kind: string
  label: string
  timestamp: number
  messageRole: string | null
}

type Row = {
  /** Entry id pi assigned to the user message. */
  id: string
  /** Display label (excerpt of the user message text). */
  label: string
}

export type ForkSelectorProps = {
  sessionId: string
  /** Re-fetch when this changes (e.g. session.lastActivityAt). */
  refreshKey: number
  /** Currently active leaf entry id. Used to auto-position the
   * cursor on the most-recent user message reachable from the
   * current leaf (closest match to "where you are"). */
  activeLeafId: string | null
  /** Fires immediately on Enter / Space — fork is non-destructive
   * so there's no confirmation step. */
  onConfirm: (args: { entryId: string; label: string }) => Promise<void> | void
  onCancel: () => void
}

export function ForkSelector({
  sessionId,
  refreshKey,
  activeLeafId,
  onConfirm,
  onCancel,
}: ForkSelectorProps) {
  const rpc = useRpc()
  const [entries, setEntries] = useState<EntryNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const hover = useHoverIntent()
  const [busy, setBusy] = useState(false)
  const [hasFocus, setHasFocus] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    rpc.pi.sessions
      .getEntryTree({ sessionId })
      .then(res => {
        if (cancelled) return
        setEntries(res.entries)
        setError(null)
        setLoading(false)
      })
      .catch(err => {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [rpc, sessionId, refreshKey])

  const allUserRows = useMemo<Row[]>(() => {
    const out: Row[] = []
    // Stable order: entries arrive in creation order from pi. We
    // don't reorder.
    for (const e of entries) {
      if (e.kind === "message" && e.messageRole === "user") {
        out.push({ id: e.id, label: e.label })
      }
    }
    return out
  }, [entries])

  const filteredRows = useMemo<Row[]>(() => {
    const tokens = searchQuery.toLowerCase().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) return allUserRows
    return allUserRows.filter(r => {
      const hay = r.label.toLowerCase()
      return tokens.every(t => hay.includes(t))
    })
  }, [allUserRows, searchQuery])

  // Auto-position the cursor on the most-recent user message
  // reachable from the active leaf on first load. Falls back to the
  // last row in the list so the user starts at "where they were".
  const positionedRef = useRef(false)
  useEffect(() => {
    if (positionedRef.current) return
    if (filteredRows.length === 0) return
    let chosen = filteredRows.length - 1
    if (activeLeafId) {
      const byId = new Map(entries.map(e => [e.id, e] as const))
      let cur: string | null = activeLeafId
      const indexById = new Map(filteredRows.map((r, i) => [r.id, i] as const))
      while (cur) {
        const idx = indexById.get(cur)
        if (idx != null) {
          chosen = idx
          break
        }
        cur = byId.get(cur)?.parentId ?? null
      }
    }
    setSelectedIndex(chosen)
    positionedRef.current = true
  }, [filteredRows, entries, activeLeafId])

  // Clamp cursor when the visible set shrinks.
  useEffect(() => {
    if (filteredRows.length === 0) {
      setSelectedIndex(0)
      return
    }
    if (selectedIndex >= filteredRows.length) {
      setSelectedIndex(filteredRows.length - 1)
    }
  }, [filteredRows.length, selectedIndex])

  const containerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    containerRef.current?.focus()
  }, [])

  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const row = listEl.querySelector<HTMLElement>(
      `[data-row-index="${selectedIndex}"]`,
    )
    if (row) ensureRowInView(listEl, row)
  }, [selectedIndex])

  const restoreFocus = useCallback(() => {
    containerRef.current?.focus()
  }, [])

  function move(delta: number) {
    if (filteredRows.length === 0) return
    hover.resetToKeyboard()
    setSelectedIndex(prev => {
      const next = prev + delta
      if (next < 0) return 0
      if (next >= filteredRows.length) return filteredRows.length - 1
      return next
    })
  }

  function moveTo(index: number) {
    if (filteredRows.length === 0) return
    hover.resetToKeyboard()
    setSelectedIndex(Math.max(0, Math.min(index, filteredRows.length - 1)))
  }

  function pageSize(): number {
    const listEl = listRef.current
    if (!listEl) return 8
    // Rows are taller here than in the tree (two-line layout); leave
    // pageSize roughly proportional to the actual content height.
    return Math.max(1, Math.floor(listEl.clientHeight / 36))
  }

  const fireConfirm = useCallback(
    async (row: Row) => {
      setBusy(true)
      try {
        await onConfirm({ entryId: row.id, label: row.label })
      } finally {
        setBusy(false)
      }
    },
    [onConfirm],
  )

  function appendSearch(ch: string, e: KeyboardEvent<HTMLDivElement>) {
    e.preventDefault()
    setSearchQuery(prev => prev + ch)
    positionedRef.current = false // re-snap cursor to nearest match
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (busy) return
    if (e.ctrlKey || e.metaKey) {
      if (e.key === "d" || e.key === "D") {
        e.preventDefault()
        move(Math.ceil(pageSize() / 2))
        return
      }
      if (e.key === "u" || e.key === "U") {
        e.preventDefault()
        move(-Math.ceil(pageSize() / 2))
        return
      }
    }
    if (e.key === "Escape") {
      e.preventDefault()
      if (searchQuery) {
        setSearchQuery("")
      } else {
        onCancel()
      }
      return
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const row = filteredRows[selectedIndex]
      if (!row) return
      void fireConfirm(row)
      return
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      if (e.key === "k" && searchQuery) return appendSearch(e.key, e)
      e.preventDefault()
      move(-1)
      return
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      if (e.key === "j" && searchQuery) return appendSearch(e.key, e)
      e.preventDefault()
      move(1)
      return
    }
    if (e.key === "ArrowLeft" || e.key === "h") {
      if (e.key === "h" && searchQuery) return appendSearch(e.key, e)
      e.preventDefault()
      move(-pageSize())
      return
    }
    if (e.key === "ArrowRight" || e.key === "l") {
      if (e.key === "l" && searchQuery) return appendSearch(e.key, e)
      e.preventDefault()
      move(pageSize())
      return
    }
    if (e.key === "PageUp") {
      e.preventDefault()
      move(-pageSize())
      return
    }
    if (e.key === "PageDown") {
      e.preventDefault()
      move(pageSize())
      return
    }
    if (e.key === "Home" || (e.key === "g" && !searchQuery)) {
      e.preventDefault()
      moveTo(0)
      return
    }
    if (e.key === "End" || (e.key === "G" && !searchQuery)) {
      e.preventDefault()
      moveTo(filteredRows.length - 1)
      return
    }
    if (e.key === "Backspace") {
      if (searchQuery.length > 0) {
        e.preventDefault()
        setSearchQuery(prev => prev.slice(0, -1))
      }
      return
    }
    if (e.key.length === 1 && !e.altKey && !e.metaKey && !e.ctrlKey) {
      appendSearch(e.key, e)
      return
    }
  }

  return (
    // Match the composer's centered max-width + padding so opening
    // /fork swaps in place without shifting the page layout.
    <div className="mx-auto w-full max-w-[919px] px-2 pt-1 pb-2">
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onFocus={() => setHasFocus(true)}
        onBlur={e => {
          const next = e.relatedTarget as Node | null
          if (next && containerRef.current?.contains(next)) return
          setHasFocus(false)
        }}
        onMouseDown={restoreFocus}
        className={cn(
          "flex max-h-[50vh] min-h-0 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg outline-none",
          hasFocus
            ? "border-primary/40 ring-1 ring-primary/30"
            : "border-border",
        )}
      >
        <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
          <div className="text-[12px] font-medium text-foreground">
            Fork from a user message
          </div>
          <div className="mt-1 flex items-baseline gap-1 text-[11px]">
            <span className="text-muted-foreground">Type to search:</span>
            <span className="font-mono text-foreground">
              {searchQuery || (
                <span className="text-muted-foreground/60">(empty)</span>
              )}
            </span>
          </div>
        </div>
        <div
          ref={listRef}
          className="min-h-0 flex-1 overflow-auto px-1 py-1"
        >
          {loading ? (
            <div className="px-3 py-2 text-[12px] text-muted-foreground">
              Loading…
            </div>
          ) : error ? (
            <div className="px-3 py-2 text-[12px] text-destructive">
              {error}
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="px-3 py-4 text-center text-[12px] text-muted-foreground">
              {searchQuery ? "No matches." : "No user messages yet."}
            </div>
          ) : (
            filteredRows.map((row, i) => (
              <ForkRow
                key={row.id}
                row={row}
                index={i}
                selected={i === selectedIndex}
                onClick={() => {
                  setSelectedIndex(i)
                  void fireConfirm(row)
                }}
                onHover={() => {
                  if (hover.isActive()) setSelectedIndex(i)
                }}
              />
            ))
          )}
        </div>
        {busy ? (
          <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
            <span className="text-shimmer">Forking…</span>
          </div>
        ) : null}
      </div>
    </div>
  )
}

function ForkRow({
  row,
  index,
  selected,
  onClick,
  onHover,
}: {
  row: Row
  index: number
  selected: boolean
  onClick: () => void
  onHover: () => void
}) {
  return (
    <div
      data-row-index={index}
      onClick={onClick}
      onMouseEnter={onHover}
      className={cn(
        "flex items-baseline gap-2 rounded-sm px-2 py-1.5",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : "text-foreground hover:bg-accent/40",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-3 shrink-0 text-center text-[12px]",
          selected ? "text-primary" : "text-transparent",
        )}
      >
        ›
      </span>
      <div className="min-w-0 flex-1 truncate text-[13px] leading-[1.3]">
        {row.label}
      </div>
    </div>
  )
}
