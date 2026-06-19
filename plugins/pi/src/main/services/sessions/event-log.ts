import { nanoid } from "nanoid"
import type { DbService } from "@zenbujs/core/services"
import type { LiveSession } from "./live-session"
import type { EventItem, Session } from "./types"
import { extractTextContent } from "./labels"
import { probeCollection } from "./pi-utils"

type DbClient = DbService["client"]

/**
 * Context everything in this module needs: a way to look up a live
 * session (so we can stamp `lastConcatError` on it) and the db
 * client (so we can read/write the collection). A free-function shape
 * keeps the service from accumulating yet more private methods.
 */
export type EventLogCtx = {
  db: DbClient
  getLive(sessionId: string): LiveSession | undefined
}

/**
 * Append a batch of items to a session's eventLog with failure
 * accounting. Every prior `.catch(() => {})` or
 * `.catch(err => console.error(...))` is routed through here so a
 * silent write failure no longer disappears: it gets stamped on
 * the LiveSession and surfaced by `peekEventLogTail` for the
 * invariant overlay.
 *
 * Why this matters: "missing_user_prompt_event" verdicts used to
 * blame the renderer subscription, but a silently rejected
 * concat looks identical from the renderer side. With this
 * helper, the next stale invariant either has a
 * `lastConcatError` (write actually failed in main) or doesn't
 * (the data IS in the collection — the renderer's subscription
 * is genuinely behind).
 */
export async function safeConcatEventLog(args: {
  ctx: EventLogCtx
  sessionId: string
  items: EventItem[]
  context: string
}): Promise<void> {
  const { ctx, sessionId, items, context } = args
  try {
    await ctx.db.pi.sessions[sessionId].eventLog.concat(items)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error(`[sessions] ${context} concat failed:`, err)
    const live = ctx.getLive(sessionId)
    if (live) {
      live.lastConcatError = { when: Date.now(), message }
    }
  }
}

/**
 * Snapshot the eventLog collection once and return the largest
 * `seq` value among its items (0 when the collection is empty
 * or the probe times out). Used by `activate()` to keep
 * `live.seq` monotonically increasing across hot reloads.
 */
export async function readMaxEventLogSeq(args: {
  ctx: EventLogCtx
  sessionId: string
}): Promise<number> {
  const { ctx, sessionId } = args
  return new Promise<number>(resolve => {
    let done = false
    let unsub: (() => void) | null = null
    const finish = (v: number) => {
      if (done) return
      done = true
      if (unsub) unsub()
      resolve(v)
    }
    // Short timeout so a missing/slow subscription never blocks
    // `activate()`. Falling back to 0 is safe — the worst case is
    // a one-time key collision on a freshly-activated session,
    // not a stuck activation.
    const timeout = setTimeout(() => finish(0), 500)
    try {
      unsub = (
        ctx.db.pi.sessions[sessionId].eventLog as unknown as {
          subscribeData(
            cb: (data: {
              collection: { items: Array<{ seq?: number }> }
            }) => void,
          ): () => void
        }
      ).subscribeData(data => {
        clearTimeout(timeout)
        let max = 0
        for (const item of data.collection.items) {
          if (typeof item.seq === "number" && item.seq > max) {
            max = item.seq
          }
        }
        finish(max)
      })
    } catch (err) {
      clearTimeout(timeout)
      console.warn("[sessions] readMaxEventLogSeq subscribe failed:", err)
      finish(0)
    }
  })
}

export async function appendUserPromptEvent(args: {
  ctx: EventLogCtx
  live: LiveSession
  text: string
  imageRefs?: { blobId: string; mimeType: string }[]
}) {
  const { ctx, live, text, imageRefs } = args
  live.seq++
  const item: EventItem = {
    seq: live.seq,
    kind: "user_prompt",
    payload:
      imageRefs && imageRefs.length > 0
        ? { text, images: imageRefs }
        : { text },
    timestamp: Date.now(),
  }
  await safeConcatEventLog({
    ctx,
    sessionId: live.sessionId,
    items: [item],
    context: "appendUserPromptEvent",
  })
}

/**
 * Replace the chat's eventLog with synthesized events that reproduce
 * the materialized message stream for pi's current branch path.
 * Called after operations that move the leaf (navigateTree, branchFromLastUserTurn).
 */
export async function rebuildEventLogFromCurrentPath(args: {
  ctx: EventLogCtx
  live: LiveSession
}) {
  const { ctx, live } = args
  const messages = (live.pi as any).messages as any[] | undefined
  const events: EventItem[] = []
  let seq = 0
  if (Array.isArray(messages)) {
    for (const msg of messages) {
      const ts =
        typeof msg?.timestamp === "number" ? msg.timestamp : Date.now()
      if (msg?.role === "user") {
        events.push({
          seq: ++seq,
          kind: "user_prompt",
          payload: {
            text: extractTextContent({ content: msg.content }),
          },
          timestamp: ts,
        })
      } else if (msg?.role === "assistant") {
        events.push({
          seq: ++seq,
          kind: "message_end",
          payload: { message: msg },
          timestamp: ts,
        })
        const blocks = Array.isArray(msg.content) ? msg.content : []
        for (const block of blocks) {
          if (block?.type === "toolCall") {
            const callTs = ts
            events.push({
              seq: ++seq,
              kind: "tool_execution_start",
              payload: {
                toolCallId: block.id,
                toolName: block.name,
                args: block.arguments,
              },
              timestamp: callTs,
            })
          }
        }
      } else if (msg?.role === "toolResult") {
        events.push({
          seq: ++seq,
          kind: "tool_execution_end",
          payload: {
            toolCallId: msg.toolCallId,
            toolName: msg.toolName,
            isError: !!msg.isError,
            result: msg.content,
          },
          timestamp: ts,
        })
      }
    }
  }
  // Rotate the eventLog collection ref instead of mutating the
  // existing one via `.delete() + .concat()`.
  //
  // Why: the renderer's `useCollection(eventLog)` subscribes to a
  // specific `collectionId`. If we wipe that collection's contents
  // and append new ones, the subscription's local view goes stale
  // — the chat-pane keeps showing the post-delete snapshot and
  // misses subsequent `.concat()` calls until the component
  // remounts (which is the "tab away + back" workaround). Pointing
  // `session.eventLog` at a brand new collectionId makes the ref
  // change propagate through `useDb`, which makes `useCollection`
  // resubscribe cleanly to the fresh collection.
  //
  // The previous collection is orphaned on disk. That's acceptable
  // for branch navigation: those events represent an abandoned
  // branch path the user explicitly walked away from.
  const newRef = {
    collectionId: nanoid(),
    debugName: `events-${live.sessionId}-${Date.now()}`,
  }
  await ctx.db.update(root => {
    const s = root.pi.sessions[live.sessionId]
    if (s) s.eventLog = newRef as Session["eventLog"]
  })
  if (events.length > 0) {
    await safeConcatEventLog({
      ctx,
      sessionId: live.sessionId,
      items: events,
      context: "rebuild eventLog",
    })
  }
  live.seq = seq
}

/**
 * Diagnostic-only RPC body: returns the main-process's view of the
 * session's `runStartContextTokens`, current `eventLog` ref, and
 * the last `limit` event-log items. Used by the invariant overlay
 * to tell apart "data never reached the DB" (a real bug in the
 * main process) from "data is in the DB but the renderer's
 * subscription went stale" (a renderer-side caching bug, e.g. the
 * one that motivated rotating the eventLog ref on rebuild).
 */
export async function peekEventLogTail(args: {
  ctx: EventLogCtx
  sessionId: string
  limit?: number
}): Promise<{
  eventLogRef: { collectionId: string; debugName: string } | null
  seq: number | null
  recentKinds: Array<{ seq: number; kind: string; timestamp: number }>
  hasUserPromptWithText: string | null
  runtimeMismatch: {
    recordSessionId: string
    recordSessionFile: string
    liveSessionId: string | null
    liveSessionFile: string | null
    mismatched: boolean
  } | null
  lastConcatError: { when: number; message: string } | null
  mainCollection: {
    totalCount: number
    recentSeqs: Array<{ seq: number; kind: string; timestamp: number }>
    hasUserPromptWithText: string | null
    probeError: string | null
  } | null
}> {
  const { ctx, sessionId } = args
  const root = ctx.db.readRoot()
  const session = root.pi.sessions[sessionId]
  if (!session) {
    return {
      eventLogRef: null,
      seq: null,
      recentKinds: [],
      hasUserPromptWithText: null,
      runtimeMismatch: null,
      lastConcatError: null,
      mainCollection: null,
    }
  }
  const ref = session.eventLog as unknown as {
    collectionId: string
    debugName: string
  }
  const live = ctx.getLive(sessionId)
  let runtimeMismatch: {
    recordSessionId: string
    recordSessionFile: string
    liveSessionId: string | null
    liveSessionFile: string | null
    mismatched: boolean
  } | null = null
  if (live) {
    const liveSessionId = live.pi.sessionManager.getSessionId() ?? null
    const liveSessionFile = live.pi.sessionManager.getSessionFile() ?? null
    runtimeMismatch = {
      recordSessionId: session.piSessionId,
      recordSessionFile: session.sessionFile,
      liveSessionId,
      liveSessionFile,
      mismatched:
        (liveSessionId != null && liveSessionId !== session.piSessionId) ||
        (liveSessionFile != null && liveSessionFile !== session.sessionFile),
    }
  }
  let mainCollection: {
    totalCount: number
    recentSeqs: Array<{ seq: number; kind: string; timestamp: number }>
    hasUserPromptWithText: string | null
    probeError: string | null
  } | null = null
  try {
    mainCollection = await probeCollection({
      node: ctx.db.pi.sessions[sessionId].eventLog,
      tail: 20,
    })
  } catch (err) {
    mainCollection = {
      totalCount: -1,
      recentSeqs: [],
      hasUserPromptWithText: null,
      probeError: err instanceof Error ? err.message : String(err),
    }
  }
  return {
    eventLogRef: ref
      ? { collectionId: ref.collectionId, debugName: ref.debugName }
      : null,
    seq: live?.seq ?? null,
    recentKinds: mainCollection?.recentSeqs ?? [],
    hasUserPromptWithText: mainCollection?.hasUserPromptWithText ?? null,
    runtimeMismatch,
    lastConcatError: live?.lastConcatError ?? null,
    mainCollection,
  }
}
