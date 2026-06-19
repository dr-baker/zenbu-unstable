import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react"
import { BanIcon, XIcon } from "lucide-react"
import { cn } from "@/lib/utils"
import { collapseHomeDir, useHomeDir } from "@/lib/home-dir"
import { UserMessageImage } from "./user-message-image"

/**
 * Module-level store for tool-card UI toggle state (e.g. BashCard's
 * "output expanded", TaskCard's "detail expanded", ...).
 *
 * Why this exists: `useWindowedItems` in `ChatDisplay` slices the
 * messages array to a sliding tail of `initialWindow` items, so a
 * tool card that scrolls out of view *unmounts* and loses any
 * `useState` it owned. When the user scrolls back the card remounts
 * with `expanded = false`, throwing away the choice they'd already
 * made. Worse: a single layout-shift-triggered remount mid-click
 * presents as the "expand button flickers open and closed" bug —
 * the click successfully sets state on the about-to-unmount
 * instance, the new instance comes up with the initial value, and
 * the visible result is identical to a no-op.
 *
 * The map is keyed by `toolCallId` + a per-toggle suffix (since a
 * single card can have multiple toggles in theory) so persistence
 * is scoped to that exact tool call across the entire app session.
 * Keys never come back once their tool call leaves the chat — a
 * trivial leak measured in tens of bytes per call, which is the
 * tradeoff we explicitly accepted in exchange for correctness.
 */
const toolCardToggleStore = new Map<string, boolean>()

function usePersistedToolToggle(
  toolCallId: string,
  suffix: string,
  initial: boolean,
): [boolean, (next: boolean | ((prev: boolean) => boolean)) => void] {
  const key = `${toolCallId}:${suffix}`
  const [value, setValue] = useState<boolean>(() => {
    const cached = toolCardToggleStore.get(key)
    return typeof cached === "boolean" ? cached : initial
  })
  const update = useCallback(
    (next: boolean | ((prev: boolean) => boolean)) => {
      setValue(prev => {
        const resolved = typeof next === "function" ? next(prev) : next
        toolCardToggleStore.set(key, resolved)
        return resolved
      })
    },
    [key],
  )
  return [value, update]
}
import type {
  ToolCallContentItem,
  ToolResponse,
} from "../lib/materialized-message"

const SHIMMER = "text-shimmer"

/**
 * Subtle red X shown trailing a tool card when the tool reported an
 * error (`isError: true`). The card itself otherwise renders in its
 * normal "completed" state (past-tense verb, no shimmer) so the
 * failure reads as "this finished, but unhappily" rather than "this
 * is still running".
 *
 * `interrupted` (user-requested stop mid-run) gets a separate
 * indicator — a muted "canceled" suffix — not the X, because the
 * tool didn't fail, the user stopped it. See `CanceledIndicator`.
 */
function FailedIndicator({ status }: { status: ToolCardProps["status"] }) {
  if (status !== "failed") return null
  return (
    <XIcon
      className="shrink-0 text-red-500"
      width={12}
      height={12}
      strokeWidth={2}
      aria-label="failed"
    />
  )
}

/**
 * Trailing muted ban glyph (⊘) shown after a tool card whose
 * status is `interrupted` (the materializer flips running/pending
 * tools to `interrupted` on a `turn_interrupted` event or an
 * aborted `message_end`). Pairs with the base-form verb each card
 * picks via `verbFor(...)` so the row reads e.g. "Create File
 * foo.ts +1 ⊘" instead of "Creating File foo.ts +1".
 *
 * Why a ban glyph (not an X, not text): the red `XIcon` already
 * means "this tool errored" — reusing it for a user-cancel would
 * conflate two very different signals. The lucide `BanIcon` is
 * the conventional "stopped / canceled" affordance (same hue
 * family as `text-muted-foreground` so it sits visually quieter
 * than the failure X, matching the underlying intent: nothing
 * broke, the user just hit stop).
 */
function CanceledIndicator({ status }: { status: ToolCardProps["status"] }) {
  if (status !== "interrupted") return null
  return (
    <BanIcon
      className="shrink-0 text-muted-foreground"
      width={12}
      height={12}
      strokeWidth={2}
      aria-label="canceled"
    />
  )
}

/** True once the tool has reached a terminal state (success,
 * failure, *or* user-interrupt). Drives `Verb`'s no-shimmer
 * rendering and gates each card's loading-only logic. */
function isDone(status: ToolCardProps["status"]) {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted"
  )
}

/** True only for cards interrupted by the user mid-run. Pulled
 * out so cards can switch their verb to the base form ("Create
 * File" rather than "Creating File" or "Created File") — the
 * progressive form lies (we didn't finish) and the past-tense
 * form also lies (it didn't actually happen). */
function isInterrupted(status: ToolCardProps["status"]) {
  return status === "interrupted"
}

/**
 * Pick the right verb form for a card given its current status.
 * Centralised so every card (Write, Edit, Bash, Task, Read) uses
 * the same three-way mapping:
 *   - loading      → progressive ("Creating File", "Editing", "Reading")
 *   - interrupted  → base ("Create File", "Edit", "Read")
 *   - done         → past tense ("Created File", "Edited", "Read")
 * The trailing `CanceledIndicator` carries the "canceled" label
 * so the verb itself stays a verb — the row reads like normal
 * English: "Create File foo.ts +1 canceled".
 */
function verbFor(
  status: ToolCardProps["status"],
  forms: { loading: string; interrupted: string; done: string },
): string {
  if (isInterrupted(status)) return forms.interrupted
  if (isDone(status)) return forms.done
  return forms.loading
}

type ToolCardProps = {
  /** Stable id pi assigns to the tool call. Used as the persistence
   * key for any per-card toggle state — see `usePersistedToolToggle`
   * — so that scrolling the card out of the windowed view and back
   * doesn't reset what the user expanded. */
  toolCallId: string
  title: string
  subtitle?: string
  kind: string
  status: "pending" | "running" | "completed" | "failed" | "interrupted"
  contentItems?: ToolCallContentItem[]
  rawInput?: unknown
  rawOutput?: unknown
  toolName?: string
  toolResponse?: ToolResponse | null
  /** False while pi is still streaming the tool-call JSON args.
   * ReadCard uses this to avoid showing a bogus basename from a
   * half-parsed path. */
  argsComplete?: boolean
  /** Resolved by materialize for `edit` / `write` calls. EditCard
   * and WriteCard fire `onOpenDiff({ directory: editDirectory,
   * path: editPath })` on click so all tool-card clicks land in
   * the shared diff pane. Both null → the card is not clickable. */
  editPath?: string | null
  editDirectory?: string | null
  onOpenDiff?: (args: { directory: string; path: string }) => void
  /** True only for the most recent tool call in the chat (computed
   * in chat-display against the un-windowed message list). BashCard
   * uses this to gate its inline output preview: the last bash
   * call shows its output below the command, but as soon as a
   * newer tool call arrives the preview disappears and the row
   * collapses to a click-to-open trigger that routes through
   * `onOpenToolOutput`. Mirrors the ThinkingBlock collapse on
   * "finished", just keyed off "next tool started". */
  isLastToolCall?: boolean
  /** Same callback as the one chat-pane passes for BashCard's
   * inline output preview, declared here on the umbrella props
   * type because ToolCallCard fans it down into BashCard. */
  onOpenToolOutput?: (toolCallId: string) => void
}

export function ToolCallCard(props: ToolCardProps) {
  const name = (props.toolName ?? "").toLowerCase()
  const kind = props.kind || "other"
  const isBash = kind === "execute" || name === "bash"
  const isEdit = kind === "edit" || name === "edit"
  const isWrite = name === "write" || kind === "create"
  const isRead = kind === "read" || name === "read"
  const isSearch =
    kind === "search" ||
    name === "grep" ||
    name === "glob" ||
    name === "find" ||
    name === "ls"
  const isTask = kind === "think" || name === "agent" || name === "task"

  if (isWrite) return <WriteCard {...props} />
  if (isEdit) return <EditCard {...props} />
  // Other card types (Bash, Read, Search, Task, Default) ignore
  // editPath / editDirectory / onOpenDiff — they keep their
  // existing accordion / shimmer behaviour.
  if (isBash) return <BashCard {...props} />
  if (isTask) return <TaskCard {...props} />
  if (isRead) return <ReadCard {...props} />
  if (isSearch) return <SearchCard {...props} />
  return <DefaultCard {...props} />
}

function isLoading(status: ToolCardProps["status"]) {
  return !isDone(status)
}

function fileBasename(p: string): string {
  return p.split("/").pop() ?? p
}

function truncateLines(text: string, max: number): string {
  const lines = text.split("\n")
  if (lines.length <= max) return text
  return lines.slice(0, max).join("\n") + `\n... ${lines.length - max} more lines`
}

function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, max) + "…"
}

function countDiffLines(diffs: (ToolCallContentItem & { type: "diff" })[]) {
  let added = 0
  let removed = 0
  for (const d of diffs) {
    const oldLines = d.oldText ? d.oldText.split("\n") : []
    const newLines = d.newText.split("\n")
    const oldSet = new Set(oldLines)
    const newSet = new Set(newLines)
    for (const line of newLines) if (!oldSet.has(line)) added++
    for (const line of oldLines) if (!newSet.has(line)) removed++
  }
  return { added, removed }
}

function Chevron({ expanded }: { expanded: boolean }) {
  return (
    <svg
      className="shrink-0 text-muted-foreground opacity-0 group-hover/tool:opacity-100"
      width="12"
      height="12"
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ transform: expanded ? "rotate(90deg)" : undefined }}
    >
      <path d="M4.5 3L7.5 6L4.5 9" />
    </svg>
  )
}

function ToolLine({
  expanded,
  children,
  onClick,
  showChevron = true,
  tooltip,
}: {
  expanded?: boolean
  children: ReactNode
  onClick?: (e: ReactMouseEvent) => void
  showChevron?: boolean
  /** Optional aria-label, used by EditCard / WriteCard to hint that
   * clicking opens the diff view in a split. Tooltip UI was removed
   * for perf — we now forward this as `aria-label` only. */
  tooltip?: string
}) {
  const interactive = !!onClick
  // Hover paints a soft `bg-accent` chip hugged to the text via
  // `-mx-1.5 px-1.5` so layout doesn't shift. No `cursor-pointer`
  // — desktop convention; the background change is the affordance.
  const Tag = interactive ? "button" : "div"
  return (
    <Tag
      type={interactive ? "button" : undefined}
      onClick={onClick}
      aria-label={tooltip}
      className={cn(
        "group/tool flex w-full min-w-0 items-center gap-1.5 bg-transparent py-0.5 text-left text-sm font-normal",
        interactive
          ? "-mx-1.5 rounded-md px-1.5 transition-colors hover:bg-accent focus-visible:outline-none focus-visible:bg-accent"
          : "px-0",
      )}
    >
      {children}
      {showChevron && interactive && <Chevron expanded={!!expanded} />}
    </Tag>
  )
}

/**
 * Simple expandable body used by TaskCard. (BashCard rolls its
 * own — see the gradient-fade pattern there — because it needs
 * to be always-visible-with-cap rather than gated behind a click.)
 */
function ExpandedBody({ children }: { children: ReactNode }) {
  return (
    <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-all rounded border border-border bg-muted px-2 py-1 text-xs text-muted-foreground">
      {children}
    </pre>
  )
}

function Verb({
  loading,
  children,
}: {
  loading: boolean
  children: ReactNode
}) {
  return (
    <span className={cn("shrink-0", loading ? SHIMMER : "text-muted-foreground")}>
      {children}
    </span>
  )
}

function EditCard({
  contentItems = [],
  status,
  editPath,
  editDirectory,
  onOpenDiff,
}: ToolCardProps) {
  const diffs = contentItems.filter(
    (c): c is ToolCallContentItem & { type: "diff" } => c.type === "diff",
  )
  const paths = [...new Set(diffs.map(d => d.path))]
  const label = paths.length > 0 ? paths.map(fileBasename).join(", ") : null
  const { added, removed } = countDiffLines(diffs)
  const loading = isLoading(status)
  // Click → open the side-by-side diff view in a shared split pane
  // (same token as the git-tree sidebar / turn-summary cards, so
  // subsequent clicks REPLACE rather than stack). Disabled while
  // we don't yet have the resolved file path / worktree (very early
  // streaming) or when the chat has no scope.
  // Gated on `!loading` so we don't race the writer while pi is
  // still streaming args.
  const canOpen = !!(onOpenDiff && editPath && editDirectory) && !loading
  const handleClick = canOpen
    ? () => onOpenDiff!({ directory: editDirectory!, path: editPath! })
    : undefined

  return (
    <ToolLine
      onClick={handleClick}
      showChevron={false}
      tooltip={canOpen ? "Open diff in a split" : undefined}
    >
      <Verb loading={loading}>
        {verbFor(status, {
          loading: "Editing",
          interrupted: "Edit",
          done: "Edited",
        })}
      </Verb>
      <span className="min-w-0 truncate text-foreground">
        {label}
      </span>
      {(added > 0 || removed > 0) && (
        <span className="flex shrink-0 items-center gap-0.5">
          {added > 0 && <span className="text-emerald-600">+{added}</span>}
          {removed > 0 && <span className="text-red-500">-{removed}</span>}
        </span>
      )}
      <FailedIndicator status={status} />
      <CanceledIndicator status={status} />
    </ToolLine>
  )
}

// Previously this file rendered an inline `<DiffPathHeader>` /
// `<DiffBlock>` accordion under EditCard. EditCard now routes
// clicks to the side-by-side `git-diff` view in a shared split
// pane (see EditCard above), so the inline diff body — and its
// `displayPath` import — are no longer needed.

function WriteCard({
  rawInput,
  status,
  editPath,
  editDirectory,
  onOpenDiff,
}: ToolCardProps) {
  const input = (rawInput ?? {}) as Record<string, unknown>
  const filePath = String(input.file_path ?? input.path ?? "")
  const content = input.content ?? input.contents
  const lineCount =
    typeof content === "string" && content ? content.split("\n").length : 0
  const loading = isLoading(status)
  // Same click-to-open-diff handler as EditCard; see the comment
  // there for the routing rationale.
  // See `EditCard` for the `!loading` gate rationale.
  const canOpen = !!(onOpenDiff && editPath && editDirectory) && !loading
  const handleClick = canOpen
    ? () => onOpenDiff!({ directory: editDirectory!, path: editPath! })
    : undefined

  return (
    <ToolLine
      onClick={handleClick}
      showChevron={false}
      tooltip={canOpen ? "Open diff in a split" : undefined}
    >
      <Verb loading={loading}>
        {verbFor(status, {
          loading: "Creating File",
          interrupted: "Create File",
          done: "Created File",
        })}
      </Verb>
      <span className="min-w-0 truncate text-foreground">
        {fileBasename(filePath)}
      </span>
      {lineCount > 0 && (
        <span className="shrink-0 text-blue-500">+{lineCount}</span>
      )}
      <FailedIndicator status={status} />
      <CanceledIndicator status={status} />
    </ToolLine>
  )
}

/**
 * Vertical pixel cap for the bash output inline preview. Whatever
 * doesn't fit gets clipped from the *top* (the preview is
 * bottom-aligned via flex justify-end so the latest streaming
 * lines stay visible). The user clicks the preview to open the
 * full output in a shared side pane — there's no in-place expand.
 *
 * Picked to be roughly the vertical weight of a long collapsed
 * user message (`UserMessage`'s `COLLAPSED_MAX_HEIGHT = 120`) plus
 * a bit, since command output usually wants a few more lines of
 * context than a user prompt does.
 */
const BASH_OUTPUT_COLLAPSED_HEIGHT = 160

function BashCard({
  toolCallId,
  rawInput,
  toolResponse,
  status,
  onOpenToolOutput,
  isLastToolCall,
}: ToolCardProps) {
  // Bash output is always shown below the command, capped at
  // `BASH_OUTPUT_COLLAPSED_HEIGHT` with the *tail* visible (newest
  // lines pinned to the bottom of the window, older lines clipped
  // off the top via `flex flex-col justify-end` + `overflow:
  // hidden`). To see the full output, the user clicks anywhere on
  // the preview — same UX as clicking a file in the file sidebar —
  // which opens it in a shared side pane via `onOpenToolOutput`.
  //
  // No in-place expand affordance, no local toggle state, no
  // windowing-resistance dance: the side view lives in its own
  // iframe with its own state, completely insulated from the
  // chat's windowed message list.
  //
  // Tail-view CSS trick: the pre keeps its intrinsic height
  // (`shrink-0`), flex pushes its bottom edge to the container's
  // bottom edge, and the top portion that doesn't fit in the
  // 160px window gets clipped by `overflow: hidden`. As bash
  // streams new bytes the pre grows downward; the bottom stays
  // pinned to the container's bottom, so older lines slide off
  // the top — terminal-style tail with zero scroll listeners and
  // zero scrollbar to hide. When the pre fits, justify-end is a
  // no-op (one child) so short output renders normally.
  const homeDir = useHomeDir()
  const input = (rawInput ?? {}) as Record<string, unknown>
  const rawCommand =
    typeof input.command === "string" && input.command.length > 0
      ? input.command
      : null
  const command =
    rawCommand != null ? collapseHomeDir(rawCommand, homeDir) : null
  const loading = isLoading(status)

  const stdout = toolResponse?.stdout ?? ""
  const stderr = toolResponse?.stderr ?? ""
  const outputText =
    stdout || stderr
      ? `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`
      : ""
  const hasOutput = outputText.length > 0

  const inner = command ? (
    <span className="text-foreground">{command}</span>
  ) : (
    <span
      className={cn(
        "mx-0.5 inline-block h-3.5 w-24 rounded-sm bg-muted align-middle",
        loading && "hg-shimmer",
      )}
    />
  )

  const canOpen = !!onOpenToolOutput
  // `stopPropagation` so the click doesn't bubble up to
  // MessageList's scroll-container `handleInteraction` (which can
  // freeze chat auto-scroll if a text selection forms mid-click).
  const handleOpen = (e: ReactMouseEvent) => {
    e.stopPropagation()
    onOpenToolOutput?.(toolCallId)
  }

  // Only render the output preview once we actually have bytes to
  // show AND this is still the most recent tool call. Previously
  // this was `hasOutput || loading`, which painted an empty preview
  // frame with a tiny shimmer pill the instant the tool started —
  // reads as "here's the output… nope, just kidding" and adds a
  // layout jump when the first line lands. Keeping the command
  // line alone (which already shimmers via `Verb`) is a clearer
  // "running, no output yet" state.
  //
  // The `isLastToolCall` gate is the auto-collapse behaviour: as
  // soon as a newer tool call lands in the chat, every prior bash
  // card folds back to just its command row. The output is still
  // one click away — the row itself becomes a click target when
  // `canOpen` is set, routing through the same `onOpenToolOutput`
  // side pane. Same model as Edit/Write cards (click → side
  // pane), same intent as ThinkingBlock's streaming → collapsed
  // transition, just keyed off the *next* tool call rather than
  // this one finishing.
  const showOutputBlock = hasOutput && isLastToolCall !== false

  // Track whether the <pre>'s natural height exceeds the collapsed
  // window so we can conditionally render the top fade gradient.
  // Without this we paint a ghost fade over short outputs (2-line
  // grep results, etc.) where there's nothing clipped to hint at.
  // ResizeObserver fires on content reflow (streaming bash output
  // growing line-by-line), so the gradient appears the moment the
  // pre actually overflows.
  const preRef = useRef<HTMLPreElement | null>(null)
  const [isOverflowing, setIsOverflowing] = useState(false)
  useEffect(() => {
    const el = preRef.current
    if (!el) {
      setIsOverflowing(false)
      return
    }
    const measure = () => {
      setIsOverflowing(el.scrollHeight > BASH_OUTPUT_COLLAPSED_HEIGHT)
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [outputText, showOutputBlock])

  // When the output preview is hidden (older bash call), the
  // command row itself becomes the click target — click on
  // `Bash(…)` to pop the full output in the shared side pane.
  // We don't wire the click when the preview is visible: the
  // preview already has its own button, and adding a second
  // overlapping target on the same row reads as noise.
  const rowClickable = !showOutputBlock && canOpen && hasOutput
  // `stopPropagation` so the click doesn't bubble into
  // MessageList's scroll-container `handleInteraction`, which can
  // freeze chat auto-scroll if a text selection forms mid-click.
  // Same rationale as `handleOpen` on the preview button below.
  const handleRowClick = rowClickable
    ? (e: ReactMouseEvent) => {
        e.stopPropagation()
        onOpenToolOutput?.(toolCallId)
      }
    : undefined

  return (
    <div>
      <ToolLine
        onClick={handleRowClick}
        showChevron={false}
        tooltip={rowClickable ? "Open output in side pane" : undefined}
      >
        <span className="min-w-0 truncate">
          <Verb loading={loading}>Bash(</Verb>
          {inner}
          <Verb loading={loading}>)</Verb>
        </span>
        <FailedIndicator status={status} />
        <CanceledIndicator status={status} />
      </ToolLine>
      {showOutputBlock && (
        // The whole preview is a single clickable target (when
        // chat-pane wired `onOpenToolOutput`). Using a real
        // `<button>` picks up native keyboard activation / focus
        // ring for free; styled as text-only so it reads as
        // inline content, not a button.
        <button
            type={canOpen ? "button" : undefined}
            onClick={canOpen ? handleOpen : undefined}
            disabled={!canOpen}
            aria-label={canOpen ? "Open output in side pane" : undefined}
            className={cn(
              "mt-1 block w-full text-left",
              // Desktop convention: no cursor-pointer. The hover
              // affordance is a *very* subtle nudge on the left
              // rule — same hue family, just slightly more opaque
              // (60% → 100% of `border`). An earlier version
              // jumped to `foreground/40`, which read as the
              // output itself "reacting" to the mouse; staying
              // inside the border token keeps it whisper-quiet.
              canOpen && "group/bash-out focus-visible:outline-none",
            )}
          >
            <div
              className={cn(
                "relative flex flex-col justify-end border-l border-border/60 pl-2 transition-colors",
                canOpen && "group-hover/bash-out:border-border",
              )}
              style={{
                maxHeight: BASH_OUTPUT_COLLAPSED_HEIGHT,
                overflow: "hidden",
              }}
            >
              <pre
                ref={preRef}
                className="shrink-0 whitespace-pre-wrap break-all py-0.5 text-xs text-muted-foreground"
              >
                {outputText}
              </pre>
              {/* Top fade: decorative — hints "more above is hidden".
                  Only rendered when the pre actually overflows the
                  collapsed window; otherwise we'd paint a ghost fade
                  over a short 2-line output. `pointer-events-none`
                  so it doesn't eat the underlying button's click. */}
              {isOverflowing && (
                <div
                  aria-hidden
                  className="pointer-events-none absolute inset-x-0 top-0 h-6 bg-gradient-to-b from-background via-background/85 to-transparent"
                />
              )}
            </div>
          </button>
      )}
    </div>
  )
}

function TaskCard({
  toolCallId,
  title,
  rawInput,
  contentItems,
  status,
}: ToolCardProps) {
  const [expanded, setExpanded] = usePersistedToolToggle(
    toolCallId,
    "task-detail-expanded",
    false,
  )
  const input = (rawInput ?? {}) as Record<string, unknown>
  const description = String(input.description ?? input.prompt ?? "")
  const promptText = contentItems?.find(
    (c): c is ToolCallContentItem & { type: "text" } => c.type === "text",
  )?.text
  const detail = promptText || description
  const summary = truncateText(description || title, 80)
  const loading = isLoading(status)

  return (
    <div>
      <ToolLine
        expanded={expanded}
        onClick={detail ? () => setExpanded(e => !e) : undefined}
      >
        <span className="break-all">
          <Verb loading={loading}>Task(</Verb>
          {summary ? (
            <span className="text-foreground">{summary}</span>
          ) : (
            <span
              className={cn(
                "mx-0.5 inline-block h-3.5 w-24 rounded-sm bg-muted align-middle",
                loading && "hg-shimmer",
              )}
            />
          )}
          <Verb loading={loading}>)</Verb>
        </span>
        <FailedIndicator status={status} />
        <CanceledIndicator status={status} />
      </ToolLine>
      {expanded && detail && <ExpandedBody>{truncateLines(detail, 30)}</ExpandedBody>}
    </div>
  )
}

function extractReadImageRefs(
  rawOutput: unknown,
): { blobId: string; mimeType: string }[] {
  const content = readResultContent(rawOutput)
  const out: { blobId: string; mimeType: string }[] = []
  for (const item of content) {
    if (!item || typeof item !== "object") continue
    const record = item as Record<string, unknown>
    if (record.type !== "image") continue
    const blobId = record.blobId
    if (typeof blobId !== "string") continue
    const mimeType =
      typeof record.mimeType === "string" ? record.mimeType : "image/png"
    out.push({ blobId, mimeType })
  }
  return out
}

function readResultContent(rawOutput: unknown): unknown[] {
  if (Array.isArray(rawOutput)) return rawOutput
  if (!rawOutput || typeof rawOutput !== "object") return []
  const content = (rawOutput as Record<string, unknown>).content
  return Array.isArray(content) ? content : []
}

function ReadCard({
  toolCallId,
  title,
  rawInput,
  rawOutput,
  status,
  argsComplete,
}: ToolCardProps) {
  const [expanded, setExpanded] = usePersistedToolToggle(
    toolCallId,
    "read-path-expanded",
    false,
  )
  const input = (rawInput ?? {}) as Record<string, unknown>
  const filePath = String(
    input.file_path ?? input.path ?? input.filePath ?? title,
  )
  // Reads spam the chat; showing just the basename keeps the list
  // scannable. Full path is still available on hover via the title.
  const cleanPath = filePath.replace(/\s*\([\d\s\-–,]+\)\s*$/, "")
  const cleanTitle = fileBasename(cleanPath)
  const startLine = numberOrUndef(
    input.offset ?? input.start_line ?? input.startLine,
  )
  const limit = numberOrUndef(input.limit)
  const endLine =
    limit != null && startLine != null
      ? startLine + limit
      : numberOrUndef(input.end_line ?? input.endLine)
  const range =
    startLine != null
      ? endLine != null
        ? ` ${startLine}-${endLine}`
        : ` ${startLine}`
      : ""
  const pathStillStreaming = argsComplete === false
  const images = extractReadImageRefs(rawOutput)

  return (
    <div className="min-w-0">
      <ToolLine
        expanded={expanded}
        onClick={pathStillStreaming ? undefined : () => setExpanded(e => !e)}
        showChevron={false}
      >
        <Verb loading={isLoading(status)}>Read</Verb>
        {!pathStillStreaming && (
          <span
            aria-label={cleanPath}
            className={expanded ? "min-w-0 break-all" : "min-w-0 truncate"}
          >
            <span className="text-foreground">{cleanTitle}</span>
            {range && <span className="text-muted-foreground">{range}</span>}
          </span>
        )}
        <FailedIndicator status={status} />
        <CanceledIndicator status={status} />
      </ToolLine>
      {images.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2 pl-[58px]">
          {images.map(image => (
            <UserMessageImage
              key={image.blobId}
              blobId={image.blobId}
              mimeType={image.mimeType}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function SearchCard({ toolCallId, title, status }: ToolCardProps) {
  const [expanded, setExpanded] = usePersistedToolToggle(
    toolCallId,
    "search-expanded",
    false,
  )
  return (
    <ToolLine
      expanded={expanded}
      onClick={() => setExpanded(e => !e)}
      showChevron={false}
    >
      <span
        className={cn(
          expanded ? "min-w-0 break-all" : "min-w-0 truncate",
          isLoading(status) ? SHIMMER : "text-foreground",
        )}
      >
        {title}
      </span>
      <FailedIndicator status={status} />
      <CanceledIndicator status={status} />
    </ToolLine>
  )
}

function DefaultCard({ toolCallId, title, status }: ToolCardProps) {
  const [expanded, setExpanded] = usePersistedToolToggle(
    toolCallId,
    "default-expanded",
    false,
  )
  return (
    <ToolLine
      expanded={expanded}
      onClick={() => setExpanded(e => !e)}
      showChevron={false}
    >
      <span
        className={cn(
          expanded ? "min-w-0 break-all" : "min-w-0 truncate",
          isLoading(status) ? SHIMMER : "text-foreground",
        )}
      >
        {title}
      </span>
      <FailedIndicator status={status} />
      <CanceledIndicator status={status} />
    </ToolLine>
  )
}

function numberOrUndef(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined
}
