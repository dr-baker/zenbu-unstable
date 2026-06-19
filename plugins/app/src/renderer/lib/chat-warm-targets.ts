import type { Schema } from "../../main/schema"
import type { PaneView } from "./window-state/types"

export type ChatWarmTarget = {
  chatId: string
  sessionId: string
  scopeId: string
  reason: "open-tab" | "scope-chat" | "workspace-chat"
  priority: number
}

export type ChatWarmStatus = {
  activeChatId: string | null
  queuedChatIds: string[]
  completedChatIds: string[]
  targetCount: number
}

type Chat = Schema["chats"][string]
type Scope = Schema["scopes"][string]

export function chatWarmTargetsForPane(args: {
  pane: PaneView
  activeTabId: string | null
  scopeId: string
  chatsById: Record<string, Chat | undefined>
  scopesById: Record<string, Scope | undefined>
  maxTargets?: number
}): ChatWarmTarget[] {
  const maxTargets = args.maxTargets ?? 12
  const currentScope = args.scopesById[args.scopeId]
  const workspaceScopeIds = new Set(
    currentScope
      ? Object.values(args.scopesById)
          .filter(scope => scope?.workspaceId === currentScope.workspaceId)
          .map(scope => scope!.id)
      : [args.scopeId],
  )
  const byChatId = new Map<string, ChatWarmTarget>()

  const add = (target: ChatWarmTarget) => {
    const existing = byChatId.get(target.chatId)
    if (!existing || target.priority < existing.priority) {
      byChatId.set(target.chatId, target)
    }
  }

  let openTabRank = 0
  for (const tab of args.pane.tabs) {
    if (tab.id === args.activeTabId) continue
    if (tab.content.kind !== "chat" || !tab.content.chatId) continue
    const chat = args.chatsById[tab.content.chatId]
    if (!chat || chat.session.kind !== "ready") continue
    add({
      chatId: chat.id,
      sessionId: chat.session.sessionId,
      scopeId: chat.scopeId,
      reason: "open-tab",
      priority: openTabRank++,
    })
  }

  const activeChatId = activeChatIdForPane(args.pane, args.activeTabId)
  const otherChats = Object.values(args.chatsById)
    .filter((chat): chat is Chat => {
      if (!chat || chat.id === activeChatId) return false
      if (chat.session.kind !== "ready") return false
      return workspaceScopeIds.has(chat.scopeId)
    })
    .sort((a, b) => b.createdAt - a.createdAt)

  let scopeRank = 0
  let workspaceRank = 0
  for (const chat of otherChats) {
    const sameScope = chat.scopeId === args.scopeId
    add({
      chatId: chat.id,
      sessionId: chat.session.sessionId,
      scopeId: chat.scopeId,
      reason: sameScope ? "scope-chat" : "workspace-chat",
      priority: sameScope ? 100 + scopeRank++ : 200 + workspaceRank++,
    })
  }

  return [...byChatId.values()]
    .sort((a, b) => a.priority - b.priority || a.chatId.localeCompare(b.chatId))
    .slice(0, maxTargets)
}

function activeChatIdForPane(pane: PaneView, activeTabId: string | null): string | null {
  const activeTab = pane.tabs.find(tab => tab.id === activeTabId)
  if (!activeTab || activeTab.content.kind !== "chat") return null
  return activeTab.content.chatId
}
