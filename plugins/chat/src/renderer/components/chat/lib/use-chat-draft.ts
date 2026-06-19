import { useCallback, useEffect, useRef } from "react"
import { useDbClient } from "@zenbujs/core/react"

const DEBOUNCE_MS = 250

/**
 * Per-chat persistence for the composer's input text.
 *
 * Design constraints:
 *  - Typing must not lag. Each keystroke does one ref write + one
 *    `setTimeout` reset; no React state, no replica write.
 *  - Drafts must survive abrupt teardowns (hot reload, chat switch,
 *    window close). The `useEffect` cleanup runs synchronously and
 *    flushes the pending value to the local replica before the
 *    component unmounts. Replica updates are buffered in-process, so
 *    even a fire-and-forget `update()` is safe across HMR.
 *  - `chatId` is captured by closure so the OLD chat's draft is the
 *    one persisted when switching to a new chat, never the new one.
 *  - **<Activity>-safe.** React's experimental `<Activity>` keeps a
 *    component mounted while hidden but unmounts/remounts its
 *    effects on each visibility toggle. We can't rely on `useMemo`
 *    (cache stability is not a React guarantee) or on plain effect
 *    deps (they fire on every remount). Instead we track the last
 *    `chatId` we observed in a ref and only re-initialize when it
 *    *really* changes \u2014 visibility toggles re-run the effect bodies
 *    but find `chatId` unchanged and bail out.
 */
export function useChatDraft(chatId: string) {
  const dbClient = useDbClient()
  const dbClientRef = useRef(dbClient)
  dbClientRef.current = dbClient

  // Sticky refs: only re-initialized when chatId truly changes.
  // `initialTextRef.current` is what we hand to the composer as
  // `initialText`; `latest` / `lastWritten` track in-flight edits.
  const lastChatIdRef = useRef<string | null>(null)
  const initialTextRef = useRef("")
  const latest = useRef("")
  const lastWritten = useRef("")
  const timer = useRef<number | null>(null)

  // Run during render. Safe because reads are sync and idempotent.
  // Doing this in render (not useEffect) means the value is ready to
  // return as `initialText` on the very render the chat changed \u2014
  // no setState-then-rerender lag.
  if (lastChatIdRef.current !== chatId) {
    const v =
      dbClientRef.current.readRoot().app.chatStates[chatId]?.draft ?? ""
    console.log(
      `[draft] (re)init chatId=${chatId || "<empty>"} prev=${lastChatIdRef.current ?? "<null>"} len=${v.length}`,
    )
    initialTextRef.current = v
    latest.current = v
    lastWritten.current = v
    lastChatIdRef.current = chatId
  }

  const flushDraft = useCallback(() => {
    const hadTimer = timer.current != null
    if (timer.current != null) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (!chatId) {
      console.log(
        `[draft] flush skip: no chatId (hadTimer=${hadTimer}, len=${latest.current.length})`,
      )
      return
    }
    if (latest.current === lastWritten.current) {
      console.log(
        `[draft] flush skip: clean chatId=${chatId} len=${latest.current.length} hadTimer=${hadTimer}`,
      )
      return
    }
    const value = latest.current
    const prevLen = lastWritten.current.length
    lastWritten.current = value
    console.log(
      `[draft] flush WRITE chatId=${chatId} prevLen=${prevLen} newLen=${value.length} hadTimer=${hadTimer}`,
    )
    // Capture chatId in closure so cleanup-time flush goes to the
    // right row even after the parent has re-rendered with a new
    // chatId. The `dbClient.update` is fire-and-forget: the replica
    // is updated synchronously in-process, persistence happens in
    // the background.
    void dbClientRef.current
      .update(root => {
        const prev = root.app.chatStates[chatId]
        root.app.chatStates[chatId] = {
          chatId,
          locked: prev?.locked ?? false,
          draft: value,
        }
      })
      .then(
        () => {
          console.log(
            `[draft] flush ACK chatId=${chatId} len=${value.length}`,
          )
        },
        err => {
          console.error(`[draft] flush FAILED chatId=${chatId}:`, err)
        },
      )
  }, [chatId])

  const onDraftChange = useCallback(
    (text: string) => {
      const prevLen = latest.current.length
      latest.current = text
      const rescheduled = timer.current != null
      if (timer.current != null) clearTimeout(timer.current)
      timer.current = window.setTimeout(flushDraft, DEBOUNCE_MS)
      console.log(
        `[draft] change chatId=${chatId || "<empty>"} prevLen=${prevLen} newLen=${text.length} rescheduled=${rescheduled}`,
      )
    },
    [flushDraft, chatId],
  )

  // Cleanup-time flush. Deps on `flushDraft` (which depends on chatId)
  // so the cleanup closure always carries the chatId that was active
  // when the effect was registered \u2014 the correct row to persist
  // under. Note: this still runs on every <Activity> visibility
  // toggle (mount on visible, cleanup on hidden); each toggle just
  // hits the "clean" early return because we don't reset
  // latest/lastWritten on toggles.
  useEffect(() => {
    console.log(`[draft] mount/bind cleanup chatId=${chatId || "<empty>"}`)
    return () => {
      console.log(
        `[draft] cleanup flush chatId=${chatId || "<empty>"} dirty=${latest.current !== lastWritten.current} len=${latest.current.length}`,
      )
      flushDraft()
    }
  }, [flushDraft, chatId])

  return {
    initialText: initialTextRef.current,
    onDraftChange,
    flushDraft,
  }
}
