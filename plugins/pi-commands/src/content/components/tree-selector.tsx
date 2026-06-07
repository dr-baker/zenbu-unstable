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
 * GUI port of pi's `/tree` session-tree selector (see
 * `@earendil-works/pi-coding-agent/dist/modes/interactive/components/tree-selector.js`
 * for the reference TUI implementation). Renders as an overlay
 * panel above the composer, takes keyboard focus, and supports
 * fuzzy search + vim-style navigation.
 *
 * Design notes:
 *
 *   1. Tree shape mirrors pi's: at every fork, the child whose
 *      subtree contains the active leaf comes first. Inside that
 *      child, the chain continues at the same indent. Other
 *      children become alt branches, indented one level with
 *      `├─` / `└─` connectors.
 *   2. Cursor starts on the active leaf when opened so the user
 *      sees "where they are" immediately.
 *   3. Default filter mirrors pi's "default" mode: hide settings/
 *      bookkeeping entries (model_change, thinking_level_change,
 *      session_info, label, custom).
 *   4. Search is incremental substring (case-insensitive over the
 *      entry label). Typing characters appends; Backspace removes;
 *      Esc clears search before closing on a second press.
 *   5. Selecting an entry hands the id+label back to the caller via
 *      `onSelect`; the caller decides what to do (typically: open
 *      the branch-summary dialog and then `navigateTree`).
 */

type EntryNode = {
  id: string
  parentId: string | null
  kind: string
  label: string
  timestamp: number
  /** When `kind === "message"`, the underlying message role; null
   * for non-message entries. Drives row eligibility in fork mode
   * (only `user` rows are pickable). */
  messageRole: string | null
}

type TreeNode = EntryNode & { children: TreeNode[] }

type FlatRow = {
  node: TreeNode
  /** Display indent level. 0 is the trunk. */
  indent: number
  /** True iff this row's row-prefix should render a tree connector
   * (`└─` or `├─`) pointing back at its parent in the previous
   * column. False for trunk rows and root rows. */
  showConnector: boolean
  /** True iff this row is the last visible sibling under its parent
   * \u2014 picks between `└─` (last) and `├─` (more siblings below). */
  isLast: boolean
  /** Per-depth vertical-line gutters that should render at columns to
   * the left of this row, indicating "the branch at depth d still
   * continues below". */
  gutters: { position: number; show: boolean }[]
  /** True iff this entry is on the path root → activeLeafId. */
  isOnPath: boolean
}

/** What the user chose for the abandoned-branch summary, fed back
 * to the caller's `onConfirm`. Mirrors `BranchSummaryChoice` from
 * the modal dialog this used to route through. */
export type TreeNavChoice =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "custom"; customInstructions: string }

export type TreeSelectorProps = {
  sessionId: string
  /** Re-fetch when this changes (e.g. session.lastActivityAt). */
  refreshKey: number
  /** Currently active leaf entry id; used to (a) auto-position the
   * cursor and (b) order forks so the active branch goes first. */
  activeLeafId: string | null
  /** Picked an entry AND the summary choice. The caller forwards
   * this to `rpc.app.sessions.navigateTree` directly — there is no
   * separate modal step. */
  onConfirm: (args: {
    entryId: string
    label: string
    choice: TreeNavChoice
  }) => Promise<void> | void
  onCancel: () => void
}

const HIDE_KINDS_DEFAULT = new Set([
  "model_change",
  "thinking_level_change",
  "session_info",
  "label",
  "custom",
])

/** Picker stage. The whole UI lives in a single panel; the stage
 * determines which sub-view is rendered + which key handler runs.
 *
 *   - `browse`   — the tree list. Enter/Space picks an entry and
 *                  transitions to `summarize`.
 *   - `summarize`— inline 3-option list (None / Default / Custom).
 *                  Picking None/Default confirms immediately and
 *                  closes the panel; picking Custom transitions to
 *                  `customPrompt`.
 *   - `customPrompt` — inline textarea for the extra summarizer
 *                      instructions. Enter (with text) confirms.
 */
type Stage =
  | { kind: "browse" }
  | { kind: "summarize"; entryId: string; label: string }
  | { kind: "customPrompt"; entryId: string; label: string }

const SUMMARY_OPTIONS: ReadonlyArray<{
  id: "none" | "default" | "custom"
  title: string
}> = [
  { id: "none", title: "No summary" },
  { id: "default", title: "Summarize" },
  { id: "custom", title: "Summarize with custom prompt" },
]

export function TreeSelector({
  sessionId,
  refreshKey,
  activeLeafId,
  onConfirm,
  onCancel,
}: TreeSelectorProps) {
  const rpc = useRpc()
  const [entries, setEntries] = useState<EntryNode[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedIndex, setSelectedIndex] = useState(0)
  const [showAll, setShowAll] = useState(false)
  const [stage, setStage] = useState<Stage>({ kind: "browse" })
  // Cursor index inside the summarize stage. Reset whenever we
  // re-enter the stage.
  const [summarizeIndex, setSummarizeIndex] = useState(0)
  // Hover-vs-keyboard intent gate. Keeps a stale mouse position
  // from claiming selection at mount (or after every keystroke).
  const hover = useHoverIntent()
  // Buffer for the custom-prompt textarea. Held here (not inside
  // CustomPromptStage) so backing out and re-entering keeps the
  // user's draft.
  const [customPromptText, setCustomPromptText] = useState("")
  // True while the confirm RPC is in flight. We render a busy
  // indicator on the active stage so the user knows their pick is
  // being processed, and we ignore further keypresses.
  const [busy, setBusy] = useState(false)
  // Whether keyboard input is currently going to this panel.
  // Mirrors DOM focus on the container (or any descendant via
  // bubbling). Drives the focus-ring — visible only when the user
  // can act on keys, so they always know where keys are going.
  const [hasFocus, setHasFocus] = useState(true)

  // Fetch tree.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    rpc.app.sessions
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

  // Path root → activeLeafId. Same defensive walk as the sidebar.
  const currentPath = useMemo(() => {
    const set = new Set<string>()
    if (!activeLeafId) return set
    const byId = new Map(entries.map(e => [e.id, e] as const))
    let cur: string | null = activeLeafId
    while (cur && !set.has(cur)) {
      set.add(cur)
      cur = byId.get(cur)?.parentId ?? null
    }
    return set
  }, [entries, activeLeafId])

  const roots = useMemo(
    () => buildTree(entries, currentPath),
    [entries, currentPath],
  )

  const visibleEntries = useMemo(() => {
    const hideSet = showAll ? new Set<string>() : HIDE_KINDS_DEFAULT
    const queryTokens = searchQuery
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean)
    return new Set(
      entries
        .filter(e => {
          if (hideSet.has(e.kind)) return false
          if (queryTokens.length === 0) return true
          const hay = e.label.toLowerCase()
          return queryTokens.every(t => hay.includes(t))
        })
        .map(e => e.id),
    )
  }, [entries, showAll, searchQuery])

  const flat = useMemo(
    () => flatten(roots, visibleEntries, currentPath),
    [roots, visibleEntries, currentPath],
  )

  // Auto-position cursor on the active leaf (or its nearest visible
  // ancestor) when the selector first opens or when the tree changes.
  // We only "jump to active" on the initial set; afterwards user
  // navigation is preserved across re-renders.
  const positionedRef = useRef(false)
  useEffect(() => {
    if (positionedRef.current) return
    if (flat.length === 0) return
    const initial = findNearestVisibleIndex(flat, activeLeafId, entries)
    setSelectedIndex(initial)
    positionedRef.current = true
  }, [flat, activeLeafId, entries])

  // Clamp the cursor when filter/search shrinks the list.
  useEffect(() => {
    if (flat.length === 0) {
      setSelectedIndex(0)
      return
    }
    if (selectedIndex >= flat.length) setSelectedIndex(flat.length - 1)
  }, [flat.length, selectedIndex])

  // Container ref + focus. We capture keys at the container level so
  // arrow keys / typing / hjkl all go through one handler regardless
  // of what's focused inside.
  const containerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    containerRef.current?.focus()
  }, [])

  // Click anywhere on the panel (the header in particular) should
  // restore focus to the container so keys start going to the
  // selector again. Bound on the outer element so a header click
  // that doesn't hit a button still re-focuses.
  const restoreFocus = useCallback(() => {
    containerRef.current?.focus()
  }, [])

  // Keep the selected row scrolled into view as the cursor moves.
  // See `ensureRowInView` for why we don't use `scrollIntoView`
  // directly here.
  const listRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const listEl = listRef.current
    if (!listEl) return
    const row = listEl.querySelector<HTMLElement>(
      `[data-row-index="${selectedIndex}"]`,
    )
    if (row) ensureRowInView(listEl, row)
  }, [selectedIndex])

  function move(delta: number) {
    if (flat.length === 0) return
    // Any keyboard nav resets mouse-intent so a stale hover position
    // can't re-claim selection on the next render.
    hover.resetToKeyboard()
    setSelectedIndex(prev => {
      const next = prev + delta
      if (next < 0) return 0
      if (next >= flat.length) return flat.length - 1
      return next
    })
  }

  function moveTo(index: number) {
    if (flat.length === 0) return
    hover.resetToKeyboard()
    setSelectedIndex(Math.max(0, Math.min(index, flat.length - 1)))
  }

  function pageSize(): number {
    const listEl = listRef.current
    if (!listEl) return 10
    // Approximate: clientHeight / row-height. Rows are 20px min, leave
    // some padding so paging always advances by a screenful.
    return Math.max(1, Math.floor(listEl.clientHeight / 22))
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    // Modifier-bearing keys first so Ctrl-D doesn't get eaten by the
    // "d" search branch below.
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
    // Enter or Space picks the highlighted entry and transitions
    // into the inline "Summarize branch?" stage. Space was
    // previously consumed by search; the user explicitly wants it
    // to be a select gesture instead. The trade-off is that
    // search becomes single-token (no spaces). Acceptable: most
    // tree searches are one word.
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const row = flat[selectedIndex]
      if (!row) return
      setStage({
        kind: "summarize",
        entryId: row.node.id,
        label: row.node.label,
      })
      setSummarizeIndex(0)
      setCustomPromptText("")
      return
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      // Plain 'k' shouldn't be eaten if the user is mid-search. Same
      // rule for j/h/l/g/G below \u2014 if a search query is active,
      // typing letters extends the search; navigation keys only fire
      // on the arrow keys.
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
      moveTo(flat.length - 1)
      return
    }
    if (e.key === "Backspace") {
      if (searchQuery.length > 0) {
        e.preventDefault()
        setSearchQuery(prev => prev.slice(0, -1))
      }
      return
    }
    // Filter toggle: Ctrl/Cmd-A flips "show everything" vs "default
    // (hide bookkeeping)". Picked Ctrl-A over a single letter so it
    // doesn't fight the search.
    if ((e.ctrlKey || e.metaKey) && (e.key === "a" || e.key === "A")) {
      e.preventDefault()
      setShowAll(v => !v)
      return
    }
    // Any single printable character extends the search query.
    if (e.key.length === 1 && !e.altKey && !e.metaKey && !e.ctrlKey) {
      appendSearch(e.key, e)
      return
    }
  }

  function appendSearch(ch: string, e: KeyboardEvent<HTMLDivElement>) {
    e.preventDefault()
    setSearchQuery(prev => prev + ch)
    positionedRef.current = false // re-snap cursor to nearest match
  }

  // ---------- Summarize stage handlers ----------

  const confirmChoice = useCallback(
    async (entryId: string, label: string, choice: TreeNavChoice) => {
      setBusy(true)
      try {
        await onConfirm({ entryId, label, choice })
      } finally {
        setBusy(false)
      }
    },
    [onConfirm],
  )

  function onSummarizeKeyDown(
    e: KeyboardEvent<HTMLDivElement>,
    s: Extract<Stage, { kind: "summarize" }>,
  ) {
    if (busy) return
    if (e.key === "Escape" || e.key === "Backspace") {
      e.preventDefault()
      setStage({ kind: "browse" })
      return
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      hover.resetToKeyboard()
      setSummarizeIndex(i => (i - 1 + SUMMARY_OPTIONS.length) % SUMMARY_OPTIONS.length)
      return
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      hover.resetToKeyboard()
      setSummarizeIndex(i => (i + 1) % SUMMARY_OPTIONS.length)
      return
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const choiceId = SUMMARY_OPTIONS[summarizeIndex].id
      if (choiceId === "custom") {
        setStage({ kind: "customPrompt", entryId: s.entryId, label: s.label })
        return
      }
      void confirmChoice(
        s.entryId,
        s.label,
        choiceId === "default" ? { kind: "default" } : { kind: "none" },
      )
      return
    }
  }

  function onCustomPromptKeyDown(
    e: KeyboardEvent<HTMLDivElement>,
    s: Extract<Stage, { kind: "customPrompt" }>,
  ) {
    if (busy) return
    if (e.key === "Escape") {
      e.preventDefault()
      setStage({ kind: "summarize", entryId: s.entryId, label: s.label })
      return
    }
    // Ctrl/Cmd+Enter confirms. Plain Enter inside the textarea
    // should insert a newline (handled by the textarea itself);
    // intercept Cmd-Enter at the container level so the textarea
    // doesn't swallow it.
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      const text = customPromptText.trim()
      if (text.length === 0) return
      void confirmChoice(s.entryId, s.label, {
        kind: "custom",
        customInstructions: text,
      })
      return
    }
  }

  return (
    // Match the composer's centered max-width + padding so the
    // tree replaces the input in place without shifting the page
    // layout.
    <div className="mx-auto w-full max-w-[919px] px-2 pt-1 pb-2">
      <div
        ref={containerRef}
        tabIndex={-1}
        onKeyDown={e => {
          if (stage.kind === "browse") onKeyDown(e)
          else if (stage.kind === "summarize") onSummarizeKeyDown(e, stage)
          else onCustomPromptKeyDown(e, stage)
        }}
        onFocus={() => setHasFocus(true)}
        onBlur={e => {
          // Treat focus moving to a descendant as still-focused;
          // only flip off when focus leaves the whole panel.
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
      {stage.kind === "browse" ? (
        <BrowseView
          searchQuery={searchQuery}
          showAll={showAll}
          flat={flat}
          entriesLength={entries.length}
          loading={loading}
          error={error}
          listRef={listRef}
          selectedIndex={selectedIndex}
          activeLeafId={activeLeafId}
          onRowClick={i => {
            setSelectedIndex(i)
            const row = flat[i]
            if (!row) return
            setStage({
              kind: "summarize",
              entryId: row.node.id,
              label: row.node.label,
            })
            setSummarizeIndex(0)
            setCustomPromptText("")
          }}
          onRowHover={i => {
            if (hover.isActive()) setSelectedIndex(i)
          }}
        />
      ) : stage.kind === "summarize" ? (
        <SummarizeView
          index={summarizeIndex}
          busy={busy}
          onPick={i => {
            const choiceId = SUMMARY_OPTIONS[i].id
            setSummarizeIndex(i)
            if (choiceId === "custom") {
              setStage({
                kind: "customPrompt",
                entryId: stage.entryId,
                label: stage.label,
              })
              return
            }
            void confirmChoice(
              stage.entryId,
              stage.label,
              choiceId === "default" ? { kind: "default" } : { kind: "none" },
            )
          }}
          onHover={i => {
            if (hover.isActive()) setSummarizeIndex(i)
          }}
          onBack={() => setStage({ kind: "browse" })}
        />
      ) : (
        <CustomPromptView
          value={customPromptText}
          onChange={setCustomPromptText}
          busy={busy}
          onSubmit={() => {
            const text = customPromptText.trim()
            if (text.length === 0) return
            void confirmChoice(stage.entryId, stage.label, {
              kind: "custom",
              customInstructions: text,
            })
          }}
          onBack={() =>
            setStage({
              kind: "summarize",
              entryId: stage.entryId,
              label: stage.label,
            })
          }
        />
      )}
      </div>
    </div>
  )
}

function BrowseView({
  searchQuery,
  showAll,
  flat,
  entriesLength,
  loading,
  error,
  listRef,
  selectedIndex,
  activeLeafId,
  onRowClick,
  onRowHover,
}: {
  searchQuery: string
  showAll: boolean
  flat: FlatRow[]
  entriesLength: number
  loading: boolean
  error: string | null
  listRef: React.RefObject<HTMLDivElement | null>
  selectedIndex: number
  activeLeafId: string | null
  onRowClick: (index: number) => void
  onRowHover: (index: number) => void
}) {
  return (
    <>
      <Header
        searchQuery={searchQuery}
        showAll={showAll}
        totalShown={flat.length}
        totalAll={entriesLength}
      />
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-auto px-1 py-1 text-[11px] leading-[1.35]"
      >
        {loading ? (
          <div className="px-3 py-2 text-muted-foreground">Loading…</div>
        ) : error ? (
          <div className="px-3 py-2 text-destructive">{error}</div>
        ) : flat.length === 0 ? (
          <div className="px-3 py-4 text-center text-muted-foreground">
            {searchQuery ? "No matches." : "No entries."}
          </div>
        ) : (
          flat.map((row, i) => (
            <TreeRow
              key={row.node.id}
              row={row}
              index={i}
              selected={i === selectedIndex}
              isActiveLeaf={row.node.id === activeLeafId}
              onClick={() => onRowClick(i)}
              onHover={() => onRowHover(i)}
            />
          ))
        )}
      </div>
      <Footer showAll={showAll} />
    </>
  )
}

function SummarizeView({
  index,
  busy,
  onPick,
  onHover,
  onBack,
}: {
  index: number
  busy: boolean
  onPick: (i: number) => void
  onHover: (i: number) => void
  onBack: () => void
}) {
  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[12px] font-medium text-foreground">
          Summarize branch?
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {SUMMARY_OPTIONS.map((opt, i) => (
          <SummaryOptionRow
            key={opt.id}
            title={opt.title}
            selected={i === index}
            onClick={() => onPick(i)}
            onHover={() => onHover(i)}
          />
        ))}
      </div>
      <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground">
        {busy ? (
          <span className="text-shimmer">Summarizing…</span>
        ) : (
          <button
            type="button"
            onClick={onBack}
            className="hover:text-foreground"
          >
            ← back to tree
          </button>
        )}
      </div>
    </>
  )
}

function SummaryOptionRow({
  title,
  selected,
  onClick,
  onHover,
}: {
  title: string
  selected: boolean
  onClick: () => void
  onHover: () => void
}) {
  return (
    <div
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
          "w-3 shrink-0 text-center text-[11px]",
          selected ? "text-primary" : "text-transparent",
        )}
      >
        ›
      </span>
      <div className="min-w-0 flex-1 text-[12px] font-medium">{title}</div>
    </div>
  )
}

function CustomPromptView({
  value,
  onChange,
  busy,
  onSubmit,
  onBack,
}: {
  value: string
  onChange: (s: string) => void
  busy: boolean
  onSubmit: () => void
  onBack: () => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    textareaRef.current?.focus()
  }, [])
  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[12px] font-medium text-foreground">
          Custom summarizer prompt
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
        <textarea
          ref={textareaRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          rows={5}
          placeholder="e.g. focus on which files were modified and which tools failed."
          className="w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        />
      </div>
      <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 flex items-center justify-between text-[10px] text-muted-foreground">
        <button
          type="button"
          onClick={onBack}
          disabled={busy}
          className="hover:text-foreground disabled:opacity-50"
        >
          ← back
        </button>
        {busy ? (
          <span className="text-shimmer">Summarizing…</span>
        ) : (
          <button
            type="button"
            onClick={onSubmit}
            disabled={value.trim().length === 0}
            className="font-medium text-foreground disabled:opacity-50"
          >
            confirm ⌘⏎
          </button>
        )}
      </div>
    </>
  )
}

function Header({
  searchQuery,
  showAll,
  totalShown,
  totalAll,
}: {
  searchQuery: string
  showAll: boolean
  totalShown: number
  totalAll: number
}) {
  return (
    <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
      <div className="text-[12px] font-medium text-foreground">
        Session Tree
      </div>
      <div className="mt-1 flex items-baseline gap-1 text-[11px]">
        <span className="text-muted-foreground">Type to search:</span>
        <span className="text-foreground">
          {searchQuery || (
            <span className="text-muted-foreground/60">(empty)</span>
          )}
        </span>
      </div>
    </div>
  )
}

function Footer({
  showAll,
}: {
  showAll: boolean
}) {
  if (!showAll) return null
  return (
    <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground">
      [all]
    </div>
  )
}

function TreeRow({
  row,
  index,
  selected,
  isActiveLeaf,
  onClick,
  onHover,
}: {
  row: FlatRow
  index: number
  selected: boolean
  isActiveLeaf: boolean
  onClick: () => void
  onHover: () => void
}) {
  const { node, indent, showConnector, isLast, gutters, isOnPath } = row
  const prefix = renderPrefix(indent, showConnector, isLast, gutters)
  // Visually dim everything that isn't a user message so the user's
  // own turns stand out at a glance. Dimming is purely cosmetic —
  // the row stays fully selectable/navigable.
  const isUserMessage = node.kind === "message" && node.messageRole === "user"
  return (
    <div
      data-row-index={index}
      onClick={onClick}
      onMouseEnter={onHover}
      className={cn(
        "flex items-baseline gap-1 rounded-sm px-1",
        selected
          ? "bg-sidebar-accent text-sidebar-accent-foreground"
          : isOnPath
            ? "text-foreground hover:bg-accent/40"
            : "text-muted-foreground/70 hover:bg-accent/40",
        !selected && !isUserMessage && "opacity-50",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-3 shrink-0 text-center",
          selected ? "text-primary" : "text-transparent",
        )}
      >
        ›
      </span>
      <span
        aria-hidden
        className={cn(
          "shrink-0 whitespace-pre",
          selected
            ? "text-sidebar-accent-foreground/70"
            : "text-muted-foreground/60",
        )}
      >
        {prefix}
      </span>
      {isActiveLeaf && (
        <span
          aria-hidden
          className={cn(
            "shrink-0",
            selected ? "text-primary" : "text-primary/80",
          )}
        >
          •&nbsp;
        </span>
      )}
      <span className="flex-1 truncate">{node.label}</span>
    </div>
  )
}

/**
 * Build the tree connector prefix string for a row.
 *
 * Each indent level is rendered as a 2-character cell:
 *   - `│ ` if a gutter at that depth is still active (branch continues
 *     below)
 *   - `  ` otherwise (no parent gutter at this level)
 *
 * The final cell (when `showConnector` is true) is either `└─` (last
 * sibling) or `├─` (more siblings).
 */
function renderPrefix(
  indent: number,
  showConnector: boolean,
  isLast: boolean,
  gutters: { position: number; show: boolean }[],
): string {
  if (indent === 0) return ""
  const cellWidth = 2
  const totalCells = indent
  const connectorPos = showConnector ? indent - 1 : -1
  const out: string[] = []
  for (let level = 0; level < totalCells; level++) {
    if (level === connectorPos) {
      out.push(isLast ? "└─" : "├─")
      continue
    }
    const g = gutters.find(g => g.position === level)
    if (g && g.show) {
      out.push("│ ")
    } else {
      out.push("  ".padEnd(cellWidth, " "))
    }
  }
  return out.join("")
}

/**
 * Build the tree, sorting children at every fork so the subtree
 * containing the active leaf comes first. This is intentional for the
 * `/tree` selector — the user almost always wants to land on their
 * current branch, and reading top-to-bottom should follow it. The
 * sidebar tree uses a different ordering (stable across leaf moves);
 * the selector reordering is bounded to a transient panel so it
 * doesn't cause layout jank in the persistent UI.
 */
function buildTree(
  entries: EntryNode[],
  currentPath: Set<string>,
): TreeNode[] {
  const byId = new Map<string, TreeNode>()
  for (const e of entries) byId.set(e.id, { ...e, children: [] })
  const roots: TreeNode[] = []
  for (const node of byId.values()) {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }
  const containsPath = (n: TreeNode): boolean => {
    if (currentPath.has(n.id)) return true
    for (const c of n.children) if (containsPath(c)) return true
    return false
  }
  const sortRec = (n: TreeNode) => {
    n.children.sort((a, b) => {
      const ap = containsPath(a)
      const bp = containsPath(b)
      if (ap && !bp) return -1
      if (bp && !ap) return 1
      return a.timestamp - b.timestamp
    })
    for (const c of n.children) sortRec(c)
  }
  roots.sort((a, b) => a.timestamp - b.timestamp)
  for (const r of roots) sortRec(r)
  return roots
}

/**
 * Walk the (sorted) tree producing flat rows with indent + connector
 * metadata. Behavior, matching pi's tree-selector:
 *
 *   - Linear chain (one child): stay at the same depth.
 *   - Branch point (>1 children): the first child (which is on the
 *     active path by sort order) continues inline at the parent's
 *     indent +1; subsequent siblings render at the same depth+1 with
 *     `├─` / `└─` connectors.
 *   - Filtered-out entries (`visibleEntries` doesn't include them)
 *     are skipped entirely; descendants reattach to the nearest
 *     visible ancestor.
 *
 * Returns rows in render order.
 */
function flatten(
  roots: TreeNode[],
  visibleEntries: Set<string>,
  currentPath: Set<string>,
): FlatRow[] {
  const out: FlatRow[] = []

  // First, walk the tree and produce a "visible subtree" — same
  // shape, but with hidden entries collapsed (their children promoted
  // to their parent). This keeps the connector math simple in the
  // second pass.
  const visible = collapseHidden(roots, visibleEntries)

  const walk = (
    node: TreeNode,
    indent: number,
    showConnector: boolean,
    isLast: boolean,
    gutters: { position: number; show: boolean }[],
  ) => {
    out.push({
      node,
      indent,
      showConnector,
      isLast,
      gutters,
      isOnPath: currentPath.has(node.id),
    })
    const kids = node.children
    if (kids.length === 0) return
    if (kids.length === 1) {
      // Linear chain: stay at the same depth, same gutters.
      walk(kids[0], indent, false, false, gutters)
      return
    }
    // Branch point. Each child renders at indent+1 with a connector
    // back to the fork at column `connectorPosition`. The child's
    // OWN descendants need a vertical-line gutter at that column iff
    // the child has more siblings BELOW it (i.e. it's not the last).
    const childIndent = indent + 1
    const connectorPosition = childIndent - 1
    for (let i = 0; i < kids.length; i++) {
      const childIsLast = i === kids.length - 1
      const childGutters = [
        ...gutters,
        { position: connectorPosition, show: !childIsLast },
      ]
      walk(kids[i], childIndent, true, childIsLast, childGutters)
    }
  }

  for (let i = 0; i < visible.length; i++) {
    walk(visible[i], 0, false, i === visible.length - 1, [])
  }
  return out
}

/**
 * Recursively rebuild the tree omitting nodes not in `visible`.
 * Hidden nodes' children are promoted to their nearest visible
 * ancestor (or to the root list, if no visible ancestor exists).
 */
function collapseHidden(
  roots: TreeNode[],
  visible: Set<string>,
): TreeNode[] {
  const collect = (n: TreeNode): TreeNode[] => {
    if (visible.has(n.id)) {
      return [{ ...n, children: n.children.flatMap(collect) }]
    }
    // Skip n: lift its children into the caller's list.
    return n.children.flatMap(collect)
  }
  return roots.flatMap(collect)
}

/**
 * Find the index in `flat` whose entry is closest to `entryId` walking
 * up the parent chain. Used to snap the cursor to "where you are" on
 * open, or to the nearest visible ancestor if the leaf itself was
 * filtered out.
 */
function findNearestVisibleIndex(
  flat: FlatRow[],
  entryId: string | null,
  entries: EntryNode[],
): number {
  if (flat.length === 0) return 0
  if (!entryId) return flat.length - 1
  const indexById = new Map(
    flat.map((r, i) => [r.node.id, i] as const),
  )
  const byId = new Map(entries.map(e => [e.id, e] as const))
  let cur: string | null = entryId
  while (cur) {
    const idx = indexById.get(cur)
    if (idx != null) return idx
    cur = byId.get(cur)?.parentId ?? null
  }
  return flat.length - 1
}
