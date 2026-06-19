import { useEffect } from "react"
import { useDbClient, useEvents } from "@zenbujs/core/react"
import { CheckCircle2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { useWindowId } from "@/lib/window-state/window-id"
import { focusPaneShowingChatInRoot, selectChatInRoot } from "@/lib/window-state/selection"
import { cn } from "@/lib/utils"
import { HoverTip } from "@zenbu/ui/hover-tip"
import { requestFocusComposer } from "@/lib/focus-composer"

/**
 * Listens for `agentCompletedUnviewed` events from the main process
 * and renders a toast that, on click, navigates to the completing
 * chat in the active window's panes \u2014 same effect as clicking the
 * row in the agent sidebar.
 *
 * The trigger heuristic lives server-side in `SessionsService` and
 * matches the sidebar's unread-dot rule: `agent_end` fires AND
 * `SessionActivityService.isViewed(sessionId) === false`. That keeps
 * the toast and the sidebar dot in lockstep \u2014 anything the dot
 * would show up on is something the toast also fires for.
 *
 * One-shot: mount this component once near the root (alongside
 * `<ShortcutBridge />` in `App`). The event fan-out is global, so
 * a single subscriber in the renderer is enough; mounting more than
 * once would just produce duplicate toasts per completion.
 */
export function AgentCompletionNotifier() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()

  useEffect(() => {
    const off = events.pi.agentCompletedUnviewed.subscribe(
      ({ sessionId, chatId, label }) => {
        // Stable toast id per session so a rapid burst of turns
        // (or one user re-prompting before clicking) replaces the
        // existing toast instead of stacking N copies for the
        // same chat. Sonner treats `id` as a primary key.
        const toastId = `agent-completed:${sessionId}`

        const handleOpen = () => {
          if (!chatId) {
            toast.dismiss(toastId)
            return
          }
          void dbClient
            .update(root => {
              // Prefer "reveal existing tab" over "replace active
              // tab", same precedence as the sidebar's
              // `handleSelectChat`. If no pane currently shows
              // this chat we replace the active tab so the user
              // always lands somewhere.
              if (focusPaneShowingChatInRoot(root, windowId, chatId)) return
              selectChatInRoot(root, windowId, chatId)
            })
            .then(() => {
              // Match sidebar behavior: if the destination has a
              // persisted draft, refocus the composer so the user
              // can pick up where they left off.
              const draft =
                dbClient.readRoot().app.chatStates[chatId]?.draft ?? ""
              if (draft.trim().length > 0) requestFocusComposer(chatId)
            })
          toast.dismiss(toastId)
        }

        toast.custom(
          () => (
            <AgentCompletionToastCard
              label={label}
              canOpen={chatId != null}
              onOpen={handleOpen}
              onDismiss={() => toast.dismiss(toastId)}
            />
          ),
          {
            id: toastId,
            // Auto-dismiss after a short window so unread
            // completions don't pile up on screen indefinitely.
            // The sidebar's unread dot is the persistent surface;
            // this toast is just an in-the-moment nudge. Dismissal
            // also happens via the X button, clicking the body to
            // open the chat, or a subsequent completion for the
            // same session (which replaces this toast in place via
            // the stable `id`).
            duration: 5_000,
          },
        )
      },
    )
    return off
  }, [events, dbClient, windowId])

  return null
}

interface AgentCompletionToastCardProps {
  label: string
  canOpen: boolean
  onOpen: () => void
  onDismiss: () => void
}

/**
 * Visual card rendered inside the sonner toast slot. Click anywhere
 * on the body (except the dismiss button) to navigate. The dismiss
 * button stops propagation so it only closes the toast.
 *
 * Styling matches `popover` tokens so it sits on the same palette
 * as the rest of the toaster (see `components/ui/sonner.tsx`).
 */
function AgentCompletionToastCard({
  label,
  canOpen,
  onOpen,
  onDismiss,
}: AgentCompletionToastCardProps) {
  return (
    <div
      role={canOpen ? "button" : undefined}
      tabIndex={canOpen ? 0 : -1}
      onClick={canOpen ? onOpen : undefined}
      onKeyDown={
        canOpen
          ? e => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault()
                onOpen()
              }
            }
          : undefined
      }
      className={cn(
        "flex w-[360px] items-start gap-3 rounded-[var(--radius)] border bg-[var(--popover)] p-3 shadow-md",
        "text-[var(--popover-foreground)]",
        canOpen && "select-none hover:bg-[var(--accent)]",
      )}
    >
      <CheckCircle2Icon className="mt-[2px] size-4 shrink-0 text-[var(--primary)]" />
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">Agent finished</div>
        <HoverTip label={label} setAriaLabel={false}>
          <div className="mt-0.5 truncate text-[12px] text-[var(--muted-foreground)]">
            {label}
          </div>
        </HoverTip>
        {canOpen && (
          <div className="mt-1 text-[11px] text-[var(--muted-foreground)]">
            Click to open
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={e => {
          e.stopPropagation()
          onDismiss()
        }}
        className="shrink-0 rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--accent)] hover:text-[var(--foreground)]"
        aria-label="Dismiss"
      >
        <XIcon className="size-3.5" />
      </button>
    </div>
  )
}
