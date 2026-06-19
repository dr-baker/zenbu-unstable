import { useEffect } from "react"
import { useDbClient, useEvents } from "@zenbujs/core/react"
import { useWindowId } from "@/lib/window-state/window-id"
import { requestFocusComposer } from "@/lib/focus-composer"
import { pendingChatComposerId } from "@/lib/window-state/panes/tabs"

/** Cmd+L \u2014 move keyboard focus into the composer of the chat showing
 * in the active pane. The composer is a CodeMirror `EditorView`
 * reused across chat switches, so we go through the renderer-local
 * `requestFocusComposer(chatId)` signal rather than poking the DOM
 * directly. No-op when the active tab in the active pane isn't a
 * chat (e.g. settings, file view). */
export function useFocusActiveComposerShortcut() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()

  useEffect(() => {
    const off = events.app.focusActiveComposer.subscribe(() => {
      const ws = dbClient.readRoot().app.windowStates[windowId]
      if (!ws) return
      const scopeId = ws.selectedScopeId
      if (!scopeId) return
      const state = ws.scopePanes?.[scopeId]
      if (!state) return
      const pane =
        state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]
      if (!pane) return
      const tab =
        pane.tabs.find(t => t.id === pane.activeTabId) ?? pane.tabs[0]
      if (!tab) return
      if (tab.content.kind === "chat") {
        requestFocusComposer(
          tab.content.chatId ?? pendingChatComposerId(tab.id),
        )
      }
    })
    return off
  }, [events, dbClient, windowId])
}
