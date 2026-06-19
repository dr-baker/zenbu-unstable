import type {
  MaterializedMessage,
  ToolCallContentItem,
  ToolMessage,
  ToolResponse,
} from "./materialized-message"

// Cross-plugin source import: the resume pipeline (and this sentinel)
// moved to the pi plugin with the sessions services. The chat surface
// is the only other consumer; this import moves with it in Phase 3.
import { SYSTEM_RELOAD_SENTINEL } from "../../../../../../pi/src/main/lib/agent-resume"

export type MaterializeEventItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}
type EventItem = MaterializeEventItem

type AssistantContent =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "toolCall"; id: string; name: string; arguments: unknown }

type AssistantMessage = {
  role: "assistant"
  content: AssistantContent[]
  stopReason?: string
  errorMessage?: string
}

type CompactToolCall = {
  type: "toolCall"
  id: string
  name: string
  arguments?: unknown
}

type AssistantMessageEvent = {
  type?: string
  contentIndex?: number
  delta?: string
  content?: string
  partial?: AssistantMessage
  toolCall?: CompactToolCall
}

type ToolStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"

type CompactionReason = "manual" | "threshold" | "overflow" | "unknown"

/**
 * Walk the pi event log and produce the list of materialized messages
 * the chat surface renders.
 *
 * The event log contains pi events plus our synthesized
 * `user_prompt` items. New logs compact streaming `message_update`
 * payloads down to deltas; legacy logs may still carry full
 * `partial: AssistantMessage` snapshots.
 *
 * For finalized assistant turns we read `message_end.payload.message`
 * and emit one materialized block per `text` / `thinking` content
 * item. For the *in-flight* assistant turn (a trailing
 * `message_start` not yet matched by `message_end`), we either use
 * the legacy `partial` snapshot or reconstruct the ordered content
 * list from compact text/thinking/tool-call deltas.
 *
 * Pure: no RPC, no DB access. Caller passes whatever events it has.
 */
export function materializeMessages(
  events: EventItem[],
  options: {
    directory?: string | null
    /** Extra worktree directories the scope has access to (the
     * scope's `extraDirectories`). Edits to files inside any of
     * these are attributed to that directory on the turn-summary
     * card so clicking the row opens the diff against the right
     * git repo — without this an edit in an extra dir would route
     * through the scope's primary cwd and `pr.getStatus` would
     * find nothing. */
    extraDirectories?: readonly string[]
    workspaceId?: string | null
    scopeId?: string | null
    /** Base 0-based user-message index for callers that materialize a
     * suffix/turn segment instead of the whole log. Whole-log callers
     * keep the default of 0. */
    initialUserMessageIndex?: number
  } = {},
): MaterializedMessage[] {
  const directory = options.directory ?? null
  const extraDirectories = options.extraDirectories ?? []
  const workspaceId = options.workspaceId ?? null
  const scopeId = options.scopeId ?? null
  const out: MaterializedMessage[] = []
  // Running 0-based index of user messages encountered. Stamped on
  // each materialized user message so the renderer can look up the
  // matching pi entry id when forking-from-edit. Reset on each call
  // since we always re-materialize from the head of the event log.
  let userIdx = options.initialUserMessageIndex ?? 0

  // Per-turn file-edit aggregator for the post-turn summary card.
  // Reset on every `user_prompt` (so each turn gets its own card),
  // appended into a `turn_summary` materialized block on every
  // `agent_end`. We use an array + an index map so the card lists
  // files in the order they were first edited (more readable than
  // dictionary iteration order, and stable across re-renders).
  type TurnFileEntry = {
    path: string
    /** Worktree this file lives in. Defaults to the scope's primary
     * `directory`, but switches to one of `extraDirectories` when
     * the edit path lands inside an extra dir — that way the
     * turn-summary card can open the diff against the right repo
     * (each extra dir is its own git worktree). */
    directory: string | null
    editCount: number
    op: "create" | "edit"
    additions: number
    removals: number
  }
  let turnFiles: TurnFileEntry[] = []
  let turnFileIdx = new Map<string, number>()
  // Map of in-flight edit/write tool calls — we only attribute the
  // edit to the file when `tool_execution_end` reports success, so
  // failed edits don't pollute the summary. Keyed by `toolCallId`.
  // `op` captures which tool started the call so the per-file
  // operation kind on the summary card matches what actually ran.
  // `createdLines` is pre-computed for `write` from the args at
  // start time (the result doesn't carry it) and used as the
  // additions count on success.
  const pendingEdits = new Map<
    string,
    { path: string; op: "create" | "edit"; createdLines: number }
  >()
  const recordEdit = (
    rawPath: string,
    op: "create" | "edit",
    additions: number,
    removals: number,
  ) => {
    // Pick the owning worktree first: prefer the longest matching
    // dir prefix across the scope's primary `directory` + every
    // `extraDirectories` entry. Falling back to the primary keeps
    // behavior identical for files that don't live in any tracked
    // dir (so the existing "render as absolute path" branch still
    // kicks in inside `normalizeEditPath`).
    const owner = pickOwningDirectory(rawPath, directory, extraDirectories)
    const normalized = normalizeEditPath(rawPath, owner)
    // Key by (directory, path) so a file with the same relative
    // path in two different worktrees doesn't collapse into one
    // row — they're genuinely different files.
    const key = `${owner ?? ""}::${normalized}`
    const existing = turnFileIdx.get(key)
    if (existing != null) {
      const prev = turnFiles[existing]!
      turnFiles[existing] = {
        ...prev,
        editCount: prev.editCount + 1,
        // First op wins: a file created this turn stays "created"
        // even if the agent edits it again before turn end, because
        // the dominant user-facing action is the creation. A file
        // that was edited first never gets reclassified as created
        // (you can't really un-create something the agent already
        // started editing).
        additions: prev.additions + additions,
        removals: prev.removals + removals,
      }
      return
    }
    turnFileIdx.set(key, turnFiles.length)
    turnFiles.push({
      path: normalized,
      directory: owner,
      editCount: 1,
      op,
      additions,
      removals,
    })
  }

  // Tracks the most recent assistant `message_start` that has not yet
  // been closed by a `message_end`. While this is non-null, the
  // latest `partial` seen on a `message_update` is the streaming
  // assistant message; on `message_end` we flush finalized blocks
  // and clear this slot.
  let openAssistantStartSeq: number | null = null
  let openAssistantPartial: AssistantMessage | null = null
  const openToolJsonByIndex = new Map<number, string>()

  // Seq of the only open `message_start` (if any). Closed messages
  // get their final blocks from `message_end.payload.message`, so
  // we can skip the O(n²) partial-JSON reparse on their deltas.
  let inFlightMessageStartSeq: number | null = null
  // Index of the most recent running compaction card. `compaction_end`
  // promotes this slot to a terminal state instead of leaving a spinner.
  let pendingCompactionIdx: number | null = null
  for (let i = 0; i < events.length; i++) {
    const ev = events[i]
    if (ev.kind === "message_start") inFlightMessageStartSeq = ev.seq
    else if (ev.kind === "message_end") inFlightMessageStartSeq = null
  }

  for (let i = 0; i < events.length; i++) {
    const event = events[i]
    switch (event.kind) {
      case "user_prompt": {
        const payload = event.payload as
          | {
              text?: string
              images?: { blobId: string; mimeType: string }[]
            }
          | undefined
        const text = payload?.text ?? ""
        // Special-case the auto-resume sentinel that
        // `SessionsService.continueKilled` dispatches when the
        // app hot-reloads mid-stream. The model still sees the
        // wrapped "Continue. The system reloaded." text and picks
        // up where it left off; we replace the user-message bubble
        // with a thin "Agent reloaded" divider so the chat history
        // reads as one continuous turn instead of looking like the
        // user typed something.
        if (text.trim() === SYSTEM_RELOAD_SENTINEL) {
          out.push({
            role: "system_reload",
            key: `system-reload-${event.seq}`,
            timestamp: event.timestamp,
          })
          turnFiles = []
          turnFileIdx = new Map()
          pendingEdits.clear()
          break
        }
        out.push({
          role: "user",
          content: text,
          images: payload?.images,
          timeSent: event.timestamp,
          key: `user-${event.seq}`,
          userMessageIndex: userIdx++,
        })
        // Start of a new turn from the user's side. Reset the
        // file-edit aggregator so the next agent_end's turn_summary
        // only reflects edits made for this prompt.
        turnFiles = []
        turnFileIdx = new Map()
        pendingEdits.clear()
        break
      }
      case "compaction_start": {
        const payload = event.payload as { reason?: string } | undefined
        out.push({
          role: "compaction",
          status: "running",
          reason: normalizeCompactionReason(payload?.reason),
          timestamp: event.timestamp,
          key: `compaction-${event.seq}`,
        })
        pendingCompactionIdx = out.length - 1
        break
      }
      case "compaction_end": {
        const terminal = compactionFromEndEvent({
          payload: event.payload,
          timestamp: event.timestamp,
          seq: event.seq,
        })
        if (pendingCompactionIdx != null) {
          const prev = out[pendingCompactionIdx]
          if (prev?.role === "compaction") {
            out[pendingCompactionIdx] = {
              ...prev,
              ...terminal,
              key: prev.key ?? terminal.key,
            }
          } else {
            out.push(terminal)
          }
          pendingCompactionIdx = null
        } else {
          out.push(terminal)
        }
        break
      }
      case "compaction_summary": {
        const payload = event.payload as
          | {
              summary?: string
              tokensBefore?: number
              firstKeptEntryId?: string
              readFiles?: string[]
              modifiedFiles?: string[]
            }
          | undefined
        out.push({
          role: "compaction",
          status: "completed",
          reason: "unknown",
          historical: true,
          timestamp: event.timestamp,
          summary: payload?.summary,
          tokensBefore: payload?.tokensBefore,
          firstKeptEntryId: payload?.firstKeptEntryId,
          readFiles: payload?.readFiles,
          modifiedFiles: payload?.modifiedFiles,
          key: `compaction-summary-${event.seq}`,
        })
        pendingCompactionIdx = null
        break
      }
      case "message_start": {
        const payload = event.payload as
          | { message?: { role?: string } }
          | undefined
        if (payload?.message?.role === "assistant") {
          openAssistantStartSeq = event.seq
          openAssistantPartial = { role: "assistant", content: [] }
          openToolJsonByIndex.clear()
        }
        break
      }
      case "message_update": {
        if (openAssistantStartSeq == null) break
        // Closed messages get their final blocks from `message_end`;
        // only the in-flight tail needs delta parsing.
        if (openAssistantStartSeq !== inFlightMessageStartSeq) break
        const payload = event.payload as
          | {
              assistantMessageEvent?: AssistantMessageEvent
            }
          | undefined
        const update = payload?.assistantMessageEvent
        const partial = update?.partial
        if (partial && partial.role === "assistant") {
          openAssistantPartial = partial
        } else if (update) {
          openAssistantPartial = applyAssistantMessageUpdate({
            current: openAssistantPartial,
            update,
            toolJsonByIndex: openToolJsonByIndex,
          })
        }
        break
      }
      case "message_end": {
        const payload = event.payload as { message?: AssistantMessage } | undefined
        const msg = payload?.message
        // Close the in-flight slot regardless \u2014 a `message_end` ends
        // *some* message; if it's the assistant message we were
        // streaming, the finalized blocks below replace any partial
        // we'd otherwise render at the tail.
        openAssistantStartSeq = null
        openAssistantPartial = null
        openToolJsonByIndex.clear()
        if (!msg || msg.role !== "assistant") break
        const stopReason = msg.stopReason
        const aborted = stopReason === "aborted"
        const errored =
          stopReason === "error" &&
          typeof msg.errorMessage === "string" &&
          msg.errorMessage.length > 0
        // Flip any *prior* in-flight tools to their terminal
        // state first — we want the indicator to appear on the
        // existing card before we push anything new under it.
        // Tools embedded in this turn's closing content are
        // emitted in the matching terminal state directly below.
        //
        // Aborted turns: the user explicitly stopped the run, so
        // any in-flight tool calls get the dedicated `interrupted`
        // status (renders as e.g. "Create File foo.ts canceled")
        // rather than the hard-failure X. Errored turns keep the
        // `failed` marker since those usually point at something
        // the user has to actually fix.
        if (aborted) {
          markInFlightToolsTerminal(out, "interrupted")
        } else if (errored) {
          markInFlightToolsTerminal(out, "failed")
        }
        for (let j = 0; j < msg.content.length; j++) {
          const block = msg.content[j]
          if (block.type === "text" && block.text) {
            out.push({
              role: "assistant",
              content: block.text,
              key: `assistant-${event.seq}-${j}`,
            })
          } else if (block.type === "thinking" && block.thinking) {
            out.push({
              role: "thinking",
              content: block.thinking,
              key: `thinking-${event.seq}-${j}`,
            })
          } else if (block.type === "toolCall") {
            // On a clean turn close we emit `pending` so pi's next
            // `tool_execution_start` can promote the same card to
            // `running` (avoids a flicker). When the turn ended in
            // abort/error there *is* no next tool_execution_start —
            // pi's agent loop bails before executing — so we mark
            // the tool's terminal state immediately. Otherwise the
            // card would sit forever pretending to be queued.
            // `aborted` (user-requested stop) maps to `interrupted`
            // so the card reads "canceled"; hard errors stay
            // `failed` (X marker, plus the error card below).
            const toolStatus: ToolStatus = aborted
              ? "interrupted"
              : errored
                ? "failed"
                : "pending"
            out.push(
              toolMessageFromToolCallBlock(block, toolStatus, {
                directory,
                extraDirectories,
                argsComplete: true,
              }),
            )
          }
        }
        // Trailing markers go *after* the partial content so the
        // chat reads chronologically: the model streamed some
        // tokens, then the request died. Putting them above would
        // make it look like the stop happened first and the
        // content arrived after it.
        //
        // Aborted turns get the thin "Interrupted" divider (same
        // look as `turn_interrupted` / `AgentReloaded`) — the user
        // *asked* for the stop, so surfacing it as a failure is
        // misleading. Dedupe against an immediately-prior
        // `interrupted` block so a `turn_interrupted` event
        // followed by an aborted `message_end` doesn't double up.
        // Hard errors get the error card with the support /
        // accounts-settings footer since those usually need user
        // action to fix.
        if (aborted) {
          if (out[out.length - 1]?.role !== "interrupted") {
            out.push({ role: "interrupted", key: `interrupted-${event.seq}` })
          }
        } else if (errored) {
          out.push({
            role: "error",
            message: msg.errorMessage as string,
            detail: extractProviderErrorDetail(msg.errorMessage as string),
            stopReason: "error",
            key: `error-${event.seq}`,
          })
        }
        break
      }
      case "tool_execution_start": {
        const payload = event.payload as
          | { toolCallId?: string; toolName?: string; args?: unknown }
          | undefined
        const id = payload?.toolCallId ?? `tool-${event.seq}`
        const toolName = payload?.toolName
        const args = payload?.args
        const opKind = editOpKind(toolName)
        if (opKind) {
          const filePath = pickEditPath(args)
          if (filePath) {
            // For `write` we need the line count of the content
            // payload — it's only present in args, not in the
            // result — so we snapshot it here. `edit` figures its
            // diff stats out from the result on success, so we
            // pass 0 and overwrite at end time.
            const createdLines =
              opKind === "create" ? lineCountOfWriteArgs(args) : 0
            pendingEdits.set(id, { path: filePath, op: opKind, createdLines })
          }
        }
        const editTarget = resolveEditTarget(toolName, args, {
          directory,
          extraDirectories,
        })
        const next: MaterializedMessage = {
          role: "tool",
          toolCallId: id,
          toolName,
          title: toolName ?? "tool",
          subtitle: summarizeArgs(args),
          kind: inferToolKind(toolName),
          status: "running",
          rawInput: args,
          rawOutput: null,
          toolResponse: null,
          argsComplete: true,
          contentItems: extractContentItems(toolName, args, null),
          editPath: editTarget.path,
          editDirectory: editTarget.directory,
          key: `tool-${id}`,
        }
        // Dedupe: `message_end` may have already pushed a `pending`
        // bridge card for this `toolCallId`. Promote it in place so
        // the DOM node (and any expanded-state the user already
        // toggled) survives the transition.
        const existingIdx = findToolIndexById(out, id)
        if (existingIdx >= 0) out[existingIdx] = next
        else out.push(next)
        break
      }
      case "tool_execution_update": {
        // Pi fires this from a tool's `onUpdate` callback while the
        // tool is still running. The bash tool uses it to stream
        // stdout/stderr as the subprocess writes — `partialResult`
        // has the same shape as the final result (`{ content,
        // details }`), just snapshot at the throttle boundary
        // (BASH_UPDATE_THROTTLE_MS in pi).
        //
        // We mirror the in-flight bytes onto the running tool
        // card's `rawOutput` / `toolResponse` so BashCard can
        // render them live (it already auto-expands while running
        // — see tool-call-card.tsx). Other tools that opt into
        // onUpdate get the same treatment for free.
        const payload = event.payload as
          | { toolCallId?: string; partialResult?: unknown }
          | undefined
        const id = payload?.toolCallId
        if (!id) break
        const idx = findToolIndexById(out, id)
        if (idx < 0) break
        const existing = out[idx]
        if (existing.role !== "tool") break
        const partialResult = payload?.partialResult ?? null
        out[idx] = {
          ...existing,
          rawOutput: partialResult,
          toolResponse: extractToolResponse(existing.toolName, partialResult),
          contentItems: extractContentItems(
            existing.toolName,
            existing.rawInput,
            partialResult,
          ),
        }
        break
      }
      case "tool_execution_end": {
        const payload = event.payload as
          | {
              toolCallId?: string
              isError?: boolean
              toolName?: string
              result?: unknown
            }
          | undefined
        const id = payload?.toolCallId
        if (!id) break
        const status: ToolStatus = payload?.isError ? "failed" : "completed"
        const pending = pendingEdits.get(id)
        if (pending) {
          pendingEdits.delete(id)
          if (!payload?.isError) {
            // Stats source depends on which tool ran:
            //   - write: pre-computed line count from args.content.
            //     Every line is an addition (the file didn't exist),
            //     removals stay 0.
            //   - edit: parse the unified diff out of the tool
            //     result, run the same unique-line tally the inline
            //     EditCard uses so the badges match what the user
            //     sees in the tool call above.
            let additions = 0
            let removals = 0
            if (pending.op === "create") {
              additions = pending.createdLines
            } else {
              const stats = editDiffStatsFromResult(payload?.result)
              additions = stats.additions
              removals = stats.removals
            }
            recordEdit(pending.path, pending.op, additions, removals)
          }
        }
        for (let k = out.length - 1; k >= 0; k--) {
          const m = out[k]
          if (m.role === "tool" && m.toolCallId === id) {
            out[k] = {
              ...m,
              status,
              rawOutput: payload?.result ?? null,
              toolResponse: extractToolResponse(m.toolName, payload?.result),
              contentItems: extractContentItems(
                m.toolName,
                m.rawInput,
                payload?.result ?? null,
              ),
            }
            break
          }
        }
        break
      }
      case "interrupted":
      case "turn_interrupted": {
        // Pi can fire a bare `interrupted` / `turn_interrupted`
        // event when the user stops a run *before* the assistant
        // turn closes — e.g. a tool was already executing and the
        // user hit stop. There's no matching `tool_execution_end`
        // coming for those tools, and the surrounding `message_end`
        // (if any) may not arrive with `stopReason: "aborted"`
        // either (some tools never reach the model). Without this
        // call the card would spin forever in `running`. Same
        // semantics as the aborted branch in `message_end`: flip
        // the in-flight cards to `interrupted` so they read
        // "canceled" instead of "failed".
        markInFlightToolsTerminal(out, "interrupted")
        out.push({ role: "interrupted", key: `interrupted-${event.seq}` })
        break
      }
      case "agent_end": {
        // End of a turn. If pi wrote / edited any files since the
        // previous user_prompt, drop a `turn_summary` block here so
        // the chat renders the post-turn "what changed" card right
        // below the assistant's last message. We snapshot the
        // current aggregator into a fresh array so any *future*
        // turn's edits (after the user replies) don't mutate this
        // card by reference.
        if (turnFiles.length > 0) {
          out.push({
            role: "turn_summary",
            files: turnFiles.slice(),
            directory,
            workspaceId,
            scopeId,
            key: `turn-summary-${event.seq}`,
          })
        }
        // Reset the aggregator so a follow-up agent_end inside the
        // same user prompt (rare — agent retries / sub-runs) emits
        // a fresh card with only the newly-edited files rather than
        // double-counting what the prior card already showed. The
        // user_prompt branch also clears on the *next* prompt, so
        // either way each card is "edits since the last summary or
        // user message, whichever came last".
        turnFiles = []
        turnFileIdx = new Map()
        break
      }
      case "cloned_from":
      case "forked_from": {
        const payload = event.payload as
          | {
              parentSessionId?: string
              parentTitle?: string
              parentEntryId?: string
            }
          | undefined
        const variant = event.kind === "forked_from" ? "fork" : "clone"
        out.push({
          role: "clone_marker",
          variant,
          parentSessionId: payload?.parentSessionId ?? null,
          parentTitle: payload?.parentTitle ?? null,
          parentEntryId: payload?.parentEntryId ?? null,
          timestamp: event.timestamp,
          key: `${variant}-${event.seq}`,
        })
        break
      }
      default:
        break
    }
  }

  // Trailing in-flight assistant message: render from the latest
  // reconstructed assistant content. Legacy logs get this from
  // `partial`; compact logs build it from deltas. Tool-call args are
  // available once their JSON has streamed to a parseable boundary
  // (and definitively on `toolcall_end`).
  if (openAssistantPartial) {
    const blocks = openAssistantPartial.content
    // Find the index of the last text / thinking block so we can
    // mark only the trailing one as actively streaming.
    let lastStreamableIdx = -1
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i]
      if (b.type === "text" || b.type === "thinking") {
        lastStreamableIdx = i
        break
      }
    }
    const startSeq = openAssistantStartSeq ?? "open"
    for (let j = 0; j < blocks.length; j++) {
      const block = blocks[j]
      if (block.type === "text" && block.text) {
        out.push({
          role: "assistant",
          content: block.text,
          key: `assistant-streaming-${startSeq}-${j}`,
        })
      } else if (block.type === "thinking" && block.thinking) {
        out.push({
          role: "thinking",
          content: block.thinking,
          // Only the *trailing* block is "still streaming" (renders
          // expanded). Earlier thinking blocks that have already been
          // closed by a subsequent text/thinking block in `partial`
          // are effectively done and should collapse.
          streaming: j === lastStreamableIdx,
          key: `thinking-streaming-${startSeq}-${j}`,
        })
      } else if (block.type === "toolCall") {
        // The toolCall block is being filled in by `toolcall_delta`
        // events — pi's provider layer parses the streaming JSON with
        // `parseStreamingJson` and exposes the partial result in
        // `block.arguments` on every delta, so feeding `arguments`
        // straight into the existing card lets WriteCard's `+N` line
        // count and EditCard's `+added / -removed` badges tick up
        // live without any card-side changes. Keying by `block.id`
        // (the toolCallId pi will also use on `tool_execution_start`)
        // means React reuses the same DOM node when the card flips
        // from streaming → pending → running → completed.
        out.push(
          toolMessageFromToolCallBlock(block, "running", {
            directory,
            extraDirectories,
            argsComplete: false,
          }),
        )
      }
    }
  }

  return coalesceThinking(out)
}

export function countMaterializedUserMessages(
  events: readonly MaterializeEventItem[],
): number {
  let count = 0
  for (const event of events) {
    if (event.kind !== "user_prompt") continue
    const payload = event.payload as { text?: string } | undefined
    if ((payload?.text ?? "").trim() === SYSTEM_RELOAD_SENTINEL) continue
    count++
  }
  return count
}

function normalizeCompactionReason(reason: string | undefined): CompactionReason {
  if (reason === "manual" || reason === "threshold" || reason === "overflow") {
    return reason
  }
  return "unknown"
}

type CompactionEndPayload = {
  reason?: string
  result?: {
    summary?: string
    firstKeptEntryId?: string
    tokensBefore?: number
    details?: { readFiles?: string[]; modifiedFiles?: string[] }
  }
  aborted?: boolean
  willRetry?: boolean
  errorMessage?: string
}

function compactionFromEndEvent(args: {
  payload: unknown
  timestamp: number
  seq: number
}): Extract<MaterializedMessage, { role: "compaction" }> {
  const raw = (args.payload ?? {}) as CompactionEndPayload
  const reason = normalizeCompactionReason(raw.reason)
  const result = raw.result
  const base = {
    role: "compaction" as const,
    reason,
    timestamp: args.timestamp,
    key: `compaction-${args.seq}`,
  }

  if (raw.aborted) {
    return { ...base, status: "aborted" }
  }

  if (!result?.summary) {
    return {
      ...base,
      status: "failed",
      errorMessage:
        raw.errorMessage ??
        (reason === "overflow"
          ? "Context overflow recovery failed"
          : "Compaction failed"),
    }
  }

  const details = result.details
  return {
    ...base,
    status: "completed",
    summary: result.summary,
    tokensBefore: result.tokensBefore,
    firstKeptEntryId: result.firstKeptEntryId,
    willRetry: raw.willRetry === true,
    readFiles: details?.readFiles,
    modifiedFiles: details?.modifiedFiles,
  }
}

function applyAssistantMessageUpdate(args: {
  current: AssistantMessage | null
  update: AssistantMessageEvent
  toolJsonByIndex: Map<number, string>
}): AssistantMessage {
  const { update, toolJsonByIndex } = args
  const content = args.current?.content.slice() ?? []
  const idx = update.contentIndex
  if (idx == null) return { role: "assistant", content }

  const existing = content[idx]
  switch (update.type) {
    case "text_start":
      content[idx] = { type: "text", text: "" }
      break
    case "text_delta": {
      const prev = existing?.type === "text" ? existing.text : ""
      content[idx] = { type: "text", text: prev + (update.delta ?? "") }
      break
    }
    case "text_end":
      content[idx] = { type: "text", text: update.content ?? "" }
      break
    case "thinking_start":
      content[idx] = { type: "thinking", thinking: "" }
      break
    case "thinking_delta": {
      const prev = existing?.type === "thinking" ? existing.thinking : ""
      content[idx] = {
        type: "thinking",
        thinking: prev + (update.delta ?? ""),
      }
      break
    }
    case "thinking_end":
      content[idx] = { type: "thinking", thinking: update.content ?? "" }
      break
    case "toolcall_start":
      if (update.toolCall) {
        content[idx] = toolCallContentFromCompact(update.toolCall, {})
      }
      break
    case "toolcall_delta": {
      if (update.delta != null) {
        const nextJson = (toolJsonByIndex.get(idx) ?? "") + update.delta
        toolJsonByIndex.set(idx, nextJson)
      }
      if (update.toolCall) {
        content[idx] = toolCallContentFromCompact(
          update.toolCall,
          parseStreamingJsonObject(toolJsonByIndex.get(idx) ?? ""),
        )
      }
      break
    }
    case "toolcall_end":
      if (update.toolCall) {
        content[idx] = toolCallContentFromCompact(
          update.toolCall,
          update.toolCall.arguments ?? {},
        )
      }
      toolJsonByIndex.delete(idx)
      break
    default:
      break
  }

  return { role: "assistant", content }
}

function toolCallContentFromCompact(
  toolCall: CompactToolCall,
  args: unknown,
): AssistantContent {
  return {
    type: "toolCall",
    id: toolCall.id,
    name: toolCall.name,
    arguments: args,
  }
}

function parseStreamingJsonObject(raw: string): unknown {
  if (!raw.trim()) return {}
  try {
    return JSON.parse(raw) as unknown
  } catch {
    const parsed = new PartialJsonParser(raw).parseValue()
    return parsed && typeof parsed === "object" ? parsed : {}
  }
}

class PartialJsonParser {
  private index = 0

  constructor(private readonly input: string) {}

  parseValue(): unknown {
    this.skipWhitespace()
    const ch = this.peek()
    if (ch === "{") return this.parseObject()
    if (ch === "[") return this.parseArray()
    if (ch === '"') return this.parseString()
    return this.parsePrimitive()
  }

  private parseObject(): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    this.index++
    while (this.index < this.input.length) {
      this.skipWhitespace()
      if (this.peek() === "}") {
        this.index++
        break
      }
      if (this.peek() === ",") {
        this.index++
        continue
      }
      if (this.peek() !== '"') break
      const key = this.parseString()
      this.skipWhitespace()
      if (this.peek() !== ":") break
      this.index++
      const before = this.index
      const value = this.parseValue()
      if (this.index === before) break
      out[key] = value
      this.skipWhitespace()
      if (this.peek() === ",") this.index++
      else if (this.peek() === "}") {
        this.index++
        break
      }
    }
    return out
  }

  private parseArray(): unknown[] {
    const out: unknown[] = []
    this.index++
    while (this.index < this.input.length) {
      this.skipWhitespace()
      if (this.peek() === "]") {
        this.index++
        break
      }
      if (this.peek() === ",") {
        this.index++
        continue
      }
      const before = this.index
      out.push(this.parseValue())
      if (this.index === before) break
      this.skipWhitespace()
      if (this.peek() === ",") this.index++
      else if (this.peek() === "]") {
        this.index++
        break
      }
    }
    return out
  }

  private parseString(): string {
    let out = ""
    this.index++
    while (this.index < this.input.length) {
      const ch = this.input[this.index]
      if (ch === '"') {
        this.index++
        break
      }
      if (ch === "\\") {
        this.index++
        if (this.index >= this.input.length) break
        out += this.parseEscape(this.input[this.index]!)
        this.index++
        continue
      }
      out += ch
      this.index++
    }
    return out
  }

  private parseEscape(ch: string): string {
    if (ch === "n") return "\n"
    if (ch === "r") return "\r"
    if (ch === "t") return "\t"
    if (ch === "b") return "\b"
    if (ch === "f") return "\f"
    if (ch === '"' || ch === "\\" || ch === "/") return ch
    if (ch !== "u") return ch
    const hex = this.input.slice(this.index + 1, this.index + 5)
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      this.index += 4
      return String.fromCharCode(parseInt(hex, 16))
    }
    return ""
  }

  private parsePrimitive(): unknown {
    const start = this.index
    while (this.index < this.input.length) {
      const ch = this.input[this.index]
      if (ch === "," || ch === "}" || ch === "]" || /\s/.test(ch ?? "")) {
        break
      }
      this.index++
    }
    const raw = this.input.slice(start, this.index)
    if (raw === "true") return true
    if (raw === "false") return false
    if (raw === "null") return null
    const n = Number(raw)
    return Number.isFinite(n) ? n : raw
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.peek() ?? "")) this.index++
  }

  private peek(): string | undefined {
    return this.input[this.index]
  }
}

/**
 * Merge runs of consecutive `thinking` messages into a single block. The
 * model often emits multiple thinking content blocks back-to-back, and
 * rendering each as its own collapsed "Thought" pill is just noise \u2014 they
 * read as one continuous thought.
 */
function coalesceThinking(
  messages: MaterializedMessage[],
): MaterializedMessage[] {
  const out: MaterializedMessage[] = []
  for (const m of messages) {
    const prev = out[out.length - 1]
    if (
      m.role === "thinking" &&
      prev &&
      prev.role === "thinking" &&
      !!prev.streaming === !!m.streaming
    ) {
      out[out.length - 1] = {
        ...prev,
        content: prev.content + "\n\n" + m.content,
      }
    } else {
      out.push(m)
    }
  }
  return out
}

function inferToolKind(name: string | undefined): string {
  const n = (name ?? "").toLowerCase()
  if (n === "bash") return "execute"
  if (n === "edit") return "edit"
  if (n === "write") return "create"
  if (n === "read") return "read"
  if (n === "grep" || n === "find" || n === "ls" || n === "glob") return "search"
  if (n === "agent" || n === "task") return "think"
  return "other"
}

function summarizeArgs(args: unknown): string | undefined {
  if (args == null) return undefined
  try {
    const s = JSON.stringify(args)
    return s.length > 120 ? s.slice(0, 120) + "…" : s
  } catch {
    return undefined
  }
}

/**
 * Pull stdout / stderr out of an opaque tool result. The pi SDK puts
 * bash output in `content` (an array of text blocks) and also exposes
 * `stdout` / `stderr` on some result shapes — try both, fail soft.
 */
function extractToolResponse(
  toolName: string | undefined,
  result: unknown,
): ToolResponse | null {
  if (!result || typeof result !== "object") return null
  const r = result as Record<string, unknown>
  const stdout = pickString(r, ["stdout"])
  const stderr = pickString(r, ["stderr"])
  if (stdout != null || stderr != null) {
    return { stdout: stdout ?? undefined, stderr: stderr ?? undefined }
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
    if (text)
      return toolName === "bash" || toolName === "execute"
        ? { stdout: text }
        : { stdout: text }
  }
  return null
}

/**
 * Pull `{ type: "diff", path, oldText, newText }` items out of an edit
 * tool result when the underlying SDK stamped them onto `details.diff`
 * (unified diff). For everything else this returns an empty list.
 */
function extractContentItems(
  toolName: string | undefined,
  input: unknown,
  output: unknown,
): ToolCallContentItem[] | undefined {
  const n = (toolName ?? "").toLowerCase()
  if (n !== "edit") return undefined
  // Prefer the finalized unified diff from the result when present —
  // it merges adjacent hunks and matches what gets persisted in the
  // turn summary. When the tool is still streaming / pending /
  // running we don't have a result yet, so synthesize diff items
  // from the partial args instead so the EditCard's `+added /
  // -removed` badges (computed from `contentItems`) can tick up
  // live as `toolcall_delta` events stream in.
  if (output && typeof output === "object") {
    const r = output as Record<string, unknown>
    const details = r.details as Record<string, unknown> | undefined
    const diff = typeof details?.diff === "string" ? details.diff : undefined
    if (diff) {
      const inp = (input ?? {}) as Record<string, unknown>
      const path =
        pickString(inp, ["file_path", "path", "filePath"]) ?? "(unknown path)"
      const { oldText, newText } = splitUnifiedDiff(diff)
      return [{ type: "diff", path, oldText, newText }]
    }
  }
  return extractContentItemsFromArgs(toolName, input)
}

/**
 * Build `{ type: "diff" }` items from an Edit tool's args. The pi
 * edit schema is `{ path, edits: { oldText, newText }[] }`; a legacy
 * single-edit shape `{ path, oldText, newText }` still shows up from
 * older models, so we accept both. Returns `undefined` when the args
 * haven't streamed far enough for any complete `{ oldText, newText }`
 * pair to exist yet — the EditCard then renders its loading state
 * with no `+N / -N` badges, which is exactly what we want for the
 * very first deltas.
 */
function extractContentItemsFromArgs(
  toolName: string | undefined,
  input: unknown,
): ToolCallContentItem[] | undefined {
  const n = (toolName ?? "").toLowerCase()
  if (n !== "edit") return undefined
  if (!input || typeof input !== "object") return undefined
  const inp = input as Record<string, unknown>
  const path =
    pickString(inp, ["file_path", "path", "filePath"]) ?? "(unknown path)"
  const out: ToolCallContentItem[] = []
  const edits = inp.edits
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (!e || typeof e !== "object") continue
      const er = e as Record<string, unknown>
      // `parseStreamingJson` typically fills `oldText` before
      // `newText` as the JSON arrives. Skip entries that don't yet
      // have *both* fields as strings so EditCard isn't asked to
      // diff a half-formed entry (the missing `newText` would
      // implicitly become `""` and the badge would briefly show a
      // spurious all-removal count for every line of `oldText`).
      if (typeof er.oldText !== "string" || typeof er.newText !== "string")
        continue
      out.push({
        type: "diff",
        path,
        oldText: er.oldText,
        newText: er.newText,
      })
    }
  } else if (
    typeof inp.oldText === "string" ||
    typeof inp.newText === "string"
  ) {
    out.push({
      type: "diff",
      path,
      oldText: typeof inp.oldText === "string" ? inp.oldText : undefined,
      newText: typeof inp.newText === "string" ? inp.newText : "",
    })
  }
  return out.length > 0 ? out : undefined
}

/**
 * Adapter: `partial.content[i]` `toolCall` block → materialized
 * `ToolMessage`. Used by both the streaming-partial tail loop
 * (status="running", live args from `parseStreamingJson`) and the
 * `message_end` finalized-blocks loop (status="pending", final args
 * but pi hasn't fired `tool_execution_start` yet so the executor
 * hasn't started).
 */
function toolMessageFromToolCallBlock(
  block: { type: "toolCall"; id: string; name: string; arguments: unknown },
  status: ToolStatus,
  ctx: {
    directory: string | null
    extraDirectories: readonly string[]
    argsComplete: boolean
  },
): ToolMessage {
  const args = block.arguments
  const edit = resolveEditTarget(block.name, args, ctx)
  return {
    role: "tool",
    toolCallId: block.id,
    toolName: block.name,
    title: block.name ?? "tool",
    subtitle: summarizeArgs(args),
    kind: inferToolKind(block.name),
    status,
    rawInput: args,
    rawOutput: null,
    toolResponse: null,
    argsComplete: ctx.argsComplete,
    contentItems: extractContentItems(block.name, args, null),
    editPath: edit.path,
    editDirectory: edit.directory,
    key: `tool-${block.id}`,
  }
}

/**
 * For `edit` / `write` tool calls, resolve the file path arg into a
 * (worktree-relative path, owning worktree directory) pair so the
 * tool card can fire `openDiff` without re-inspecting `rawInput`.
 * Mirrors the resolution path the turn-summary aggregator uses
 * (`pickEditPath` + `pickOwningDirectory` + `normalizeEditPath`) so
 * a click on the inline tool card lands on exactly the same diff
 * a click on the turn-summary row would.
 *
 * Returns `{ path: null, directory: null }` for:
 *   - non-edit tools (bash, read, search, …) — they don't have an
 *     editable file in the user-facing sense
 *   - edit / write calls where the `path` arg hasn't streamed in
 *     yet (the very first `toolcall_delta` frames). The card
 *     stays unclickable until the path arrives — better than
 *     pointing at "(unknown path)".
 */
function resolveEditTarget(
  toolName: string | undefined,
  args: unknown,
  ctx: {
    directory: string | null
    extraDirectories: readonly string[]
  },
): { path: string | null; directory: string | null } {
  if (!editOpKind(toolName)) return { path: null, directory: null }
  const rawPath = pickEditPath(args)
  if (!rawPath) return { path: null, directory: null }
  const directory = pickOwningDirectory(
    rawPath,
    ctx.directory,
    ctx.extraDirectories,
  )
  const path = normalizeEditPath(rawPath, directory)
  return { path, directory }
}

/**
 * Walk back through the materialized list and flip any tool cards
 * still in a non-terminal state (`running` / `pending`) to the
 * supplied terminal status. Called from `message_end` (abort or
 * error) and from the bare `interrupted` / `turn_interrupted`
 * branches — pi never emits a closing `tool_execution_end` for
 * tools that were in flight when the run died, so without this
 * they'd spin forever in the UI.
 *
 * We don't touch already-terminal cards (`completed`, `failed`,
 * `interrupted`): a tool that finished cleanly — or already got
 * marked failed by a prior pass — keeps its existing state.
 */
function markInFlightToolsTerminal(
  out: MaterializedMessage[],
  status: "failed" | "interrupted",
): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role !== "tool") continue
    if (m.status === "running" || m.status === "pending") {
      out[i] = { ...m, status }
    }
  }
}

function findToolIndexById(
  out: MaterializedMessage[],
  id: string,
): number {
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i]
    if (m.role === "tool" && m.toolCallId === id) return i
  }
  return -1
}

function pickString(
  obj: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const k of keys) {
    const v = obj[k]
    if (typeof v === "string") return v
  }
  return null
}

/**
 * Classify a tool as a file-modifying op, returning the user-facing
 * kind for the summary card or `null` if it doesn't modify a file.
 * `write` creates (or overwrites) a file from scratch; `edit`
 * applies a patch to an existing one. `bash` is intentionally
 * excluded — it can also touch files but pi's event log doesn't
 * tell us which ones, so we'd end up with empty cards or false
 * negatives.
 */
function editOpKind(
  name: string | undefined,
): "create" | "edit" | null {
  const n = (name ?? "").toLowerCase()
  if (n === "write") return "create"
  if (n === "edit") return "edit"
  return null
}

/** Mirror of WriteCard's lineCount: the `write` tool body lives in
 * `content` (some SDK variants spell it `contents`). Empty payload
 * → 0, matching the inline card so the badge stays hidden in that
 * edge case. */
function lineCountOfWriteArgs(args: unknown): number {
  if (!args || typeof args !== "object") return 0
  const a = args as Record<string, unknown>
  const content = typeof a.content === "string" ? a.content : a.contents
  if (typeof content !== "string" || content.length === 0) return 0
  return content.split("\n").length
}

/** Mirror of countDiffLines + splitUnifiedDiff from tool-call-card.
 * Pulls the unified diff out of `result.details.diff` (same place
 * EditCard reads it), then tallies unique additions / removals by
 * line so a pure reformat doesn't double-count. Returns zeroes
 * when the SDK didn't stamp a diff onto the result. */
function editDiffStatsFromResult(
  result: unknown,
): { additions: number; removals: number } {
  if (!result || typeof result !== "object") return { additions: 0, removals: 0 }
  const r = result as Record<string, unknown>
  const details = r.details as Record<string, unknown> | undefined
  const diff = typeof details?.diff === "string" ? details.diff : undefined
  if (!diff) return { additions: 0, removals: 0 }
  const { oldText, newText } = splitUnifiedDiff(diff)
  const oldLines = oldText ? oldText.split("\n") : []
  const newLines = newText ? newText.split("\n") : []
  const oldSet = new Set(oldLines)
  const newSet = new Set(newLines)
  let additions = 0
  let removals = 0
  for (const line of newLines) if (!oldSet.has(line)) additions++
  for (const line of oldLines) if (!newSet.has(line)) removals++
  return { additions, removals }
}

function pickEditPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null
  return pickString(args as Record<string, unknown>, [
    "file_path",
    "path",
    "filePath",
  ])
}

/**
 * Edit tool args usually carry an absolute path (claude-code
 * convention), but git status / the diff viewer want
 * worktree-relative paths. If the path lives inside `directory`,
 * strip the prefix; otherwise leave it as-is so we don't fabricate
 * a relative path that points nowhere.
 */
function normalizeEditPath(
  filePath: string,
  directory: string | null,
): string {
  if (!directory) return filePath
  const dir = directory.endsWith("/") ? directory.slice(0, -1) : directory
  if (filePath === dir) return filePath
  const prefix = dir + "/"
  if (filePath.startsWith(prefix)) return filePath.slice(prefix.length)
  return filePath
}

/**
 * Figure out which configured worktree (primary `directory` or one
 * of `extraDirectories`) an edited file lives in. Picks the
 * *longest* matching dir prefix so a nested extra dir wins over
 * the primary cwd when both would match. Returns the primary
 * `directory` as the fallback so out-of-tree edits still get
 * attributed somewhere (matches the pre-extra-dirs behavior).
 */
function pickOwningDirectory(
  filePath: string,
  primary: string | null,
  extras: readonly string[],
): string | null {
  let best: string | null = null
  let bestLen = -1
  const candidates: (string | null)[] = [primary, ...extras]
  for (const cand of candidates) {
    if (!cand) continue
    const dir = cand.endsWith("/") ? cand.slice(0, -1) : cand
    if (filePath === dir || filePath.startsWith(dir + "/")) {
      if (dir.length > bestLen) {
        best = cand
        bestLen = dir.length
      }
    }
  }
  return best ?? primary
}

function splitUnifiedDiff(diff: string): {
  oldText: string
  newText: string
} {
  const oldLines: string[] = []
  const newLines: string[] = []
  for (const line of diff.split("\n")) {
    if (line.startsWith("---") || line.startsWith("+++")) continue
    if (line.startsWith("@@")) continue
    if (line.startsWith("-")) oldLines.push(line.slice(1))
    else if (line.startsWith("+")) newLines.push(line.slice(1))
    else if (line.startsWith(" ")) {
      oldLines.push(line.slice(1))
      newLines.push(line.slice(1))
    }
  }
  return { oldText: oldLines.join("\n"), newText: newLines.join("\n") }
}

/** Pull `.error.message` / `.message` out of pi's `errorMessage`
 * (typically `"<status> <JSON body>"`). Returns null when the
 * payload doesn't carry a parseable JSON object. */
function extractProviderErrorDetail(raw: string): string | null {
  const start = raw.indexOf("{")
  if (start < 0) return null
  const end = raw.lastIndexOf("}")
  if (end <= start) return null
  const slice = raw.slice(start, end + 1)
  let parsed: unknown
  try {
    parsed = JSON.parse(slice)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const obj = parsed as Record<string, unknown>
  const inner = obj.error
  if (inner && typeof inner === "object") {
    const msg = (inner as Record<string, unknown>).message
    if (typeof msg === "string" && msg.length > 0) return msg
  }
  if (typeof obj.message === "string" && obj.message.length > 0) {
    return obj.message
  }
  return null
}
