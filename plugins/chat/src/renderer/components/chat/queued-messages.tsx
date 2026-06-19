import { useContext, useEffect, useRef, useState } from "react"
import { useDb, useRpc } from "@zenbujs/core/react"
import {
  PencilIcon,
  Trash2Icon,
  ShipWheelIcon,
  ArrowUpIcon,
  ChevronRightIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Composer } from "../composer/composer"
import type { ComposerSubmitPayload } from "../composer/composer"
import { FileIndexContext } from "./lib/file-index-context"

type QueueKind = "steer" | "followUp"

type Row = {
  id: string
  text: string
  kind: QueueKind
  createdAt: number
}

export function QueuedMessages({ sessionId }: { sessionId: string }) {
  const rpc = useRpc()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(true)

  const draft = useDb(
    root => (root.pi.sessions[sessionId]?.queueDraft ?? []) as Row[],
  )

  if (draft.length === 0) return null

  const steerCount = draft.filter(r => r.kind === "steer").length
  const followCount = draft.length - steerCount
  // Only show per-row kind badges when the queue is actually mixed.
  // A homogeneous queue is unambiguous — the badge would just be
  // visual noise on every row.
  const showKindBadges = steerCount > 0 && followCount > 0

  // Display order: steers first (they fire first), then follow-ups.
  // Within each kind, keep insertion order (= delivery order).
  const ordered = [
    ...draft.filter(r => r.kind === "steer"),
    ...draft.filter(r => r.kind === "followUp"),
  ]

  const handleDelete = (id: string) => {
    rpc.pi.sessions
      .deleteQueued({ sessionId, id })
      .catch(err => console.error("[queue] delete failed", err))
  }

  const handleSave = (id: string, payload: ComposerSubmitPayload) => {
    rpc.pi.sessions
      .editQueued({
        sessionId,
        id,
        text: payload.displayText,
        imageRefs: payload.imageRefs,
      })
      .catch(err => console.error("[queue] edit failed", err))
    setEditingId(null)
  }

  const handleFlipKind = (row: Row) => {
    const nextKind: QueueKind = row.kind === "steer" ? "followUp" : "steer"
    rpc.pi.sessions
      .editQueued({ sessionId, id: row.id, text: row.text, kind: nextKind })
      .catch(err => console.error("[queue] flip-kind failed", err))
  }

  const handleSendNow = (id: string) => {
    rpc.pi.sessions
      .sendQueuedNow({ sessionId, id })
      .catch(err => console.error("[queue] send-now failed", err))
  }

  return (
    <div className="mx-auto w-full max-w-[919px] px-2">
      <div className="overflow-hidden rounded-md border border-border bg-card/85 text-card-foreground">
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          aria-label={expanded ? "Collapse queued" : "Expand queued"}
          className="flex w-full items-center px-2 py-1 text-muted-foreground hover:text-foreground"
        >
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 transition-transform",
              expanded && "rotate-90",
            )}
          />
        </button>
        {expanded && (
          <div className="flex flex-col border-t border-border/60">
            {ordered.map(row => (
              <QueuedRow
                key={row.id}
                row={row}
                editing={editingId === row.id}
                showKindBadge={showKindBadges}
                onStartEdit={() => setEditingId(row.id)}
                onCancelEdit={() => setEditingId(null)}
                onSave={payload => handleSave(row.id, payload)}
                onDelete={() => handleDelete(row.id)}
                onFlipKind={() => handleFlipKind(row)}
                onSendNow={() => handleSendNow(row.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function QueuedRow({
  row,
  editing,
  showKindBadge,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
  onFlipKind,
  onSendNow,
}: {
  row: Row
  editing: boolean
  showKindBadge: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (payload: ComposerSubmitPayload) => void
  onDelete: () => void
  onFlipKind: () => void
  onSendNow: () => void
}) {
  const fileProvider = useContext(FileIndexContext)
  // Focus boundary for the auto-cancel-on-blur effect below.
  const rowRef = useRef<HTMLDivElement>(null)

  // Mirror the user-message bubble's edit affordance: leaving the row
  // exits edit mode without saving. The Composer + its action buttons
  // all live under `rowRef`, so focusout whose `relatedTarget` is
  // outside the row means the user clicked away. We deliberately
  // ignore focusout that lands back inside the row so clicking the
  // Cancel button doesn't double-fire the exit.
  useEffect(() => {
    if (!editing) return
    const el = rowRef.current
    if (!el) return
    const handleFocusOut = (e: FocusEvent) => {
      const next = e.relatedTarget as Node | null
      if (next && el.contains(next)) return
      onCancelEdit()
    }
    el.addEventListener("focusout", handleFocusOut)
    return () => el.removeEventListener("focusout", handleFocusOut)
  }, [editing, onCancelEdit])

  const kindBadge = !showKindBadge ? null : row.kind === "steer" ? (
    <span className="rounded-sm border border-amber-500/40 bg-amber-500/10 px-1 text-[9px] uppercase tracking-wide text-amber-600 dark:text-amber-300">
      S
    </span>
  ) : (
    <span className="rounded-sm border border-sky-500/40 bg-sky-500/10 px-1 text-[9px] uppercase tracking-wide text-sky-600 dark:text-sky-300">
      F
    </span>
  )

  if (editing) {
    return (
      <div
        ref={rowRef}
        className="group flex items-start gap-2 px-2 py-1.5 text-sm"
        onKeyDown={e => {
          if (e.key === "Escape") {
            e.preventDefault()
            onCancelEdit()
          }
        }}
      >
        {kindBadge && <div className="mt-1.5">{kindBadge}</div>}
        <div className="min-w-0 flex-1">
          <Composer
            key={`queued-edit-${row.id}`}
            composerKey={`queued-edit-${row.id}`}
            // Chromeless: inherits the row's bg-card/85 surface
            // instead of stamping its own bg-card rectangle on top.
            embedded
            initialText={row.text}
            fileProvider={fileProvider}
            placeholder="Edit and press Enter to save"
            onSubmit={onSave}
            // Highlight the existing text so the first keystroke
            // replaces it — makes "you're editing" obvious.
            selectAllOnMount
          />
        </div>
        <div className="mt-0.5 flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onCancelEdit}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Cancel (Esc)"
          >
            <XIcon className="size-3.5" />
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={rowRef}
      className={cn(
        "group flex items-center gap-2 px-3 py-1.5 text-sm",
      )}
    >
      {kindBadge}
      <div className="min-w-0 flex-1 truncate text-foreground/90">
        {row.text || (
          <span className="italic text-muted-foreground">(empty)</span>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
        <button
          type="button"
          onClick={onSendNow}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Send now (interrupt current turn)"
        >
          <ArrowUpIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onFlipKind}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={
            row.kind === "steer"
              ? "Demote to follow-up"
              : "Promote to steer"
          }
        >
          <ShipWheelIcon
            className={cn(
              "size-3.5",
              row.kind === "steer" &&
                "text-amber-600 dark:text-amber-300",
            )}
          />
        </button>
        <button
          type="button"
          onClick={onStartEdit}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label="Edit"
        >
          <PencilIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-destructive"
          aria-label="Remove"
        >
          <Trash2Icon className="size-3.5" />
        </button>
      </div>
    </div>
  )
}
