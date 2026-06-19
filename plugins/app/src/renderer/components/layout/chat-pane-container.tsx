import { Activity, useCallback, useEffect, useMemo, useRef } from "react"
import { nanoid } from "nanoid"
import {
  View,
  useDb,
  useDbClient,
  useInjections,
  useRpc,
} from "@zenbujs/core/react"
import type { Schema } from "../../../main/schema"
import { ChatPaneSlot } from "./chat-pane-slot"
import { PaneFrame } from "./pane-frame"
import { ChatTabs, type ChatTabEntry } from "./chat-tabs"
import { chatLabel } from "@/lib/chat-label"
import { useVisited } from "@/lib/hooks/use-visited"
import type { PaneTabView, PaneView } from "@/lib/window-state/types"
import { useWindowId } from "@/lib/window-state/window-id"
import { assignChatToTabInRoot, openChatInNewTabInRoot, paneTabChatId } from "@/lib/window-state/panes/tabs"
import { useAddPane, useAddTab, useClosePane, useCloseTab, useSelectPane, useSelectTab } from "@/lib/window-state/panes/hooks"
export type ChatPaneContainerProps = {
  scopeId: string
  pane: PaneView
  isActivePane: boolean
  /** Whether another pane sits to our left in the host layout. Forwarded
   * to ChatPane so it knows whether to round its top-left corner. */
  leftAdjacent: boolean
  rightAdjacent: boolean
  bottomAdjacent: boolean
  /** Used to suppress tab chrome when the whole host has exactly one
   * pane and that pane has exactly one tab. Both conditions need to
   * hold — a second pane with a single tab still needs its tab bar
   * so the split is legible and the close affordance is reachable. */
  hideStripWhenSingleTab: boolean
  paneCount: number
}

/** One pane in the chats host. Owns its own tab strip and renders every
 * visited tab (chat or view) under an `<Activity>` so state stays warm
 * when the user flips between tabs. Tabs whose content is a registered
 * view are mounted via `<View />`; tabs whose content is a chat are
 * mounted via `<ChatPane />`. */
export function ChatPaneContainer({
  scopeId,
  pane,
  isActivePane,
  leftAdjacent,
  rightAdjacent,
  bottomAdjacent,
  hideStripWhenSingleTab,
  paneCount,
}: ChatPaneContainerProps) {
  const chatsById = useDb(root => root.app.chats)
  const sessionsById = useDb(root => root.pi.sessions)
  const injections = useInjections()

  const activeTab = useMemo<PaneTabView | null>(
    () =>
      pane.tabs.find(t => t.id === pane.activeTabId) ?? pane.tabs[0] ?? null,
    [pane.tabs, pane.activeTabId],
  )

  // Track ids we've ever shown so React keeps DOM mounted. We key by
  // tab id (not chatId) so view tabs participate too — multiple view
  // tabs of the same type stay isolated, and switching back to a tab
  // doesn't pay the iframe boot cost again.
  const visited = useVisited(activeTab?.id ?? null)
  const visitedTabs = useMemo(
    () => pane.tabs.filter(t => visited.has(t.id)),
    [pane.tabs, visited],
  )

  const viewLabelFor = useCallback(
    (viewType: string): string => {
      const entry = injections.find(v => v.name === viewType)
      const label = entry?.meta?.label
      return typeof label === "string" ? label : formatLabel(viewType)
    },
    [injections],
  )

  const tabEntries = useMemo<ChatTabEntry[]>(
    () =>
      pane.tabs.map(t => {
        if (t.content.kind === "view") {
          // Special-case the `file` view: each instance shows a
          // different file, so the tab title should be the file's
          // basename rather than the generic registry label.
          let title = viewLabelFor(t.content.viewType)
          if (t.content.viewType === "file") {
            const p = t.content.args.path
            if (typeof p === "string" && p.length > 0) {
              title = basenameOf(p)
            }
          }
          return {
            id: t.id,
            title,
            hasChat: false,
            sessionId: null,
            isStreaming: false,
            isView: true,
          }
        }
        const chat = t.content.chatId ? chatsById[t.content.chatId] : null
        const title = chat ? chatLabel(chat, sessionsById) : "New tab"
        const sessionId =
          chat && chat.session.kind === "ready"
            ? chat.session.sessionId
            : null
        const sessionRecord = sessionId ? sessionsById[sessionId] : null
        const isStreaming = sessionRecord?.isStreaming ?? false
        // Only show unread on tabs that aren't the active tab of
        // a focused pane. `SessionActivityService` stamps
        // `lastOpenedAt` for active tabs, but it only fires AFTER
        // a db update lands — the local `t.id !== pane.activeTabId
        // || !isActivePane` guard avoids a 1-frame flash where the
        // dot would otherwise be visible on the tab the user just
        // clicked into.
        const isFocusedHere = isActivePane && t.id === pane.activeTabId
        const hasUnread =
          !isFocusedHere &&
          sessionRecord != null &&
          sessionRecord.lastCompletedAt != null &&
          sessionRecord.lastCompletedAt >
            (sessionRecord.lastOpenedAt ?? 0)
        return {
          id: t.id,
          title,
          hasChat: !!chat,
          sessionId,
          isStreaming,
          hasUnread,
          isView: false,
        }
      }),
    [pane.tabs, pane.activeTabId, isActivePane, chatsById, sessionsById, viewLabelFor],
  )

  const selectPane = useSelectPane()
  const selectTab = useSelectTab()
  const addTab = useAddTab()
  const closeTab = useCloseTab()
  const addPane = useAddPane()
  const closePane = useClosePane()
  const dbClient = useDbClient()
  const windowId = useWindowId()

  const handleSelectTab = useCallback(
    (tabId: string) => {
      selectTab(scopeId, pane.id, tabId)
    },
    [selectTab, scopeId, pane.id],
  )

  const handleCloseTab = useCallback(
    (tabId: string) => {
      closeTab(scopeId, pane.id, tabId)
    },
    [closeTab, scopeId, pane.id],
  )

  const handleNewTab = useCallback(() => {
    addTab(scopeId, pane.id)
  }, [addTab, scopeId, pane.id])

  const handleSplit = useCallback(() => {
    addPane(scopeId, pane.id)
  }, [addPane, scopeId, pane.id])

  const handleClosePane = useCallback(() => {
    closePane(scopeId, pane.id)
  }, [closePane, scopeId, pane.id])

  const handleOpenInNewTab = useCallback(
    (tabId: string) => {
      const tab = pane.tabs.find(t => t.id === tabId)
      const chatId = paneTabChatId(tab)
      if (!chatId) return
      void dbClient.update(root => {
        openChatInNewTabInRoot(root, windowId, chatId)
      })
    },
    [pane.tabs, dbClient, windowId],
  )

  const handlePaneMouseDown = useCallback(() => {
    if (!isActivePane) selectPane(scopeId, pane.id)
  }, [isActivePane, selectPane, scopeId, pane.id])

  // When the host has exactly one pane AND that pane has exactly one
  // tab, suppress the tab strip entirely (per request: don't expose
  // tab UI until the user opts in).
  const hideTabBar = hideStripWhenSingleTab && pane.tabs.length === 1
  const activeChatId = paneTabChatId(activeTab)
  const activeChat = activeChatId ? chatsById[activeChatId] : null
  const activeIsView = activeTab?.content.kind === "view"

  // Safety net for two adjacent failure modes that both manifest as
  // "the chat surface looks alive but Enter does nothing":
  //
  //   1. Legacy / edge-case data: a chat tab points at `chatId=null`
  //      (or a chatId that no longer resolves). We fabricate a fresh
  //      chat in the pane's scope and assign it to the tab, then
  //      materialize its session.
  //   2. Pending session: the chat exists but its `session` is still
  //      `{ kind: "pending" }` because whoever created it didn't (or
  //      couldn't) follow up with `createChatSession`. The most
  //      visible offender historically was the auto-created
  //      self-edit workspace (long since removed), but anything
  //      that creates a pending chat and forgets the RPC ends up
  //      here too. We just
  //      fire `createChatSession`; it's idempotent (returns the
  //      existing sessionId if the chat is already ready), so a
  //      duplicate against a race winner is harmless.
  //
  // We key the re-entrancy guard by `tab.id + chatId` so flipping
  // chats in the same tab doesn't lock the second one out, and
  // re-opening the workspace re-arms it.
  const rpc = useRpc()
  const filledTabRef = useRef<string | null>(null)
  useEffect(() => {
    if (activeIsView) return
    if (!activeTab) return
    if (activeTab.content.kind !== "chat") return

    // Case 2: the chat exists but its session is still pending.
    // Fire-and-forget the materialize RPC; the chat record flips to
    // `ready` on the next replica tick and the surface comes alive
    // without remounting.
    if (activeChat && activeChat.session.kind === "pending") {
      const guardKey = `${activeTab.id}:${activeChat.id}`
      if (filledTabRef.current === guardKey) return
      filledTabRef.current = guardKey
      void rpc.pi.sessions
        .createChatSession({
          scopeId: activeChat.scopeId,
          chatId: activeChat.id,
        })
        .catch(err =>
          console.error(
            "[chat-pane] auto materialize pending chat failed:",
            err,
          ),
        )
      return
    }

    // Case 1: no chat record under this tab — fabricate one.
    if (activeChat) return
    if (filledTabRef.current === activeTab.id) return
    filledTabRef.current = activeTab.id
    const chatId = nanoid()
    const now = Date.now()
    void dbClient
      .update(root => {
        root.app.chats[chatId] = {
          id: chatId,
          scopeId,
          session: { kind: "pending" },
          createdAt: now,
        }
        assignChatToTabInRoot(
          root,
          windowId,
          scopeId,
          pane.id,
          activeTab.id,
          chatId,
        )
      })
      .then(() => {
        void rpc.pi.sessions
          .createChatSession({ scopeId, chatId })
          .catch(err =>
            console.error("[chat-pane] auto createChatSession failed:", err),
          )
      })
  }, [
    activeIsView,
    activeChat,
    activeTab,
    dbClient,
    rpc,
    scopeId,
    pane.id,
    windowId,
  ])

  const childTopAdjacent = !hideTabBar

  return (
    <div
      onMouseDownCapture={handlePaneMouseDown}
      className="relative flex h-full min-h-0 w-full flex-col"
    >
      {!hideTabBar && (
        <ChatTabs
          entries={tabEntries}
          activeId={pane.activeTabId}
          mode="full"
          paneFocused={isActivePane}
          leftAdjacent={leftAdjacent}
          rightAdjacent={rightAdjacent}
          onSelect={handleSelectTab}
          onClose={handleCloseTab}
          onNewTab={handleNewTab}
          onSplitRight={handleSplit}
          onOpenInNewTab={handleOpenInNewTab}
          onClosePane={handleClosePane}
          canClosePane={paneCount > 1}
        />
      )}
      <div className="relative min-h-0 flex-1">
        {visitedTabs.map(tab => (
          <TabPanel
            key={tab.id}
            tab={tab}
            visible={tab.id === activeTab?.id}
            chat={
              tab.content.kind === "chat" && tab.content.chatId
                ? chatsById[tab.content.chatId] ?? null
                : null
            }
            leftAdjacent={leftAdjacent}
            rightAdjacent={rightAdjacent}
            bottomAdjacent={bottomAdjacent}
            topAdjacent={childTopAdjacent}
          />
        ))}
      </div>
    </div>
  )
}

type Chat = Schema["chats"][string]

type TabPanelProps = {
  tab: PaneTabView
  visible: boolean
  chat: Chat | null
  leftAdjacent: boolean
  rightAdjacent: boolean
  bottomAdjacent: boolean
  topAdjacent: boolean
}

function TabPanel({
  tab,
  visible,
  chat,
  leftAdjacent,
  rightAdjacent,
  bottomAdjacent,
  topAdjacent,
}: TabPanelProps) {
  // Pane chrome (including the top seam when the tab strip is
  // suppressed) is owned entirely by `PaneFrame` / `ChatPane` —
  // both already draw `border-t` when nothing adjacent above
  // claims the edge. We used to paint an extra `border-t` on this
  // wrapper for view tabs as a defensive belt-and-suspenders, but
  // it stacked on top of `PaneFrame`'s own top border and showed
  // up as a 2px-thick seam against the title bar. The wrapper is
  // back to being a neutral positioning container.
  return (
    <Activity mode={visible ? "visible" : "hidden"}>
      <div className="absolute inset-0">
        {tab.content.kind === "view" ? (
          // View tabs share the same border rules as chat tabs: only
          // draw a side when nothing adjacent already owns the line.
          // Critically that means `border-t` IS drawn when the tab
          // strip is hidden (`topAdjacent === false`), so single-tab
          // panes still get a seam against the title bar above. The
          // iframe deliberately doesn't draw any borders of its own;
          // chrome lives entirely on the host side.
          //
          // `leftAdjacent` is forced true here — mirrors ChatPane's
          // implicit "never draw a left border" policy (the sidebar /
          // outer shell owns that edge). If we ever expose a pane
          // with nothing on its left, we'll thread it through.
          <PaneFrame
            topAdjacent={topAdjacent}
            bottomAdjacent={bottomAdjacent}
            rightAdjacent={rightAdjacent}
            leftAdjacent
          >
            <View
              name={tab.content.viewType}
              args={cloneViewArgs(tab.content.args)}
              className="size-full"
              fallback={
                <div className="flex h-full items-center justify-center text-[11px] text-muted-foreground">
                  Loading view…
                </div>
              }
            />
          </PaneFrame>
        ) : (
          <ChatPaneSlot
            chat={chat}
            leftAdjacent={leftAdjacent}
            bottomAdjacent={bottomAdjacent}
            rightAdjacent={rightAdjacent}
            topAdjacent={topAdjacent}
          />
        )}
      </div>
    </Activity>
  )
}

function formatLabel(type: string): string {
  const tail = type.includes("/") ? type.split("/").pop()! : type
  return tail.replace(/[-_]/g, " ")
}

function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * `tab.content.args` comes back from the zenbu db as a *proxy* over
 * the stored object — handy for reactivity, but `postMessage` (used
 * by `<View>` to push args into the view iframe) runs the structured
 * clone algorithm, which cannot clone proxies and throws
 * `DataCloneError: ... could not be cloned`.
 *
 * Args are always shallow `Record<string, unknown>` of plain JSON
 * values (see helpers in `lib/window-state/panes/views.ts`), so a
 * round-trip through JSON is both safe and the cheapest way to
 * detach the proxy. We fall back to an empty object if the args
 * happen to contain something non-serializable rather than letting
 * the whole pane crash. */
function cloneViewArgs(
  args: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!args) return {}
  try {
    return JSON.parse(JSON.stringify(args)) as Record<string, unknown>
  } catch (err) {
    console.warn("[chat-pane-container] view args not serializable:", err)
    return {}
  }
}
