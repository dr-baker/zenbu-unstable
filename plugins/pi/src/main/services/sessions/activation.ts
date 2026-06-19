import os from "node:os"
import path from "node:path"
import { nanoid } from "nanoid"
import {
  type AgentSessionEvent,
  type CreateAgentSessionOptions,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent"
import {
  collectExtraAgentsFiles,
  formatExtraDirsPrompt,
} from "../../lib/extra-dirs"
import { LiveSession } from "./live-session"
import type { SessionsService } from "../sessions"

type Svc = SessionsService
import { computeStats, countLeaves, latestBranchSummary } from "./stats"
import {
  extractTextContent,
  findChatIdForSession,
  resolveSessionLabel,
} from "./labels"
import {
  readMaxEventLogSeq,
  safeConcatEventLog,
} from "./event-log"
import {
  compactAgentEventForEventLog,
  compactAgentEventForEventLogSync,
  toolExecutionEndHasImage,
} from "./event-log-payloads"
import type { EventItem, ProviderModelRef, QueuedDraft, Session } from "./types"

export const PI_SESSION_DIR = path.join(
  os.homedir(),
  ".zenbu",
  "pi-sessions",
)

export async function activate(args: {
  svc: Svc
  sessionId: string
}): Promise<LiveSession> {
  const { svc, sessionId } = args
  const record = requireRecord({ svc, sessionId })
  const scope = svc.ctx.db.client.readRoot().app.scopes[record.scopeId]
  if (!scope) {
    throw new Error(
      `unknown scope ${record.scopeId} for session ${sessionId}`,
    )
  }
  const sm = SessionManager.open(record.sessionFile, PI_SESSION_DIR)
  const scopeId = record.scopeId
  const piConfig = await svc.ctx.piRuntime.getSessionConfig({
    sessionId,
    scopeId,
    cwd: scope.directory,
  })
  const additionalExtensionPaths = piConfig.extensionPaths
  const agentDir = getAgentDir()
  // The two override closures below intentionally re-read the scope
  // from the db on every call rather than capturing the snapshot
  // taken at activation time. That way, a later
  // `resourceLoader.reload()` (fired by the `scopes` subscription
  // we install below) picks up dirs the user (or another service)
  // appended to `extraDirectories` without us having to rebuild
  // the loader from scratch.
  const getExtraDirs = (): readonly string[] => {
    const s = svc.ctx.db.client.readRoot().app.scopes[scopeId]
    return s?.extraDirectories ?? []
  }
  const resourceLoader = new DefaultResourceLoader({
    cwd: scope.directory,
    agentDir,
    additionalExtensionPaths,
    eventBus: piConfig.eventBus,
    // Concatenate pi's primary-cwd AGENTS.md scan with one
    // `loadProjectContextFiles` call per extra dir. Pi feeds
    // the resulting array straight into the system prompt's
    // "<project_context>" block, so adding entries here is
    // semantically equivalent to having one giant AGENTS.md at
    // the cwd that imported all the others.
    agentsFilesOverride: base => {
      const extras = collectExtraAgentsFiles(
        getExtraDirs(),
        agentDir,
        base.agentsFiles,
      )
      return extras.length === 0
        ? base
        : { agentsFiles: [...base.agentsFiles, ...extras] }
    },
    // Append a markdown section that explicitly *names* the extra
    // dirs so the agent treats them as in-bounds for edits, not
    // just as readable context. Pi places each appendSystemPrompt
    // entry after the default system prompt; an empty list means
    // we contribute nothing.
    appendSystemPromptOverride: base => {
      const section = formatExtraDirsPrompt(getExtraDirs())
      return section ? [...base, section] : base
    },
  })
  await resourceLoader.reload()

  const options: CreateAgentSessionOptions = {
    cwd: scope.directory,
    sessionManager: sm,
    authStorage: svc.auth,
    modelRegistry: svc.models,
    resourceLoader,
  }
  if (record.model) {
    const model = svc.models.find(record.model.provider, record.model.id)
    if (model) options.model = model
  }

  const { session } = await createAgentSession(options)
  const existingTitle = record.title?.trim()
  if (!session.sessionName && existingTitle && existingTitle !== "Untitled") {
    session.setSessionName(existingTitle)
  }

  const live = new LiveSession({
    sessionId,
    pi: session,
    onEvent: (l, e) => void onPiEvent({ svc, live: l, event: e }),
  })
  // Restore `live.seq` from the existing eventLog so new appends
  // don't collide with items written by a previous LiveSession for
  // the same session id (the case that hits us after a hot reload
  // or process restart). Without this, every fresh activate
  // restarts the counter at 0, materialize.ts emits duplicate
  // React keys (`user-1`, `assistant-2-0`, …), and continued-after-
  // reload turns appear to vanish in the chat surface even though
  // they really are in the collection.
  live.seq = await readMaxEventLogSeq({
    ctx: { db: svc.ctx.db.client, getLive: id => svc.live.get(id) },
    sessionId,
  })
  live.extraDirsSnapshot = [...scope.extraDirectories]
  svc.live.set(sessionId, live)

  // React to runtime changes in `extraDirectories` for this
  // scope. The DB replica fans changes out to every process
  // instantly, so a renderer-side mutation (or another service
  // calling `db.client.update`) lands here without an RPC round
  // trip. Diff against the cached snapshot to figure out what
  // changed; on any change reload the resource loader (so the
  // overrides above see the new list / load the new AGENTS.md)
  // and drop a quiet "aside" into pi so the agent gets a
  // mid-session notification.
  const unsubscribeScopes = svc.ctx.db.client.app.scopes.subscribe(() => {
    void onScopesChanged({ svc, live, scopeId })
  })
  live.addDisposer(unsubscribeScopes)

  await svc.syncPiRuntimeCommands(live)
  await syncRuntime({ svc, live })
  return live
}

/**
 * Compare the live session's cached `extraDirsSnapshot` with the
 * current `scope.extraDirectories`. If they differ, reload the
 * resource loader (so its overrides re-read the live list and
 * re-scan AGENTS.md files) and send a quiet aside to pi so the
 * agent learns about the change on its next turn without us
 * interrupting the current one.
 */
async function onScopesChanged(args: {
  svc: Svc
  live: LiveSession
  scopeId: string
}): Promise<void> {
  const { svc, live, scopeId } = args
  const scope = svc.ctx.db.client.readRoot().app.scopes[scopeId]
  if (!scope) return
  const before = live.extraDirsSnapshot
  const after = scope.extraDirectories
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter(d => !beforeSet.has(d))
  const removed = before.filter(d => !afterSet.has(d))
  if (added.length === 0 && removed.length === 0) return
  live.extraDirsSnapshot = [...after]
  try {
    await live.pi.resourceLoader.reload()
  } catch (err) {
    console.warn(
      "[sessions] resourceLoader.reload() after extra-dirs change failed:",
      err,
    )
  }
  const lines: string[] = []
  if (added.length > 0) {
    lines.push(
      `The following working directories were added to this session and are now available to you:`,
    )
    for (const dir of added) lines.push(`- \`${dir}\``)
  }
  if (removed.length > 0) {
    if (lines.length > 0) lines.push("")
    lines.push(
      `The following working directories were removed and are no longer in scope:`,
    )
    for (const dir of removed) lines.push(`- \`${dir}\``)
  }
  if (added.length > 0) {
    lines.push("")
    lines.push(
      "Their AGENTS.md files (if any) have been merged into your context. You may read, edit, and run commands in these directories as needed.",
    )
  }
  const content = lines.join("\n")
  try {
    await live.pi.sendCustomMessage(
      {
        customType: "extraDirsChanged",
        content,
        // `display: false` keeps this aside out of the user-visible
        // chat surface. It's purely model-side context.
        display: false,
        details: { added, removed },
      },
      { deliverAs: "nextTurn" },
    )
  } catch (err) {
    console.warn(
      "[sessions] sendCustomMessage(extraDirsChanged) failed:",
      err,
    )
  }
}

/**
 * Coalesced flusher for a single live session's pending event-log
 * items. Called at most once per microtask (see
 * `LiveSession.eventFlushScheduled`). Items are sorted by `seq` so
 * the rare async `tool_execution_end`-with-image path can't reorder
 * against sync events that landed in the buffer while it was awaiting.
 */
function flushPendingEventItems(args: { svc: Svc; live: LiveSession }) {
  const { svc, live } = args
  live.eventFlushScheduled = false
  if (live.pendingEventItems.length === 0) return
  const items = live.pendingEventItems.splice(0)
  // Sort defensively: with an all-sync producer the buffer is already
  // monotonic, but the async image path may have pushed an older `seq`
  // after newer ones landed during its await.
  items.sort((a, b) => a.seq - b.seq)
  const ctx = {
    db: svc.ctx.db.client,
    getLive: (id: string) => svc.live.get(id),
  }
  void safeConcatEventLog({
    ctx,
    sessionId: live.sessionId,
    items,
    context: "onPiEvent flush",
  })
}

function scheduleEventFlush(args: { svc: Svc; live: LiveSession }) {
  const { live } = args
  if (live.eventFlushScheduled) return
  live.eventFlushScheduled = true
  queueMicrotask(() => flushPendingEventItems(args))
}

export async function onPiEvent(args: {
  svc: Svc
  live: LiveSession
  event: AgentSessionEvent
}) {
  const { svc, live, event } = args
  live.seq++

  // Skip the synthetic user-side message events: we already
  // append a richer `user_prompt` item from `prompt()` (with
  // `imageRefs`), and the pi-emitted user `message_start` /
  // `message_end` would just double up in materialization.
  // Everything else is appended to the event log after payload
  // compaction. Pi's raw streaming events include full partial
  // message snapshots on every delta; storing those verbatim grows
  // O(n²) for long tool calls and can turn one chat into hundreds
  // of MB. See `event-log-payloads.ts` for the compact format.
  const isUserMessageEvent =
    (event.type === "message_start" || event.type === "message_end") &&
    event.message.role === "user"

  if (!isUserMessageEvent) {
    // Hot path: sync compaction + buffered concat. Pi delivers events
    // at streaming-token cadence — doing one `await concat([item])`
    // per event turned every token into a WS roundtrip and slammed
    // both replicas with a SubscriptionRef notification per token.
    // We compact synchronously, push into the per-session buffer,
    // and a microtask drains the whole tick's worth of events into
    // a single concat. See `LiveSession.pendingEventItems`.
    const seq = live.seq
    const timestamp = Date.now()
    const kind = event.type
    if (toolExecutionEndHasImage(event)) {
      // Rare: tool returned an inline image. We still need to spill
      // its base64 payload into a blob ref before persisting, which
      // is async. Build and push synchronously after the await — the
      // flusher sorts by `seq` so anything that arrived while we were
      // awaiting stays in the right order.
      const payload = await compactAgentEventForEventLog(event, {
        createBlob: data => svc.ctx.db.client.createBlob(data, true),
      })
      live.pendingEventItems.push({ seq, kind, payload, timestamp })
    } else {
      live.pendingEventItems.push({
        seq,
        kind,
        payload: compactAgentEventForEventLogSync(event),
        timestamp,
      })
    }
    scheduleEventFlush({ svc, live })
  } else if (event.type === "message_end") {
    // A pi user `message_end` is the moment a user message actually
    // lands in the conversation — whether it came from `prompt()`,
    // `enqueue()` (queued/steer), or pi delivering a queue item we
    // dispatched. We shift the FIFO of `expectedUserMessages` to
    // figure out which case we're in:
    //   - preStaged   — `prompt()` already appended a richer
    //                  `user_prompt` (with imageRefs, displayText).
    //                  Nothing to do; the materializer renders
    //                  that pre-staged event.
    //   - synthesize  — queued/steer delivery. Pi just "unqueued"
    //                  the message and is about to start the
    //                  assistant turn; append a `user_prompt`
    //                  event now so the chat surface renders the
    //                  user-message bubble before the assistant's.
    //   - <empty>     — unexpected (e.g. branch-restore replays
    //                  pi events outside our tracking). Fall back
    //                  to extracting text from the pi event so the
    //                  message at least shows up; imageRefs lost.
    const expected = live.expectedUserMessages.shift()
    if (!expected || expected.kind === "synthesize") {
      const displayText =
        expected?.kind === "synthesize"
          ? expected.displayText
          : extractTextContent({
              content: (event.message as { content?: unknown }).content,
            })
      const imageRefs =
        expected?.kind === "synthesize" ? expected.imageRefs : []
      const item: EventItem = {
        seq: live.seq,
        kind: "user_prompt",
        payload:
          imageRefs.length > 0
            ? { text: displayText, images: imageRefs }
            : { text: displayText },
        timestamp: Date.now(),
      }
      // Route through the same buffer as the regular event path so a
      // synthesized user_prompt can't get reordered ahead of streaming
      // events that pi already dispatched into the buffer this tick.
      live.pendingEventItems.push(item)
      scheduleEventFlush({ svc, live })
    }
  }

  // Snapshot the context-window baseline at the start of every
  // agent run. The renderer subtracts this from the live
  // `stats.contextUsage.tokens` to display the per-run "Xs, N
  // tokens" counter while streaming.
  //
  // We use pi's context-window measurement here (not the billing
  // rollup `stats.tokens.input/output/...`). The billing rollup
  // sums every LLM call's `usage.input` across the run, and each
  // call re-sends the entire growing context — so the rollup
  // balloons WAY past the actual conversation growth on
  // multi-turn (tool-call) runs. `contextUsage.tokens` is the
  // same value the context-view and status-bar already show, so
  // the two numbers tick at the same rate.
  //
  // Cleared on `agent_end` so the next prompt starts from a
  // fresh baseline.
  if (event.type === "agent_start") {
    // Track the turn boundary ourselves — see `LiveSession.inAgentLoop`
    // for why we don't rely on `pi.isStreaming` here.
    live.inAgentLoop = true
    await svc.ctx.db.client.update(root => {
      const s = root.pi.sessions[live.sessionId]
      if (!s) return
      s.runStartContextTokens = s.stats.contextUsage?.tokens ?? 0
    })
  } else if (event.type === "agent_end") {
    live.inAgentLoop = false
    // Stamp `lastCompletedAt` so the unread-dot logic can detect
    // a turn finished. If the user is currently viewing the
    // session (tracked by `SessionActivityService`), also bump
    // `lastOpenedAt` so the dot never appears on a chat they're
    // already looking at. Anyone else (other windows, sidebar
    // rows) sees the dot until they focus the chat.
    const isViewed = svc.ctx.sessionActivity.isViewed(live.sessionId)
    const now = Date.now()
    await svc.ctx.db.client.update(root => {
      const s = root.pi.sessions[live.sessionId]
      if (!s) return
      s.runStartContextTokens = null
      s.lastCompletedAt = now
      if (isViewed) s.lastOpenedAt = now
    })
    // Notify the renderer when the user isn't looking at this
    // session. Mirrors the sidebar's unread-dot heuristic
    // (`lastCompletedAt > (lastOpenedAt ?? 0)` + not the active
    // tab) so the toast only fires for the same set of sessions
    // that would otherwise quietly grow a dot. Pre-resolves the
    // label and chatId here so the renderer doesn't have to
    // subscribe to extra db keys just to render the toast.
    if (!isViewed) {
      const root = svc.ctx.db.client.readRoot()
      const session = root.pi.sessions[live.sessionId]
      const chatId = findChatIdForSession({ root, sessionId: live.sessionId })
      const label = resolveSessionLabel({ root, session })
      svc.ctx.rpc.emit.pi.agentCompletedUnviewed({
        sessionId: live.sessionId,
        chatId,
        label,
      })
    }
  }

  if (
    event.type === "agent_start" ||
    event.type === "agent_end" ||
    event.type === "turn_end" ||
    event.type === "queue_update" ||
    event.type === "thinking_level_changed" ||
    event.type === "session_info_changed"
  ) {
    await syncRuntime({ svc, live })
  }

}

export async function syncRuntime(args: {
  svc: Svc
  live: LiveSession
}) {
  const { svc, live } = args
  const pi = live.pi
  const modelRef: ProviderModelRef | null = pi.model
    ? { provider: pi.model.provider, id: pi.model.id }
    : null
  const thinkingLevel = pi.thinkingLevel as Session["thinkingLevel"]
  const isStreaming = pi.isStreaming
  const leafId = pi.sessionManager.getLeafId() ?? null
  const steering = [...pi.getSteeringMessages()]
  const followUp = [...pi.getFollowUpMessages()]
  const leafCount = countLeaves({ entries: pi.sessionManager.getEntries() })
  const branchSummary = latestBranchSummary({ branch: pi.sessionManager.getBranch() })
  const stats = computeStats({ pi })
  await svc.ctx.db.client.update(root => {
    const s = root.pi.sessions[live.sessionId]
    if (!s) return
    s.title = pi.sessionName ?? "Untitled"
    s.model = modelRef
    s.thinkingLevel = thinkingLevel
    s.isStreaming = isStreaming
    s.currentLeafEntryId = leafId
    s.queue = { steering, followUp }
    s.leafCount = leafCount
    s.branchSummary = branchSummary
    s.stats = stats
    s.lastActivityAt = Date.now()
  })
  // Drop shadow items pi no longer holds (i.e. delivered) so the
  // panel updates as pi drains the queue. Only touches items in
  // `pending` state; `paused` items live entirely client-side.
  reconcileQueueDraft({ svc, live, piSteer: steering, piFollow: followUp })
}

/**
 * Pi's queue is the authority for delivery; our shadow is the
 * authority for payload. After every `queue_update` we walk our
 * shadow heads and drop any `pending` item whose text no longer
 * appears at the corresponding pi-queue head.
 *
 * Multiplicity is handled by consuming pi entries left-to-right as
 * we match shadow items in shadow order. A genuine drift (shadow
 * head text not present in pi at all) logs a warning and rebuilds
 * the shadow from pi's strings with synthetic ids.
 */
function reconcileQueueDraft(args: {
  svc: Svc
  live: LiveSession
  piSteer: readonly string[]
  piFollow: readonly string[]
}) {
  const { svc, live, piSteer, piFollow } = args
  void svc.ctx.db.client
    .update(root => {
      const s = root.pi.sessions[live.sessionId]
      if (!s) return
      const steerPi = [...piSteer]
      const followPi = [...piFollow]
      const keep: QueuedDraft[] = []
      let drift = false
      for (const item of s.queueDraft) {
        const pool = item.kind === "steer" ? steerPi : followPi
        const idx = pool.indexOf(item.text)
        if (idx >= 0) {
          pool.splice(idx, 1)
          keep.push(item)
        }
        // else: pi already delivered this item → drop from shadow.
      }
      // If pi still has strings we didn't account for, the shadow
      // drifted (e.g. a programmatic enqueue from elsewhere). Adopt
      // them so the panel stays consistent.
      if (steerPi.length > 0 || followPi.length > 0) {
        drift = true
        for (const text of steerPi) {
          keep.push({
            id: nanoid(),
            text,
            images: [],
            editorState: null,
            createdAt: Date.now(),
            kind: "steer",
          })
        }
        for (const text of followPi) {
          keep.push({
            id: nanoid(),
            text,
            images: [],
            editorState: null,
            createdAt: Date.now(),
            kind: "followUp",
          })
        }
      }
      if (drift) {
        console.warn(
          "[sessions] queueDraft drift; adopted pi state",
          live.sessionId,
        )
      }
      s.queueDraft = keep
    })
    .catch(err => console.error("[sessions] reconcileQueueDraft failed:", err))
}

export function requireRecord(args: {
  svc: Svc
  sessionId: string
}): Session {
  const record = args.svc.ctx.db.client.readRoot().pi.sessions[args.sessionId]
  if (!record) {
    throw new Error(`unknown session ${args.sessionId}`)
  }
  return record
}

/**
 * Snapshot of the human-readable label for a session at the time
 * of call. Session display names are owned by Pi's session file;
 * `session.title` is Zenbu's cached copy from `syncRuntime()`.
 */
export function resolveSessionLabelSnapshot(args: {
  svc: Svc
  sessionId: string
}): string {
  const { svc, sessionId } = args
  const session = svc.ctx.db.client.readRoot().pi.sessions[sessionId]
  const title = session?.title?.trim()
  if (title && title !== "Untitled") return title
  return ""
}
