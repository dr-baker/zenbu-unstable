import { nanoid } from "nanoid"
import { SessionManager } from "@earendil-works/pi-coding-agent"
import type { SessionsService } from "../sessions"
import {
  PI_SESSION_DIR,
  requireRecord,
  resolveSessionLabelSnapshot,
  syncRuntime,
} from "./activation"
import {
  rebuildEventLogFromCurrentPath,
  safeConcatEventLog,
} from "./event-log"
import { extractTextContent } from "./labels"
import { flushSessionManagerHeader } from "./pi-utils"
import { emptyStats } from "./stats"
import type { EventItem, Session } from "./types"

type Svc = SessionsService

/**
 * Wait for a value derived from the db root to become truthy, then
 * return it. Used to absorb the small replication lag between the
 * renderer writing a record and main's replica seeing it.
 *
 * The renderer pattern is:
 *   await dbClient.update(root => { root.app.chats[id] = ... })
 *   await rpc.pi.sessions.createChatSession({ chatId: id, ... })
 *
 * The `await` on `update()` resolves once the local replica has
 * applied the change, but propagation to other processes (main,
 * other windows) happens in the background — so the RPC can land
 * in main before its replica has the chat record yet. Without
 * this guard, we'd throw `unknown chat ${id}` for a record the
 * caller correctly created moments earlier.
 *
 * `timeoutMs` is intentionally short: a real "this id was never
 * written" bug should still surface as a thrown error, not hang
 * the call indefinitely.
 */
async function waitForDbValue<T>(
  svc: Svc,
  read: () => T | null | undefined,
  field: { subscribe: (cb: () => void) => () => void },
  timeoutMs = 2000,
): Promise<T | null> {
  const initial = read()
  if (initial) return initial
  return new Promise<T | null>(resolve => {
    let done = false
    const finish = (v: T | null) => {
      if (done) return
      done = true
      clearTimeout(timer)
      unsub()
      resolve(v)
    }
    const unsub = field.subscribe(() => {
      const v = read()
      if (v) finish(v)
    })
    const timer = setTimeout(() => finish(read() ?? null), timeoutMs)
  })
}

export async function createChatSession(args: {
  svc: Svc
  scopeId: string
  chatId: string
  parentSessionId?: string
  parentEntryId?: string
  title?: string
}): Promise<{ sessionId: string }> {
  const { svc } = args
  // Both scope and chat may be in-flight from a renderer-side
  // `dbClient.update()` whose replication to main hasn't landed
  // yet. Wait briefly for them before declaring failure — see
  // waitForDbValue's comment for the full race.
  const scope = await waitForDbValue(
    svc,
    () => svc.ctx.db.client.readRoot().app.scopes[args.scopeId],
    svc.ctx.db.client.app.scopes,
  )
  if (!scope) {
    throw new Error(`unknown scope ${args.scopeId}`)
  }
  const chat = await waitForDbValue(
    svc,
    () => svc.ctx.db.client.readRoot().app.chats[args.chatId],
    svc.ctx.db.client.app.chats,
  )
  if (!chat) {
    throw new Error(`unknown chat ${args.chatId}`)
  }
  if (chat.session.kind === "ready") {
    return { sessionId: chat.session.sessionId }
  }

  const sm = SessionManager.create(scope.directory, PI_SESSION_DIR)
  const sessionId = sm.getSessionId()
  const sessionFile = sm.getSessionFile()
  if (!sessionFile) {
    throw new Error("SessionManager did not produce a session file")
  }
  const title = args.title ?? "Untitled"
  if (args.title?.trim()) {
    sm.appendSessionInfo(args.title.trim())
  }

  // Force pi's SessionManager to write the session header to disk
  // NOW, before we discard `sm`. Without this, the file stays
  // in-memory-only until something appends an entry, and our
  // recorded `piSessionId` / `sessionFile` point at a path that
  // doesn't exist on disk yet.
  //
  // The trouble that causes: the next `ensureLive(sessionId)`
  // calls `SessionManager.open(record.sessionFile, …)`, which
  // sees an empty/missing file and falls into pi's
  // "empty-or-corrupted, generate a fresh session id" recovery
  // branch. The result: the live runtime's in-memory sessionId
  // is a NEW UUID (created 30–40ms later) while our DB record
  // still has the original. Everything else on top of that
  // (clone, prompts, navigateTree, eventLog appends) operates
  // against a corrupted runtime — see the
  // `runtime_session_manager_mutated` invariant verdict.
  flushSessionManagerHeader({ sm })

  // fixme: this should be using make collection api
  const eventLogRef = {
    collectionId: nanoid(),
    debugName: `events-${sessionId}`,
  }

  const record: Session = {
    id: sessionId,
    scopeId: args.scopeId,
    parentSessionId: args.parentSessionId ?? null,
    parentEntryId: args.parentEntryId ?? null,
    title,
    sessionFile,
    piSessionId: sessionId,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    lastMessageSentTime: null,
    archived: false,
    model: null,
    thinkingLevel: "medium",
    isStreaming: false,
    currentLeafEntryId: null,
    queue: { steering: [], followUp: [] },
    queueDraft: [],
    subscriberCount: 0,
    leafCount: 1,
    branchSummary: null,
    stats: emptyStats(),
    runStartContextTokens: null,
    lastOpenedAt: null,
    lastCompletedAt: null,
    eventLog: eventLogRef as Session["eventLog"],
  }

  await svc.ctx.db.client.update(root => {
    root.pi.sessions[sessionId] = record
    const chatRecord = root.app.chats[args.chatId]
    if (chatRecord) {
      chatRecord.session = { kind: "ready", sessionId }
    }
  })

  return { sessionId }
}

export async function fork(args: {
  svc: Svc
  sessionId: string
  entryId: string
  workspaceId: string
  title?: string
}): Promise<{ sessionId: string; chatId: string; scopeId: string }> {
  const { svc } = args
  const parent = requireRecord({ svc, sessionId: args.sessionId })
  const live = await svc.ensureLive(args.sessionId)
  live.pi.sessionManager.branch(args.entryId)

  const parentScope = svc.ctx.db.client.readRoot().app.scopes[parent.scopeId]
  if (!parentScope) {
    throw new Error(`unknown scope ${parent.scopeId}`)
  }

  const newSm = SessionManager.forkFrom(
    parent.sessionFile,
    parentScope.directory,
    PI_SESSION_DIR,
  )
  const childId = newSm.getSessionId()
  const childFile = newSm.getSessionFile()
  if (!childFile) {
    throw new Error("forked SessionManager did not produce a session file")
  }
  const title = args.title ?? `${parent.title} (fork)`
  newSm.appendSessionInfo(title)
  // Same persist-before-discard contract as createChatSession.
  flushSessionManagerHeader({ sm: newSm })

  const eventLogRef = {
    collectionId: nanoid(),
    debugName: `events-${childId}`,
  }

  const chatId = nanoid()
  const scopeId = parentScope.id

  await svc.ctx.db.client.update(root => {
    root.pi.sessions[childId] = {
      id: childId,
      scopeId,
      parentSessionId: parent.id,
      parentEntryId: args.entryId,
      title,
      sessionFile: childFile,
      piSessionId: childId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastMessageSentTime: null,
      archived: false,
      model: null,
      thinkingLevel: "medium",
      isStreaming: false,
      currentLeafEntryId: null,
      queue: { steering: [], followUp: [] },
      queueDraft: [],
      subscriberCount: 0,
      leafCount: 1,
      branchSummary: null,
      stats: emptyStats(),
      runStartContextTokens: null,
      lastOpenedAt: null,
      lastCompletedAt: null,
      eventLog: eventLogRef as Session["eventLog"],
    }
    root.app.chats[chatId] = {
      id: chatId,
      scopeId,
      session: { kind: "ready", sessionId: childId },
      createdAt: Date.now(),
    }
  })

  return { sessionId: childId, chatId, scopeId }
}

/**
 * Duplicate the current session at the current leaf.
 *
 * Mirrors pi's `/clone` slash command (see
 * `agent-session-runtime.fork(leafId, { position: "at" })`):
 * we take the source session's linear path from root → current
 * leaf and write it as a brand-new session file via
 * `SessionManager.createBranchedSession(leafId)`. The result is a
 * standalone session that starts with an exact copy of the
 * conversation history up to here, with no shared mutation state.
 *
 * Returns a fresh `sessionId` + `chatId` + `scopeId`. Caller is
 * expected to swap the active tab's chat to the new `chatId` so
 * the user immediately sees the cloned session (the cloning act
 * itself does NOT change pi state on the source session).
 */
export async function clone(args: {
  svc: Svc
  sessionId: string
  title?: string
}): Promise<{ sessionId: string; chatId: string; scopeId: string }> {
  const { svc } = args
  const parent = requireRecord({ svc, sessionId: args.sessionId })
  const live = await svc.ensureLive(args.sessionId)
  const leafId = live.pi.sessionManager.getLeafId()
  if (!leafId) {
    throw new Error("Cannot clone: session has no current entry")
  }
  const parentScope = svc.ctx.db.client.readRoot().app.scopes[parent.scopeId]
  if (!parentScope) {
    throw new Error(`unknown scope ${parent.scopeId}`)
  }
  // CRITICAL: `createBranchedSession` mutates the SessionManager it
  // is called on — it overwrites `sessionId`, `sessionFile`, and
  // `fileEntries` in place, then rebuilds the index. If we call it
  // on `live.pi.sessionManager`, the *parent*'s live pi runtime
  // ends up pointing at the child's file with the child's id, and
  // every subsequent prompt/append on the parent silently operates
  // on the child file. Symptom: send a message in the OG chat
  // post-clone and watch the renderer drift permanently out of
  // sync with the eventLog — the underlying pi is corrupted.
  //
  // Open a throwaway SessionManager from the parent's file on
  // disk and call createBranchedSession on THAT instead. The live
  // parent runtime stays untouched. This matches what pi's own
  // `fork()` does internally.
  const sourceSm = SessionManager.open(parent.sessionFile, PI_SESSION_DIR)
  const newPath = sourceSm.createBranchedSession(leafId)
  if (!newPath) {
    throw new Error(
      "createBranchedSession returned undefined (session not persisted?)",
    )
  }
  const newSm = SessionManager.open(newPath, PI_SESSION_DIR)
  const childId = newSm.getSessionId()
  const childFile = newSm.getSessionFile()
  if (!childFile) {
    throw new Error("cloned SessionManager did not produce a session file")
  }
  const title = args.title ?? `${parent.title} (clone)`
  newSm.appendSessionInfo(title)

  // Same persist-before-discard contract as createChatSession.
  // Note: `sourceSm.createBranchedSession` already wrote the
  // file IF the branch contains an assistant message. If the
  // leaf is a user message, pi defers the write until first
  // assistant response — leaving the same empty-file hazard
  // we hit in createChatSession. Force-flush to close it.
  flushSessionManagerHeader({ sm: newSm })

  const eventLogRef = {
    collectionId: nanoid(),
    debugName: `events-${childId}`,
  }

  const chatId = nanoid()
  const scopeId = parentScope.id

  await svc.ctx.db.client.update(root => {
    root.pi.sessions[childId] = {
      id: childId,
      scopeId,
      parentSessionId: parent.id,
      parentEntryId: leafId,
      title,
      sessionFile: childFile,
      piSessionId: childId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastMessageSentTime: null,
      archived: false,
      model: parent.model,
      thinkingLevel: parent.thinkingLevel,
      isStreaming: false,
      currentLeafEntryId: null,
      queue: { steering: [], followUp: [] },
      queueDraft: [],
      subscriberCount: 0,
      leafCount: 1,
      branchSummary: null,
      stats: emptyStats(),
      runStartContextTokens: null,
      lastOpenedAt: null,
      lastCompletedAt: null,
      eventLog: eventLogRef as Session["eventLog"],
    }
    root.app.chats[chatId] = {
      id: chatId,
      scopeId,
      session: { kind: "ready", sessionId: childId },
      createdAt: Date.now(),
    }
  })

  // Activate pi on the cloned session and synthesize its event log
  // from the file we just wrote. Without this, the new chat shows
  // an empty surface even though the session file contains the
  // full root → leaf history — our materialize layer reads from
  // the eventLog collection, not directly from pi.
  //
  // `rebuildEventLogFromCurrentPath` walks `live.pi.messages`
  // (already populated by SessionManager.open on activation) and
  // emits the same kind of synthetic events the navigateTree path
  // produces, so the renderer sees a normal chat history
  // immediately.
  const childLive = await svc.ensureLive(childId)
  const ctx = {
    db: svc.ctx.db.client,
    getLive: (id: string) => svc.live.get(id),
  }
  await rebuildEventLogFromCurrentPath({ ctx, live: childLive })

  // Stamp a synthetic `cloned_from` event at the tail of the new
  // eventLog so materialize.ts can render a divider in the chat
  // showing "this is where the clone happened". Lives in the
  // eventLog (not pi's session entries) because it's purely a
  // UI marker — pi has no concept of "this session was cloned".
  //
  // `parentTitle` is the fallback label used by the marker when
  // the parent no longer exists. Stamp it with the cached Pi
  // session name so the marker doesn't show the literal string
  // "Untitled".
  childLive.seq++
  const cloneEvent: EventItem = {
    seq: childLive.seq,
    kind: "cloned_from",
    payload: {
      parentSessionId: parent.id,
      parentTitle: resolveSessionLabelSnapshot({ svc, sessionId: parent.id }),
      parentEntryId: leafId,
    },
    timestamp: Date.now(),
  }
  await safeConcatEventLog({
    ctx,
    sessionId: childId,
    items: [cloneEvent],
    context: "clone marker",
  })

  await syncRuntime({ svc, live: childLive })

  return { sessionId: childId, chatId, scopeId }
}

/**
 * Pi-style fork from a user message.
 *
 * The user picks a `user` message in the source session's tree.
 * We:
 *   1. Take the path root → parent-of-that-message and write it
 *      to a new session file via `createBranchedSession`. The
 *      picked message itself is NOT copied.
 *   2. Extract the picked message's text and stage it in the new
 *      chat's persisted draft so the composer auto-fills with it
 *      on first mount.
 *   3. In ONE db update: create the new session record, new chat
 *      record, set the chat's draft, and append a new tab
 *      containing that chat to the window's active pane.
 *
 * Effect: user types `/fork`, picks an old user message, lands in
 * a new tab with prior context already loaded and the picked
 * message text in the composer ready to edit and resend.
 *
 * Distinct from `clone`: clone keeps the picked entry (and its
 * assistant response) in the new session. Fork drops the picked
 * user message (and any descendants on the current path) so the
 * user can re-issue it differently.
 */
export async function forkAtUserMessage(args: {
  svc: Svc
  sessionId: string
  /** Pi entry id of the user message to fork at. Must be a
   * `message` entry with `role === "user"`. */
  entryId: string
  /** Window id whose active pane should receive the new tab. */
  windowId: string
}): Promise<{
  sessionId: string
  chatId: string
  scopeId: string
  editorText: string
}> {
  const { svc } = args
  const parent = requireRecord({ svc, sessionId: args.sessionId })
  const parentScope = svc.ctx.db.client.readRoot().app.scopes[parent.scopeId]
  if (!parentScope) {
    throw new Error(`unknown scope ${parent.scopeId}`)
  }
  // Look up the picked entry. We deliberately open a separate
  // SessionManager rather than touching the live one (see
  // clone()'s comment on why `createBranchedSession` mutates).
  const sourceSm = SessionManager.open(parent.sessionFile, PI_SESSION_DIR)
  const pickedEntry = sourceSm.getEntry(args.entryId) as
    | {
        id: string
        type: string
        parentId: string | null
        message?: { role?: string; content?: unknown }
      }
    | null
  if (!pickedEntry || pickedEntry.type !== "message") {
    throw new Error(`Entry ${args.entryId} is not a message entry`)
  }
  if (pickedEntry.message?.role !== "user") {
    throw new Error(
      `Entry ${args.entryId} is not a user message (role=${pickedEntry.message?.role})`,
    )
  }
  const editorText = extractTextContent({ content: pickedEntry.message.content })
  // `position: "before"` semantics: new leaf is the PARENT of the
  // picked user message. `createBranchedSession(null)` resets to
  // a clean root, which is fine for the case where the picked
  // message was the very first user message in the session.
  const newLeafId = pickedEntry.parentId
  const newPath =
    newLeafId === null
      ? // No parent: forking before the first message produces an
        // empty session. createBranchedSession requires a real leaf
        // id, so synthesize an empty SessionManager directly.
        SessionManager.create(
          parentScope.directory,
          PI_SESSION_DIR,
        ).getSessionFile()
      : sourceSm.createBranchedSession(newLeafId)
  if (!newPath) {
    throw new Error(
      "could not produce a forked session file (source not persisted?)",
    )
  }
  const newSm = SessionManager.open(newPath, PI_SESSION_DIR)
  const childId = newSm.getSessionId()
  const childFile = newSm.getSessionFile()
  if (!childFile) {
    throw new Error("forked SessionManager did not produce a session file")
  }

  const eventLogRef = {
    collectionId: nanoid(),
    debugName: `events-${childId}`,
  }
  const chatId = nanoid()
  const scopeId = parentScope.id
  const tabId = nanoid()

  const title = `${parent.title} (fork)`
  newSm.appendSessionInfo(title)
  flushSessionManagerHeader({ sm: newSm })

  // SINGLE db update: session record + chat record + persisted
  // draft + new active tab. Everything the renderer needs to mount
  // the new chat with the forked message in the composer lands in
  // one transaction; the renderer sees no intermediate state.
  await svc.ctx.db.client.update(root => {
    root.pi.sessions[childId] = {
      id: childId,
      scopeId,
      parentSessionId: parent.id,
      parentEntryId: args.entryId,
      title,
      sessionFile: childFile,
      piSessionId: childId,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      lastMessageSentTime: null,
      archived: false,
      model: parent.model,
      thinkingLevel: parent.thinkingLevel,
      isStreaming: false,
      currentLeafEntryId: null,
      queue: { steering: [], followUp: [] },
      queueDraft: [],
      subscriberCount: 0,
      leafCount: 1,
      branchSummary: null,
      stats: emptyStats(),
      runStartContextTokens: null,
      lastOpenedAt: null,
      lastCompletedAt: null,
      eventLog: eventLogRef as Session["eventLog"],
    }
    root.app.chats[chatId] = {
      id: chatId,
      scopeId,
      session: { kind: "ready", sessionId: childId },
      createdAt: Date.now(),
    }
    root.app.chatStates[chatId] = {
      chatId,
      locked: false,
      draft: editorText,
    }
    // Append a new tab containing this chat to the active pane
    // of the requested window's active scope. Mirrors the logic
    // in `openChatInNewTabInRoot` but inlined so the whole
    // mutation is one transaction.
    const ws = root.app.windowStates[args.windowId]
    if (ws) {
      const workspaceId = parentScope.workspaceId
      ws.activeView = { kind: "workspace", workspaceId }
      ws.selectedScopeId = scopeId
      ws.workspaceActiveScope[workspaceId] = scopeId
      const state = ws.scopePanes?.[scopeId]
      if (state && state.panes.length > 0) {
        const paneIdx =
          state.panes.findIndex(p => p.id === state.activePaneId) >= 0
            ? state.panes.findIndex(p => p.id === state.activePaneId)
            : 0
        const pane = state.panes[paneIdx]!
        const newTabContent = { kind: "chat" as const, chatId }
        state.panes[paneIdx] = {
          ...pane,
          tabs: [
            ...pane.tabs,
            {
              id: tabId,
              content: newTabContent,
            },
          ],
          activeTabId: tabId,
        }
      }
    }
  })

  // Hydrate pi for the new session + rebuild its event log from
  // the file we just wrote. Same dance as clone(); see that
  // method for the rationale on why this is needed even though
  // the file already exists on disk.
  const childLive = await svc.ensureLive(childId)
  const ctx = {
    db: svc.ctx.db.client,
    getLive: (id: string) => svc.live.get(id),
  }
  await rebuildEventLogFromCurrentPath({ ctx, live: childLive })

  // Marker event at the tail so materialize.ts can show a divider
  // "forked from <parent title>" — same pattern as cloned_from.
  childLive.seq++
  const forkEvent: EventItem = {
    seq: childLive.seq,
    kind: "forked_from",
    payload: {
      parentSessionId: parent.id,
      parentTitle: resolveSessionLabelSnapshot({ svc, sessionId: parent.id }),
      parentEntryId: args.entryId,
    },
    timestamp: Date.now(),
  }
  await safeConcatEventLog({
    ctx,
    sessionId: childId,
    items: [forkEvent],
    context: "fork marker",
  })

  await syncRuntime({ svc, live: childLive })

  return { sessionId: childId, chatId, scopeId, editorText }
}

export async function deleteSession(args: {
  svc: Svc
  sessionId: string
}): Promise<void> {
  const { svc, sessionId } = args
  const live = svc.live.get(sessionId)
  if (live) {
    live.dispose()
    svc.live.delete(sessionId)
  }
  await svc.ctx.db.client.pi.sessions[sessionId].eventLog
    .delete()
    .catch(() => {})
  await svc.ctx.db.client.update(root => {
    delete root.pi.sessions[sessionId]
  })
}
