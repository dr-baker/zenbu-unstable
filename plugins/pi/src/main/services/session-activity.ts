import { Service } from "@zenbujs/core/runtime"
import { DbService } from "@zenbujs/core/services"

/**
 * Server-side derivation of "which sessions are currently being viewed
 * by the user, in any window". Subscribes to `windowStates` + `chats`
 * and recomputes the viewer set on every change. When a session enters
 * the viewer set (transitions from unseen → being-watched), its
 * `lastOpenedAt` is stamped to `Date.now()`.
 *
 * Paired with `SessionsService` on the `agent_end` path: when an
 * agent run finishes, sessions check `isViewed(sessionId)` here and
 * bump `lastOpenedAt` together with `lastCompletedAt` so the
 * unread-dot never appears on a session the user is actively looking
 * at. Sessions the user is NOT currently looking at only get
 * `lastCompletedAt` stamped, and the dot appears via the
 * `lastCompletedAt > lastOpenedAt` rule until they revisit.
 *
 * "Viewing" is defined as: the chat referenced by the active tab in
 * any pane of any window's currently-selected workspace. Chat-window
 * (`root.app.chatWindows`) active tabs count too, so a popped-out
 * chat suppresses the dot the same way a docked tab does.
 */
export class SessionActivityService extends Service.create({
  key: "sessionActivity",
  deps: { db: DbService },
}) {
  /** sessionId → set of viewerKeys currently looking at it. A
   * viewerKey is "<windowId>:<paneId>" for pane tabs, or
   * "chatWindow:<windowId>" for the standalone chat-window. We
   * track the full set (not just a count) so we can recompute
   * idempotently on every db change without leaking refcount
   * drift if a window's pane state mutates in unexpected ways. */
  private readonly viewers = new Map<string, Set<string>>()

  evaluate() {
    this.setup("watch", () => {
      this.recompute()
      const unsubWindows = this.ctx.db.client.app.windowStates.subscribe(
        () => this.recompute(),
      )
      const unsubChats = this.ctx.db.client.app.chats.subscribe(
        () => this.recompute(),
      )
      const unsubChatWindows = this.ctx.db.client.app.chatWindows.subscribe(
        () => this.recompute(),
      )
      return () => {
        unsubWindows()
        unsubChats()
        unsubChatWindows()
      }
    })
  }

  /** Called by `SessionsService` on `agent_end`. Returns true when the
   * session is currently the active tab in at least one window. */
  isViewed(sessionId: string): boolean {
    const set = this.viewers.get(sessionId)
    return !!set && set.size > 0
  }

  private recompute(): void {
    const root = this.ctx.db.client.readRoot()
    const next = computeViewers(root)
    const opened = new Set<string>()
    for (const sessionId of next.keys()) {
      if (!this.viewers.has(sessionId)) opened.add(sessionId)
    }
    this.viewers.clear()
    for (const [sessionId, viewerKeys] of next) {
      this.viewers.set(sessionId, viewerKeys)
    }
    if (opened.size === 0) return
    const now = Date.now()
    void this.ctx.db.client
      .update(root => {
        for (const sessionId of opened) {
          const s = root.pi.sessions[sessionId]
          if (!s) continue
          s.lastOpenedAt = now
        }
      })
      .catch(err =>
        console.warn(
          "[session-activity] failed to stamp lastOpenedAt:",
          err,
        ),
      )
  }
}

/** Walk the db root and build `sessionId → viewerKeys`. The viewer
 * set is "the union of active-tab chats across every window's panes
 * (in the active workspace) and every chat-window's activeChatId,
 * resolved to ready sessions." Pure function so it's trivial to
 * reason about and test. */
function computeViewers(
  // Inline `any`-ish type: the db proxy isn't exported as a named
  // type in the service runtime, and the consumer treats every
  // field as optional via `??` guards anyway. Keeping this loose
  // avoids a fragile dependency on the generated Schema shape.
  root: ReturnType<DbService["client"]["readRoot"]>,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>()

  const add = (sessionId: string, viewerKey: string) => {
    let set = out.get(sessionId)
    if (!set) {
      set = new Set()
      out.set(sessionId, set)
    }
    set.add(viewerKey)
  }

  const sessionIdOfChat = (chatId: string | null | undefined): string | null => {
    if (!chatId) return null
    const chat = root.app.chats[chatId]
    if (!chat) return null
    return chat.session.kind === "ready" ? chat.session.sessionId : null
  }

  for (const [windowId, ws] of Object.entries(root.app.windowStates ?? {})) {
    if (!ws) continue
    // Only count panes as "viewing" when the user is on a workspace
    // (not onboarding) and that workspace has an active scope.
    if (ws.activeView.kind !== "workspace") continue
    const scopeId = ws.selectedScopeId
    if (!scopeId) continue
    const paneState = ws.scopePanes?.[scopeId]
    if (!paneState) continue
    for (const pane of paneState.panes) {
      const tab =
        pane.tabs.find(t => t.id === pane.activeTabId) ?? pane.tabs[0]
      if (!tab || tab.content.kind !== "chat") continue
      const sessionId = sessionIdOfChat(tab.content.chatId)
      if (sessionId) add(sessionId, `${windowId}:${pane.id}`)
    }
  }

  for (const [windowId, cw] of Object.entries(root.app.chatWindows ?? {})) {
    if (!cw) continue
    const sessionId = sessionIdOfChat(cw.activeChatId)
    if (sessionId) add(sessionId, `chatWindow:${windowId}`)
  }

  return out
}
