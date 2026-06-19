import { useCallback, useEffect, useRef } from "react"
import { useRpc } from "@zenbujs/core/react"
import { nanoid } from "nanoid"
import { reportInvariant } from "./invariant-store"

type EventItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}

type Pending = {
  id: string
  text: string
  /** Whether this send was queued (enqueue) or fired directly (prompt).
   * Affects which surface we expect the text to appear in. */
  path: "prompt" | "enqueue"
  sentAt: number
  /** Best-effort context to ship along if the invariant fires. */
  sessionId: string | null
  /** EventLog collection ref id at the time of send, so the
   * post-mortem can detect whether a navigateTree-style ref rotation
   * happened mid-flight. */
  eventLogCollectionId: string | null
  /** Live `seq` counter snapshot from the main process at send time
   * (best effort — fetched via peekEventLogTail). */
  seqAtSend: number | null
}

type QueueDraftItem = { text: string }

type EventLogRef = { collectionId: string; debugName: string } | null

const TIMEOUT_MS = 5000

/**
 * Catches the "I sent a message but it never appeared in the UI" class
 * of bug.
 *
 * Two surfaces, two invariants:
 *
 *   1. `prompt` path  — text must show up as a `user_prompt` event in
 *      the session's event log within `TIMEOUT_MS`.
 *   2. `enqueue` path — text must show up as an entry in
 *      `session.queueDraft` within `TIMEOUT_MS`.
 *
 * The hook returns a `track(text, path)` callback. Call it right
 * before calling the corresponding RPC; if the expected surface
 * doesn't reflect the send in time, an invariant is filed against
 * the chat with a snapshot of the recent events and queue state for
 * debugging.
 *
 * Sends are auto-resolved (removed from the watchlist) as soon as
 * the expected entry appears, so the success path is silent.
 *
 * Diagnostics: on timeout we probe the main process via
 * `peekEventLogTail` to compare the renderer-side view against
 * what main believes about the session. The report classifies the
 * failure into one of:
 *
 *   - `eventlog_ref_rotated` — `session.eventLog.collectionId`
 *     changed since send. The most likely culprit is
 *     `rebuildEventLogFromCurrentPath` (called after navigateTree /
 *     branch operations). Renderer needs to resubscribe to the new
 *     ref; if you're seeing this AND the UI is stale, the rotation
 *     happened but the renderer isn't updating — check `useDb` /
 *     `useCollection` plumbing in chat-pane.
 *   - `main_seq_did_not_advance` — main's `live.seq` is unchanged.
 *     The append in `appendUserPromptEvent` / `onPiEvent` never ran.
 *     Look at the RPC layer (prompt / enqueue) and the main service.
 *   - `main_seq_advanced_but_renderer_stale` — main's seq grew but
 *     no matching user_prompt is in the renderer's events. Most
 *     likely a replica sync issue or a stale collection
 *     subscription.
 */
export function useMessageDeliveryInvariant(args: {
  chatId: string | null
  sessionId: string | null
  events: EventItem[]
  queueDraft: QueueDraftItem[]
  eventLogRef: EventLogRef
}) {
  const { chatId, sessionId, events, queueDraft, eventLogRef } = args
  const pendingRef = useRef<Map<string, Pending>>(new Map())
  const rpc = useRpc()

  // Keep the latest values in a ref so the timeout closure can see
  // them at fire time without recreating the timeout.
  const liveRef = useRef({ events, queueDraft, eventLogRef })
  liveRef.current = { events, queueDraft, eventLogRef }

  // Whenever events or queueDraft change, sweep pending sends and
  // resolve the ones that are now visible. We match by exact text +
  // a sentAt timestamp window to avoid resolving an old send with a
  // new identical message.
  useEffect(() => {
    if (pendingRef.current.size === 0) return
    for (const [id, p] of pendingRef.current) {
      if (p.path === "prompt") {
        const found = events.some(ev => {
          if (ev.kind !== "user_prompt") return false
          const text = (ev.payload as { text?: string } | undefined)?.text
          return text === p.text && ev.timestamp >= p.sentAt - 1000
        })
        if (found) pendingRef.current.delete(id)
      } else {
        const found = queueDraft.some(q => q.text === p.text)
        if (found) pendingRef.current.delete(id)
      }
    }
  }, [events, queueDraft])

  const track = useCallback(
    (text: string, path: Pending["path"]) => {
      if (!chatId) return
      const id = nanoid()
      const entry: Pending = {
        id,
        text,
        path,
        sentAt: Date.now(),
        sessionId,
        eventLogCollectionId: eventLogRef?.collectionId ?? null,
        seqAtSend: null,
      }
      // Snapshot main's seq counter at send time so we can compare on
      // failure. Best-effort: if the probe fails we just leave it null.
      if (sessionId) {
        rpc.pi.sessions
          .peekEventLogTail({ sessionId })
          .then(snap => {
            const e = pendingRef.current.get(id)
            if (e) e.seqAtSend = snap.seq
          })
          .catch(() => {})
      }
      pendingRef.current.set(id, entry)
      window.setTimeout(async () => {
        const still = pendingRef.current.get(id)
        if (!still) return
        pendingRef.current.delete(id)
        const {
          events: curEvents,
          queueDraft: curQueueDraft,
          eventLogRef: curRef,
        } = liveRef.current
        // Probe main for the post-mortem.
        let mainSnapshot: {
          eventLogRef: EventLogRef
          seq: number | null
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
            recentSeqs: Array<{
              seq: number
              kind: string
              timestamp: number
            }>
            hasUserPromptWithText: string | null
            probeError: string | null
          } | null
        } = {
          eventLogRef: null,
          seq: null,
          runtimeMismatch: null,
          lastConcatError: null,
          mainCollection: null,
        }
        if (sessionId) {
          try {
            const snap = await rpc.pi.sessions.peekEventLogTail({
              sessionId,
            })
            mainSnapshot = {
              eventLogRef: snap.eventLogRef,
              seq: snap.seq,
              runtimeMismatch: snap.runtimeMismatch,
              lastConcatError: snap.lastConcatError,
              mainCollection: snap.mainCollection,
            }
          } catch (err) {
            console.warn(
              "[invariant] peekEventLogTail failed during diagnosis:",
              err,
            )
          }
        }
        const verdict = classify({
          sendCollectionId: still.eventLogCollectionId,
          sendSeq: still.seqAtSend,
          currentRendererCollectionId: curRef?.collectionId ?? null,
          mainCollectionId: mainSnapshot.eventLogRef?.collectionId ?? null,
          mainSeq: mainSnapshot.seq,
          runtimeMismatched: mainSnapshot.runtimeMismatch?.mismatched ?? false,
          lastConcatError: mainSnapshot.lastConcatError,
          mainTotalCount:
            mainSnapshot.mainCollection?.totalCount ?? null,
          mainHasMatchingUserPrompt:
            !!mainSnapshot.mainCollection?.recentSeqs.some(s =>
              s.kind === "user_prompt"
              ? true
              : false,
            ) ||
            !!mainSnapshot.mainCollection?.recentSeqs.find(
              s =>
                s.kind === "user_prompt" &&
                s.timestamp >= still.sentAt - 1000,
            ),
          rendererTotalCount: curEvents.length,
          probeError: mainSnapshot.mainCollection?.probeError ?? null,
        })
        reportInvariant({
          chatId,
          kind:
            path === "prompt"
              ? "missing_user_prompt_event"
              : "missing_queue_draft_entry",
          message:
            path === "prompt"
              ? `Sent prompt didn't appear as a user_prompt event within ${TIMEOUT_MS}ms (verdict: ${verdict})`
              : `Enqueued prompt didn't appear in queueDraft within ${TIMEOUT_MS}ms (verdict: ${verdict})`,
          data: {
            sentText: still.text,
            sentAt: still.sentAt,
            elapsedMs: Date.now() - still.sentAt,
            sessionId: still.sessionId,
            verdict,
            // Side-by-side state so the failure is auditable. The
            // verdict above is the inference; this is the evidence.
            evidence: {
              atSend: {
                eventLogCollectionId: still.eventLogCollectionId,
                mainSeq: still.seqAtSend,
              },
              atTimeout: {
                rendererEventLogCollectionId:
                  curRef?.collectionId ?? null,
                mainEventLogCollectionId:
                  mainSnapshot.eventLogRef?.collectionId ?? null,
                mainSeq: mainSnapshot.seq,
                runtimeMismatch: mainSnapshot.runtimeMismatch,
                lastConcatError: mainSnapshot.lastConcatError,
                mainCollection: mainSnapshot.mainCollection,
                rendererTotalCount: curEvents.length,
              },
            },
            // Snapshot a tail of the renderer's events so the report
            // shows what WAS visible from the renderer's side at
            // failure time.
            rendererRecentEvents: curEvents.slice(-20).map(ev => ({
              seq: ev.seq,
              kind: ev.kind,
              timestamp: ev.timestamp,
            })),
            queueDraftSummary: curQueueDraft.map(q => ({
              text: q.text.slice(0, 80),
            })),
          },
        })
      }, TIMEOUT_MS)
    },
    [chatId, sessionId, eventLogRef, rpc],
  )

  return { track }
}

type Verdict =
  | "runtime_session_manager_mutated"
  | "main_concat_rejected"
  | "eventlog_ref_rotated"
  | "main_seq_did_not_advance"
  | "main_collection_missing_writes"
  | "renderer_subscription_dropped_updates"
  | "probe_failed"
  | "unknown"

/**
 * Reduce the probe + send-time snapshot into a one-line verdict that
 * names a likely culprit. Read the report's `evidence` block for the
 * raw numbers.
 */
function classify(args: {
  sendCollectionId: string | null
  sendSeq: number | null
  currentRendererCollectionId: string | null
  mainCollectionId: string | null
  mainSeq: number | null
  runtimeMismatched: boolean
  lastConcatError: { when: number; message: string } | null
  mainTotalCount: number | null
  mainHasMatchingUserPrompt: boolean
  rendererTotalCount: number
  probeError: string | null
}): Verdict {
  const {
    sendCollectionId,
    sendSeq,
    currentRendererCollectionId,
    mainCollectionId,
    mainSeq,
    runtimeMismatched,
    lastConcatError,
    mainTotalCount,
    mainHasMatchingUserPrompt,
    rendererTotalCount,
    probeError,
  } = args
  // 1. Pi runtime was mutated out from under us (the classic
  //    `createBranchedSession` foot-gun in a fork/clone path).
  if (runtimeMismatched) return "runtime_session_manager_mutated"
  // 2. We have a recorded concat rejection on the LiveSession.
  if (lastConcatError) return "main_concat_rejected"
  // 3. The eventLog collection ref changed since send (some path
  //    rotated it mid-flight, e.g. rebuild after navigateTree).
  if (
    sendCollectionId &&
    mainCollectionId &&
    sendCollectionId !== mainCollectionId
  ) {
    return "eventlog_ref_rotated"
  }
  // 4. We couldn't read the main collection at all; everything below
  //    is suspect.
  if (probeError) return "probe_failed"
  // 5. Main never advanced its in-memory seq counter — the prompt /
  //    enqueue never propagated through onPiEvent /
  //    appendUserPromptEvent.
  if (mainSeq != null && sendSeq != null && mainSeq <= sendSeq) {
    return "main_seq_did_not_advance"
  }
  // 6. Main says it appended (`mainSeq` advanced) but the actual
  //    collection in main's replica doesn't contain a matching
  //    user_prompt event for the text we sent. That means our
  //    write path is broken — attempts increment the counter but
  //    nothing lands in the collection.
  if (
    mainSeq != null &&
    sendSeq != null &&
    mainSeq > sendSeq &&
    !mainHasMatchingUserPrompt
  ) {
    return "main_collection_missing_writes"
  }
  // 7. Main's collection HAS the data (matching user_prompt is
  //    present), but the renderer's `useCollection` doesn't show
  //    it. The renderer's total item count is also lower than
  //    main's. That's a zenbu subscription bug — a real one,
  //    worth filing upstream.
  if (
    mainTotalCount != null &&
    rendererTotalCount < mainTotalCount &&
    mainHasMatchingUserPrompt
  ) {
    return "renderer_subscription_dropped_updates"
  }
  return "unknown"
}
