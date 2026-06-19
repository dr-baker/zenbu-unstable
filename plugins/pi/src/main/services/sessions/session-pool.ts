import type { LiveSession } from "./live-session"

export type SessionPoolPolicy = {
  /** Max live Pi sessions kept hot in memory. */
  maxHotSessions: number
  /** Ms after last Pi use before an idle session becomes evictable. */
  idleGraceMs: number
}

export const DEFAULT_SESSION_POOL_POLICY: SessionPoolPolicy = {
  maxHotSessions: 5,
  idleGraceMs: 3 * 60 * 1000,
}

/** Delay before background-warming a session that entered the viewer set. */
export const SESSION_PREFETCH_DELAY_MS = 400

export type SessionPoolHost = {
  live: Map<string, LiveSession>
  activating: Map<string, Promise<LiveSession>>
  subscribers: Map<string, Set<string>>
  sessionActivity: { isViewed(sessionId: string): boolean }
}

export function touchSessionUsed(live: LiveSession): void {
  live.lastUsedAt = Date.now()
}

export function isSessionEvictable(
  svc: SessionPoolHost,
  live: LiveSession,
  policy: SessionPoolPolicy,
): boolean {
  const sessionId = live.sessionId
  const viewerCount = svc.subscribers.get(sessionId)?.size ?? 0
  if (viewerCount > 0) return false
  if (live.subscribers.size > 0) return false
  if (live.inAgentLoop) return false
  if (live.pi.isStreaming) return false
  if (svc.sessionActivity.isViewed(sessionId)) return false
  return Date.now() - live.lastUsedAt >= policy.idleGraceMs
}

export function listEvictableSessions(
  svc: SessionPoolHost,
  policy: SessionPoolPolicy,
  exceptSessionId?: string,
): LiveSession[] {
  const candidates: LiveSession[] = []
  for (const live of svc.live.values()) {
    if (exceptSessionId && live.sessionId === exceptSessionId) continue
    if (!isSessionEvictable(svc, live, policy)) continue
    candidates.push(live)
  }
  candidates.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  return candidates
}

/** Tear down one live session without touching DB rows or session files. */
export async function disposeLiveSession(
  svc: Pick<SessionPoolHost, "live" | "activating">,
  sessionId: string,
): Promise<boolean> {
  const live = svc.live.get(sessionId)
  if (!live) return false
  try {
    if (live.pi.isStreaming) await live.pi.abort()
  } catch (err) {
    console.warn("[session-pool] abort before dispose failed:", err)
  }
  try {
    live.dispose()
  } catch (err) {
    console.warn("[session-pool] dispose failed:", err)
  }
  svc.live.delete(sessionId)
  svc.activating.delete(sessionId)
  return true
}

/**
 * Make room before activating `incomingSessionId`. Evicts the least-recently-used
 * idle sessions until under `maxHotSessions` or no safe victims remain.
 */
export async function ensurePoolCapacity(
  svc: SessionPoolHost,
  incomingSessionId: string,
  policy: SessionPoolPolicy = DEFAULT_SESSION_POOL_POLICY,
): Promise<number> {
  let evicted = 0
  while (svc.live.size >= policy.maxHotSessions) {
    const candidates = listEvictableSessions(svc, policy, incomingSessionId)
    if (candidates.length === 0) break
    const victim = candidates[0]!
    if (await disposeLiveSession(svc, victim.sessionId)) {
      evicted++
      console.info(
        `[session-pool] evicted ${victim.sessionId} for ${incomingSessionId} (live=${svc.live.size})`,
      )
    }
  }
  return evicted
}

/** Evict every idle session past the grace window — keeps abandoned hots from lingering. */
export async function sweepIdleSessions(
  svc: SessionPoolHost,
  policy: SessionPoolPolicy = DEFAULT_SESSION_POOL_POLICY,
): Promise<number> {
  let evicted = 0
  for (const live of listEvictableSessions(svc, policy)) {
    if (await disposeLiveSession(svc, live.sessionId)) {
      evicted++
      console.info(`[session-pool] swept idle session ${live.sessionId}`)
    }
  }
  return evicted
}
