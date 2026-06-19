import { useDb, useDbClient } from "@zenbujs/core/react"
import type { CloneMarkerProps } from "../message-components"
import { useWindowId } from "@/lib/window-state/window-id"
import { openChatInNewTabInRoot } from "@/lib/window-state/panes/tabs"
/**
 * Divider rendered at the point a session was cloned or forked.
 * The underlying event is either `cloned_from` (synthesized by
 * `SessionsService.clone`) or `forked_from` (synthesized by
 * `SessionsService.forkAtUserMessage`); materialize.ts collapses
 * both into a single `clone_marker` row with a `variant` flag.
 *
 * Why it's useful: both clone and fork produce a new session that
 * opens with the parent's history already in place, which can be
 * disorienting ("did I just somehow get all this context?"). The
 * marker draws an explicit line so the user can see where the
 * derived chat began.
 *
 * Clicking the parent title opens the parent session in a new tab
 * (no live link — the two sessions are independent from this
 * point onward).
 */
export function CloneMarker({
  variant,
  parentSessionId,
  parentTitle,
  parentEntryId,
  timestamp,
}: CloneMarkerProps) {
  void parentEntryId // reserved for "scroll parent to this entry" later
  void timestamp // wallclock kept on the event for the eventLog view, not rendered here

  const dbClient = useDbClient()
  const windowId = useWindowId()
  const parentExists = useDb(root =>
    parentSessionId ? !!root.pi.sessions[parentSessionId] : false,
  )
  // Resolve a chat that points at the parent session, if any.
  // Click below opens that chat in a NEW tab rather than replacing
  // the current one — the user wants the clone to stay visible so
  // they can flip between parent and clone without losing their
  // place.
  const parentChatId = useDb(root => {
    if (!parentSessionId) return null
    for (const c of Object.values(root.app.chats)) {
      if (c.session.kind === "ready" && c.session.sessionId === parentSessionId) {
        return c.id
      }
    }
    return null
  })

  // Live label for the parent from Zenbu's cached Pi session name.
  // Falls back to the stamped `parentTitle` payload when the parent
  // no longer exists or has no resolvable label.
  const liveParentLabel = useDb(root => {
    if (!parentSessionId) return null
    const title = root.pi.sessions[parentSessionId]?.title?.trim()
    if (title && title !== "Untitled") return title
    return null
  })

  const labelTitle =
    liveParentLabel ||
    parentTitle?.trim() ||
    (parentSessionId ? "previous session" : "an earlier session")

  const onJump = () => {
    if (!parentChatId) return
    dbClient.update(root => {
      openChatInNewTabInRoot(root, windowId, parentChatId)
    })
  }

  // Single-line layout: "<verb> from — <Title>" inline, sitting on
  // a horizontal rule. No timestamp — it's still on the underlying
  // event for debugging via the pi-event-log view, but it adds
  // visual weight here without helping anyone parse the chat.
  const verb = variant === "fork" ? "Forked from" : "Cloned from"
  return (
    <div
      role="separator"
      aria-label={`${verb} ${labelTitle}`}
      className="my-2 flex items-center gap-2 px-3"
    >
      <div className="h-px flex-1 bg-primary/30" />
      <div className="flex items-baseline gap-1.5 text-[10.5px]">
        <span className="text-primary/80">{verb}</span>
        {parentChatId && parentExists ? (
          <button
            type="button"
            onClick={onJump}
            aria-label="Open the parent session in a new tab"
            className="max-w-[280px] truncate font-medium text-foreground underline underline-offset-2 hover:no-underline"
          >
            {labelTitle}
          </button>
        ) : (
          <span className="max-w-[280px] truncate font-medium text-muted-foreground">
            {labelTitle}
            {parentSessionId && !parentExists ? " (deleted)" : ""}
          </span>
        )}
      </div>
      <div className="h-px flex-1 bg-primary/30" />
    </div>
  )
}
