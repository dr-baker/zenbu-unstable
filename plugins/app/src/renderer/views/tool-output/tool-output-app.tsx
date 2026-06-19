import { useLayoutEffect, useMemo, useRef } from "react"
import { useCollection, useDb, useViewArgs } from "@zenbujs/core/react"
import { useThemeSync } from "@/lib/theme"
import { collapseHomeDir, useHomeDir } from "@/lib/home-dir"
import { cn } from "@/lib/utils"
import {
  extractToolCallOutput,
  type ToolCallOutputState,
} from "../../../../../chat/src/renderer/components/chat/lib/extract-tool-call-output"

type ToolOutputArgs = {
  sessionId?: string
  toolCallId?: string
}

/**
 * Embed view that renders the full output of a single tool call in
 * a side pane. Opened from a chat tool-call card click via
 * `rpc.app.toolOutput.openOutput → openToolOutputInActivePane`.
 *
 * The pane is live: it subscribes to the session's eventLog
 * collection and re-folds on every new event, so streaming bash
 * output ticks here the same way it ticks in the inline preview.
 * When the user is following the tail (scroll position within 16px
 * of the bottom), we keep `scrollTop` pinned so new lines stay
 * visible \u2014 release the pin the moment they scroll up.
 *
 * Tool-agnostic on purpose: we render whatever
 * `extractToolCallOutput` exposes (`{ command, stdout, stderr,
 * status }`) plus a header. Bash gets a nice `Bash(<command>)`
 * header; other tools fall back to the tool name. Non-text
 * result shapes (e.g. an `edit` with structured details) get a
 * raw-JSON dump so the pane is never empty when there's *some*
 * payload.
 */
export function ToolOutputApp() {
  useThemeSync()
  const { sessionId, toolCallId } = useViewArgs<ToolOutputArgs>()

  if (!sessionId || !toolCallId) {
    return <Placeholder>No tool call selected.</Placeholder>
  }
  return (
    <ToolOutputPane
      key={`${sessionId}::${toolCallId}`}
      sessionId={sessionId}
      toolCallId={toolCallId}
    />
  )
}

function ToolOutputPane({
  sessionId,
  toolCallId,
}: {
  sessionId: string
  toolCallId: string
}) {
  const eventLogRef = useDb(root =>
    sessionId ? root.pi.sessions[sessionId]?.eventLog : undefined,
  )
  const { items: events } = useCollection(eventLogRef)
  const state = useMemo<ToolCallOutputState>(
    () => extractToolCallOutput(events, toolCallId),
    [events, toolCallId],
  )

  // `state.status == null` covers two cases that should both render
  // silently rather than flashing a "not found" placeholder:
  //   1. Transient first render — the zenbu collection subscription
  //      hasn't delivered its first snapshot yet, so `events` is
  //      `[]` and the fold returns null. This is what produced the
  //      one-frame flicker when clicking a bash card.
  //   2. The toolCallId really isn't in this session's event log
  //      (e.g. forked away). Rare, and a blank pane is a fine
  //      signal — the user already sees no header / no output.
  // In both cases, return the bare background container so the
  // chrome stays consistent and nothing jitters when state lands.
  if (state.status == null) {
    return (
      <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground" />
    )
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-background text-foreground">
      <Header state={state} />
      <OutputBody state={state} />
    </div>
  )
}

function Header({ state }: { state: ToolCallOutputState }) {
  const homeDir = useHomeDir()
  const title = useMemo(() => formatHeaderTitle(state, homeDir), [state, homeDir])
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-background px-3 text-[11.5px] text-muted-foreground">
      <span className="min-w-0 truncate font-mono">{title}</span>
      <span className="ml-auto shrink-0">
        <StatusPill status={state.status} />
      </span>
    </div>
  )
}

function StatusPill({ status }: { status: ToolCallOutputState["status"] }) {
  if (status == null) return null
  // `interrupted` reads as the user-cancel state (matches the
  // inline tool card's trailing "canceled" label) — distinct from
  // `failed` (red X for actual tool errors) and from `completed`
  // (which would lie since the tool didn't actually finish).
  const label =
    status === "running"
      ? "running"
      : status === "pending"
        ? "pending"
        : status === "failed"
          ? "failed"
          : status === "interrupted"
            ? "canceled"
            : "completed"
  const tone =
    status === "failed"
      ? "bg-red-500/15 text-red-600 dark:text-red-300"
      : status === "running" || status === "pending"
        ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
        : "bg-muted text-muted-foreground"
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
        tone,
      )}
    >
      {label}
    </span>
  )
}

/**
 * Output body: the monospace text dump. Auto-scrolls to the bottom
 * while the tool is still running and the user is at the tail.
 * Same anti-yank deadband (16px) the inline preview uses.
 */
function OutputBody({ state }: { state: ToolCallOutputState }) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const stickToBottomRef = useRef(true)

  const stdout = state.toolResponse?.stdout ?? ""
  const stderr = state.toolResponse?.stderr ?? ""
  const text = stdout || stderr
    ? `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`
    : ""
  const loading = state.status === "running" || state.status === "pending"

  // Pin to bottom on every text update while we're tailing.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight
    }
  }, [text])

  // Watch user scroll: pin holds while within 16px of the bottom,
  // releases on scroll-up.
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      stickToBottomRef.current = distance < 16
    }
    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [])

  if (!text) {
    if (loading) {
      return (
        <div className="flex flex-1 items-center justify-center text-[11.5px] text-muted-foreground">
          <span className="hg-shimmer inline-block h-3 w-32 rounded-sm bg-muted" />
        </div>
      )
    }
    // Completed with no recognizable text payload — fall back to a
    // raw-JSON dump so the pane is at least informative for tools
    // that don't expose `{ content: [{ text }] }`.
    if (state.rawOutput != null) {
      return (
        <div
          ref={scrollRef}
          className="min-h-0 flex-1 overflow-auto px-3 py-2"
        >
          <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] text-muted-foreground">
            {safeJson(state.rawOutput)}
          </pre>
        </div>
      )
    }
    return (
      <div className="flex flex-1 items-center justify-center text-[11.5px] text-muted-foreground">
        No output.
      </div>
    )
  }

  return (
    <div
      ref={scrollRef}
      className="min-h-0 flex-1 overflow-auto px-3 py-2"
    >
      <pre className="whitespace-pre-wrap break-all font-mono text-[11.5px] text-muted-foreground">
        {text}
      </pre>
    </div>
  )
}

function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center bg-background p-4 text-center text-[12px] text-muted-foreground">
      {children}
    </div>
  )
}

function formatHeaderTitle(
  state: ToolCallOutputState,
  homeDir: string | null,
): string {
  const name = state.toolName ?? "tool"
  if (name === "bash") {
    const args = (state.args ?? {}) as Record<string, unknown>
    const cmd = typeof args.command === "string" ? args.command : ""
    const shown = cmd ? collapseHomeDir(cmd, homeDir) : "\u2026"
    return `Bash(${shown})`
  }
  // Generic header for non-bash tools: just the name. Once we wire
  // more cards through, this can grow per-tool formatters.
  return name
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
