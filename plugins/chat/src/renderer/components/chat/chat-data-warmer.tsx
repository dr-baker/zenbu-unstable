import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useCollection, useDb } from "@zenbujs/core/react"
import { perfTrace } from "@/lib/perf-trace"
import type { ChatWarmStatus, ChatWarmTarget } from "@/lib/chat-warm-targets"
import { getCachedSegmentedMaterializedMessages } from "./lib/materialized-message-cache"
import type { MaterializeEventItem } from "./lib/materialize"

export type ChatDataWarmerProps = {
  targets: ChatWarmTarget[]
  activeChatId: string | null
  onStatusChange?: (status: ChatWarmStatus) => void
}

const SETTLE_DELAY_MS = 1_200
const BETWEEN_TARGET_DELAY_MS = 250
const EMPTY_COLLECTION_GRACE_MS = 3_000
const WARMED_TTL_MS = 5 * 60_000

const recentlyWarmedAt = new Map<string, number>()

export function ChatDataWarmer({
  targets,
  activeChatId,
  onStatusChange,
}: ChatDataWarmerProps) {
  const candidates = useMemo(
    () =>
      targets
        .filter(target => target.chatId !== activeChatId)
        .filter(target => !wasRecentlyWarmed(target.sessionId))
        .slice(0, 12),
    [targets, activeChatId],
  )
  const candidatesKey = useMemo(
    () => candidates.map(targetKey).join("|"),
    [candidates],
  )
  const [completed, setCompleted] = useState<Set<string>>(() => new Set())
  const [activeKey, setActiveKey] = useState<string | null>(null)

  useEffect(() => {
    setCompleted(new Set())
    setActiveKey(null)
  }, [candidatesKey, activeChatId])

  useEffect(() => {
    if (activeKey) return
    const next = candidates.find(target => !completed.has(targetKey(target)))
    if (!next) return
    const delay = completed.size === 0 ? SETTLE_DELAY_MS : BETWEEN_TARGET_DELAY_MS
    const timeout = window.setTimeout(() => {
      setActiveKey(targetKey(next))
    }, delay)
    return () => window.clearTimeout(timeout)
  }, [activeKey, candidates, completed])

  const handleDone = useCallback((target: ChatWarmTarget) => {
    const key = targetKey(target)
    markRecentlyWarmed(target.sessionId)
    setCompleted(prev => {
      if (prev.has(key)) return prev
      const next = new Set(prev)
      next.add(key)
      return next
    })
    setActiveKey(current => (current === key ? null : current))
  }, [])

  const activeTarget = activeKey
    ? candidates.find(target => targetKey(target) === activeKey) ?? null
    : null

  useEffect(() => {
    const status = warmStatus(candidates, activeKey, completed)
    onStatusChange?.(status)
    perfTrace.mark("chat.data_warm.status", {
      activeChatId: status.activeChatId,
      queuedCount: status.queuedChatIds.length,
      completedCount: status.completedChatIds.length,
      targetCount: status.targetCount,
    })
  }, [activeKey, candidates, completed, onStatusChange])

  useEffect(() => {
    return () => {
      onStatusChange?.({
        activeChatId: null,
        queuedChatIds: [],
        completedChatIds: [],
        targetCount: 0,
      })
    }
  }, [onStatusChange])

  if (!activeTarget) return null
  return <ChatDataWarmWorker key={activeKey} target={activeTarget} onDone={handleDone} />
}

function ChatDataWarmWorker({
  target,
  onDone,
}: {
  target: ChatWarmTarget
  onDone: (target: ChatWarmTarget) => void
}) {
  const session = useDb(root => root.pi.sessions[target.sessionId])
  const eventLogRef = useDb(root => root.pi.sessions[target.sessionId]?.eventLog)
  const scope = useDb(root => root.app.scopes[target.scopeId])
  const { items: events } = useCollection(eventLogRef)
  const collection = collectionInfo(eventLogRef)
  const doneRef = useRef(false)
  const mountedAtRef = useRef(performance.now())

  const finish = useCallback(
    (reason: string) => {
      if (doneRef.current) return
      doneRef.current = true
      perfTrace.markForSubject(`chat:${target.chatId}`, "chat.data_warm.done", {
        chatId: target.chatId,
        sessionId: target.sessionId,
        collectionId: collection.id,
        reason,
        targetReason: target.reason,
        elapsedMs: round(performance.now() - mountedAtRef.current),
      })
      onDone(target)
    },
    [collection.id, onDone, target],
  )

  useEffect(() => {
    if (doneRef.current) return
    const timeout = window.setTimeout(() => {
      finish(events.length === 0 ? "empty-timeout" : "timeout")
    }, EMPTY_COLLECTION_GRACE_MS)
    return () => window.clearTimeout(timeout)
  }, [events.length, finish])

  useEffect(() => {
    if (doneRef.current) return
    if (!session || !collection.id || events.length === 0) return
    perfTrace.markForSubject(`chat:${target.chatId}`, "chat.data_warm.idle_scheduled", {
      chatId: target.chatId,
      sessionId: target.sessionId,
      collectionId: collection.id,
      eventCount: events.length,
      targetReason: target.reason,
    })
    const cancel = scheduleIdle(() => {
      if (doneRef.current) return
      const span = perfTrace.startSpanForSubject(
        `chat:${target.chatId}`,
        "chat.data_warm.materialize",
        {
          chatId: target.chatId,
          sessionId: target.sessionId,
          collectionId: collection.id,
          eventCount: events.length,
          targetReason: target.reason,
        },
      )
      try {
        const materialized = getCachedSegmentedMaterializedMessages(
          events as MaterializeEventItem[],
          {
            sessionId: target.sessionId,
            collectionId: collection.id,
            directory: scope?.directory ?? null,
            extraDirectories: scope?.extraDirectories ?? [],
            workspaceId: scope?.workspaceId ?? null,
            scopeId: target.scopeId,
          },
        )
        span?.end({
          messageCount: materialized.messages.length,
          cacheHit: materialized.cacheHit,
          strategy: materialized.strategy,
          stableSegmentCount: materialized.stableSegmentCount,
          stableSegmentCacheHits: materialized.stableSegmentCacheHits,
          tailEventCount: materialized.tailEventCount,
          fallbackReason: materialized.fallbackReason,
        })
        finish("materialized")
      } catch (err) {
        span?.end({ error: err instanceof Error ? err.message : String(err) })
        console.warn("[chat-data-warmer] materialization failed:", err)
        finish("error")
      }
    }, 2_000)
    return cancel
  }, [collection.id, events, finish, scope, session, target])

  return null
}

function warmStatus(
  candidates: ChatWarmTarget[],
  activeKey: string | null,
  completed: Set<string>,
): ChatWarmStatus {
  const active = activeKey
    ? candidates.find(target => targetKey(target) === activeKey) ?? null
    : null
  return {
    activeChatId: active?.chatId ?? null,
    queuedChatIds: candidates
      .filter(target => targetKey(target) !== activeKey)
      .filter(target => !completed.has(targetKey(target)))
      .map(target => target.chatId),
    completedChatIds: candidates
      .filter(target => completed.has(targetKey(target)))
      .map(target => target.chatId),
    targetCount: candidates.length,
  }
}

function targetKey(target: ChatWarmTarget): string {
  return `${target.chatId}:${target.sessionId}`
}

function wasRecentlyWarmed(sessionId: string): boolean {
  const warmedAt = recentlyWarmedAt.get(sessionId)
  if (!warmedAt) return false
  if (Date.now() - warmedAt <= WARMED_TTL_MS) return true
  recentlyWarmedAt.delete(sessionId)
  return false
}

function markRecentlyWarmed(sessionId: string): void {
  recentlyWarmedAt.set(sessionId, Date.now())
  if (recentlyWarmedAt.size <= 200) return
  const cutoff = Date.now() - WARMED_TTL_MS
  for (const [key, warmedAt] of recentlyWarmedAt) {
    if (warmedAt < cutoff) recentlyWarmedAt.delete(key)
  }
}

function scheduleIdle(callback: () => void, timeout: number): () => void {
  const requestIdle = (window as unknown as {
    requestIdleCallback?: (cb: () => void, options?: { timeout?: number }) => number
    cancelIdleCallback?: (id: number) => void
  }).requestIdleCallback
  const cancelIdle = (window as unknown as {
    cancelIdleCallback?: (id: number) => void
  }).cancelIdleCallback
  if (requestIdle) {
    const id = requestIdle(callback, { timeout })
    return () => cancelIdle?.(id)
  }
  const id = window.setTimeout(callback, Math.min(timeout, 500))
  return () => window.clearTimeout(id)
}

function collectionInfo(value: unknown): { id: string | null } {
  if (value == null || typeof value !== "object") return { id: null }
  const ref = value as { collectionId?: unknown }
  return { id: typeof ref.collectionId === "string" ? ref.collectionId : null }
}

function round(value: number): number {
  return Math.round(value * 10) / 10
}
