import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
} from "react"
import {
  CheckIcon,
  ChevronDown,
  ChevronUp,
  CopyIcon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react"
import { Button } from "@zenbu/ui/button"
import { Composer } from "@/components/composer/composer"
import type { ComposerSubmitPayload } from "@/components/composer/composer"
import type { UserMessageProps } from "../message-components"
import { FileIndexContext } from "../lib/file-index-context"
import { UserMessageImage } from "./user-message-image"
import { cn } from "@/lib/utils"
import {
  BranchSummaryPicker,
  type BranchSummaryChoice,
} from "../lib/branch-summary-choice"

const COLLAPSED_MAX_HEIGHT = 120

/**
 * Read-only render of a past user message bubble. Click the bubble
 * body to flip into edit mode; a Revert affordance lives under the
 * bubble footer alongside copy.
 *
 *   - Edit (click bubble): flip the same Composer instance from
 *     `readOnly` into a live editor seeded with the bubble's
 *     content. Pressing Enter captures the edit and reveals the
 *     summarize-choice picker; once the user picks None / Default /
 *     Custom, the parent `onEditSubmit` runs the branch-and-send
 *     flow. Drag-selecting text inside the bubble doesn't trigger
 *     the flip (we ignore clicks when there's an active selection)
 *     so copy-by-selection still works on the read-only view.
 *
 *   - Revert (undo arrow): no editor stage. Goes straight to the
 *     summarize picker; once the user picks, `onRevertSubmit` runs
 *     the branch-only flow. The parent emits an `appendComposerDraft`
 *     event with the bubble text so the live composer picks it up
 *     for the user to tweak before resending.
 *
 * Both flows go through pi's branching primitive (`navigateTree`)
 * with a `BranchSummaryChoice`. The bubble itself is oblivious to
 * the underlying RPCs \u2014 the chat-pane wires `onEditSubmit` /
 * `onRevertSubmit` into the right main-process calls.
 *
 * Overflow: when the message body exceeds `COLLAPSED_MAX_HEIGHT`,
 * we clip it and pin a gradient-fade chevron strip across the
 * bottom edge that doubles as the expand affordance — same
 * treatment the post-turn summary card uses (see `turn-summary.tsx`).
 * Clicking the strip expands; clicking it does _not_ enter edit
 * mode (it stops propagation), so the chevron stays a pure
 * expand/collapse control.
 *
 * Legacy fallback: messages persisted before the migration to
 * display-text don't contain `@blob:<id>` tokens, so their image
 * refs land in the separate `images` array. Detect that case and
 * fall back to the old inline-thumbnail strip.
 */
type Stage =
  | { kind: "idle" }
  /** Composer mounted as a live editor; waiting for the user to
   * submit (Enter) or cancel (Esc / blur). */
  | { kind: "editing" }
  /** Captured an edit payload + showing the summarize picker. The
   * payload is held in state so picking a summary choice still has
   * access to the text the user typed. */
  | {
      kind: "editChoosing"
      text: string
      displayText: string
    }
  /** Revert flow: no editor stage, summarize picker straight away. */
  | { kind: "revertChoosing" }
  /** A choice has been confirmed and the parent is working on it.
   * Held briefly so the picker can show a "Working\u2026" indicator
   * before the bubble re-renders (or, in the edit case, before the
   * session rebuilds and this materialized message goes away).
   * `flow` keeps the action-label stable across the transition.
   * For the edit flow we also carry the just-edited `displayText`
   * so the preview bubble keeps showing the new message (not the
   * original `content` prop) while the summary work runs. */
  | { kind: "busy"; flow: "edit"; displayText: string }
  | { kind: "busy"; flow: "revert" }

export function UserMessage({
  content,
  images,
  userMessageIndex,
  onEditSubmit,
  onRevertSubmit,
}: UserMessageProps) {
  const [expanded, setExpanded] = useState(false)
  const [overflows, setOverflows] = useState(false)
  const [copied, setCopied] = useState(false)
  const [stage, setStage] = useState<Stage>({ kind: "idle" })
  // Tracks whether this React instance is still mounted. After an
  // edit/revert the materialized message list is rebuilt, but the
  // outer key is `user-${index}` so React reuses _this_ component
  // instance with new props. We use the ref to safely flip out of
  // the busy stage once the parent's async work resolves, instead
  // of getting stuck on a spinner forever.
  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])
  const innerRef = useRef<HTMLDivElement>(null)
  // Bubble's outer chip \u2014 used as the focus boundary for the
  // auto-exit-on-blur effect below.
  const bubbleRef = useRef<HTMLDivElement>(null)
  const files = useContext(FileIndexContext)

  // Auto-revert to read-only when focus leaves the bubble while
  // we're in the live-editor stage. The CodeMirror editor lives
  // inside `bubbleRef`, so a `focusout` whose `relatedTarget` is
  // outside the chip means the user clicked away. We deliberately
  // ignore focusout events whose new focus target is still inside
  // the chip so clicking the inline action buttons doesn't kick us
  // out of edit mode. Skipped while the summarize picker is up:
  // its rows live in the same bubble, but the picker has its own
  // explicit cancel-on-Escape, so we don't want the focus dance to
  // collapse mid-pick.
  useEffect(() => {
    if (stage.kind !== "editing") return
    const el = bubbleRef.current
    if (!el) return
    const handleFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (next && el.contains(next)) return
      // Defer the idle-flip across a microtask + one rAF so a
      // synchronous state transition out of "editing" (e.g. the
      // submit path that swaps in the summarize picker) wins. Without
      // this, hitting Enter to submit the edit fires focusout while
      // the live CodeMirror DOM is being torn down (its key changes
      // so React unmounts it), the listener is still attached because
      // its effect cleanup runs _after_ DOM mutations, and the idle
      // flip would clobber the just-set `editChoosing` stage —
      // hiding the picker entirely. The functional setState below
      // makes it safe regardless: if we've already left editing, the
      // updater is a no-op.
      requestAnimationFrame(() => {
        setStage(prev => (prev.kind === "editing" ? { kind: "idle" } : prev))
      })
    }
    el.addEventListener("focusout", handleFocusOut)
    return () => el.removeEventListener("focusout", handleFocusOut)
  }, [stage.kind])

  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el) return
    const check = () => {
      setOverflows(el.scrollHeight > COLLAPSED_MAX_HEIGHT + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [content])

  const handleCopy = (e: MouseEvent) => {
    e.stopPropagation()
    navigator.clipboard.writeText(content).catch(() => {})
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  const enterEditMode = () => {
    if (userMessageIndex == null || !onEditSubmit) return
    // Expand so the user can see/edit the whole message even if it
    // was collapsed behind a fade.
    setExpanded(true)
    setStage({ kind: "editing" })
  }

  // Click anywhere inside the bubble to enter edit mode — unless
  // the user is mid-drag-selecting text, in which case we want to
  // preserve the selection for copy. We also bail when something
  // already stopped propagation (action buttons, the expand
  // chevron) or when we're not in a clickable stage.
  const handleBubbleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented) return
    if (!canEdit) return
    if (stage.kind !== "idle") return
    const selection = window.getSelection()
    if (selection && selection.toString().length > 0) return
    enterEditMode()
  }

  const handleRevert = (e: MouseEvent) => {
    e.stopPropagation()
    if (userMessageIndex == null || !onRevertSubmit) return
    setStage({ kind: "revertChoosing" })
  }

  const handleComposerSubmit = (payload: ComposerSubmitPayload) => {
    if (userMessageIndex == null || !onEditSubmit) return
    // Don't fire the parent yet \u2014 the user still needs to pick a
    // summary choice. Hold the captured text in state, swap the
    // editor for the picker.
    setStage({
      kind: "editChoosing",
      text: payload.text,
      displayText: payload.displayText,
    })
  }

  // Await the parent then flip back to idle. The reused-instance
  // case (edit on a user message at index N) means the bubble
  // sticks around with new `content`, so we _must_ reset state or
  // it'll show "Working…" forever. The mountedRef guard handles
  // the cases where React _did_ tear us down between submit and
  // resolve.
  const confirmEdit = async (choice: BranchSummaryChoice) => {
    if (stage.kind !== "editChoosing") return
    if (userMessageIndex == null || !onEditSubmit) return
    const { text, displayText } = stage
    setStage({ kind: "busy", flow: "edit", displayText })
    try {
      await onEditSubmit({ userMessageIndex, text, displayText, choice })
    } finally {
      if (mountedRef.current) setStage({ kind: "idle" })
    }
  }

  const confirmRevert = async (choice: BranchSummaryChoice) => {
    if (userMessageIndex == null || !onRevertSubmit) return
    setStage({ kind: "busy", flow: "revert" })
    try {
      await onRevertSubmit({ userMessageIndex, choice })
    } finally {
      if (mountedRef.current) setStage({ kind: "idle" })
    }
  }

  // Legacy entries (pre-displayText) carry images via the separate
  // `images` array and don't have a `@blob:` token in their content.
  // For those, render inline thumbnails the old way so the message
  // doesn't lose its images.
  const hasInlineBlobToken =
    typeof content === "string" && content.includes("@blob:")
  const legacyImages =
    images && images.length > 0 && !hasInlineBlobToken ? images : null

  const canEdit = userMessageIndex != null && !!onEditSubmit
  const canRevert = userMessageIndex != null && !!onRevertSubmit
  const editing = stage.kind === "editing"
  const showingPicker =
    stage.kind === "editChoosing" || stage.kind === "revertChoosing"
  const busy = stage.kind === "busy"
  // Apply the collapsed-view max-height *eagerly*, without waiting for
  // the resize-observer to confirm there's overflow. The Composer
  // mounts CodeMirror inside a `useEffect`, which fires after this
  // component's `useLayoutEffect` runs — so our initial measurement
  // always sees an empty host and reports `overflows=false`. The
  // bubble then paints full-size, CM inserts its content, the RO
  // fires, we flip `overflows` true, and the bubble *snaps* short on
  // the next paint. Visible flicker on every long paste.
  //
  // RO callbacks do fire before the next paint inside their own
  // frame, but only after CM has already triggered a layout pass
  // we've already painted in response to. Reading layout
  // "synchronously" can't help us here — the layout we'd be reading
  // is the *empty* one from before CM mounted.
  //
  // So: clip preemptively. Short messages are smaller than the cap
  // anyway (max-height is a no-op), long messages start clipped on
  // the first paint. The RO is still wired up so `overflows` becomes
  // accurate and drives the chevron + footer affordances.
  const collapsedView = !expanded && !editing && !showingPicker && !busy
  const clipped = collapsedView
  const showExpandChevron = collapsedView && overflows
  const showCollapseFooter =
    expanded && !editing && !showingPicker && !busy && overflows

  // While the summary picker (or its busy follow-up) is up after an
  // edit, the read-only preview bubble should reflect the text the
  // user just typed — not the original `content` prop, which hasn't
  // been replaced yet because the session only rebuilds once a
  // summary choice is confirmed. Without this the bubble shows the
  // *previous* message above the picker. The revert flow has no
  // edited text, so it falls back to `content`.
  const previewContent =
    stage.kind === "editChoosing"
      ? stage.displayText
      : stage.kind === "busy" && stage.flow === "edit"
        ? stage.displayText
        : content

  // React `key` on Composer forces a full unmount/remount when we
  // flip in/out of edit mode. The Composer reads `readOnly` once at
  // mount (it's baked into the CodeMirror extension set) so a prop
  // change alone wouldn't rebuild the editor. Keying on
  // `previewContent` (not `content`) also remounts the read-only
  // bubble when we swap in the edited text for the picker preview.
  const composerInstanceKey = `user-msg-${editing ? "edit" : "view"}-${previewContent.length}-${previewContent.slice(0, 32)}`

  return (
    <div className="group/msg py-1">
      <div
        ref={bubbleRef}
        onClick={handleBubbleClick}
        className={cn(
          // `overflow-hidden` is what actually makes the bubble round.
          // Without it, `rounded-md` only curves the bubble's own
          // background + border, but children (CodeMirror lines,
          // image pill widgets, the gradient-fade chevron strip) all
          // paint into a square clip box that bleeds over the curved
          // corners. Most visible when the message is just a pasted
          // image — the embedded preview ran right up to a sharp
          // corner inside a clearly-rounded chip.
          "group w-full overflow-hidden rounded-md border border-border bg-accent text-accent-foreground",
        )}
        style={{
          boxShadow: "0 1px 2px rgba(0, 0, 0, 0.03)",
        }}
      >
        <div
          className="relative overflow-hidden"
          style={clipped ? { maxHeight: COLLAPSED_MAX_HEIGHT } : undefined}
        >
          <div ref={innerRef} className="user-message-body">
            <Composer
              key={composerInstanceKey}
              composerKey={composerInstanceKey}
              readOnly={!editing}
              // Stay chromeless even when editable so the live editor
              // inherits the bubble's `bg-accent` instead of stamping
              // a `bg-card` rectangle on top of it.
              embedded
              // `previewContent` is the original `content` except
              // while the post-edit picker is up, when it's the
              // just-edited text so the preview matches what's about
              // to be sent.
              initialText={editing ? content : previewContent}
              files={files}
              placeholder="Edit and press Enter \u2192 pick summary"
              onSubmit={editing ? handleComposerSubmit : NOOP_SUBMIT}
              // Pre-select the whole bubble on edit-mount so the
              // first keystroke replaces it — it's a clear visual
              // cue that you're now editing this message.
              selectAllOnMount={editing}
            />
            {legacyImages ? (
              <div className="mt-2 flex flex-wrap gap-2 px-3 pb-2">
                {legacyImages.map((ref, i) => (
                  <UserMessageImage
                    key={`${ref.blobId}-${i}`}
                    blobId={ref.blobId}
                    mimeType={ref.mimeType}
                  />
                ))}
              </div>
            ) : null}
            {showingPicker || busy ? (
              // The embedded variant of BranchSummaryPicker drops
              // its own chrome entirely (no header, no footer, no
              // border, no surface fill) so it reads as a list of
              // rows hanging directly off the bubble. The picker
              // itself paints the selected row — everything else
              // shares the bubble's `bg-accent`. No extra wrapping
              // div: nesting it any deeper just brings back the
              // "too many surfaces" feel we just removed.
              <BranchSummaryPicker
                variant="embedded"
                actionLabel={
                  (stage.kind === "editChoosing" ||
                    (stage.kind === "busy" && stage.flow === "edit"))
                    ? "branch + send edited message"
                    : "branch + drop text into composer"
                }
                busy={busy}
                onConfirm={choice => {
                  if (stage.kind === "editChoosing") void confirmEdit(choice)
                  else if (stage.kind === "revertChoosing")
                    void confirmRevert(choice)
                }}
                onCancel={() => setStage({ kind: "idle" })}
              />
            ) : null}
          </div>
          {showExpandChevron ? (
            <button
              type="button"
              onClick={e => {
                e.stopPropagation()
                setExpanded(true)
              }}
              aria-label="Expand message"
              className={cn(
                "absolute inset-x-0 bottom-0 flex h-10 items-end justify-center pb-1.5",
                "bg-gradient-to-t from-accent via-accent/85 to-transparent",
                "text-muted-foreground hover:text-foreground",
              )}
            >
              <ChevronDown className="h-4 w-4" />
            </button>
          ) : null}
        </div>
        {showCollapseFooter ? (
          <button
            type="button"
            onClick={e => {
              e.stopPropagation()
              setExpanded(false)
            }}
            aria-label="Collapse message"
            className={cn(
              "flex w-full items-center justify-center gap-1 border-t border-border/60 py-1",
              "text-sm text-muted-foreground hover:text-foreground",
            )}
          >
            <ChevronUp className="h-4 w-4" />
          </button>
        ) : null}
      </div>
      <div className="relative flex h-2 justify-end">
        <div className="absolute right-0 top-0 flex items-center gap-0.5 opacity-0 group-hover/msg:opacity-100">
          {editing || showingPicker ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={e => {
                e.stopPropagation()
                setStage({ kind: "idle" })
              }}
              className="size-7 rounded text-muted-foreground hover:bg-transparent hover:text-foreground"
              aria-label="Cancel (Esc)"
            >
              <XIcon className="size-4" strokeWidth={1.8} />
            </Button>
          ) : (
            <>
              {canRevert && (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={handleRevert}
                  className="size-7 rounded text-muted-foreground hover:bg-transparent hover:text-foreground"
                  aria-label="Revert to this message"
                >
                  <RotateCcwIcon className="size-4" strokeWidth={1.8} />
                </Button>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={handleCopy}
                className="size-7 rounded text-muted-foreground hover:bg-transparent hover:text-foreground"
                aria-label="Copy"
              >
                {copied ? (
                  <CheckIcon className="size-4" strokeWidth={1.8} />
                ) : (
                  <CopyIcon className="size-4" strokeWidth={1.8} />
                )}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// Composer requires an onSubmit prop; in read-only mode the keymap is
// disabled so this never fires. Hoisted to a module constant so the
// reference stays stable across renders.
const NOOP_SUBMIT = () => {}

