import { useSyncExternalStore } from "react"
import { nanoid } from "nanoid"

/**
 * Renderer-side store for chat invariant violations.
 *
 * Lives outside React so it survives chat-pane unmount/remount (the
 * tabbed UI mounts a fresh pane every time you switch chats). Keyed
 * by `chatId` so the overlay only shows errors for the chat the
 * user is currently looking at.
 *
 * Intentionally NOT persisted to the DB: invariant violations are a
 * dev-time signal about renderer↔service contracts, and they should
 * reset on reload. If a class of error survives a reload, it'll
 * re-fire from whatever check raised it the first time.
 */

export type InvariantError = {
  id: string
  chatId: string
  /** Stable kind identifier. Used as a header in the UI and as the
   * de-dupe key when an invariant fires repeatedly for the same
   * underlying cause. */
  kind: string
  /** Human-readable one-line description. */
  message: string
  /** Arbitrary structured payload. Rendered as JSON in the expanded
   * view and copied to the clipboard verbatim. Keep this small —
   * deep cloning happens on every emit. */
  data: unknown
  timestamp: number
}

type Store = {
  errors: InvariantError[]
}

const store: Store = { errors: [] }
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/**
 * Append a new invariant. Returns the generated id so the caller can
 * dismiss it programmatically later if it wants to.
 */
export function reportInvariant(args: {
  chatId: string
  kind: string
  message: string
  data?: unknown
}): string {
  const err: InvariantError = {
    id: nanoid(),
    chatId: args.chatId,
    kind: args.kind,
    message: args.message,
    data: args.data ?? null,
    timestamp: Date.now(),
  }
  store.errors = [...store.errors, err]
  emit()
  // Also stamp it into the console so it shows up in devtools alongside
  // the rest of the renderer's noise.
  console.warn(`[invariant] ${args.kind}: ${args.message}`, args.data)
  return err.id
}

export function dismissInvariant(id: string): void {
  const next = store.errors.filter(e => e.id !== id)
  if (next.length === store.errors.length) return
  store.errors = next
  emit()
}

export function clearChatInvariants(chatId: string): void {
  const next = store.errors.filter(e => e.chatId !== chatId)
  if (next.length === store.errors.length) return
  store.errors = next
  emit()
}

// Snapshot for the empty-chat case so identity stays stable across
// renders — useSyncExternalStore otherwise tears infinitely if
// `getSnapshot` returns a new reference on every call.
const EMPTY: InvariantError[] = []

// Cache of the most recently computed per-chat slice. We must return
// a stable reference from `getSnapshot` between emits; each emit
// replaces `store.errors` so we use that array identity as the cache
// key.
const sliceCache = new Map<string, InvariantError[]>()
let sliceCacheRoot: InvariantError[] = store.errors

function getChatSlice(chatId: string): InvariantError[] {
  if (sliceCacheRoot !== store.errors) {
    sliceCache.clear()
    sliceCacheRoot = store.errors
  }
  const cached = sliceCache.get(chatId)
  if (cached) return cached
  const filtered = store.errors.filter(e => e.chatId === chatId)
  const next = filtered.length === 0 ? EMPTY : filtered
  sliceCache.set(chatId, next)
  return next
}

/**
 * Subscribe to invariants for one chat. Returns a new array reference
 * only when the slice actually changes.
 */
export function useChatInvariants(chatId: string | null): InvariantError[] {
  return useSyncExternalStore(
    subscribe,
    () => (chatId ? getChatSlice(chatId) : EMPTY),
    () => EMPTY,
  )
}
