import { useMemo } from "react"
import { Allotment } from "allotment"
import { ChatPaneContainer } from "../layout/chat-pane-container"
import { ChatPaneSlot } from "../layout/chat-pane-slot"
import type { PaneView, ScopePaneStateView } from "@/lib/window-state/types"
import { useActiveScopeId } from "@/lib/window-state/active-view"
import { useScopePanes } from "@/lib/window-state/panes/hooks"
import { useDb } from "@zenbujs/core/react"

export type ChatsAreaProps = {
  leftAdjacent?: boolean
  bottomAdjacent?: boolean
  rightAdjacent?: boolean
}

/** Renders the chat working area as a horizontal Allotment of panes,
 * one per `windowState.scopePanes[scope].panes` entry. Each pane
 * owns its own tab strip and visited-tab cache.
 *
 * When no scope is selected, or no pane state has been seeded yet,
 * we render a single chat pane against the latest chat in the scope
 * so the host always shows something. Helpers in `window-state`
 * materialize the real pane state on the first user interaction. */
export function ChatsArea({
  leftAdjacent,
  bottomAdjacent,
  rightAdjacent,
}: ChatsAreaProps) {
  const scopeId = useActiveScopeId()
  const realPaneState = useScopePanes()

  const fallbackChatId = useDb(root => {
    if (!scopeId) return null
    if (realPaneState) return null
    let latestId: string | null = null
    let latestAt = -Infinity
    for (const chat of Object.values(root.app.chats)) {
      if (chat.scopeId !== scopeId) continue
      if (chat.createdAt > latestAt) {
        latestAt = chat.createdAt
        latestId = chat.id
      }
    }
    return latestId
  })

  const paneState = useMemo<ScopePaneStateView>(() => {
    if (realPaneState) return realPaneState
    // Synthetic 1-pane / 1-tab state. We render this even when
    // there's no active scope so the outer Allotment shell stays
    // mounted across the onboarding → workspace transition. If we
    // returned a non-Allotment fallback here the inner Allotment
    // would freshly mount the moment a scope appears, and its
    // ResizeObserver-driven first paint would briefly render its
    // (single) pane at 0px width — the same torn frame the outer
    // shell now pre-warms against in WorkspaceBody.
    const tabContent = { kind: "chat" as const, chatId: fallbackChatId }
    const tab = {
      id: "__synthetic_tab__",
      content: tabContent,
      history: { entries: [tabContent], index: 0 },
    }
    const pane: PaneView = {
      id: "__synthetic_pane__",
      tabs: [tab],
      activeTabId: tab.id,
    }
    return { panes: [pane], activePaneId: pane.id }
  }, [realPaneState, fallbackChatId])

  // No scope yet: render a single empty ChatPane inside the
  // Allotment shell so the shell measures itself. ChatPaneContainer
  // requires a scopeId, so we drop down to a bare ChatPane for the
  // synthetic case — it's purely visual filler.
  if (!scopeId) {
    return (
      <Allotment proportionalLayout>
        <Allotment.Pane key="__no_scope__" minSize={240}>
          <ChatPaneSlot
            chat={null}
            leftAdjacent={leftAdjacent}
            bottomAdjacent={bottomAdjacent}
            rightAdjacent={rightAdjacent}
          />
        </Allotment.Pane>
      </Allotment>
    )
  }

  const paneCount = paneState.panes.length
  const single = paneCount === 1

  return (
    <Allotment proportionalLayout>
      {paneState.panes.map((pane, idx) => {
        const isLeftmost = idx === 0
        const isRightmost = idx === paneCount - 1
        return (
          <Allotment.Pane key={pane.id} minSize={240}>
            <ChatPaneContainer
              scopeId={scopeId}
              pane={pane}
              isActivePane={single || pane.id === paneState.activePaneId}
              leftAdjacent={isLeftmost ? !!leftAdjacent : true}
              rightAdjacent={isRightmost ? !!rightAdjacent : true}
              bottomAdjacent={!!bottomAdjacent}
              hideStripWhenSingleTab={single}
              paneCount={paneCount}
            />
          </Allotment.Pane>
        )
      })}
    </Allotment>
  )
}
