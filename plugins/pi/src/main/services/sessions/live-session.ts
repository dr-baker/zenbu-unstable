import { nanoid } from "nanoid"
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent"
import type { EventItem, ExpectedUserMessage } from "./types"

/**
 * Random token unique to this Node process. Stamped onto every
 * killedSession marker `dispose-live` writes; the next `evaluate()`
 * compares it against its own `PROCESS_TOKEN` to decide whether
 * a marker came from a hot reload (same process → auto-resume) or
 * a real quit (different process → show the user a toast).
 *
 * Stored on `globalThis` so module-level re-evaluation (which is
 * what zenbu's hot reload actually does) keeps the same token.
 * Plain module-scope `const PROCESS_TOKEN = nanoid()` re-randomises
 * on every hot reload, which makes every hot reload look like a
 * process restart — wrong direction.
 */
export const PROCESS_TOKEN: string = (() => {
  const g = globalThis as unknown as Record<string, string | undefined>
  const KEY = "__zenbu_sessions_process_token"
  let existing = g[KEY]
  if (typeof existing !== "string" || existing.length === 0) {
    existing = nanoid()
    g[KEY] = existing
  }
  return existing
})()

export class LiveSession {
  seq = 0
  readonly subscribers = new Set<string>()
  /**
   * True between `agent_start` and `agent_end` events from pi.
   * Strictly tighter than `pi.isStreaming`, which can stay `true`
   * for a beat after the turn really finished (pi flushes some
   * internal bookkeeping post-agent_end). The `dispose-live`
   * cleanup uses this to decide whether the session is mid-turn
   * — if we trusted `pi.isStreaming` instead, quitting the app
   * immediately after a visibly-complete turn would still stamp
   * a killedSessions marker and surprise-resume on the next boot.
   *
   * Defaults to `false` because a freshly activated session is
   * between turns by definition; `onPiEvent` flips it back on
   * the next `agent_start`.
   */
  inAgentLoop = false
  /** FIFO mirror of user messages we've sent to pi but haven't yet
   * seen a `message_end` for. Shifted on each pi user `message_end`.
   * See `ExpectedUserMessage` for what each entry means. */
  expectedUserMessages: ExpectedUserMessage[] = []
  /** Stamped whenever a concat against this session's eventLog
   * rejects. `peekEventLogTail` surfaces it so the invariant
   * report can tell apart "write actually failed" from "renderer
   * subscription dropped". */
  lastConcatError: { when: number; message: string } | null = null
  /**
   * Per-session microtask-flushed buffer of event-log items. `onPiEvent`
   * pushes here instead of doing one `concat([item])` per pi event;
   * a microtask drains the buffer into a single `concat(items)` call.
   *
   * Why this matters: kyju turns every `.concat()` into a separate WS
   * write + state transition + subscriber notification on both the
   * main and renderer replicas. On a fast model (or a tool-call-heavy
   * turn) pi can deliver hundreds of streaming events per second.
   * Without coalescing, every token becomes its own roundtrip and the
   * UI stutters even on a small chat. Coalescing one `requestAnimationFrame`-
   * equivalent worth of events into a single concat collapses N
   * WS frames + N renderer renders into 1. Items are sorted by `seq`
   * at flush time, which means the (rare) `tool_execution_end`-with-image
   * path can `await` blob extraction without reordering the events
   * that landed in the buffer while it was awaiting.
   */
  pendingEventItems: EventItem[] = []
  /** True when a microtask flush of `pendingEventItems` is already queued.
   * Prevents queueing N microtasks for N pushes within one tick. */
  eventFlushScheduled = false
  /** Last-seen snapshot of the owning scope's `extraDirectories`.
   * The scope-subscription handler diffs against this to figure out
   * which dirs were added or removed when the user (or another
   * service) mutates the scope mid-session. Initialised at
   * `activate()` time. */
  extraDirsSnapshot: readonly string[] = []
  /** Cleanup callbacks registered alongside the pi subscription. Run
   * in order on `dispose()`. Used for things like the db subscription
   * that watches `extraDirectories` — their lifetime is the same as
   * the live pi session. */
  private readonly extraDisposers: Array<() => void> = []
  private readonly unsubscribePi: () => void

  constructor(args: {
    sessionId: string
    pi: AgentSession
    onEvent: (live: LiveSession, event: AgentSessionEvent) => void
  }) {
    this.sessionId = args.sessionId
    this.pi = args.pi
    this.unsubscribePi = args.pi.subscribe(event => args.onEvent(this, event))
  }

  readonly sessionId: string
  readonly pi: AgentSession

  addDisposer(fn: () => void) {
    this.extraDisposers.push(fn)
  }

  dispose() {
    this.unsubscribePi()
    for (const fn of this.extraDisposers.splice(0)) {
      try {
        fn()
      } catch (err) {
        console.warn("[sessions] disposer threw:", err)
      }
    }
    this.pi.dispose()
  }
}
