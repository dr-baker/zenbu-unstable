import { useEffect } from "react"
import { useDbClient, useEvents, useRpc } from "@zenbujs/core/react"
import type { SplitPaneResult } from "@/lib/window-state/types"
import { useWindowId } from "@/lib/window-state/window-id"
import { useActiveScopeId } from "@/lib/window-state/active-view"
import { splitPaneSameSessionInRoot } from "@/lib/window-state/panes/splits"
import { pendingChatComposerId } from "@/lib/window-state/panes/tabs"
import { requestFocusComposer } from "@/lib/focus-composer"

/** Cmd+1…Cmd+9 — focus pane N in the active scope. If pane N doesn't
 * exist (only for the immediate next slot) split-same-session to
 * create it first. */
export function useFocusPaneShortcut() {
  const events = useEvents()
  const rpc = useRpc()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const activeScopeId = useActiveScopeId()

  useEffect(() => {
    const off = events.app.focusPane.subscribe(({ index }) => {
      const i = index - 1
      if (i < 0 || i > 8) return
      const scopeId = activeScopeId
      if (!scopeId) return
      void (async () => {
        let needCreate = false
        const ws = dbClient.readRoot().app.windowStates[windowId]
        const state = ws?.scopePanes?.[scopeId]
        const existing = state?.panes[i]
        if (!existing) {
          // Only auto-create for the immediate next slot — Cmd+7 on
          // a single-pane scope shouldn't silently create pane 7
          // with six implicit empty panes in front of it.
          if (state && i === state.panes.length) {
            needCreate = true
          } else {
            return
          }
        }
        let result: SplitPaneResult | null = null
        if (needCreate) {
          await dbClient.update(root => {
            result = splitPaneSameSessionInRoot(root, windowId)
          })
        } else {
          await dbClient.update(root => {
            const s =
              root.app.windowStates[windowId]?.scopePanes?.[scopeId]
            const p = s?.panes[i]
            if (s && p) {
              s.activePaneId = p.id
            }
          })
        }
        // After the update, refocus into the now-active pane.
        const afterWs = dbClient.readRoot().app.windowStates[windowId]
        const afterState = afterWs?.scopePanes?.[scopeId]
        const afterPane = afterState?.panes[i]
        if (afterPane) {
          const activeTab = afterPane.tabs.find(
            t => t.id === afterPane.activeTabId,
          )
          if (activeTab?.content.kind === "chat") {
            requestFocusComposer(
              activeTab.content.chatId ?? pendingChatComposerId(activeTab.id),
            )
          }
        }
        // TS CFA can't see the closure assignment inside
        // `dbClient.update(...)`, so `result` is narrowed back to
        // `null` here. The other shortcut handlers read inside
        // `.then(...)` which is itself a closure and opaque to CFA;
        // we can't use that shape here because we want to interleave
        // the read with synchronous pane-state lookups.
        const finalResult = result as SplitPaneResult | null
        if (finalResult?.kind === "chat" && finalResult.needsSession) {
          void rpc.pi.sessions
            .createChatSession({
              scopeId: finalResult.scopeId,
              chatId: finalResult.chatId,
            })
            .catch(err =>
              console.error(
                "[shortcuts] focusPane createChatSession failed:",
                err,
              ),
            )
        }
      })()
    })
    return off
  }, [events, dbClient, rpc, windowId, activeScopeId])
}
