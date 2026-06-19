import { useLayoutEffect, useRef, useState } from "react"
import { useRpc } from "@zenbujs/core/react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { FileIcon } from "@/components/common/file-icon"
import type { TurnSummaryProps } from "../message-components"
import { cn } from "@/lib/utils"

/**
 * Post-turn "what changed" card. Rendered at the tail of every turn
 * the agent finished with at least one successful `edit` / `write`
 * tool call — materialize.ts walks the event log from the previous
 * `user_prompt` to the closing `agent_end`, aggregates edits by file
 * path, and emits a `turn_summary` block carrying the per-file
 * counts plus the worktree `directory` the chat is anchored at.
 *
 * Clicking a file row calls `rpc.app.gitTree.openDiff(...)`, which
 * the git-tree-sidebar uses for the same job: it emits an
 * `openDiffInActivePane` event that the agent-sidebar-pane catches
 * and routes through `openViewBySourceInRoot` with source
 * `"git-tree-sidebar"`. The host shell already knows how to split a
 * pane off for that source, so we get a side-by-side diff for free
 * without inventing a parallel routing primitive.
 *
 * Layout: a single bordered "table" of rows so the summary reads as
 * one continuous block rather than a stack of separate cards. Every
 * row uses the same `text-sm` size the rest of the chat uses — file
 * name and path included — so the row reads as one consistent line
 * rather than a heading + caption.
 *
 * Overflow: when the rows exceed `COLLAPSED_MAX_HEIGHT`, we clip
 * (no scrolling) and pin a gradient-fade chevron strip across the
 * bottom edge that doubles as the expand affordance. Clicking it
 * removes the cap and swaps to a "collapse" footer. The state is
 * local — turn summaries are immutable once the turn finishes, so
 * there's nothing to persist across reloads.
 */

const COLLAPSED_MAX_HEIGHT = 168

export function TurnSummary({
  files,
  directory,
  workspaceId,
  scopeId,
}: TurnSummaryProps) {
  const rpc = useRpc()
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)
  const rowsRef = useRef<HTMLDivElement>(null)

  useLayoutEffect(() => {
    const el = rowsRef.current
    if (!el) return
    const check = () => {
      setOverflowing(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [files.length])

  if (files.length === 0) return null
  // The card needs the *full* routing tuple to open the diff in the
  // right place. Bail out (hide the card) if any piece is missing
  // so we never fall back to the active-workspace heuristic that
  // teleported users into a sibling workspace. We allow a missing
  // card-level `directory` as long as every file row carries its
  // own — the row is the source of truth now that edits can
  // land in extra dirs.
  if (!workspaceId || !scopeId) return null
  if (!directory && files.some(f => !f.directory)) return null

  const handleOpen = (fileDirectory: string | null, path: string) => {
    // Per-file directory wins so an edit in an extra dir routes
    // through that worktree's git repo instead of the scope's
    // primary cwd (where `pr.getStatus` would find nothing).
    const target = fileDirectory ?? directory
    if (!target) return
    void rpc.app.gitTree
      .openDiff({ workspaceId, scopeId, directory: target, path })
      .catch(err => console.error("[turn-summary] openDiff failed:", err))
  }

  const headerLabel = summarizeOps(files)
  const showFade = overflowing && !expanded

  return (
    <div className="px-3 py-2">
      <div className="flex flex-col gap-1.5">
        <div className="text-sm text-muted-foreground">{headerLabel}</div>
        <div className="overflow-hidden rounded-md border border-border/60 bg-card/40">
          <div
            className="relative"
            style={
              expanded
                ? undefined
                : { maxHeight: COLLAPSED_MAX_HEIGHT, overflow: "hidden" }
            }
          >
            <div ref={rowsRef} className="divide-y divide-border/40">
              {files.map(file => (
                <TurnSummaryRow
                  key={`${file.directory ?? ""}::${file.path}`}
                  path={file.path}
                  editCount={file.editCount}
                  op={file.op}
                  additions={file.additions}
                  removals={file.removals}
                  onClick={() => handleOpen(file.directory, file.path)}
                />
              ))}
            </div>
            {showFade ? (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                aria-label={`Show all ${files.length} files`}
                className={cn(
                  "absolute inset-x-0 bottom-0 flex h-10 items-end justify-center pb-1.5",
                  "bg-gradient-to-t from-card via-card/85 to-transparent",
                  "text-muted-foreground hover:text-foreground",
                )}
              >
                <ChevronDown className="h-4 w-4" />
              </button>
            ) : null}
          </div>
          {expanded && overflowing ? (
            <button
              type="button"
              onClick={() => setExpanded(false)}
              className={cn(
                "flex w-full items-center justify-center gap-1 border-t border-border/40 py-1",
                "text-sm text-muted-foreground hover:bg-card hover:text-foreground",
              )}
            >
              <ChevronUp className="h-4 w-4" />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )
}

/**
 * Build the one-line summary the card uses as its header: count
 * files per operation kind and join the parts in canonical order
 * ("Created N", "edited N", "deleted N" — deleted reserved for when
 * we add a delete tool). Pluralizes per part so the copy reads
 * naturally regardless of the mix:
 *
 *   - all creates    → "Created 3 files"
 *   - all edits      → "Edited 2 files"
 *   - mixed          → "Created 2 files, edited 1 file"
 *
 * The first part is capitalized; subsequent parts are lowercase so
 * the whole line reads as one sentence.
 */
function summarizeOps(
  files: TurnSummaryProps["files"],
): string {
  let created = 0
  let edited = 0
  for (const f of files) {
    if (f.op === "create") created++
    else edited++
  }
  const parts: string[] = []
  if (created > 0) parts.push(`created ${created} ${plural(created, "file")}`)
  if (edited > 0) parts.push(`edited ${edited} ${plural(edited, "file")}`)
  if (parts.length === 0) return ""
  parts[0] = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1)
  return parts.join(", ")
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`
}

/**
 * One row in the summary "table". Laid out so the path column is
 * always right-aligned and truncates from the left (via direction:
 * rtl on the wrapping span), which keeps the most-specific segment
 * of the path visible when space is tight — same trick the file
 * picker and breadcrumb use elsewhere in the app.
 */
function TurnSummaryRow({
  path,
  editCount,
  op,
  additions,
  removals,
  onClick,
}: {
  path: string
  editCount: number
  op: "create" | "edit"
  additions: number
  removals: number
  onClick: () => void
}) {
  const slash = path.lastIndexOf("/")
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dir = slash >= 0 ? path.slice(0, slash) : ""
  const editLabel = `${editCount} ${editCount === 1 ? "edit" : "edits"}`

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Open diff in a split"
      className={cn(
        "group flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors",
        "hover:bg-card focus-visible:outline-none focus-visible:bg-card",
      )}
    >
      <FileIcon path={path} size={14} className="shrink-0" />
      <span className="shrink-0 truncate text-sm text-foreground">
        {name}
      </span>
      <OpStats op={op} additions={additions} removals={removals} />
      {editCount > 1 ? (
        <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-sm text-muted-foreground">
          {editLabel}
        </span>
      ) : null}
      {dir ? (
        <span
          className="ml-auto min-w-0 truncate text-sm text-muted-foreground/80"
          style={{ direction: "rtl", textAlign: "left" }}
        >
          {/* bidi isolate so slashes still read LTR inside the rtl span */}
          <bdi>{dir}</bdi>
        </span>
      ) : (
        <span className="ml-auto" />
      )}
    </button>
  )
}

/**
 * Per-row line-count badge. Matches the colors and ordering of the
 * inline tool cards above (WriteCard / EditCard in tool-call-card.tsx)
 * so the same edit reads the same way whether you look at the tool
 * call or the post-turn summary:
 *
 *   - create (write) → blue  `+N` for the new file's line count
 *   - edit            → green `+N` and / or red `-N` for diff stats
 *   - (delete         → red   `-N` — reserved for when pi grows a
 *                       delete tool; same red as EditCard's removals
 *                       column so it visually rhymes with "this
 *                       went away")
 *
 * Renders nothing when there are no stats to show (e.g. an empty
 * write or a no-op edit) so the row stays clean.
 */
function OpStats({
  op,
  additions,
  removals,
}: {
  op: "create" | "edit"
  additions: number
  removals: number
}) {
  if (op === "create") {
    if (additions <= 0) return null
    return (
      <span className="shrink-0 text-sm text-blue-500">+{additions}</span>
    )
  }
  if (additions <= 0 && removals <= 0) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-sm">
      {additions > 0 ? (
        <span className="text-emerald-600">+{additions}</span>
      ) : null}
      {removals > 0 ? (
        <span className="text-red-500">-{removals}</span>
      ) : null}
    </span>
  )
}
