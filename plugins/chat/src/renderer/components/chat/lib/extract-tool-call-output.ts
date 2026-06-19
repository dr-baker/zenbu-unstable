import type { ToolResponse } from "./materialized-message"

type EventItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}

export type ToolCallOutputState = {
  /** The tool's `name` (e.g. `"bash"`, `"edit"`). Null when we
   * haven't yet seen a `tool_execution_start` / `tool_execution_end`
   * for this call. */
  toolName: string | null
  /** The raw args object passed to the tool (e.g. for `bash`,
   * `{ command, timeout }`). Null until `tool_execution_start`. */
  args: unknown
  /** Streaming or final output, normalized to stdout / stderr where
   * we can recognize the shape. Null until the first
   * `tool_execution_update` or `tool_execution_end`. */
  toolResponse: ToolResponse | null
  /** Status mirror of the materializer's `ToolMessage.status`:
   *   - `null`        \u2014 toolCallId never seen in the event log
   *   - `pending`     \u2014 tool call block exists in an assistant message
   *                     but `tool_execution_start` hasn't fired yet
   *   - `running`     \u2014 `tool_execution_start` fired, end hasn't
   *   - `completed` / `failed` \u2014 `tool_execution_end` settled it
   *   - `interrupted` \u2014 a `turn_interrupted` (or aborted
   *                     `message_end`) arrived after
   *                     `tool_execution_start` with no matching
   *                     `tool_execution_end`. Matches what the
   *                     inline tool card reads as "canceled". */
  status:
    | "pending"
    | "running"
    | "completed"
    | "failed"
    | "interrupted"
    | null
  /** Raw payload from the last `tool_execution_end` (or
   * `tool_execution_update` if end hasn't fired yet) so the view
   * can fall back to `JSON.stringify`-ing for non-bash tools we
   * don't have first-class formatters for. */
  rawOutput: unknown
}

/**
 * Walk the chat's event log and return the latest known state of a
 * single tool call (identified by `toolCallId`). Used by the
 * `tool-output` view to render bash / other tool output in a side
 * pane without re-running the full `materializeMessages` pipeline
 * (which builds turn summaries, fork markers, system-reload
 * sentinels \u2014 all irrelevant to a single tool call's output).
 *
 * Folds four event kinds:
 *   - `tool_execution_start` \u2192 captures toolName + args, status \u2192 running
 *   - `tool_execution_update` \u2192 captures partialResult (live streaming)
 *   - `tool_execution_end` \u2192 captures result + isError \u2192 completed/failed
 *   - `interrupted` / `turn_interrupted` \u2192 flips a still-running
 *     tool to `interrupted` so the side pane label matches the
 *     inline card's "canceled" indicator. Same trigger the
 *     materializer uses for the in-chat status switch.
 *
 * Pure: no DB, no RPC. Caller supplies whatever events it has.
 * Returns `{ status: null, ... }` when the toolCallId isn't in the
 * log (e.g. the chat was forked away from the branch that ran it).
 */
export function extractToolCallOutput(
  events: readonly EventItem[],
  toolCallId: string,
): ToolCallOutputState {
  const state: ToolCallOutputState = {
    toolName: null,
    args: null,
    toolResponse: null,
    status: null,
    rawOutput: null,
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    const kind = event.kind
    // Interrupt events don't carry a toolCallId \u2014 they apply to
    // whichever tool was in flight at the time. Only flip when
    // we've already seen this call start: a `turn_interrupted`
    // that arrives before `tool_execution_start` is for a
    // different call (or for the assistant text). Mirrors the
    // materializer's `markInFlightToolsTerminal(out, "interrupted")`
    // pass so the side pane status pill agrees with the inline
    // card's "canceled" indicator.
    if (kind === "interrupted" || kind === "turn_interrupted") {
      if (state.status === "running" || state.status === "pending") {
        state.status = "interrupted"
      }
      continue
    }
    if (
      kind !== "tool_execution_start" &&
      kind !== "tool_execution_update" &&
      kind !== "tool_execution_end"
    )
      continue
    const payload = event.payload as
      | {
          toolCallId?: string
          toolName?: string
          args?: unknown
          partialResult?: unknown
          result?: unknown
          isError?: boolean
        }
      | undefined
    if (payload?.toolCallId !== toolCallId) continue

    if (kind === "tool_execution_start") {
      state.toolName = payload.toolName ?? state.toolName
      state.args = payload.args ?? null
      state.status = "running"
      continue
    }
    if (kind === "tool_execution_update") {
      state.toolName = payload.toolName ?? state.toolName
      const partial = payload.partialResult ?? null
      state.rawOutput = partial
      state.toolResponse = extractToolResponse(state.toolName, partial)
      // Keep `running` \u2014 update events don't settle the call.
      if (state.status == null) state.status = "running"
      continue
    }
    // tool_execution_end
    state.toolName = payload.toolName ?? state.toolName
    const result = payload.result ?? null
    state.rawOutput = result
    state.toolResponse = extractToolResponse(state.toolName, result)
    state.status = payload.isError ? "failed" : "completed"
  }

  return state
}

/**
 * Shape the tool result into `{ stdout, stderr }` where we can
 * recognize the SDK's conventions. Bash and most other tools put
 * text into `content[]` as `{ type: "text", text }` entries; some
 * shapes also expose top-level `stdout` / `stderr`. Returns null
 * when there's nothing recognizable so the view can decide whether
 * to fall back to a raw JSON dump.
 *
 * Lifted (and slightly simplified) from `materialize.ts` so the
 * view stays self-contained \u2014 the two implementations are kept
 * in sync by the streaming-tool tests that hit `materialize.ts`.
 */
function extractToolResponse(
  toolName: string | null,
  result: unknown,
): ToolResponse | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>

  const stdout = typeof r.stdout === "string" ? r.stdout : undefined
  const stderr = typeof r.stderr === "string" ? r.stderr : undefined
  if (stdout != null || stderr != null) {
    return { stdout, stderr }
  }

  const content = Array.isArray(r.content) ? (r.content as unknown[]) : null
  if (content) {
    const text = content
      .map(c =>
        c && typeof c === "object" && "text" in c
          ? String((c as Record<string, unknown>).text ?? "")
          : "",
      )
      .filter(Boolean)
      .join("\n")
    if (text) {
      // Bash routes its bytes through stdout; everything else also
      // lands there since the SDK doesn't separate streams in this
      // shape. The view will display it accordingly.
      void toolName
      return { stdout: text }
    }
  }
  return null
}
