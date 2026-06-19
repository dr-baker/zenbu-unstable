import type { Schema } from "../../schema"

export type Session = Schema["sessions"][string]
export type ModelInfo = Schema["models"][string]

export type ImageRef = { blobId: string; mimeType: string }
export type QueueKind = "steer" | "followUp"
export type QueuedDraft = {
  id: string
  text: string
  images: ImageRef[]
  editorState: unknown
  createdAt: number
  kind: QueueKind
}

export type EventItem = {
  seq: number
  kind: string
  payload: unknown
  timestamp: number
}

export type ProviderModelRef = { provider: string; id: string }

/**
 * Tracks what's expected from pi's next user `message_end` event.
 *   preStaged  — we already appended a `user_prompt` to the event
 *                  log (`prompt()` path), so the matching pi event
 *                  is a no-op for materialization.
 *   synthesize — the message was dispatched as a queued or steer
 *                  item; pi will emit `message_end` when it delivers
 *                  it, and that's our cue to append a `user_prompt`
 *                  event so the chat surface renders the bubble.
 *
 * Carried out-of-band on `LiveSession` because pi events don't carry
 * the display text (with image-pill placeholders) or the imageRef
 * metadata we need to render the user-message bubble.
 */
export type ExpectedUserMessage =
  | { kind: "preStaged" }
  | { kind: "synthesize"; displayText: string; imageRefs: ImageRef[] }
