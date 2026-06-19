import { useEffect, useRef } from "react"
import { useDb, useRpc } from "@zenbujs/core/react"
import { toast } from "sonner"
import { Button } from "@zenbu/ui/button"

/**
 * Two complementary surfaces driven by main:
 *
 *   - `killedSessions` (only ever populated with markers from a
 *     *previous* process — main consumes its own same-process
 *     markers itself before they reach the renderer): user quit
 *     mid-stream. Show a sticky toast with Continue / Dismiss.
 *     The user explicitly chose to quit, so they need to opt in.
 *
 *   - `pendingReloadToasts`: hot-reload auto-resume. Main already
 *     dispatched the silent "Continue. The system reloaded."
 *     prompt; this record exists purely so we pop a global toast
 *     telling the user which agent woke back up (the in-chat
 *     "Agent reloaded" divider only helps if they're already
 *     looking at the right chat).
 *
 * Both signals follow the same consume-on-display contract: render
 * the toast, fire a server-authoritative ack RPC to delete the DB
 * entry, never show it again. The `shownRef` set guards against
 * the render-cycle race between firing the RPC and the DB update
 * propagating back as an empty array.
 */
export function KilledAgentsWatcher() {
  const killed = useDb(root => Object.values(root.pi.killedSessions))
  const reloads = useDb(root => Object.values(root.pi.pendingReloadToasts))
  const rpc = useRpc()
  const shownKilledRef = useRef<Set<string>>(new Set())
  const shownReloadRef = useRef<Set<string>>(new Set())

  // Quit-while-streaming → actionable Continue / Dismiss toast.
  useEffect(() => {
    if (killed.length === 0) return
    const fresh = killed.filter(k => !shownKilledRef.current.has(k.sessionId))
    if (fresh.length === 0) return
    for (const k of fresh) shownKilledRef.current.add(k.sessionId)

    const sessionIds = fresh.map(k => k.sessionId)
    void rpc.pi.sessions
      .acknowledgeKilledMarkers({ sessionIds })
      .catch(err =>
        console.error(
          "[killed-agents] acknowledgeKilledMarkers failed:",
          err,
        ),
      )

    const count = sessionIds.length
    const noun = count === 1 ? "agent" : "agents"
    const verb = count === 1 ? "was" : "were"
    const continueLabel = count === 1 ? "Continue" : "Continue all"

    toast.custom(
      id => (
        <div className="flex w-[320px] flex-col gap-3 rounded-md border border-border bg-popover p-4 text-popover-foreground shadow-md">
          <div className="flex flex-col gap-1">
            <div className="text-[13px] font-medium text-amber-600 dark:text-amber-400">
              {count} {noun} {verb} interrupted when you quit
            </div>
            <div className="text-[12px] text-muted-foreground">
              Resume them where they left off?
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <Button
              size="sm"
              onClick={() => {
                toast.dismiss(id)
                void rpc.pi.sessions.continueKilled({ sessionIds })
              }}
            >
              {continueLabel}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                toast.dismiss(id)
              }}
            >
              Dismiss
            </Button>
          </div>
        </div>
      ),
      // Long enough to read and decide, short enough that an
      // ignored toast doesn't sit on screen forever. The killed
      // marker is already acked above, so letting this expire is
      // equivalent to "Dismiss".
      { duration: 20_000 },
    )
  }, [killed, rpc])

  // Hot-reload auto-resume → informational "Agent reloaded" toast.
  useEffect(() => {
    if (reloads.length === 0) return
    const fresh = reloads.filter(
      k => !shownReloadRef.current.has(k.sessionId),
    )
    if (fresh.length === 0) return
    for (const k of fresh) shownReloadRef.current.add(k.sessionId)

    const sessionIds = fresh.map(k => k.sessionId)
    void rpc.pi.sessions
      .acknowledgeReloadToasts({ sessionIds })
      .catch(err =>
        console.error(
          "[killed-agents] acknowledgeReloadToasts failed:",
          err,
        ),
      )

    const count = sessionIds.length
    const noun = count === 1 ? "agent" : "agents"
    toast.success(`Resumed ${count} ${noun} after reload`, {
      duration: 3500,
    })
  }, [reloads, rpc])

  return null
}
