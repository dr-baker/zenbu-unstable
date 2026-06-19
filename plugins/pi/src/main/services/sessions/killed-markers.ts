import { SYSTEM_RELOAD_SENTINEL } from "../../lib/agent-resume"
import type { SessionsService } from "../sessions"

type Svc = SessionsService

/**
 * On boot, reconcile killed-session markers written by a previous
 * `dispose-live`. Two cases:
 *
 *   - `processToken === PROCESS_TOKEN`  — marker was written by
 *     this same process's previous `dispose-live` cleanup, i.e.
 *     we hot-reloaded mid-stream. Auto-resume silently — hot
 *     reload is our interruption, not the user's.
 *
 *   - `processToken !== PROCESS_TOKEN`  — marker survived a
 *     process restart. The user quit while something was
 *     streaming. Leave the marker in the DB; the renderer's
 *     `KilledAgentsWatcher` will pick it up, show a one-shot
 *     toast, and consume the marker on display.
 *
 * No `reason` classification, no 24h stale-cleanup, no
 * `agent_end`-side bookkeeping. `dispose-live` is the single
 * owner of marker lifecycle; everywhere else just reads.
 */
export async function reconcileKilledMarkersOnBoot(args: {
  svc: Svc
  processToken: string
}): Promise<void> {
  const { svc, processToken } = args
  const sameProcess = Object.values(
    svc.ctx.db.client.readRoot().pi.killedSessions,
  )
    .filter(k => k.processToken === processToken)
    .map(k => k.sessionId)

  if (sameProcess.length === 0) return

  // Same-process markers are a hot-reload artifact — consume them
  // ourselves and silently auto-resume. `continueKilled` deletes
  // the markers up front and dispatches the sentinel-wrapped
  // prompt that the chat surface renders as an "Agent reloaded"
  // divider.
  //
  // Stamp a transient `pendingReloadToasts` entry per session
  // BEFORE kicking off the resume. The renderer's
  // `KilledAgentsWatcher` reads this record and pops a global
  // "Agent reloaded" toast so users with another chat focused
  // still find out the agent woke back up. Stamped before the
  // resume so a slow renderer reconnect (after the hot-reload
  // WS tear-down) can still pick it up on first paint.
  const now = Date.now()
  await svc.ctx.db.client.update(root => {
    for (const sessionId of sameProcess) {
      root.pi.pendingReloadToasts[sessionId] = {
        sessionId,
        resumedAt: now,
      }
    }
  })
  void svc.continueKilled({ sessionIds: sameProcess }).catch(err =>
    console.warn("[sessions] auto-resume failed:", err),
  )
}

/**
 * Called from the `dispose-live` setup cleanup. Stamps a
 * killedSessions marker for every session currently mid-turn,
 * clears any stale same-process markers for sessions that have
 * since finished, then aborts + disposes every live session.
 *
 * Pi's `dispose()` only detaches listeners — it does NOT cancel
 * the agent loop or its tool calls. Skipping the abort leaves
 * orphan LLM runs editing files in the background after a hot
 * reload.
 */
export async function snapshotKilledMarkersOnDispose(args: {
  svc: Svc
  processToken: string
}): Promise<void> {
  const { svc, processToken } = args
  const streaming: string[] = []
  for (const [sessionId, live] of svc.live) {
    if (live.inAgentLoop) streaming.push(sessionId)
  }
  const streamingSet = new Set(streaming)
  try {
    const now = Date.now()
    await svc.ctx.db.client.update(root => {
      for (const k of Object.values(root.pi.killedSessions)) {
        if (
          k.processToken === processToken &&
          !streamingSet.has(k.sessionId)
        ) {
          delete root.pi.killedSessions[k.sessionId]
        }
      }
      for (const sessionId of streaming) {
        root.pi.killedSessions[sessionId] = {
          sessionId,
          killedAt: now,
          processToken,
        }
      }
    })
  } catch (err) {
    console.warn(
      "[sessions] failed to sync killedSessions on dispose:",
      err,
    )
  }
  await Promise.all(
    [...svc.live.values()].map(async live => {
      try {
        if (live.pi.isStreaming) await live.pi.abort()
      } catch (err) {
        console.warn("[sessions] dispose abort failed:", err)
      }
      try {
        await svc.ctx.piResourceRegistry.markRuntimeSnapshotInactive({
          sessionId: live.sessionId,
        })
      } catch (err) {
        console.warn("[sessions] runtime snapshot inactive mark failed:", err)
      }
      try {
        live.dispose()
      } catch (err) {
        console.warn("[sessions] dispose threw:", err)
      }
    }),
  )
  svc.live.clear()
}

/**
 * Resume sessions whose in-flight runs were killed by a hot
 * reload or shutdown. For each one, re-activate pi from its
 * persisted session file and send a plain-English "continue"
 * prompt — there's no native way to resume an LLM stream, so
 * talking to the model is the only path forward.
 *
 * The markers are cleared up front (not after each prompt) so
 * the toast disappears immediately on click. If a prompt fails
 * we log and keep going — better to lose one resume than to
 * have a stuck toast that can't be dismissed.
 */
export async function continueKilled(args: {
  svc: Svc
  sessionIds: string[]
}): Promise<void> {
  const { svc, sessionIds } = args
  await svc.ctx.db.client.update(root => {
    for (const sessionId of sessionIds) {
      delete root.pi.killedSessions[sessionId]
    }
  })
  for (const sessionId of sessionIds) {
    try {
      // The `<system>...</system>` wrapper is a sentinel that the
      // chat surface's materializer recognises and renders as a
      // small "Agent reloaded" divider instead of a user-message
      // bubble. The wrapped text is still what the model sees, so
      // it understands to keep going where it left off.
      await svc.prompt({
        sessionId,
        text: SYSTEM_RELOAD_SENTINEL,
      })
    } catch (err) {
      console.warn("[sessions] continueKilled failed for", sessionId, err)
    }
  }
}

/** Drop killed-session markers without resuming. */
export async function dismissKilled(args: {
  svc: Svc
  sessionIds: string[]
}): Promise<void> {
  await args.svc.ctx.db.client.update(root => {
    for (const sessionId of args.sessionIds) {
      delete root.pi.killedSessions[sessionId]
    }
  })
}

/**
 * Server-authoritative "consume on display" hook for the renderer's
 * `KilledAgentsWatcher`. Same delete-from-DB action as `dismissKilled`,
 * but named separately so the intent at the call site is clear:
 * this isn't a user action, it's an "I've now displayed this notice"
 * acknowledgement. Renderer-initiated `client.update` was racing
 * with main-process reloads and not persisting reliably; routing
 * through RPC makes the write authoritative on main.
 */
export async function acknowledgeKilledMarkers(args: {
  svc: Svc
  sessionIds: string[]
}): Promise<void> {
  await args.svc.ctx.db.client.update(root => {
    for (const sessionId of args.sessionIds) {
      delete root.pi.killedSessions[sessionId]
    }
  })
}

/**
 * Renderer-side counterpart for `pendingReloadToasts`. Called by
 * `KilledAgentsWatcher` immediately after popping the "Agent
 * reloaded" toast so the entry doesn't survive across mount
 * cycles or multi-window renders.
 */
export async function acknowledgeReloadToasts(args: {
  svc: Svc
  sessionIds: string[]
}): Promise<void> {
  await args.svc.ctx.db.client.update(root => {
    for (const sessionId of args.sessionIds) {
      delete root.pi.pendingReloadToasts[sessionId]
    }
  })
}
