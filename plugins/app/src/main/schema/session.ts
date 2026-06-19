import { z } from "@zenbujs/core/db";

// `session`, `killedSession`, and `reloadToast` moved to the pi plugin
// with the sessions services (see BREAKING.md). Only the chat surface
// records remain here.

// ---------------------------------------------------------------------------
// Chat (the renderer-side handle that owns a session + composer draft)
// ---------------------------------------------------------------------------

const chatSessionRef = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("ready"), sessionId: z.string() }),
]);

export const chat = z.object({
  id: z.string(),
  scopeId: z.string(),
  session: chatSessionRef,
  createdAt: z.number(),
});

export const chatState = z.object({
  chatId: z.string(),
  locked: z.boolean(),
  /** Persisted composer input. Plain doc text — file pills (`@<path>`)
   * re-decorate from the scanner on restore, and image pills
   * (`@blob:<id>`) re-hydrate via `hydrateImage`. Empty string =
   * no draft. */
  draft: z.string().default(""),
});

/**
 * Tab state for the standalone chat-window view, keyed by Electron
 * windowId. The window stays open as long as `tabs` is non-empty.
 */
export const chatWindowState = z.object({
  tabs: z.array(z.string()).default([]),
  activeChatId: z.string().nullable().default(null),
});
