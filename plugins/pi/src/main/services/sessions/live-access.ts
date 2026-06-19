import type { LiveSession } from "./live-session"
import { touchSessionUsed } from "./session-pool"

/**
 * Minimal host surface for lazy Pi activation. Helper modules depend on
 * this shape instead of the full `SessionsService` to avoid import cycles.
 */
export type SessionLiveHost = {
  ensureLive(sessionId: string): Promise<LiveSession>
  live: Map<string, LiveSession>
}

/**
 * RPC methods that must stay cold — they only touch DB state, lifecycle,
 * or diagnostics. Everything else that accepts `{ sessionId }` and talks
 * to Pi should go through `withLiveSession`.
 */
export const VIEWER_ONLY_SESSION_RPC = new Set([
  "subscribe",
  "unsubscribe",
  "createChatSession",
  "fork",
  "clone",
  "forkAtUserMessage",
  "deleteSession",
  "moveToNewWorktree",
  "moveChatToExistingScope",
  "continueKilled",
  "dismissKilled",
  "acknowledgeKilledMarkers",
  "acknowledgeReloadToasts",
  "appendComposerDraft",
  "peekEventLogTail",
  "refreshAvailableModels",
])

/**
 * Activate Pi when needed, then run the callback with the live session.
 * All agent-facing RPC paths must use this (directly or via
 * `SessionsService.withLive`) — never `live.get()` for mutating work.
 */
export async function withLiveSession<T>(
  svc: SessionLiveHost,
  sessionId: string,
  fn: (live: LiveSession) => Promise<T>,
): Promise<T> {
  const live = await svc.ensureLive(sessionId)
  touchSessionUsed(live)
  return fn(live)
}

/**
 * Run a callback only when the session is already live. Used for abort-style
 * ops where cold activation would be wasteful and there is nothing to stop.
 */
export async function withLiveSessionIfPresent<T>(
  svc: SessionLiveHost,
  sessionId: string,
  fn: (live: LiveSession) => Promise<T>,
): Promise<T | undefined> {
  const live = svc.live.get(sessionId)
  if (!live) return undefined
  return fn(live)
}
