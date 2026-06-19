import { nanoid } from "nanoid"
import type { EmptyChatTabResult, Root } from "../types"
import { setActiveScope } from "../selection"
import { isLiveScope, isSidebarVisibleChat } from "../visibility"
import {
  chatIdOf,
  ensureScopePanes,
  makeTab,
  pendingChatComposerId,
  setTabContent,
} from "./internal"

/** Append an unmaterialized chat tab to a pane. The tab carries
 * `chatId=null` until its first submit; the chat row + pi session
 * are created by the chat surface at send time. */
export function addTabInRoot(
  root: Root,
  windowId: string,
  scopeId: string,
  paneId: string,
): EmptyChatTabResult | null {
  if (!isLiveScope(root, scopeId)) return null
  const state = ensureScopePanes(root, windowId, scopeId)
  const paneIdx = state.panes.findIndex(p => p.id === paneId)
  if (paneIdx < 0) return null
  const tabId = nanoid()
  const pane = state.panes[paneIdx]!
  const activeIdx = pane.tabs.findIndex(t => t.id === pane.activeTabId)
  const insertAt = activeIdx < 0 ? pane.tabs.length : activeIdx + 1
  state.panes[paneIdx] = {
    ...pane,
    tabs: [
      ...pane.tabs.slice(0, insertAt),
      makeTab(tabId, { kind: "chat", chatId: null }),
      ...pane.tabs.slice(insertAt),
    ],
    activeTabId: tabId,
  }
  state.activePaneId = paneId
  setActiveScope(root, windowId, scopeId)
  return {
    kind: "empty-chat",
    scopeId,
    paneId,
    tabId,
    composerId: pendingChatComposerId(tabId),
  }
}

/** Close a tab, cascading to closing its pane when it's the last
 * tab there. If it's the only tab of the only pane, replaces the
 * tab's content with an unmaterialized chat so the layout never goes
 * empty and no abandoned session is created. */
export function closeTabInRoot(
  root: Root,
  windowId: string,
  scopeId: string,
  paneId: string,
  tabId: string,
): EmptyChatTabResult | null {
  if (!isLiveScope(root, scopeId)) return null
  const state = ensureScopePanes(root, windowId, scopeId)
  const paneIdx = state.panes.findIndex(p => p.id === paneId)
  if (paneIdx < 0) return null
  const pane = state.panes[paneIdx]!
  if (pane.tabs.length > 1) {
    const removedIdx = pane.tabs.findIndex(t => t.id === tabId)
    if (removedIdx < 0) return null
    const nextTabs = pane.tabs.filter((_, i) => i !== removedIdx)
    let nextActive = pane.activeTabId
    if (pane.activeTabId === tabId) {
      const next = nextTabs[Math.min(removedIdx, nextTabs.length - 1)]!
      nextActive = next.id
    }
    state.panes[paneIdx] = { ...pane, tabs: nextTabs, activeTabId: nextActive }
    setActiveScope(root, windowId, scopeId)
    return null
  }
  if (state.panes.length > 1) {
    const nextPanes = state.panes.filter((_, i) => i !== paneIdx)
    state.panes = nextPanes
    if (state.activePaneId === paneId) {
      const next = nextPanes[Math.min(paneIdx, nextPanes.length - 1)]!
      state.activePaneId = next.id
    }
    setActiveScope(root, windowId, scopeId)
    return null
  }
  // last tab of last pane → keep the layout invariant with a blank
  // unmaterialized chat tab instead of creating a throwaway session.
  const newTabId = nanoid()
  state.panes[paneIdx] = {
    ...pane,
    tabs: [makeTab(newTabId, { kind: "chat", chatId: null })],
    activeTabId: newTabId,
  }
  setActiveScope(root, windowId, scopeId)
  return {
    kind: "empty-chat",
    scopeId,
    paneId,
    tabId: newTabId,
    composerId: pendingChatComposerId(newTabId),
  }
}

/** Bind a chat to a specific tab and focus it. */
export function assignChatToTabInRoot(
  root: Root,
  windowId: string,
  scopeId: string,
  paneId: string,
  tabId: string,
  chatId: string,
): void {
  if (!isLiveScope(root, scopeId)) return
  const state = ensureScopePanes(root, windowId, scopeId)
  const pane = state.panes.find(p => p.id === paneId)
  if (!pane) return
  const tabIdx = pane.tabs.findIndex(t => t.id === tabId)
  if (tabIdx < 0) return
  const tab = pane.tabs[tabIdx]!
  const nextTabs = pane.tabs.slice()
  nextTabs[tabIdx] = setTabContent(tab, { kind: "chat", chatId })
  const paneIdx = state.panes.findIndex(p => p.id === paneId)
  if (paneIdx >= 0) {
    state.panes[paneIdx] = { ...pane, tabs: nextTabs, activeTabId: tabId }
  }
  state.activePaneId = paneId
  setActiveScope(root, windowId, scopeId)
}

/** Open an existing chat as a new tab in the active pane of the
 * chat's scope. Switches scope if needed. */
export function openChatInNewTabInRoot(
  root: Root,
  windowId: string,
  chatId: string,
): void {
  const chat = root.app.chats[chatId]
  if (!chat || !isSidebarVisibleChat(root, chatId)) return
  if (!root.app.scopes[chat.scopeId]) return
  setActiveScope(root, windowId, chat.scopeId)
  const state = ensureScopePanes(root, windowId, chat.scopeId)
  const paneIdx = state.panes.findIndex(p => p.id === state.activePaneId)
  const targetIdx = paneIdx >= 0 ? paneIdx : 0
  const pane = state.panes[targetIdx]!
  const tabId = nanoid()
  state.panes[targetIdx] = {
    ...pane,
    tabs: [...pane.tabs, makeTab(tabId, { kind: "chat", chatId })],
    activeTabId: tabId,
  }
}

/** Open an existing chat in a brand-new pane and focus it. */
export function openChatInNewPaneInRoot(
  root: Root,
  windowId: string,
  chatId: string,
): void {
  const chat = root.app.chats[chatId]
  if (!chat || !isSidebarVisibleChat(root, chatId)) return
  if (!root.app.scopes[chat.scopeId]) return
  setActiveScope(root, windowId, chat.scopeId)
  const state = ensureScopePanes(root, windowId, chat.scopeId)
  const paneId = nanoid()
  const tabId = nanoid()
  const after = state.panes.findIndex(p => p.id === state.activePaneId)
  const newPane = {
    id: paneId,
    tabs: [makeTab(tabId, { kind: "chat", chatId })],
    activeTabId: tabId,
  }
  const next = state.panes.slice()
  if (after >= 0) next.splice(after + 1, 0, newPane)
  else next.push(newPane)
  state.panes = next
  state.activePaneId = paneId
}

export { chatIdOf as paneTabChatId, pendingChatComposerId } from "./internal"
