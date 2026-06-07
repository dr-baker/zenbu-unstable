import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { useDb, useRpc } from "@zenbujs/core/react"
import { cn } from "@/lib/utils"
import { ensureRowInView } from "@/lib/ensure-row-in-view"
import { useHoverIntent } from "@/lib/hooks/use-hover-intent"
import { openArchiveWorktreeDialog } from "@/lib/archive-worktree-dialog-store"

/**
 * `/worktree-handoff` panel — one git operation per run, with a
 * keyboard-driven follow-up to archive the worktree.
 *
 * Flow (all stages share the same picker shell so the panel
 * doesn't layout-shift when an operation kicks off):
 *
 *   pickTarget    — list of materialized worktree scopes. ↵ picks
 *                   one. Worktrees that aren't opened as scopes
 *                   yet are filtered out (use the sidebar to open
 *                   them first).
 *   askCommit     — only when the source has uncommitted changes.
 *                   Text input for the commit message; ↵ commits
 *                   and continues to inspect.
 *   working       — inspect + rebase/FF. Rendered as a status bar
 *                   underneath the picker (rather than as its own
 *                   view) so the panel keeps the same height.
 *   doneRebase    — after a successful rebase. "Test, then re-run
 *                   to land." Esc to close.
 *   askComplete   — after a successful FF. "Archive `<branch>`?"
 *                   ↵ yes opens the shared Archive-worktree
 *                   confirmation dialog (same one the command
 *                   palette / sidebar use) and closes the panel.
 *                   esc closes.
 *
 * Conflict during rebase: not a stage. The main side has already
 * dropped the prompt into the composer; we call
 * `onConflictHandedToComposer` and the panel closes immediately.
 */

type InspectResult = Awaited<
  ReturnType<
    ReturnType<typeof useRpc>["app"]["gitHandoff"]["inspect"]
  >
>

export type WorktreeHandoffSelectorProps = {
  /** Chat id — used as composerId for the conflict-prompt event. */
  chatId: string
  /** Current chat's scope (the source of the handoff). */
  sourceScopeId: string
  onCancel: () => void
  /** User dismissed a terminal view (done / askComplete:no /
   * archive handed off to the dialog). Close the panel. */
  onClose: () => void
  /** Conflict prompt was just emitted into the composer. Close
   * the panel immediately so the composer takes focus. */
  onConflictHandedToComposer: () => void
}

type Candidate = {
  scopeId: string
  worktreePath: string
  branch: string | null
  isMainWorktree: boolean
}

type Stage =
  | { kind: "pickTarget" }
  | {
      kind: "askCommit"
      target: Candidate
      dirtyFileCount: number
    }
  | { kind: "working"; label: string; target: Candidate }
  | {
      kind: "doneRebase"
      target: Candidate
      rebasedCommits: number
      reason: "behind" | "diverged"
    }
  | {
      kind: "askComplete"
      target: Candidate
      landedCommits: number
      sourceBranch: string
      cursor: number
    }

export function WorktreeHandoffSelector({
  chatId,
  sourceScopeId,
  onCancel,
  onClose,
  onConflictHandedToComposer,
}: WorktreeHandoffSelectorProps) {
  const rpc = useRpc()
  const sourceScope = useDb(root => root.app.scopes[sourceScopeId])
  const repo = useDb(root =>
    sourceScope?.repoId ? root.app.repos[sourceScope.repoId] : undefined,
  )
  const allScopes = useDb(root => root.app.scopes)

  // Candidates = worktrees in the same repo that already have a
  // materialized scope in this workspace. Worktrees without a
  // scope are filtered out entirely — they can't be addressed by
  // the handoff RPCs anyway, and showing them with a "not opened"
  // hint was just noise.
  const candidates = useMemo<Candidate[]>(() => {
    if (!repo || !sourceScope) return []
    const out: Candidate[] = []
    for (const w of repo.worktrees) {
      if (w.path === sourceScope.directory) continue
      // Match the sidebar's visibility filter: skip archived
      // scopes. Otherwise the picker shows worktrees the user
      // has shelved (and doesn't see in the sidebar), which is
      // confusing.
      const existing = Object.values(allScopes).find(
        s =>
          s.workspaceId === sourceScope.workspaceId &&
          s.directory === w.path &&
          !s.archived,
      )
      if (!existing) continue
      out.push({
        scopeId: existing.id,
        worktreePath: w.path,
        branch: w.branch,
        isMainWorktree: w.path === repo.mainWorktreePath,
      })
    }
    return out
  }, [repo, sourceScope, allScopes])

  const [stage, setStage] = useState<Stage>({ kind: "pickTarget" })
  const [cursor, setCursor] = useState(0)
  const hover = useHoverIntent()
  const [error, setError] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState("")
  const [hasFocus, setHasFocus] = useState(true)

  useEffect(() => {
    if (cursor >= candidates.length) {
      setCursor(Math.max(0, candidates.length - 1))
    }
  }, [candidates.length, cursor])

  const containerRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const commitInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    if (stage.kind === "askCommit") {
      commitInputRef.current?.focus()
    } else {
      containerRef.current?.focus()
    }
  }, [stage.kind])
  useLayoutEffect(() => {
    if (stage.kind !== "pickTarget") return
    const listEl = listRef.current
    if (!listEl) return
    const row = listEl.querySelector<HTMLElement>(
      `[data-row-index="${cursor}"]`,
    )
    if (row) ensureRowInView(listEl, row)
  }, [cursor, stage.kind])

  const cannotProceedReason: string | null = !sourceScope
    ? "Scope not found."
    : !sourceScope.repoId
      ? "This chat's working directory is not a git repository."
      : !repo
        ? "Repo metadata still syncing — try again in a moment."
        : candidates.length === 0
          ? "No other open worktrees in this repo. Create one with /workspace, or open an existing one from the sidebar."
          : null

  // ---- stage transitions ----

  const startForTarget = async (target: Candidate) => {
    setError(null)
    // We need an inspect upfront because:
    //   1. it tells us if source is dirty (→ askCommit step), and
    //   2. it tells us which operation to run (rebase vs FF).
    setStage({ kind: "working", label: "Working…", target })
    let inspect: InspectResult
    try {
      inspect = await rpc.app.gitHandoff.inspect({
        sourceScopeId,
        targetScopeId: target.scopeId,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage({ kind: "pickTarget" })
      return
    }

    if (inspect.source.dirty) {
      setStage({
        kind: "askCommit",
        target,
        dirtyFileCount: inspect.source.dirtyFileCount,
      })
      return
    }

    await runOperation(target, inspect)
  }

  const submitCommit = async (s: Extract<Stage, { kind: "askCommit" }>) => {
    setError(null)
    setStage({ kind: "working", label: "Working…", target: s.target })
    try {
      const res = await rpc.app.gitHandoff.commitSourceChanges({
        sourceScopeId,
        message: commitMessage,
      })
      if (!res.ok) {
        setError(res.error)
        setStage({
          kind: "askCommit",
          target: s.target,
          dirtyFileCount: s.dirtyFileCount,
        })
        return
      }
      // Re-inspect post-commit so we have an accurate view of
      // sourceAhead / targetAhead (the new commit shifts the
      // counts).
      setStage({
        kind: "working",
        label: "Working…",
        target: s.target,
      })
      const inspect = await rpc.app.gitHandoff.inspect({
        sourceScopeId,
        targetScopeId: s.target.scopeId,
      })
      await runOperation(s.target, inspect)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage({
        kind: "askCommit",
        target: s.target,
        dirtyFileCount: s.dirtyFileCount,
      })
    }
  }

  const runOperation = async (
    target: Candidate,
    inspect: InspectResult,
  ) => {
    const action = inspect.recommendedAction
    if (action.kind === "noop") {
      setError(
        `Nothing to do: \`${inspect.target.branch}\` is already in sync with \`${inspect.source.branch}\`.`,
      )
      setStage({ kind: "pickTarget" })
      return
    }

    if (action.kind === "rebase") {
      setStage({
        kind: "working",
        label: "Rebasing…",
        target,
      })
      try {
        const res = await rpc.app.gitHandoff.rebaseSourceOntoTarget({
          sourceScopeId,
          targetScopeId: target.scopeId,
          chatId,
        })
        if (!res.ok && res.reason === "conflicts") {
          onConflictHandedToComposer()
          return
        }
        if (!res.ok) {
          setError(res.error)
          setStage({ kind: "pickTarget" })
          return
        }
        setStage({
          kind: "doneRebase",
          target,
          rebasedCommits: res.rebasedCommits,
          reason: action.reason,
        })
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err))
        setStage({ kind: "pickTarget" })
      }
      return
    }

    // action.kind === "fastForward"
    setStage({
      kind: "working",
      label: "Landing…",
      target,
    })
    try {
      const res = await rpc.app.gitHandoff.fastForwardTargetToSource({
        sourceScopeId,
        targetScopeId: target.scopeId,
      })
      if (!res.ok) {
        setError(res.error)
        setStage({ kind: "pickTarget" })
        return
      }
      setStage({
        kind: "askComplete",
        target,
        landedCommits: res.landedCommits,
        sourceBranch: inspect.source.branch,
        cursor: 0,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setStage({ kind: "pickTarget" })
    }
  }

  const acceptComplete = (
    _s: Extract<Stage, { kind: "askComplete" }>,
  ) => {
    // Hand off to the shared Archive-worktree confirmation dialog
    // (the same one the command palette and sidebar overflow menu
    // open). It owns the "also delete the folder" choice and the
    // actual archive mutation, so the handoff panel just opens it
    // and gets out of the way.
    openArchiveWorktreeDialog(sourceScopeId)
    onClose()
  }

  // ---- keyboard ----

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (stage.kind === "pickTarget") return onPickTargetKey(e)
    if (stage.kind === "askCommit") return onAskCommitKey(e, stage)
    if (stage.kind === "working") {
      if (e.key === "Escape") {
        e.preventDefault()
        onCancel()
      }
      return
    }
    if (stage.kind === "doneRebase") {
      if (e.key === "Escape" || e.key === "Enter") {
        e.preventDefault()
        onClose()
      }
      return
    }
    // askComplete
    onAskCompleteKey(e, stage)
  }

  const onAskCompleteKey = (
    e: KeyboardEvent<HTMLDivElement>,
    s: Extract<Stage, { kind: "askComplete" }>,
  ) => {
    const n = 2
    if (e.key === "Escape") {
      e.preventDefault()
      onClose()
      return
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      hover.resetToKeyboard()
      setStage({ ...s, cursor: (s.cursor - 1 + n) % n })
      return
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      hover.resetToKeyboard()
      setStage({ ...s, cursor: (s.cursor + 1) % n })
      return
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      if (s.cursor === 0) acceptComplete(s)
      else onClose()
    }
  }

  const onPickTargetKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      hover.resetToKeyboard()
      setCursor(c => Math.max(0, c - 1))
      return
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      hover.resetToKeyboard()
      setCursor(c => Math.min(candidates.length - 1, c + 1))
      return
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      const pick = candidates[cursor]
      if (!pick) return
      void startForTarget(pick)
    }
  }

  const onAskCommitKey = (
    e: KeyboardEvent<HTMLDivElement>,
    s: Extract<Stage, { kind: "askCommit" }>,
  ) => {
    if (e.key === "Escape") {
      e.preventDefault()
      setStage({ kind: "pickTarget" })
      setCommitMessage("")
      return
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void submitCommit(s)
    }
  }

  // ---- render ----

  const showPickerShell =
    stage.kind === "pickTarget" ||
    stage.kind === "askCommit" ||
    stage.kind === "working"

  return (
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
        className={cn(
          "flex max-h-[60vh] min-h-0 flex-col overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-lg outline-none",
          hasFocus
            ? "border-primary/40 ring-1 ring-primary/30"
            : "border-border",
        )}
      >
        {cannotProceedReason ? (
          <FixedStateMessage
            title="Worktree handoff"
            body={cannotProceedReason}
            onCancel={onCancel}
          />
        ) : showPickerShell ? (
          <PickerShell
            candidates={candidates}
            cursor={cursor}
            onCursor={i => {
              if (hover.isActive()) setCursor(i)
            }}
            onPick={i => {
              setCursor(i)
              const c = candidates[i]
              if (c && stage.kind === "pickTarget") {
                void startForTarget(c)
              }
            }}
            error={error}
            listRef={listRef}
            interactive={stage.kind === "pickTarget"}
            footer={
              stage.kind === "askCommit" ? (
                <CommitFooter
                  inputRef={commitInputRef}
                  message={commitMessage}
                  onChange={setCommitMessage}
                />
              ) : stage.kind === "working" ? (
                <StatusFooter label={stage.label} />
              ) : null
            }
          />
        ) : stage.kind === "doneRebase" ? (
          <DoneRebaseView
            target={stage.target}
            rebasedCommits={stage.rebasedCommits}
            reason={stage.reason}
            onClose={onClose}
          />
        ) : (
          <AskCompleteView
            sourceBranch={stage.sourceBranch}
            targetBranch={stage.target.branch ?? "target"}
            landedCommits={stage.landedCommits}
            cursor={stage.cursor}
            onCursor={i => {
              if (hover.isActive()) setStage({ ...stage, cursor: i })
            }}
            onPick={i => {
              if (i === 0) acceptComplete(stage)
              else onClose()
            }}
            error={error}
          />
        )}
      </div>
    </div>
  )
}

// ---- sub-views ----

function PickerShell({
  candidates,
  cursor,
  onCursor,
  onPick,
  error,
  listRef,
  interactive,
  footer,
}: {
  candidates: Candidate[]
  cursor: number
  onCursor: (i: number) => void
  onPick: (i: number) => void
  error: string | null
  listRef: React.RefObject<HTMLDivElement | null>
  interactive: boolean
  footer: React.ReactNode
}) {
  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[12px] font-medium text-foreground">
          Pick a target worktree
        </div>
      </div>
      <div
        ref={listRef}
        className={cn(
          "min-h-0 flex-1 overflow-auto px-1 py-1 text-[12px]",
          !interactive && "opacity-60",
        )}
      >
        {candidates.map((c, i) => (
          <div
            key={c.worktreePath}
            data-row-index={i}
            onMouseEnter={() => interactive && onCursor(i)}
            onClick={() => interactive && onPick(i)}
            className={cn(
              "flex items-baseline gap-2 rounded-sm px-2 py-1",
              i === cursor
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "text-foreground hover:bg-accent/40",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "w-3 shrink-0 text-center text-[11px]",
                i === cursor ? "text-primary" : "text-transparent",
              )}
            >
              ›
            </span>
            <span className="flex-1 truncate">
              <span className="text-foreground">
                {c.branch ?? "(detached)"}
              </span>
              {c.isMainWorktree && (
                <span className="ml-1 text-[11px] font-medium text-muted-foreground">
                  main
                </span>
              )}
              <span className="ml-2 text-muted-foreground">
                {c.worktreePath}
              </span>
            </span>
          </div>
        ))}
      </div>
      {footer}
      {error && (
        <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[12px] text-destructive whitespace-pre-wrap">
          {error}
        </div>
      )}
    </>
  )
}

function CommitFooter({
  inputRef,
  message,
  onChange,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>
  message: string
  onChange: (s: string) => void
}) {
  return (
    <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-2 flex flex-col gap-1.5">
      <div className="text-[12px] font-medium text-foreground">
        Commit pending changes
      </div>
      <input
        ref={inputRef}
        type="text"
        value={message}
        onChange={e => onChange(e.target.value)}
        placeholder="(auto-generated commit)"
        className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-[12px] text-foreground placeholder:text-muted-foreground/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      />
    </div>
  )
}

function StatusFooter({ label }: { label: string }) {
  return (
    <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1.5">
      <span className="text-shimmer text-[12px]">{label}</span>
    </div>
  )
}

function DoneRebaseView({
  target,
  rebasedCommits,
  reason,
  onClose,
}: {
  target: Candidate
  rebasedCommits: number
  reason: "behind" | "diverged"
  onClose: () => void
}) {
  const reasonNote =
    reason === "diverged"
      ? `Your branch had diverged from \`${target.branch}\` — it's been rebased on top.`
      : `Your branch was behind \`${target.branch}\` — it's been rebased on top.`
  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[12px] font-medium text-foreground">
          Rebased {rebasedCommits} commit{rebasedCommits === 1 ? "" : "s"}{" "}
          onto {target.branch}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 flex flex-col gap-2">
        <div className="text-[12px] text-foreground">{reasonNote}</div>
        <div className="text-[12px] text-muted-foreground">
          Test it, then re-run <code>/worktree-handoff</code> to land the
          commits on <code>{target.branch}</code>.
        </div>
      </div>
      <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground flex justify-end">
        <button
          type="button"
          onClick={onClose}
          className="font-medium text-foreground hover:text-foreground"
        >
          close ⏎
        </button>
      </div>
    </>
  )
}

function AskCompleteView({
  sourceBranch,
  targetBranch,
  landedCommits,
  cursor,
  onCursor,
  onPick,
  error,
}: {
  sourceBranch: string
  targetBranch: string
  landedCommits: number
  cursor: number
  onCursor: (i: number) => void
  onPick: (i: number) => void
  error: string | null
}) {
  const options = [
    { title: `Archive \`${sourceBranch}\`` },
    { title: "Just close" },
  ]
  return (
    <OptionPickerView
      title={`Applied ${landedCommits} commit${landedCommits === 1 ? "" : "s"} to ${targetBranch}`}
      options={options}
      cursor={cursor}
      onCursor={onCursor}
      onPick={onPick}
      error={error}
    />
  )
}

/**
 * Shared chrome for the yes/no follow-up (askComplete). Same
 * shape as the picker — header strip, a list of
 * keyboard-selectable option rows, optional error bar — so the
 * stage reads as a sibling of pickTarget rather than an ad-hoc
 * confirmation dialog. Canonical reference: BranchSummaryPicker
 * in `chat/lib/branch-summary-choice.tsx`.
 */
function OptionPickerView({
  title,
  options,
  cursor,
  onCursor,
  onPick,
  error,
}: {
  title: string
  options: Array<{ title: string; description?: string }>
  cursor: number
  onCursor: (i: number) => void
  onPick: (i: number) => void
  error: string | null
}) {
  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[12px] font-medium text-foreground">
          {title}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 py-1">
        {options.map((opt, i) => (
          <OptionRow
            key={i}
            title={opt.title}
            description={opt.description}
            selected={i === cursor}
            onHover={() => onCursor(i)}
            onClick={() => {
              onCursor(i)
              onPick(i)
            }}
          />
        ))}
      </div>
      {error && (
        <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[12px] text-destructive whitespace-pre-wrap">
          {error}
        </div>
      )}
    </>
  )
}

function OptionRow({
  title,
  description,
  selected,
  onHover,
  onClick,
}: {
  title: string
  description?: string
  selected: boolean
  onHover: () => void
  onClick: () => void
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
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium">{title}</div>
        {description ? (
          <div
            className={cn(
              "text-[11px]",
              selected
                ? "text-sidebar-accent-foreground/80"
                : "text-muted-foreground",
            )}
          >
            {description}
          </div>
        ) : null}
      </div>
    </div>
  )
}

function FixedStateMessage({
  title,
  body,
  onCancel,
}: {
  title: string
  body: string
  onCancel: () => void
}) {
  return (
    <>
      <div className="shrink-0 border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[12px] font-medium text-foreground">{title}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-3 py-3 text-[12px] text-foreground">
        {body}
      </div>
      <div className="shrink-0 border-t border-border bg-muted/30 px-3 py-1 text-[11px] text-muted-foreground flex justify-end">
        <button
          type="button"
          onClick={onCancel}
          className="hover:text-foreground"
        >
          close
        </button>
      </div>
    </>
  )
}

