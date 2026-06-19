import { collection, z } from "@zenbujs/core/db"

// ---------------------------------------------------------------------------
// Session (one agent conversation backed by a pi session file)
//
// Moved from the app plugin (Phase 2 of the app decomposition): the pi
// plugin owns live AgentSession lifecycle, so it owns the session
// records, queue shadow, and event log. Chat tab/draft state stays in
// the app plugin (`root.app.chats` / `chatStates` / `chatWindows`) —
// that belongs to the chat surface, not the runtime.
// ---------------------------------------------------------------------------

const providerModel = z.object({
  provider: z.string(),
  id: z.string(),
})

const thinkingLevel = z.enum([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
])

const queueState = z.object({
  steering: z.array(z.string()),
  followUp: z.array(z.string()),
})

/**
 * Queue shadow. Pi only stores `string[]` for its steering/followUp
 * queues; anything richer (ids, images, editor state, createdAt,
 * edit-by-id) lives here and reconciles into pi via
 * `clearQueue() + replay` on edits.
 */
const queuedMessage = z.object({
  id: z.string(),
  text: z.string(),
  images: z
    .array(z.object({ blobId: z.string(), mimeType: z.string() }))
    .default([]),
  editorState: z.unknown().nullable().default(null),
  createdAt: z.number(),
  kind: z.enum(["steer", "followUp"]),
})

const eventItem = z.object({
  seq: z.number(),
  kind: z.string(),
  payload: z.unknown(),
  timestamp: z.number(),
})

const sessionStats = z.object({
  tokens: z.object({
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  cost: z.number(),
  contextUsage: z
    .object({
      tokens: z.number().nullable(),
      contextWindow: z.number(),
      percent: z.number().nullable(),
    })
    .nullable(),
  autoCompactionEnabled: z.boolean(),
})

export const session = z.object({
  id: z.string(),
  scopeId: z.string(),

  parentSessionId: z.string().nullable(),
  parentEntryId: z.string().nullable(),

  title: z.string(),
  sessionFile: z.string(),
  piSessionId: z.string(),
  createdAt: z.number(),
  lastActivityAt: z.number(),
  /** Unix ms the user most recently sent a prompt. Used to tell
   * whether a just-created chat has ever carried a real message. */
  lastMessageSentTime: z.number().nullable().default(null),

  model: providerModel.nullable(),
  thinkingLevel: thinkingLevel,
  isStreaming: z.boolean(),
  currentLeafEntryId: z.string().nullable(),
  queue: queueState,
  /** Snapshot of `stats.contextUsage.tokens` at `agent_start`,
   * cleared on `agent_end`. Subtract from live tokens to get the
   * current run's contribution (what the streaming indicator
   * shows). Uses pi's context-window measurement, not the billing
   * rollup (which double-counts across multi-turn runs). */
  runStartContextTokens: z.number().nullable().default(null),
  /** Unix ms the user most recently opened this session in any
   * window. Stamped by `SessionActivityService`. Compared with
   * `lastCompletedAt` to drive the unread-dot. */
  lastOpenedAt: z.number().nullable().default(null),
  /** Unix ms the agent last finished a turn (`agent_end`). Stamped
   * by `SessionsService`. Drives the unread-dot. */
  lastCompletedAt: z.number().nullable().default(null),
  /** Rich shadow of pi's queue. Authoritative for payload; pi is
   * authoritative for delivery ordering within each kind. */
  queueDraft: z.array(queuedMessage).default([]),
  subscriberCount: z.number(),
  leafCount: z.number(),
  branchSummary: z.string().nullable(),
  stats: sessionStats,
  /** Soft-delete: archived sessions are hidden from list UIs; data
   * is left intact. */
  archived: z.boolean().default(false),

  eventLog: collection(eventItem, { debugName: "events" }),
})

// ---------------------------------------------------------------------------
// Killed-agent + auto-resume signaling
//
// `SessionsService.dispose-live` syncs `killedSession` on every
// teardown (hot reload or shutdown), stamping each entry with the
// current process's `PROCESS_TOKEN`. The next `evaluate()` classifies
// at read time:
//
//   - processToken === current → hot reload. Main auto-resumes
//     silently and writes a `reloadToast` for the renderer.
//   - processToken !== current → process restart. Marker is left
//     for `<KilledAgentsWatcher />` to surface a Continue/Dismiss
//     toast and consume on display.
// ---------------------------------------------------------------------------

export const killedSession = z.object({
  sessionId: z.string(),
  killedAt: z.number(),
  /** Token unique to the process that wrote this marker. Empty
   * string sentinel for markers written before this field existed
   * (treated as shutdown to be conservative). */
  processToken: z.string().default(""),
})

export const reloadToast = z.object({
  sessionId: z.string(),
  resumedAt: z.number(),
})

/** One entry per model in Pi's registry, published by AuthService. */
export const modelInfo = z.object({
  provider: z.string(),
  id: z.string(),
  name: z.string(),
  api: z.string(),
  reasoning: z.boolean(),
  thinkingLevelMap: z.record(z.string(), z.string().nullable()).nullable(),
  input: z.array(z.string()),
  contextWindow: z.number(),
  maxTokens: z.number(),
})
