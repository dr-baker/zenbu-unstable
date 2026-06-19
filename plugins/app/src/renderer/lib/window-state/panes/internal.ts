import { nanoid } from "nanoid"
import type {
  PaneTabContent,
  PaneTabView,
  PaneView,
  Root,
  ScopePaneStateView,
} from "../types"
import { ensureWindowState } from "../ensure"
import { latestChatIdInScope } from "../derived"

export function makeTab(id: string, content: PaneTabContent): PaneTabView {
  return { id, content }
}

/** Replace the tab's content in place. */
export function setTabContent(
  tab: PaneTabView,
  nextContent: PaneTabContent,
): PaneTabView {
  return { id: tab.id, content: nextContent }
}

export function chatIdOf(
  tab: { content: { kind: string; chatId?: string | null } } | null | undefined,
): string | null {
  if (!tab) return null
  return tab.content.kind === "chat" ? tab.content.chatId ?? null : null
}

export function pendingChatComposerId(tabId: string): string {
  return `pending-chat:${tabId}`
}

/** Materialize a scope's pane layout, seeding it with the scope's
 * most-recent chat (or an empty chat tab if the scope has no chats
 * yet — `ChatPaneContainer` fills that in on first paint). */
export function ensureScopePanes(
  root: Root,
  windowId: string,
  scopeId: string,
): ScopePaneStateView {
  const ws = ensureWindowState(root, windowId)
  let state = ws.scopePanes[scopeId]
  if (!state) {
    const seedChatId = latestChatIdInScope(root, scopeId)
    const paneId = nanoid()
    const tabId = nanoid()
    state = {
      panes: [
        {
          id: paneId,
          tabs: [makeTab(tabId, { kind: "chat", chatId: seedChatId })],
          activeTabId: tabId,
        },
      ],
      activePaneId: paneId,
    }
    ws.scopePanes[scopeId] = state
  }
  return state
}

export function getActivePane(state: ScopePaneStateView): PaneView {
  return state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]!
}

export type ActiveContext = {
  workspaceId: string
  scopeId: string
  state: ScopePaneStateView
  activePane: PaneView
  activeTab: PaneTabView | null
  activeChatId: string | null
}

/** Resolve the active window's workspace + scope + active pane/tab.
 * Returns `null` when the window isn't on a workspace or the active
 * scope hasn't been resolved yet. */
export function getActiveContext(
  root: Root,
  windowId: string,
): ActiveContext | null {
  const ws = root.app.windowStates[windowId]
  if (!ws || ws.activeView.kind !== "workspace") return null
  const workspaceId = ws.activeView.workspaceId
  const scopeId = ws.selectedScopeId
  if (!scopeId) return null
  const state = ensureScopePanes(root, windowId, scopeId)
  const activePane =
    state.panes.find(p => p.id === state.activePaneId) ?? state.panes[0]
  if (!activePane) return null
  const activeTab =
    activePane.tabs.find(t => t.id === activePane.activeTabId) ??
    activePane.tabs[0] ??
    null
  return {
    workspaceId,
    scopeId,
    state,
    activePane,
    activeTab,
    activeChatId: chatIdOf(activeTab),
  }
}

/** Insert a new pane after `afterPaneId`, holding a single chat tab. */
export function insertPaneWithChat(
  state: ScopePaneStateView,
  afterPaneId: string,
  chatId: string,
): string {
  const paneId = nanoid()
  const tabId = nanoid()
  const newPane = {
    id: paneId,
    tabs: [makeTab(tabId, { kind: "chat", chatId })],
    activeTabId: tabId,
  }
  const after = state.panes.findIndex(p => p.id === afterPaneId)
  const next = state.panes.slice()
  if (after >= 0) next.splice(after + 1, 0, newPane)
  else next.push(newPane)
  state.panes = next
  state.activePaneId = paneId
  return paneId
}

