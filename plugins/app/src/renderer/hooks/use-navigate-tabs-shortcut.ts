import { useEffect } from "react"
import { useDbClient, useEvents } from "@zenbujs/core/react"
import { useWindowId } from "@/lib/window-state/window-id"
import { useActiveScopeId } from "@/lib/window-state/active-view"
import { requestFocusComposer } from "@/lib/focus-composer"
import { pendingChatComposerId } from "@/lib/window-state/panes/tabs"

/** Cmd+Shift+[ / Cmd+Shift+] — cycle the active tab in the active
 * pane. Mirrors macOS-native tab navigation (Safari, Chrome, Finder,
 * Terminal, iTerm). Wraps at both ends and no-ops on a single-tab
 * pane. After the switch we route DOM focus into the newly-active
 * tab's chat composer when applicable, matching how
 * `useFocusPaneShortcut` behaves. */
export function useNavigateTabsShortcut() {
  const events = useEvents()
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const activeScopeId = useActiveScopeId()

  useEffect(() => {
    const off = events.app.navigateTabs.subscribe(({ dir }) => {
      const scopeId = activeScopeId
      if (!scopeId) return
      void (async () => {
        let targetComposerId: string | null = null
        await dbClient.update(root => {
          const state = root.app.windowStates[windowId]?.scopePanes?.[scopeId]
          if (!state) return
          const pane = state.panes.find(p => p.id === state.activePaneId)
          if (!pane || pane.tabs.length <= 1) return
          const idx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
          const from = idx < 0 ? 0 : idx
          const len = pane.tabs.length
          const delta = dir === "prev" ? -1 : 1
          const nextIdx = (from + delta + len) % len
          const nextTab = pane.tabs[nextIdx]
          if (!nextTab) return
          pane.activeTabId = nextTab.id
          if (nextTab.content.kind === "chat") {
            targetComposerId =
              nextTab.content.chatId ?? pendingChatComposerId(nextTab.id)
          }
        })
        if (targetComposerId) {
          requestFocusComposer(targetComposerId)
        }
      })()
    })
    return off
  }, [events, dbClient, windowId, activeScopeId])
}
