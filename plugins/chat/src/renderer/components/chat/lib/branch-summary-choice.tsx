import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react"
import { Composer } from "../../composer/composer"
import { cn } from "@/lib/utils"
import { useHoverIntent } from "@/lib/hooks/use-hover-intent"

/**
 * What the user chose for the abandoned-branch summary when
 * navigating the session tree. Shared between every callsite that
 * branches the session (`/tree`, the user-message edit-to-branch
 * flow, the user-message revert flow) so they all feed the same
 * shape into `rpc.pi.sessions.navigateTree`.
 */
export type BranchSummaryChoice =
  | { kind: "none" }
  | { kind: "default" }
  | { kind: "custom"; customInstructions: string }

export const SUMMARY_OPTIONS: ReadonlyArray<{
  id: "none" | "default" | "custom"
  title: string
}> = [
  { id: "none", title: "No summary" },
  { id: "default", title: "Summarize" },
  { id: "custom", title: "Summarize with custom prompt" },
]

type Stage =
  | { kind: "options" }
  | { kind: "custom" }

export type BranchSummaryPickerProps = {
  /** Short label for what's about to happen on confirm, e.g. "Send
   * edit" or "Revert". Surfaces in the header so the user knows
   * what their summary choice gates. */
  actionLabel: string
  /** Called once the user has picked a complete choice (None /
   * Default / Custom + text). The picker itself doesn't do any
   * branching — the caller wires it into `navigateTree`. */
  onConfirm: (choice: BranchSummaryChoice) => void | Promise<void>
  /** Fired on Escape from the options stage. */
  onCancel: () => void
  /** When true, swap the action button for a "Working…" indicator
   * and ignore further input. */
  busy?: boolean
  /**
   * `standalone` (default) renders the picker as a self-contained
   * popover — own border, popover surface, drop shadow. Use when
   * mounting it as a top-level UI surface (the composer-slot tree
   * panel, modals, etc.).
   *
   * `embedded` is for when the picker is rendered _inside_ another
   * container (e.g. nested under a user-message bubble after the
   * edit/revert action). It drops the shadow and uses a softer
   * surface so the picker reads as a nested shell of the parent
   * rather than a floating popup stamped on top of it. The wrapper
   * around it is expected to provide the outer chrome.
   */
  variant?: "standalone" | "embedded"
}

/**
 * Self-contained keyboard-navigable picker for the branch summary
 * choice. Two stages: the three-option list, then (for Custom) a
 * mini textarea for the extra summarizer instructions. Autofocuses
 * itself on mount; Escape on the options stage fires `onCancel`,
 * Escape on the custom stage goes back to options.
 */
export function BranchSummaryPicker({
  actionLabel,
  onConfirm,
  onCancel,
  busy,
  variant = "standalone",
}: BranchSummaryPickerProps) {
  const [stage, setStage] = useState<Stage>({ kind: "options" })
  const [index, setIndex] = useState(0) // Default to "No summary"
  const [customText, setCustomText] = useState("")

  const containerRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    containerRef.current?.focus()
  }, [])

  // The picker frequently mounts directly under the cursor (e.g.
  // when it pops up where the user just clicked the Edit action on
  // a user message). Without a gate, the row beneath the cursor
  // immediately fires onMouseEnter and steals selection from our
  // initial index — "No summary" used to be effectively unreachable
  // as the default.
  const hover = useHoverIntent()

  // Re-focus the container whenever we leave the textarea stage so
  // keyboard nav keeps working without the user manually clicking.
  useEffect(() => {
    if (stage.kind === "options") containerRef.current?.focus()
  }, [stage.kind])

  const confirmOption = useCallback(
    (i: number) => {
      if (busy) return
      const opt = SUMMARY_OPTIONS[i]!
      if (opt.id === "custom") {
        setStage({ kind: "custom" })
        return
      }
      void onConfirm(
        opt.id === "default" ? { kind: "default" } : { kind: "none" },
      )
    },
    [busy, onConfirm],
  )

  const onOptionsKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (busy) return
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
      return
    }
    if (e.key === "ArrowUp" || e.key === "k") {
      e.preventDefault()
      hover.resetToKeyboard()
      setIndex(i => (i - 1 + SUMMARY_OPTIONS.length) % SUMMARY_OPTIONS.length)
      return
    }
    if (e.key === "ArrowDown" || e.key === "j") {
      e.preventDefault()
      hover.resetToKeyboard()
      setIndex(i => (i + 1) % SUMMARY_OPTIONS.length)
      return
    }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault()
      confirmOption(index)
      return
    }
  }

  // While summarizing we collapse every stage down to a single
  // "Summarizing…" indicator. Leaving the option rows or the custom
  // prompt composer mounted (even dimmed) reads as "you can still
  // change your mind" — and worse, after the composer clears itself
  // on submit, the empty placeholder text shows under the busy
  // indicator which makes it look like a separate input was still
  // waiting on the user.
  if (busy) {
    return <BusyIndicator variant={variant} />
  }

  if (stage.kind === "custom") {
    return (
      <CustomPromptView
        onSubmit={text => {
          const trimmed = text.trim()
          if (trimmed.length === 0) return
          void onConfirm({
            kind: "custom",
            customInstructions: trimmed,
          })
        }}
        onChange={setCustomText}
        seed={customText}
        onBack={() => setStage({ kind: "options" })}
        variant={variant}
      />
    )
  }

  const embedded = variant === "embedded"
  // Unused in embedded mode (no header surfaces it); the type is
  // still required so the standalone callsite stays happy.
  void actionLabel
  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={onOptionsKeyDown}
      className={cn(
        "outline-none",
        embedded
          ? // Embedded: no chrome at all. No border, no fill, no
            // shadow. The picker becomes a list of rows hanging
            // directly off the parent surface so the only color
            // change between the bubble and the picker is the
            // selection highlight on the active row.
            "px-1 pb-1"
          : "overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg",
      )}
    >
      {embedded ? null : (
        <div className="border-b border-border bg-muted/40 px-3 py-1.5">
          <div className="text-[11px] font-medium text-foreground">
            Summarize branch?
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            On confirm: <span className="text-foreground">{actionLabel}</span>
          </div>
        </div>
      )}
      <div className={cn(embedded ? "py-0.5" : "px-1 py-1") }>
        {SUMMARY_OPTIONS.map((opt, i) => (
          <SummaryOptionRow
            key={opt.id}
            title={opt.title}
            selected={i === index}
            onClick={() => {
              setIndex(i)
              confirmOption(i)
            }}
            onHover={() => {
              if (!hover.isActive()) return
              setIndex(i)
            }}
          />
        ))}
      </div>
    </div>
  )
}

function BusyIndicator({
  variant,
}: {
  variant: "standalone" | "embedded"
}) {
  if (variant === "embedded") {
    return (
      <div className="px-3 py-2 text-[11px] text-muted-foreground">
        <span className="text-shimmer">Summarizing…</span>
      </div>
    )
  }
  return (
    <div className="overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="px-3 py-2 text-[11px] text-muted-foreground">
        <span className="text-shimmer">Summarizing…</span>
      </div>
    </div>
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
  seed,
  onChange,
  onSubmit,
  onBack,
  variant,
}: {
  /** Pre-existing draft text — used as the Composer's `initialText`
   * the first time this view mounts so going options → custom →
   * back → custom doesn't wipe what the user already typed. */
  seed: string
  onChange: (s: string) => void
  /** Receives the typed text. Composer is uncontrolled, so we pass
   * the payload's text directly instead of relying on a controlled
   * `value` that may lag a frame behind the submit keystroke. */
  onSubmit: (text: string) => void
  onBack: () => void
  variant: "standalone" | "embedded"
}) {
  const embedded = variant === "embedded"
  // Escape on the outer wrapper goes back to options. The Composer's
  // own Escape handler only fires when its typeahead menu is open
  // (which we never trigger here — no files/slash commands wired up),
  // so the event reliably bubbles to this listener.
  //
  // While busy, the parent renders <BusyIndicator/> instead of this
  // view, so we never have to gate keystrokes on a busy flag here.
  const handleKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault()
      e.stopPropagation()
      onBack()
    }
  }

  if (embedded) {
    return (
      // Flush layout: no border, no fill, no header chrome. Just
      // the Composer hanging directly off the bubble surface so it
      // doesn't read as a container-in-a-container.
      <div onKeyDown={handleKeyDown} className="px-1 pb-1">
        <Composer
          composerKey="branch-summary-custom-prompt"
          embedded
          initialText={seed}
          onDraftChange={onChange}
          onSubmit={payload => onSubmit(payload.text)}
          placeholder="e.g. focus on which files were modified and which tools failed."
        />
      </div>
    )
  }

  return (
    <div
      onKeyDown={handleKeyDown}
      className="overflow-hidden rounded-md border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="border-b border-border bg-muted/40 px-3 py-1.5">
        <div className="text-[11px] font-medium text-foreground">
          Custom summarizer prompt
        </div>
      </div>
      <div className="px-3 py-2">
        <Composer
          composerKey="branch-summary-custom-prompt-standalone"
          embedded
          initialText={seed}
          onDraftChange={onChange}
          onSubmit={payload => onSubmit(payload.text)}
          placeholder="e.g. focus on which files were modified and which tools failed."
        />
      </div>
      <div className="flex items-center justify-between border-t border-border bg-muted/30 px-3 py-1 text-[10px] text-muted-foreground">
        <button
          type="button"
          onClick={onBack}
          className="hover:text-foreground"
        >
          ← back
        </button>
      </div>
    </div>
  )
}
