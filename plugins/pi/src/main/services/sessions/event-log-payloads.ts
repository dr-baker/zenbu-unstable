import { Buffer } from "node:buffer"
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent"

/**
 * Event-log payload standard.
 *
 * Persist only the data the app needs to replay chat UI. Provider
 * events often carry full conversation/message snapshots on every
 * streaming delta; those snapshots can grow O(n²) and have accounted
 * for gigabytes of local collection data. When a field is intentionally
 * omitted, leave a small `dropped` marker so future readers know the
 * lossiness is deliberate rather than corruption.
 */
export async function compactAgentEventForEventLog(
  event: AgentSessionEvent,
  options: { createBlob: (data: Uint8Array) => Promise<string> },
): Promise<unknown> {
  const raw = asRecord(event)
  const type = stringProp(raw, "type")

  if (type === "tool_execution_end") {
    return compactToolExecutionEnd(raw, options)
  }

  return compactAgentEventForEventLogSync(event)
}

/**
 * Synchronous variant used on the hot streaming path. Identical to
 * `compactAgentEventForEventLog` for every event type EXCEPT
 * `tool_execution_end`: that one may need to spill embedded image
 * `data` into a blob, which is async. For `tool_execution_end` this
 * function returns the raw event unchanged — the caller is expected
 * to gate on `toolExecutionEndHasImage(event)` and route the rare
 * image-bearing case through the async function above.
 *
 * Why it exists: the previous all-async signature meant `onPiEvent`
 * `await`-ed once per pi event even though 99% of events do zero
 * async work. Combined with one-concat-per-event, that turned every
 * streamed token into a microtask hop + a WS roundtrip ack. On a
 * fast model the chat surface visibly stalls. See `onPiEvent`'s
 * buffer/flush logic for the matching producer side.
 */
export function compactAgentEventForEventLogSync(
  event: AgentSessionEvent,
): unknown {
  const raw = asRecord(event)
  const type = stringProp(raw, "type")

  if (type === "message_update") return compactMessageUpdate(raw)

  if (type === "agent_end") {
    return omitWithDropped(raw, ["messages"])
  }

  if (type === "turn_end") {
    return omitWithDropped(raw, ["message", "toolResults"])
  }

  if (type === "message_start") {
    return compactMessageBoundary(raw, "message_start")
  }

  if (type === "message_end") {
    const message = asRecord(raw.message)
    const role = stringProp(message, "role")
    if (role === "assistant") return raw
    return compactMessageBoundary(raw, "message_end")
  }

  // tool_execution_end: image-bearing case is handled async by the
  // caller. With no images, the original implementation returned
  // `raw` unchanged (replaceImageDataWithBlobRefs walks the tree
  // without mutating anything), so it's safe to do the same here.
  return raw
}

/**
 * Cheap recursive probe used by `onPiEvent` to decide whether a
 * `tool_execution_end` event needs the async blob-spill path. Returns
 * true the moment we find an `{ type: "image", data: string }` node
 * anywhere under `result`. For the vast majority of tool results
 * (text-only) this short-circuits on the top-level array and the
 * event flows through the sync hot path.
 */
export function toolExecutionEndHasImage(event: AgentSessionEvent): boolean {
  if ((event as { type?: string }).type !== "tool_execution_end") return false
  return hasImageData((event as { result?: unknown }).result)
}

function hasImageData(value: unknown): boolean {
  if (Array.isArray(value)) {
    for (const item of value) if (hasImageData(item)) return true
    return false
  }
  if (!value || typeof value !== "object") return false
  const rec = value as Record<string, unknown>
  if (rec.type === "image" && typeof rec.data === "string") return true
  for (const k in rec) if (hasImageData(rec[k])) return true
  return false
}

async function compactToolExecutionEnd(
  raw: Record<string, unknown>,
  options: { createBlob: (data: Uint8Array) => Promise<string> },
): Promise<Record<string, unknown>> {
  try {
    const result = await replaceImageDataWithBlobRefs(raw.result, options)
    return result.changed
      ? {
          ...raw,
          result: result.value,
          dropped: mergeDropped(raw.dropped, ["result.content[].image.data"]),
        }
      : raw
  } catch (err) {
    console.warn("[event-log] image blob compaction failed:", err)
    return raw
  }
}

async function replaceImageDataWithBlobRefs(
  value: unknown,
  options: { createBlob: (data: Uint8Array) => Promise<string> },
): Promise<{ value: unknown; changed: boolean }> {
  if (Array.isArray(value)) {
    let changed = false
    const next: unknown[] = []
    for (const item of value) {
      const r = await replaceImageDataWithBlobRefs(item, options)
      changed ||= r.changed
      next.push(r.value)
    }
    return { value: changed ? next : value, changed }
  }

  const record = asRecord(value)
  if (Object.keys(record).length === 0) return { value, changed: false }

  if (stringProp(record, "type") === "image") {
    const data = stringProp(record, "data")
    if (data) {
      const bytes = decodeBase64(data)
      const blobId = await options.createBlob(bytes)
      return {
        value: {
          ...record,
          data: undefined,
          blobId,
          mimeType: imageMimeType(record),
          dropped: mergeDropped(record.dropped, ["data"]),
        },
        changed: true,
      }
    }
  }

  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(record)) {
    const r = await replaceImageDataWithBlobRefs(child, options)
    changed ||= r.changed
    next[key] = r.value
  }
  return { value: changed ? next : value, changed }
}

function compactMessageUpdate(raw: Record<string, unknown>): Record<string, unknown> {
  const assistantEvent = asRecord(raw.assistantMessageEvent)
  const dropped = ["message", "assistantMessageEvent.partial"]
  if (shouldDropStreamingToolArguments(assistantEvent)) {
    dropped.push("assistantMessageEvent.toolCall.arguments")
  }
  return {
    type: "message_update",
    assistantMessageEvent: compactAssistantMessageEvent(assistantEvent),
    dropped,
  }
}

function compactAssistantMessageEvent(
  event: Record<string, unknown>,
): Record<string, unknown> {
  const type = stringProp(event, "type")
  const contentIndex = numberProp(event, "contentIndex")
  const compact: Record<string, unknown> = { type }
  if (contentIndex != null) compact.contentIndex = contentIndex

  const delta = stringProp(event, "delta")
  if (delta != null) compact.delta = delta

  const content = stringProp(event, "content")
  if (content != null) compact.content = content

  const toolCall = event.toolCall ?? toolCallMetaFromPartial(event)
  if (toolCall != null) {
    compact.toolCall = compactToolCall(toolCall, {
      includeArguments: type === "toolcall_end",
    })
  }

  return compact
}

function compactMessageBoundary(
  raw: Record<string, unknown>,
  fallbackType: string,
): Record<string, unknown> {
  const message = asRecord(raw.message)
  const role = stringProp(message, "role")
  return {
    type: stringProp(raw, "type") ?? fallbackType,
    message: role ? { role } : undefined,
    dropped: ["message.content"],
  }
}

function omitWithDropped(
  raw: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key)) out[key] = value
  }
  out.dropped = keys
  return out
}

function toolCallMetaFromPartial(event: Record<string, unknown>): unknown {
  const contentIndex = numberProp(event, "contentIndex")
  if (contentIndex == null) return null
  const partial = asRecord(event.partial)
  const content = Array.isArray(partial.content) ? partial.content : null
  const block = content?.[contentIndex]
  const record = asRecord(block)
  return stringProp(record, "type") === "toolCall" ? record : null
}

function compactToolCall(
  value: unknown,
  options: { includeArguments: boolean },
): Record<string, unknown> | null {
  const record = asRecord(value)
  if (stringProp(record, "type") !== "toolCall") return null
  const id = stringProp(record, "id")
  const name = stringProp(record, "name")
  if (!id || !name) return null
  const out: Record<string, unknown> = { type: "toolCall", id, name }
  if (options.includeArguments && "arguments" in record) {
    out.arguments = record.arguments
  }
  return out
}

function shouldDropStreamingToolArguments(
  event: Record<string, unknown>,
): boolean {
  if (stringProp(event, "type") !== "toolcall_delta") return false
  const toolCall = event.toolCall ?? toolCallMetaFromPartial(event)
  return "arguments" in asRecord(toolCall)
}

function decodeBase64(data: string): Uint8Array {
  return Uint8Array.from(Buffer.from(data, "base64"))
}

function imageMimeType(record: Record<string, unknown>): string {
  return (
    stringProp(record, "mimeType") ??
    stringProp(record, "mediaType") ??
    stringProp(record, "mime") ??
    "image/png"
  )
}

function mergeDropped(existing: unknown, added: string[]): string[] {
  const out = new Set<string>()
  if (Array.isArray(existing)) {
    for (const item of existing) {
      if (typeof item === "string") out.add(item)
    }
  }
  for (const item of added) out.add(item)
  return [...out]
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringProp(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key]
  return typeof value === "string" ? value : null
}

function numberProp(
  record: Record<string, unknown>,
  key: string,
): number | null {
  const value = record[key]
  return typeof value === "number" ? value : null
}
