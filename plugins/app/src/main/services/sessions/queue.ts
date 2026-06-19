import { nanoid } from "nanoid"
import type { ImageContent } from "@earendil-works/pi-ai"
import type { SessionsService } from "../sessions"
import type { LiveSession } from "./live-session"
import { syncRuntime } from "./activation"
import { appendUserPromptEvent } from "./event-log"
import type { ImageRef, QueueKind, QueuedDraft } from "./types"

type Svc = SessionsService

/** Stamp `session.lastMessageSentTime = now` when a real user
 * message is sent. This distinguishes an unused ready chat from one
 * that has carried conversation content without needing a separate
 * metadata cache. */
export async function stampLastMessageSent(args: {
  svc: Svc
  sessionId: string
}): Promise<void> {
  const { svc, sessionId } = args
  const now = Date.now()
  await svc.ctx.db.client.update(root => {
    const session = root.app.sessions[sessionId]
    if (session) session.lastMessageSentTime = now
  })
}

export async function prompt(args: {
  svc: Svc
  sessionId: string
  text: string
  /** Verbatim composer doc text — the same value the user sees in the
   * input. Used for chat-history rendering so the user-message bubble
   * can re-render via the read-only composer with pill widgets. When
   * omitted, falls back to `text` (legacy callers). */
  displayText?: string
  /** Image attachments forwarded directly to pi as `PromptOptions.images`. */
  images?: ImageContent[]
  /** Stable references for the same images (blobId + mimeType). Stored
   * on the user_prompt event so chat history can re-render the image
   * after a reload, without keeping base64 in the event log. */
  imageRefs?: ImageRef[]
  /** Optional editor state for rehydrating pills on re-edit. */
  editorState?: unknown
  streamingBehavior?: "steer" | "followUp"
}): Promise<void> {
  const { svc } = args
  const live = await svc.ensureLive(args.sessionId)
  // When streaming, route through the shadow so the QueuedMessages
  // panel sees this item. The renderer should normally call enqueue
  // directly, but supporting this path keeps callers that just say
  // "send" working uniformly.
  if (live.pi.isStreaming) {
    const kind: QueueKind = args.streamingBehavior ?? "followUp"
    await enqueue({
      svc,
      sessionId: args.sessionId,
      text: args.text,
      displayText: args.displayText,
      kind,
      images: args.images,
      imageRefs: args.imageRefs,
      editorState: args.editorState,
    })
    return
  }
  const ctx = {
    db: svc.ctx.db.client,
    getLive: (id: string) => svc.live.get(id),
  }
  await appendUserPromptEvent({
    ctx,
    live,
    text: args.displayText ?? args.text,
    imageRefs: args.imageRefs,
  })
  await stampLastMessageSent({ svc, sessionId: args.sessionId })
  // Stake out the matching pi user message_end as "already in our
  // log" so onPiEvent doesn't synthesize a duplicate `user_prompt`.
  live.expectedUserMessages.push({ kind: "preStaged" })
  await live.pi.prompt(args.text, { images: args.images })
}

/**
 * Append a rich message to the shadow and route into pi. Always
 * dispatched live — there's no held/paused state anymore.
 */
export async function enqueue(args: {
  svc: Svc
  sessionId: string
  text: string
  /** See `prompt.displayText`. Defaults to `text`. */
  displayText?: string
  kind: QueueKind
  images?: ImageContent[]
  imageRefs?: ImageRef[]
  editorState?: unknown
}): Promise<void> {
  const { svc } = args
  const live = await svc.ensureLive(args.sessionId)
  await withQueueLock({
    svc,
    sessionId: args.sessionId,
    fn: async () => {
      const item: QueuedDraft = {
        id: nanoid(),
        // Persist the display form so the queued-messages UI renders
        // the same way the user typed it. Wire text (with metadata)
        // is rebuilt from the display text only when re-dispatching.
        text: args.displayText ?? args.text,
        images: args.imageRefs ?? [],
        editorState: args.editorState ?? null,
        createdAt: Date.now(),
        kind: args.kind,
      }
      await svc.ctx.db.client.update(root => {
        const s = root.app.sessions[args.sessionId]
        if (!s) return
        s.queueDraft.push(item)
      })
      // Register the matching pi user message_end so onPiEvent
      // synthesizes a `user_prompt` event (with the right
      // displayText + imageRefs) when pi finally delivers this
      // item. Without this the chat surface never renders the
      // queued/steer message.
      live.expectedUserMessages.push({
        kind: "synthesize",
        displayText: item.text,
        imageRefs: item.images,
      })
      await dispatchToPi({
        live,
        kind: args.kind,
        text: args.text,
        images: args.images,
      })
    },
  })
  // Enqueued items are user messages too — treat them as "last
  // message sent" for sort purposes, even if pi hasn't drained
  // them yet.
  await stampLastMessageSent({ svc, sessionId: args.sessionId })
}

/**
 * Edit a queued shadow item. The implementation is the only one pi's
 * API permits: clearQueue + replay surviving items in order.
 */
export async function editQueued(args: {
  svc: Svc
  sessionId: string
  id: string
  text: string
  images?: ImageContent[]
  imageRefs?: ImageRef[]
  editorState?: unknown
  kind?: QueueKind
}): Promise<void> {
  const { svc } = args
  const live = await svc.ensureLive(args.sessionId)
  await withQueueLock({
    svc,
    sessionId: args.sessionId,
    fn: async () => {
      await svc.ctx.db.client.update(root => {
        const s = root.app.sessions[args.sessionId]
        if (!s) return
        const item = s.queueDraft.find(m => m.id === args.id)
        if (!item) return
        item.text = args.text
        if (args.imageRefs) item.images = args.imageRefs
        if ("editorState" in args) item.editorState = args.editorState ?? null
        if (args.kind) item.kind = args.kind
      })
      await replayShadowIntoPi({ svc, live, sessionId: args.sessionId })
    },
  })
}

export async function deleteQueued(args: {
  svc: Svc
  sessionId: string
  id: string
}): Promise<void> {
  const { svc } = args
  const live = await svc.ensureLive(args.sessionId)
  await withQueueLock({
    svc,
    sessionId: args.sessionId,
    fn: async () => {
      await svc.ctx.db.client.update(root => {
        const s = root.app.sessions[args.sessionId]
        if (!s) return
        s.queueDraft = s.queueDraft.filter(m => m.id !== args.id)
      })
      await replayShadowIntoPi({ svc, live, sessionId: args.sessionId })
    },
  })
}

/**
 * Send a specific queued item right now: interrupt whatever pi is
 * doing, fire the item as a fresh `prompt()`, and re-dispatch the
 * remaining queue items into pi so they fire after the new turn.
 *
 * This is the "jump the line" operation, used when the user wants
 * to redirect the agent into a particular queued message instead
 * of letting it drain in order.
 */
export async function sendQueuedNow(args: {
  svc: Svc
  sessionId: string
  id: string
}): Promise<void> {
  const { svc } = args
  const live = await svc.ensureLive(args.sessionId)
  const ctx = {
    db: svc.ctx.db.client,
    getLive: (id: string) => svc.live.get(id),
  }
  let dispatched = false
  await withQueueLock({
    svc,
    sessionId: args.sessionId,
    fn: async () => {
      const s = svc.ctx.db.client.readRoot().app.sessions[args.sessionId]
      const item = s?.queueDraft.find(m => m.id === args.id)
      if (!item) return

      // 1. Interrupt the current turn (no-op if pi is idle).
      await live.pi.abort()

      // 1b. `pi.abort()` only signals the active run — it does NOT
      //     touch pi's internal steering/followUp queues. Any items
      //     we previously dispatched via `enqueue` are still sitting
      //     in pi's queue, including the one we're about to send
      //     now. If we leave them there, the next `pi.prompt()` will
      //     call `getSteeringMessages()` at the top of its loop and
      //     drain those items into the same turn — re-emitting a
      //     user `message_end` for each one, which `onPiEvent`
      //     would synthesize a duplicate `user_prompt` for.
      //
      //     Clear pi's queue and drop the matching `synthesize`
      //     expectations now. The shadow stays authoritative; step
      //     4 below replays the surviving items back into pi after
      //     the new prompt completes.
      live.pi.clearQueue()
      dropSynthesizeExpectations({ live })

      // 2. Drop the item from the shadow so the upcoming replay
      //    doesn't re-dispatch it as a queue entry.
      await svc.ctx.db.client.update(root => {
        const ss = root.app.sessions[args.sessionId]
        if (!ss) return
        ss.queueDraft = ss.queueDraft.filter(m => m.id !== args.id)
      })

      // 3. Fire the item as a fresh prompt. Mirrors `prompt()`'s
      //    not-streaming branch: we own the user_prompt event and
      //    stake a `preStaged` expectation so onPiEvent doesn't
      //    synthesize a duplicate.
      await appendUserPromptEvent({
        ctx,
        live,
        text: item.text,
        imageRefs: item.images,
      })
      live.expectedUserMessages.push({ kind: "preStaged" })
      await live.pi.prompt(item.text)

      // 4. Reconcile pi's queue with the now-smaller shadow. Pi's
      //    queue was cleared in step 1b, so this is really just
      //    re-dispatching the surviving shadow items in order so
      //    they drain after the new prompt finishes.
      //    `dropSynthesizeExpectations` inside replay preserves
      //    the `preStaged` entry we just pushed.
      await replayShadowIntoPi({ svc, live, sessionId: args.sessionId })
      dispatched = true
    },
  })
  if (dispatched) await stampLastMessageSent({ svc, sessionId: args.sessionId })
  await syncRuntime({ svc, live })
}

/** Per-session async mutex protecting all queue mutations. Without
 * this, concurrent enqueue/edit/delete can race with each other and
 * with `clearQueue + replay`, leaving pi and the shadow out of
 * sync. */
async function withQueueLock<T>(args: {
  svc: Svc
  sessionId: string
  fn: () => Promise<T>
}): Promise<T> {
  const { svc, sessionId, fn } = args
  const prev = svc.queueLocks.get(sessionId) ?? Promise.resolve()
  let release!: () => void
  const ticket = new Promise<void>(r => (release = r))
  svc.queueLocks.set(sessionId, ticket)
  try {
    await prev
    return await fn()
  } finally {
    release()
    if (svc.queueLocks.get(sessionId) === ticket) {
      svc.queueLocks.delete(sessionId)
    }
  }
}

/** Send one item to pi based on kind. Used by enqueue and replay. */
async function dispatchToPi(args: {
  live: LiveSession
  kind: QueueKind
  text: string
  images?: ImageContent[]
}) {
  const { live, kind, text, images } = args
  if (kind === "steer") {
    await live.pi.steer(text, images)
  } else {
    await live.pi.followUp(text, images)
  }
}

/**
 * Make pi's queue match the shadow's non-paused items, in shadow
 * order, by kind. The only knob pi gives us for this is
 * `clearQueue()` + per-item `steer`/`followUp` calls.
 *
 * Image *bytes* aren't replayed (we only persisted refs, not
 * base64). That's OK: pi's queue is delivered into a follow-up turn
 * where the bytes are recovered from the blob store at submit time.
 * If we ever need to replay with bytes, hydrate them from
 * `chatBlobs` here.
 */
async function replayShadowIntoPi(args: {
  svc: Svc
  live: LiveSession
  sessionId: string
}) {
  const { svc, live, sessionId } = args
  live.pi.clearQueue()
  // Pi's queue is now empty — the synthesize expectations we had
  // for items in that queue are dead. Keep any preStaged entries
  // (their `pi.prompt` call is still in flight independent of
  // the queue) and re-register synthesize entries for each item
  // we're about to re-dispatch.
  dropSynthesizeExpectations({ live })
  const s = svc.ctx.db.client.readRoot().app.sessions[sessionId]
  if (!s) return
  for (const item of s.queueDraft) {
    live.expectedUserMessages.push({
      kind: "synthesize",
      displayText: item.text,
      imageRefs: item.images,
    })
    await dispatchToPi({ live, kind: item.kind, text: item.text })
  }
}

/** Drop every `synthesize` expectation, leaving `preStaged` ones
 * in place. Call this whenever we `pi.clearQueue()`: any queued
 * items pi was holding are now gone, so the matching pi
 * `message_end` events will never fire. */
function dropSynthesizeExpectations(args: { live: LiveSession }): void {
  args.live.expectedUserMessages = args.live.expectedUserMessages.filter(
    e => e.kind !== "synthesize",
  )
}
