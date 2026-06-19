import { useDb, useDbClient } from "@zenbujs/core/react"
import { ChatTreeRow } from "./chat-tree-row"
import { resolveChatLabel } from "@/lib/chat-label"
import { useWindowId } from "@/lib/window-state/window-id"
import { useActiveChatId } from "@/lib/window-state/active-view"
import { openChatInNewTabInRoot } from "@/lib/window-state/panes/tabs"
import type { Schema } from "@host/main/schema"
import { ArchiveIcon, MoreIcon, NewTabIcon } from "./icons"
import { ChatRowActionButton } from "./chat-row-action-button"
import { useSidebarActions } from "@/hooks/use-sidebar-actions"
import { useWorkspaceContextMenu } from "@/hooks/use-workspace-context-menu"

type Chat = Schema["chats"][string]

export type ChatSidebarItemProps = {
  chat: Chat
  /** Hide the archive affordance when this is the only chat in
   * its group. */
  canArchive: boolean
}

const NOOP = () => {}

/** Sidebar row representing one chat. Subscribes only to its own
 * session, draft, and the active-chat id — typing in chat A or
 * streaming in chat B doesn't recommit chat C's row. */
export function ChatSidebarItem({ chat, canArchive }: ChatSidebarItemProps) {
  const dbClient = useDbClient()
  const windowId = useWindowId()
  const actions = useSidebarActions()
  const contextMenus = useWorkspaceContextMenu()
  const activeChatId = useActiveChatId()

  const sessionId =
    chat.session.kind === "ready" ? chat.session.sessionId : null

  const session = useDb(root =>
    sessionId ? root.pi.sessions[sessionId] : undefined,
  )
  const { label } = resolveChatLabel(chat, session)

  // True when the active pane's chat is this chat — or shares a
  // session with it (⌘/ split-same-session keeps one row lit).
  const isActive = useDb(root => {
    if (!activeChatId) return false
    if (chat.id === activeChatId) return true
    if (chat.session.kind !== "ready") return false
    const active = root.app.chats[activeChatId]
    if (!active || active.session.kind !== "ready") return false
    return active.session.sessionId === chat.session.sessionId
  })

  // Per-row draft subscription so typing in one chat only recommits
  // this row.
  const draftText = useDb(root => root.app.chatStates[chat.id]?.draft ?? "")
  const hasDraft = !isActive && draftText.trim().length > 0

  const hasUnread =
    !isActive &&
    session != null &&
    session.lastCompletedAt != null &&
    session.lastCompletedAt > (session.lastOpenedAt ?? 0)

  return (
    <ChatTreeRow
      label={label}
      isGeneratingTitle={false}
      isActive={isActive}
      isStreaming={session?.isStreaming ?? false}
      hasUnread={hasUnread}
      hasDraft={hasDraft}
      timestamp={session?.lastActivityAt ?? chat.createdAt}
      expandable={false}
      isExpanded={false}
      onToggleExpand={NOOP}
      onClick={() => actions.handleSelectChat(chat.id)}
      onContextMenu={e => contextMenus.handleChatContextMenu(chat, e)}
      hoverActions={
        <>
          <ChatRowActionButton
            title="Open in new tab"
            onClick={() =>
              void dbClient.update(root => {
                openChatInNewTabInRoot(root, windowId, chat.id)
              })
            }
          >
            <NewTabIcon />
          </ChatRowActionButton>
          {canArchive && (
            <ChatRowActionButton
              title="Archive"
              onClick={() => actions.archiveChat(chat)}
            >
              <ArchiveIcon />
            </ChatRowActionButton>
          )}
          <ChatRowActionButton
            title="More"
            onClick={e => {
              const rect = (
                e.currentTarget as HTMLButtonElement
              ).getBoundingClientRect()
              contextMenus.handleChatContextMenu(chat, {
                clientX: rect.right,
                clientY: rect.bottom,
                preventDefault: () => {},
                stopPropagation: () => {},
              } as unknown as React.MouseEvent)
            }}
          >
            <MoreIcon />
          </ChatRowActionButton>
        </>
      }
      treeContent={null}
    />
  )
}
