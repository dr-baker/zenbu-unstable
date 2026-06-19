import { useEffect, useMemo, useState } from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  XIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { HoverTip } from "@zenbu/ui/hover-tip"
import {
  clearChatInvariants,
  dismissInvariant,
  useChatInvariants,
  type InvariantError,
} from "./invariant-store"

/**
 * Devtool widget pinned to the top-right of the chat surface.
 *
 * Always rendered — even when there are zero errors — so the user
 * can rely on the same screen position to check status. With no
 * errors the collapsed pill is a small muted dot; on click the
 * panel confirms "no invariants firing". With errors it switches
 * to a destructive-tinted pill with a count and the expanded panel
 * lists each row with copy-to-clipboard + dismiss controls.
 *
 * Intentionally global (not gated on a dev flag): the underlying
 * bugs are infrequent and hard to reproduce on demand, so we want
 * the signal available in any session.
 */
export function InvariantOverlay({ chatId }: { chatId: string }) {
  const errors = useChatInvariants(chatId)
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="pointer-events-none absolute right-2 top-2 z-30 flex justify-end">
      {expanded ? (
        <ExpandedPanel
          chatId={chatId}
          errors={errors}
          onCollapse={() => setExpanded(false)}
        />
      ) : (
        <CollapsedPill
          count={errors.length}
          onExpand={() => setExpanded(true)}
        />
      )}
    </div>
  )
}

function CollapsedPill({
  count,
  onExpand,
}: {
  count: number
  onExpand: () => void
}) {
  if (count === 0) {
    return (
      <HoverTip label="No invariant errors. Click to confirm." setAriaLabel={false}>
        <button
          type="button"
          onClick={onExpand}
          aria-label="Invariant overlay (no errors)"
          className={cn(
            "pointer-events-auto flex items-center gap-1 rounded-full",
            "border border-border bg-background px-2 py-0.5",
            "text-[10px] font-medium text-muted-foreground shadow-sm",
            "hover:text-foreground transition-colors",
          )}
        >
          <CheckIcon className="h-3 w-3" />
          <span className="tabular-nums">0</span>
        </button>
      </HoverTip>
    )
  }
  return (
    <HoverTip
      label={`${count} invariant ${count === 1 ? "error" : "errors"}. Click to inspect.`}
      setAriaLabel={false}
    >
      <button
        type="button"
        onClick={onExpand}
        className={cn(
          "pointer-events-auto flex items-center gap-1.5 rounded-full",
          "border border-destructive/30 bg-destructive/15 px-2.5 py-1",
          "text-[11px] font-medium text-destructive shadow-sm",
          "hover:bg-destructive/25 transition-colors",
        )}
      >
        <AlertTriangleIcon className="h-3.5 w-3.5" />
        <span className="tabular-nums">{count}</span>
      </button>
    </HoverTip>
  )
}

function ExpandedPanel({
  chatId,
  errors,
  onCollapse,
}: {
  chatId: string
  errors: InvariantError[]
  onCollapse: () => void
}) {
  const empty = errors.length === 0
  return (
    <div
      className={cn(
        "pointer-events-auto flex w-[min(420px,calc(100vw-1.5rem))] flex-col overflow-hidden",
        "rounded-md border bg-popover text-popover-foreground shadow-lg",
        empty ? "border-border" : "border-destructive/30",
      )}
    >
      <header
        className={cn(
          "flex items-center justify-between gap-2 border-b border-border px-2.5 py-1.5",
          empty ? "bg-muted/40" : "bg-destructive/10",
        )}
      >
        <div
          className={cn(
            "flex items-center gap-1.5 text-[11px] font-medium",
            empty ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {empty ? (
            <CheckIcon className="h-3.5 w-3.5" />
          ) : (
            <AlertTriangleIcon className="h-3.5 w-3.5" />
          )}
          <span>
            {empty
              ? "No invariant errors"
              : `${errors.length} invariant ${errors.length === 1 ? "error" : "errors"}`}
          </span>
        </div>
        <div className="flex items-center gap-1">
          {!empty && (
            <>
              <CopyButton
                label="Copy all"
                value={serializeAll(errors)}
                ariaLabel="Copy all invariant errors as JSON"
              />
              <HoverTip label="Clear all errors for this chat" setAriaLabel={false}>
                <button
                  type="button"
                  onClick={() => clearChatInvariants(chatId)}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
                >
                  Clear
                </button>
              </HoverTip>
            </>
          )}
          <button
            type="button"
            onClick={onCollapse}
            aria-label="Collapse"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>
      {empty ? (
        <div className="px-3 py-4 text-center text-[11px] text-muted-foreground">
          All invariants are holding for this chat.
          <br />
          <span className="text-[10px] opacity-70">
            Violations will appear here as they're caught.
          </span>
        </div>
      ) : (
        <ul className="max-h-[60vh] divide-y divide-border overflow-auto">
          {errors.map(err => (
            <InvariantRow key={err.id} error={err} />
          ))}
        </ul>
      )}
    </div>
  )
}

function InvariantRow({ error }: { error: InvariantError }) {
  const serialized = useMemo(() => serializeOne(error), [error])
  const [showJson, setShowJson] = useState(false)
  return (
    <li className="flex flex-col gap-1 px-2.5 py-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-[10px] uppercase tracking-wide text-destructive">
              {error.kind}
            </span>
            <span className="text-[10px] tabular-nums text-muted-foreground">
              {formatTime(error.timestamp)}
            </span>
          </div>
          <div className="mt-0.5 text-[11px] leading-tight text-foreground">
            {error.message}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton
            value={serialized}
            ariaLabel={`Copy ${error.kind} as JSON`}
          />
          <button
            type="button"
            onClick={() => dismissInvariant(error.id)}
            aria-label="Dismiss"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
          </button>
        </div>
      </div>
      <button
        type="button"
        onClick={() => setShowJson(v => !v)}
        className="self-start text-[10px] text-muted-foreground hover:text-foreground"
      >
        {showJson ? "Hide details" : "Show details"}
      </button>
      {showJson && (
        <pre className="max-h-48 overflow-auto rounded bg-muted/60 px-2 py-1.5 font-mono text-[10px] leading-tight text-foreground">
          {serialized}
        </pre>
      )}
    </li>
  )
}

/**
 * Small icon button with a copy affordance. Shows "Copied" briefly on
 * success so the user has feedback that the click took effect.
 */
function CopyButton({
  value,
  ariaLabel,
  label,
}: {
  value: string
  ariaLabel: string
  label?: string
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(t)
  }, [copied])

  async function onClick() {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
    } catch (err) {
      console.error("[invariant-overlay] copy failed:", err)
    }
  }

  if (label) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-label={ariaLabel}
        className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <CopyIcon className="h-3 w-3" />
        {copied ? "Copied" : label}
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={copied ? "Copied!" : "Copy as JSON"}
      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
    >
      <CopyIcon className="h-3 w-3" />
    </button>
  )
}

function serializeOne(err: InvariantError): string {
  return JSON.stringify(
    {
      id: err.id,
      kind: err.kind,
      message: err.message,
      timestamp: err.timestamp,
      data: err.data,
    },
    null,
    2,
  )
}

function serializeAll(errors: InvariantError[]): string {
  return JSON.stringify(
    errors.map(e => ({
      id: e.id,
      kind: e.kind,
      message: e.message,
      timestamp: e.timestamp,
      data: e.data,
    })),
    null,
    2,
  )
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const hh = String(d.getHours()).padStart(2, "0")
  const mm = String(d.getMinutes()).padStart(2, "0")
  const ss = String(d.getSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}
