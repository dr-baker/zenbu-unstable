import {
  StrictMode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { createRoot } from "react-dom/client"
import {
  useCollection,
  useDb,
  useEvents,
  useRpc,
  ZenbuProvider,
} from "@zenbujs/core/react"
import { Plus } from "lucide-react"
import { Input } from "@zenbu/ui/input"
import { Button } from "@zenbu/ui/button"
import { PaletteShell, PaletteRow } from "@zenbu/ui/palette"
import { useWindowId } from "@/lib/window-state/window-id"

/**
 * Open-projects palette.
 *
 * Index source: `db.openProjects.index.projects` (a collection
 * populated on boot by the utility-process scanner). We pull the
 * full collection up front via `useCollection`, then filter +
 * window in the renderer.
 *
 * Why a custom palette body (not `<Palette />` from `@zenbu/ui`):
 * the shared `Palette` renders every filtered item into a single
 * scrollable column. That's fine for the typical small palette
 * (recent workspaces, recent agents), but the project index can
 * easily hit a few thousand entries on a developer's `$HOME`.
 * We want to render the first ~80 and infinite-scroll the rest in.
 * `PaletteShell` + `PaletteRow` give us the same chrome with a
 * body we can take over.
 *
 * Activate path: `rpc.app.workspaces.createFromDirectory` \u2014 the
 * same RPC the legacy onboarding screen used. By the time it
 * resolves, the host has materialized a workspace + scope + chat
 * + pi session at the chosen folder and pointed the calling
 * window at it. The palette closes on activation.
 */

type ProjectEntry = {
  path: string
  name: string
  parent: string
  depth: number
  marker: string
}

/**
 * Sanitize the project-name field as the user types, mirroring the
 * onboarding screen: collapse runs of whitespace to a single hyphen
 * (the conventional directory separator) and collapse adjacent
 * dashes so a fast-typed "my  cool   app" doesn't become
 * `my--cool---app`.
 */
function normalizeProjectName(raw: string): string {
  return raw.replace(/\s+/g, "-").replace(/-{2,}/g, "-")
}

/** How many rows we render on the first cut, and how many we add
 * each time the user scrolls past `INFINITE_SCROLL_TRIGGER_PX`
 * from the bottom. Tuned for a 360px-tall palette body \u2014 80 is
 * plenty more than fits on screen at once, so the infinite-scroll
 * effect kicks in only on real lists. */
const INITIAL_WINDOW = 80
const WINDOW_STEP = 80
const INFINITE_SCROLL_TRIGGER_PX = 240

function OpenProjectsPalette() {
  const events = useEvents()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const off = events.openProjects.togglePalette.subscribe(() => {
      setOpen(o => !o)
    })
    return () => off()
  }, [events])

  const close = useCallback(() => setOpen(false), [])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-start justify-center pt-[12vh]"
      onClick={close}
    >
      <OpenProjectsPaletteBody onClose={close} />
    </div>
  )
}

function OpenProjectsPaletteBody({ onClose }: { onClose: () => void }) {
  const rpc = useRpc()
  const windowId = useWindowId()

  // Pull the index collection. `useCollection` subscribes on
  // mount and streams items as the worker publishes new batches,
  // so opening the palette while the scan is still running
  // shows results as they trickle in.
  const projectsRef = useDb(root => root.openProjects.index.projects)
  const { items: rawItems } = useCollection(projectsRef)
  const items = rawItems as ProjectEntry[]


  // MRU input for the unranked sort tiebreaker \u2014
  // `recentProjects` is the host's IDE-cache scrape (VS Code,
  // Cursor, etc.). We just want a Set<absolute path> we can look
  // up in for "this is a known recent project; float it up".
  const recentPathSet = useDb(root => {
    const set = new Set<string>()
    for (const r of Object.values(root.app.recentProjects)) {
      set.add(r.path)
    }
    return set
  })
  const recentLastOpenedAt = useDb(root => {
    const map = new Map<string, number>()
    for (const r of Object.values(root.app.recentProjects)) {
      map.set(r.path, r.lastOpenedAt)
    }
    return map
  })
  void recentPathSet // consumed via recentLastOpenedAt below

  const [query, setQuery] = useState("")
  const [selected, setSelected] = useState(0)
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW)
  // When the user activates the pinned "Create project" row the
  // palette flips into the new-project form (same flow as the
  // onboarding screen). `null` = the normal fuzzy list.
  const [mode, setMode] = useState<"list" | "new">("list")
  const inputRef = useRef<HTMLInputElement>(null)
  const scrollerRef = useRef<HTMLDivElement>(null)
  // Ref the *currently-selected* row threads onto. Plain ref
  // (not a querySelector lookup) so the scroll-into-view effect
  // doesn't have to walk the DOM on every selection change.
  const selectedRowRef = useRef<HTMLButtonElement | null>(null)
  const hover = useHoverIntent()

  // Focus the input the moment we mount.
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // ---- filter + sort -------------------------------------------
  // We compute the full filtered+sorted list, then slice to the
  // visible window. Keyboard nav walks `filtered`, not the slice,
  // so arrowing past the end of the visible window auto-grows it
  // (see the scroll-into-view effect below).
  const filtered = useMemo(() => {
    // `sortFiltered` does its own normalize (lowercasing +
    // separator stripping), so we just pass the trimmed query
    // through. Empty after trim → unfiltered list.
    const q = query.trim()
    if (q.length === 0) {
      return sortUnfiltered(items, recentLastOpenedAt)
    }
    return sortFiltered(items, q, recentLastOpenedAt)
  }, [items, query, recentLastOpenedAt])

  // Reset the visible window + selection whenever the query
  // changes. The user's intent on typing is "show me the top
  // matches from the start", not "keep my scroll position".
  // Default to the first project (selection index 1) so Enter
  // opens the top match, same as before the pinned create row
  // existed; the clamp effect below falls back to the create row
  // (index 0) when there are no projects.
  useEffect(() => {
    setWindowSize(INITIAL_WINDOW)
    setSelected(1)
  }, [query])

  // Clamp selection if the filtered list got shorter than where
  // we were sitting. Valid range is 0 (create row) .. filtered.length
  // (last project lives at index filtered.length).
  useEffect(() => {
    if (selected > filtered.length) {
      setSelected(0)
    }
  }, [filtered.length, selected])

  // Auto-grow the window so the selected row is in the DOM. The
  // keyboard handler walks `filtered` (not the slice), so Ctrl-N
  // / ArrowDown can take the cursor past the visible edge — when
  // that happens we extend the window enough to render up to the
  // selected row + a small buffer.
  useEffect(() => {
    // `selected` includes the pinned create row at index 0, so the
    // project-list index is `selected - 1`.
    const projectIdx = selected - 1
    if (projectIdx >= windowSize) {
      const needed = projectIdx + 1
      setWindowSize(prev =>
        prev >= needed
          ? prev
          : prev + WINDOW_STEP * Math.ceil((needed - prev) / WINDOW_STEP),
      )
    }
  }, [selected, windowSize])

  const visible = useMemo(
    () => filtered.slice(0, windowSize),
    [filtered, windowSize],
  )

  // Scroll the selected row into view when the *selection*
  // changes. Deliberately NOT dependent on `visible` — if it
  // were, every infinite-scroll bump (which mutates `visible`)
  // would re-fire this and snap the scroll back to the selected
  // row, fighting the user's scroll wheel.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current
    const row = selectedRowRef.current
    if (!scroller || !row) return
    const cRect = scroller.getBoundingClientRect()
    const rRect = row.getBoundingClientRect()
    const topDelta = rRect.top - cRect.top
    const bottomDelta = rRect.bottom - cRect.top
    if (topDelta < 0) {
      scroller.scrollTop += topDelta
    } else if (bottomDelta > scroller.clientHeight) {
      scroller.scrollTop += bottomDelta - scroller.clientHeight
    }
  }, [selected])

  // Infinite scroll: when the user nears the bottom, append the
  // next WINDOW_STEP items. Independent of the keyboard-driven
  // auto-grow above.
  const onScroll = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    if (windowSize >= filtered.length) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    if (distanceFromBottom < INFINITE_SCROLL_TRIGGER_PX) {
      setWindowSize(prev =>
        prev >= filtered.length ? prev : prev + WINDOW_STEP,
      )
    }
  }, [windowSize, filtered.length])

  const setSelectedFromKeyboard = useCallback(
    (n: number | ((s: number) => number)) => {
      hover.resetToKeyboard()
      setSelected(n)
    },
    [hover],
  )

  // Total navigable rows = the pinned "Create project" row (index
  // 0, always present) + the filtered project list. Project entry
  // `i` lives at selection index `i + 1`.
  const CREATE_ROW_INDEX = 0
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault()
        onClose()
        return
      }
      // 1 extra for the pinned create row.
      const len = filtered.length + 1
      const plainCtrl =
        e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
      if (e.key === "ArrowDown" || (plainCtrl && (e.key === "n" || e.key === "N"))) {
        e.preventDefault()
        setSelectedFromKeyboard(s => (s + 1) % len)
        return
      }
      if (e.key === "ArrowUp" || (plainCtrl && (e.key === "p" || e.key === "P"))) {
        e.preventDefault()
        setSelectedFromKeyboard(s => (s - 1 + len) % len)
        return
      }
      if (plainCtrl && (e.key === "d" || e.key === "D")) {
        e.preventDefault()
        setSelectedFromKeyboard(s => Math.min(len - 1, s + 8))
        return
      }
      if (plainCtrl && (e.key === "u" || e.key === "U")) {
        e.preventDefault()
        setSelectedFromKeyboard(s => Math.max(0, s - 8))
        return
      }
      if (e.key === "Enter") {
        e.preventDefault()
        if (selected === CREATE_ROW_INDEX) {
          setMode("new")
          return
        }
        const item = filtered[selected - 1]
        if (item) void activate(item)
      }
    },
    [filtered, selected, setSelectedFromKeyboard, onClose],
  )

  const activate = useCallback(
    async (entry: ProjectEntry) => {
      onClose()
      try {
        await rpc.app.workspaces.createFromDirectory({
          directory: entry.path,
          windowId,
        })
      } catch {
        // Swallow — a failed open just leaves the user where
        // they were.
      }
    },
    [rpc, windowId, onClose],
  )

  // ---- new-project form -----------------------------------------
  // Same flow as the onboarding screen: create an empty folder via
  // `repos.createEmptyProject`, then open it as a workspace.
  if (mode === "new") {
    return (
      <NewProjectForm
        onCancel={() => setMode("list")}
        onCreate={async relative => {
          const result = await rpc.app.repos.createEmptyProject({
            relativePath: "~/" + relative,
          })
          if (!result.ok) return result.error
          onClose()
          try {
            await rpc.app.workspaces.createFromDirectory({
              directory: result.directory,
              windowId,
            })
          } catch {
            // Swallow — the folder was created; a failed open just
            // leaves the user where they were.
          }
          return null
        }}
      />
    )
  }

  return (
    <PaletteShell
      header={
        <Input
          ref={inputRef}
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Open project…"
          spellCheck={false}
          className="w-full rounded-none border-0 bg-transparent px-3 py-2 text-[13px] shadow-none focus-visible:ring-0"
        />
      }
    >
      <div
        ref={scrollerRef}
        onScroll={onScroll}
        // Fixed height (not `max-h-`) so the popover doesn't pop
        // from a one-line "no projects found" placeholder to a
        // full 360px body when the index finishes loading. The
        // index can take a beat on cold start; locking the
        // height eliminates that single-frame layout shift.
        className="h-[360px] overflow-y-auto"
      >
        {/* No empty-state text at all — empty list, error,
          * mid-indexing, no matches … every case renders as a
          * blank rectangle inside the fixed-height scroller. The
          * input above is the only thing the user needs to see
          * when there are zero results. */}
        {/* Pinned first row — always present so there's always a
          * way to create a project, even when the index is empty,
          * still loading, or has no matches for the query. */}
        <CreateProjectRow
          isSelected={selected === CREATE_ROW_INDEX}
          rowRef={selected === CREATE_ROW_INDEX ? selectedRowRef : noopRef}
          onMouseMove={() => {
            if (hover.isActive()) setSelected(CREATE_ROW_INDEX)
          }}
          onActivate={() => setMode("new")}
        />
        {visible.map((entry, i) => {
          // Project entry `i` occupies selection index `i + 1`
          // (the create row is index 0).
          const idx = i + 1
          return (
            <ProjectPaletteRow
              key={entry.path}
              entry={entry}
              isSelected={idx === selected}
              rowRef={idx === selected ? selectedRowRef : noopRef}
              onMouseMove={() => {
                if (hover.isActive()) setSelected(idx)
              }}
              onActivate={() => void activate(entry)}
            />
          )
        })}
      </div>
    </PaletteShell>
  )
}

function ProjectPaletteRow({
  entry,
  isSelected,
  rowRef,
  onMouseMove,
  onActivate,
}: {
  entry: ProjectEntry
  isSelected: boolean
  rowRef: React.Ref<HTMLButtonElement>
  onMouseMove: () => void
  onActivate: () => void
}) {
  return (
    <PaletteRow
      isSelected={isSelected}
      rowRef={rowRef}
      onMouseMove={onMouseMove}
      onActivate={onActivate}
    >
      <span className="min-w-0 flex-1 truncate" title={entry.path}>
        <span className="text-popover-foreground">{entry.name}</span>
        <span className="ml-2 text-muted-foreground">
          {displayParent(entry.parent)}
        </span>
      </span>
    </PaletteRow>
  )
}

function CreateProjectRow({
  isSelected,
  rowRef,
  onMouseMove,
  onActivate,
}: {
  isSelected: boolean
  rowRef: React.Ref<HTMLButtonElement>
  onMouseMove: () => void
  onActivate: () => void
}) {
  return (
    <PaletteRow
      isSelected={isSelected}
      rowRef={rowRef}
      onMouseMove={onMouseMove}
      onActivate={onActivate}
    >
      <span className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="truncate text-popover-foreground">Create project</span>
        <Plus
          className="h-[14px] w-[14px] shrink-0 text-muted-foreground"
          strokeWidth={1.75}
        />
      </span>
    </PaletteRow>
  )
}

/* -------------------------------------------------------------------------- */
/*                              New project form                              */
/* -------------------------------------------------------------------------- */

/**
 * In-palette new-project form. Mirrors the onboarding screen's
 * "New project" step: a single name field (mapped to the last path
 * segment) with an "Advanced" disclosure for the parent folder
 * (defaults to `~/projects`). `onCreate` returns an error string to
 * surface inline, or `null` on success (the palette closes).
 */
function NewProjectForm({
  onCancel,
  onCreate,
}: {
  onCancel: () => void
  onCreate: (relativePath: string) => Promise<string | null>
}) {
  const [name, setName] = useState("")
  const [parent, setParent] = useState("projects")
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    nameRef.current?.focus()
  }, [])

  const submit = useCallback(async () => {
    if (busy) return
    const cleanName = name.trim().replace(/^\/+/, "").replace(/\/+$/, "")
    if (!cleanName) {
      setError("Enter a project name")
      return
    }
    const cleanParent = parent.trim().replace(/^\/+/, "").replace(/\/+$/, "")
    const relative = cleanParent ? `${cleanParent}/${cleanName}` : cleanName
    setError(null)
    setBusy(true)
    try {
      const err = await onCreate(relative)
      if (err) setError(err)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [busy, name, parent, onCreate])

  return (
    <PaletteShell
      header={
        <div className="px-3 py-2 text-[13px] font-medium text-popover-foreground">
          New project
        </div>
      }
    >
      <div className="flex flex-col gap-3 p-3">
        <input
          ref={nameRef}
          placeholder="my-app"
          value={name}
          onChange={e => setName(normalizeProjectName(e.target.value))}
          onKeyDown={e => {
            if (e.key === "Enter") {
              e.preventDefault()
              void submit()
            }
            if (e.key === "Escape") {
              e.preventDefault()
              onCancel()
            }
          }}
          disabled={busy}
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          className="h-10 w-full rounded-md border border-input bg-transparent px-3 text-[13px] outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setAdvancedOpen(o => !o)}
            className="flex w-fit items-center gap-1 text-[12px] text-muted-foreground transition-colors hover:text-foreground"
          >
            <span
              className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`}
            >
              ›
            </span>
            Advanced
          </button>
          {advancedOpen ? (
            <label className="flex flex-col gap-1.5">
              <span className="text-[12px] text-muted-foreground">
                Parent folder
              </span>
              <div className="flex h-9 w-full items-stretch rounded-md border border-input bg-transparent focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/40">
                <span className="flex items-center pl-3 pr-1 text-[13px] text-muted-foreground select-none">
                  ~/
                </span>
                <input
                  placeholder="projects"
                  value={parent}
                  onChange={e => setParent(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === "Enter") {
                      e.preventDefault()
                      void submit()
                    }
                    if (e.key === "Escape") {
                      e.preventDefault()
                      onCancel()
                    }
                  }}
                  disabled={busy}
                  spellCheck={false}
                  autoCorrect="off"
                  autoCapitalize="off"
                  className="h-full min-w-0 flex-1 rounded-r-md bg-transparent pr-3 text-[13px] outline-none disabled:cursor-not-allowed disabled:opacity-50"
                />
              </div>
            </label>
          ) : null}
        </div>
        {error ? (
          <div className="text-[12px] text-destructive">{error}</div>
        ) : null}
        <div className="flex items-center gap-2 pt-0.5">
          <Button
            type="button"
            onClick={() => void submit()}
            disabled={busy || name.trim().length === 0}
          >
            Create project
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={busy}
          >
            Cancel
          </Button>
        </div>
      </div>
    </PaletteShell>
  )
}

/* -------------------------------------------------------------------------- */
/*                                  Sorting                                   */
/* -------------------------------------------------------------------------- */

/**
 * Unfiltered sort order (palette opens with empty query):
 *
 *   1. Recently opened in another IDE (per `db.app.recentProjects`)
 *      \u2014 highest `lastOpenedAt` wins.
 *   2. Shorter `depth` \u2014 keeps `~/code/foo` above
 *      `~/code/team/repo/foo`.
 *   3. Lexicographic on `name`.
 */
function sortUnfiltered(
  items: ProjectEntry[],
  lastOpenedAt: Map<string, number>,
): ProjectEntry[] {
  const out = items.slice()
  out.sort((a, b) => {
    const ta = lastOpenedAt.get(a.path)
    const tb = lastOpenedAt.get(b.path)
    if (ta != null || tb != null) {
      if (ta == null) return 1
      if (tb == null) return -1
      if (ta !== tb) return tb - ta
    }
    if (a.depth !== b.depth) return a.depth - b.depth
    return a.name.localeCompare(b.name)
  })
  return out
}

/**
 * Filtered sort order, given a query `q` (already lowercased):
 *
 *   1. Match bucket:
 *      a. basename startsWith q
 *      b. basename includes q
 *      c. path includes q
 *      d. subsequence in basename (typo / abbreviation
 *         tolerance: each char of the query appears in the
 *         basename in order),
 *      e. subsequence in path,
 *      f. (no match — dropped entirely)
 *   2. Inside the bucket, fall back to the unfiltered ordering.
 *
 * Both query and target strings are *normalized* before any of
 * the above so separator wiggles don't matter:
 *   `"my project"` → `"myproject"` (matches `"my-project"`)
 *   `"my_project"` → `"myproject"`
 *   `"my.proj"` → `"myproj"`
 * Subsequence then covers most typos *of the dropping-or-
 * inserting-a-char variety*, e.g. `"myproect"` still matches
 * `"my-project"` because m→y→p→r→o→e→c→t appears in
 * order. It deliberately won't match transposed adjacent chars
 * (`"myporject"`); we'd need real edit-distance for that, which
 * isn't worth the size today.
 */
function sortFiltered(
  items: ProjectEntry[],
  q: string,
  lastOpenedAt: Map<string, number>,
): ProjectEntry[] {
  type Bucketed = { entry: ProjectEntry; bucket: number }
  const qNorm = normalizeForMatch(q)
  // If the query collapses to nothing after normalization (e.g.
  // the user typed just a bunch of dashes), short-circuit
  // empty.
  if (qNorm.length === 0) return []
  const matched: Bucketed[] = []
  for (const entry of items) {
    const nameNorm = normalizeForMatch(entry.name)
    const pathNorm = normalizeForMatch(entry.path)
    if (nameNorm.startsWith(qNorm)) {
      matched.push({ entry, bucket: 0 })
    } else if (nameNorm.includes(qNorm)) {
      matched.push({ entry, bucket: 1 })
    } else if (pathNorm.includes(qNorm)) {
      matched.push({ entry, bucket: 2 })
    } else if (isSubsequence(qNorm, nameNorm)) {
      matched.push({ entry, bucket: 3 })
    } else if (isSubsequence(qNorm, pathNorm)) {
      matched.push({ entry, bucket: 4 })
    }
  }
  matched.sort((a, b) => {
    if (a.bucket !== b.bucket) return a.bucket - b.bucket
    const ta = lastOpenedAt.get(a.entry.path)
    const tb = lastOpenedAt.get(b.entry.path)
    if (ta != null || tb != null) {
      if (ta == null) return 1
      if (tb == null) return -1
      if (ta !== tb) return tb - ta
    }
    if (a.entry.depth !== b.entry.depth) return a.entry.depth - b.entry.depth
    return a.entry.name.localeCompare(b.entry.name)
  })
  return matched.map(m => m.entry)
}

/**
 * Collapse separators + lowercase. Treats whitespace, dashes,
 * underscores, dots, slashes (and backslashes for Windows-style
 * paths if any leak in) as equivalent and strips them all. This
 * is what makes `"my project"` match `"my-project"` and
 * `"openProjects"` match `"open-projects"` (after the lowercase
 * pass).
 */
function normalizeForMatch(s: string): string {
  // We also split camelCase into separator-less form by lowercasing
  // — `"openProjects"` → `"openprojects"` — because that's what
  // the user will type. We don't insert separators around case
  // changes; the strip below would just remove them anyway.
  return s.toLowerCase().replace(/[\s\-_./\\]+/g, "")
}

/**
 * True when every character of `needle` appears in `haystack` in
 * the same order (not necessarily contiguously). Both args are
 * expected to be normalized (lowercased, separator-stripped).
 *
 * Cheap: O(needle + haystack) and runs entirely on primitive
 * char codes. We re-run this per row on every keystroke, against
 * the (already pre-bucketed) miss list, so cheap matters.
 */
function isSubsequence(needle: string, haystack: string): boolean {
  if (needle.length === 0) return true
  if (needle.length > haystack.length) return false
  let i = 0
  for (let j = 0; j < haystack.length; j++) {
    if (haystack.charCodeAt(j) === needle.charCodeAt(i)) {
      i++
      if (i === needle.length) return true
    }
  }
  return false
}

/* -------------------------------------------------------------------------- */
/*                                  Helpers                                   */
/* -------------------------------------------------------------------------- */

const noopRef: React.Ref<HTMLButtonElement> = () => {}

/**
 * Collapse `$HOME` to `~` for display so paths read naturally.
 * We don't have `os.homedir()` over here in the renderer; we use
 * the same `app.env.homeDir` cache the rest of the renderer uses
 * via a synchronous closure. Stored in this module so we read it
 * once per palette render instead of once per row.
 */
let cachedHomeDir: string | null = null
function setHomeDir(h: string | null) {
  cachedHomeDir = h
}
function displayParent(parent: string): string {
  if (cachedHomeDir && parent.startsWith(cachedHomeDir + "/")) {
    return "~" + parent.slice(cachedHomeDir.length)
  }
  if (cachedHomeDir && parent === cachedHomeDir) {
    return "~"
  }
  return parent
}

/** Subscribes to `db.app.env.homeDir` so `displayParent` can
 * collapse paths without a `useDb` per row (which would re-fire
 * the row's render on unrelated env changes). */
function HomeDirSync() {
  const homeDir = useDb(root => root.app.env.homeDir)
  useEffect(() => {
    setHomeDir(homeDir ?? null)
  }, [homeDir])
  return null
}

/**
 * Gate hover-driven selection on real mouse movement. Layout
 * shifts when the palette mounts can synthesize `pointermove`
 * events at stationary coordinates; those would otherwise flip
 * the hover gate active before the user touched the mouse and
 * steal keyboard selection.
 */
function useHoverIntent() {
  const ref = useRef(false)
  useEffect(() => {
    ref.current = false
    let lastX: number | null = null
    let lastY: number | null = null
    const onMove = (e: PointerEvent) => {
      if (lastX !== null && e.clientX === lastX && e.clientY === lastY) return
      lastX = e.clientX
      lastY = e.clientY
      ref.current = true
    }
    window.addEventListener("pointermove", onMove)
    return () => window.removeEventListener("pointermove", onMove)
  }, [])
  return useMemo(
    () => ({
      isActive: () => ref.current,
      resetToKeyboard: () => {
        ref.current = false
      },
    }),
    [],
  )
}

/* -------------------------------------------------------------------------- */
/*                                  Mount                                     */
/* -------------------------------------------------------------------------- */

function mount() {
  if (document.body?.dataset.openProjectsPaletteMounted === "1") return
  if (document.body) document.body.dataset.openProjectsPaletteMounted = "1"

  const host = document.createElement("div")
  host.setAttribute("data-open-projects-palette", "1")
  document.body.appendChild(host)

  createRoot(host).render(
    <StrictMode>
      <ZenbuProvider>
        <HomeDirSync />
        <OpenProjectsPalette />
      </ZenbuProvider>
    </StrictMode>,
  )
}

mount()
