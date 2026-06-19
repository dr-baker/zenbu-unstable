import { useCallback, useMemo } from "react"
import { useDb, useDbClient } from "@zenbujs/core/react"
import { useThemeSync } from "@/lib/theme"
import { useWindowId } from "@/lib/window-state/window-id"
import { useHasTrafficLights } from "@/lib/window-state/has-traffic-lights"
import { ChatPane } from "../../components/chat/chat-pane"
import { OAuthFlowModal } from "@/components/auth/oauth-flow-modal"
import {
  ChatTabs,
  type ChatTabEntry,
} from "@/components/layout/chat-tabs"
import { chatLabel } from "@/lib/chat-label"
import type { Schema } from "@host/main/schema"

type Chat = Schema["chats"][string]

/**
 * Standalone chat-window view. A flat tab strip at the top (one tab
 * per chat the user has popped into this window) over the active
 * chat's `<ChatPane>`. Tab + active state lives in
 * `root.app.chatWindows[windowId]` so right-click → "Open in new
 * window" appends a tab live with no RPC round trip on the renderer
 * side.
 *
 * Intentionally has no pane concept — this is a single-pane view.
 * The tab strip is the same `<ChatTabs>` component the main app's
 * pane container uses, just with the pane-related actions
 * (`onNewTab`, `onSplitRight`, `onClosePane`) omitted.
 */
export function ChatWindowApp() {
  useThemeSync()
  const windowId = useWindowId()
  const dbClient = useDbClient()
  const hasTrafficLights = useHasTrafficLights()

  const state = useDb(root => root.app.chatWindows[windowId] ?? null)
  const tabIds = state?.tabs ?? []
  const activeId =
    state?.activeChatId && tabIds.includes(state.activeChatId)
      ? state.activeChatId
      : tabIds[tabIds.length - 1] ?? null

  const chatsById = useDb(root => root.app.chats)
  const sessionsById = useDb(root => root.pi.sessions)

  const entries = useMemo<ChatTabEntry[]>(
    () =>
      tabIds.map(chatId => {
        const chat = chatsById[chatId]
        const sessionId =
          chat && chat.session.kind === "ready"
            ? chat.session.sessionId
            : null
        return {
          // ChatTabs keys by `id`; we use the chatId directly since
          // there's exactly one tab per chat in this view.
          id: chatId,
          title: chat ? chatLabel(chat, sessionsById) : "Missing chat",
          hasChat: !!chat,
          sessionId,
        }
      }),
    [tabIds, chatsById, sessionsById],
  )

  const activeChat: Chat | null = activeId ? chatsById[activeId] ?? null : null

  const handleSelect = useCallback(
    (chatId: string) => {
      void dbClient.update(root => {
        const entry = root.app.chatWindows[windowId]
        if (!entry) return
        entry.activeChatId = chatId
      })
    },
    [dbClient, windowId],
  )

  const handleClose = useCallback(
    (chatId: string) => {
      void dbClient.update(root => {
        const entry = root.app.chatWindows[windowId]
        if (!entry) return
        const idx = entry.tabs.indexOf(chatId)
        if (idx < 0) return
        entry.tabs.splice(idx, 1)
        if (entry.activeChatId === chatId) {
          // Prefer the neighbor on the right, fall back to the left.
          const next = entry.tabs[idx] ?? entry.tabs[idx - 1] ?? null
          entry.activeChatId = next
        }
      })
    },
    [dbClient, windowId],
  )

  return (
    <div
      className={
        "flex h-screen w-screen min-h-0 min-w-0 flex-col overflow-hidden bg-muted bg-clip-padding" +
        (hasTrafficLights ? " border" : "")
      }
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      {/* Traffic-light gutter — keeps the macOS controls clear of the
          first tab and stays draggable. */}
      <div className="flex h-8 shrink-0 items-stretch">
        {/* h-8 to match `ChatTabs` h-8 — keeps the bar's bottom crease
            aligned with the sidebar tab bar across windows. */}
        {hasTrafficLights && <div className="w-[72px] shrink-0" />}
        <div
          className="flex min-w-0 flex-1 items-stretch"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <ChatTabs
            entries={entries}
            activeId={activeId ?? ""}
            mode="full"
            onSelect={handleSelect}
            onClose={handleClose}
          />
        </div>
      </div>
      <div
        className="flex min-h-0 min-w-0 flex-1"
        style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
      >
        {tabIds.length === 0 ? (
          <EmptyState message="No chats open. Right-click a chat in the main window to add one here." />
        ) : !activeChat ? (
          <EmptyState message="Chat not found. It may have been deleted." />
        ) : (
          <ChatPane key={activeChat.id} chat={activeChat} topAdjacent />
        )}
      </div>
      {/* Mirror the main window's OAuth modal so a sign-in kicked
       * off from inside a popped-out chat window has a place to
       * complete. The flow record is replicated, so both windows
       * render the same modal off the same `oauthFlow` state. */}
      <OAuthFlowModal />
    </div>
  )
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-1 items-center justify-center bg-background p-4 text-center text-[12px] text-muted-foreground">
      {message}
    </div>
  )
}
