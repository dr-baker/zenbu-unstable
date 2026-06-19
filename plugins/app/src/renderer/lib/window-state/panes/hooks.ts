import { useCallback } from "react"
import { useDb, useDbClient, useRpc } from "@zenbujs/core/react"
import type { OpenMode, ScopePaneStateView } from "../types"
import { useWindowId } from "../window-id"
import {
  addPaneInRoot,
  closePaneInRoot,
} from "./splits"
import {
  addTabInRoot,
  closeTabInRoot,
  openChatInNewPaneInRoot,
  openChatInNewTabInRoot,
} from "./tabs"
import {
  selectPaneInRoot,
  selectTabInRoot,
} from "../selection"
import { openViewInRoot } from "./views"

/** Subscribe to the active scope's pane layout. Returns null when
 * no scope is selected (e.g. onboarding or a freshly created
 * workspace with no scopes yet). */
export function useScopePanes(): ScopePaneStateView | null {
  const windowId = useWindowId()
  return useDb(root => {
    const ws = root.app.windowStates[windowId]
    if (!ws) return null
    const scopeId = ws.selectedScopeId
    if (!scopeId) return null
    return ws.scopePanes?.[scopeId] ?? null
  })
}

export function useSelectPane() {
  const windowId = useWindowId()
  const client = useDbClient()
  return useCallback(
    (scopeId: string, paneId: string) => {
      void client.update(root => {
        selectPaneInRoot(root, windowId, scopeId, paneId)
      })
    },
    [client, windowId],
  )
}

export function useSelectTab() {
  const windowId = useWindowId()
  const client = useDbClient()
  return useCallback(
    (scopeId: string, paneId: string, tabId: string) => {
      void client.update(root => {
        selectTabInRoot(root, windowId, scopeId, paneId, tabId)
      })
    },
    [client, windowId],
  )
}

export function useAddTab() {
  const windowId = useWindowId()
  const client = useDbClient()
  const rpc = useRpc()
  return useCallback(
    (scopeId: string, paneId: string) => {
      let result: { tabId: string; chatId: string; scopeId: string } | null = null
      void client
        .update(root => {
          result = addTabInRoot(root, windowId, scopeId, paneId)
        })
        .then(() => {
          if (!result) return
          void rpc.pi.sessions
            .createChatSession({ scopeId: result.scopeId, chatId: result.chatId })
            .catch(err =>
              console.error("[panes] addTab createChatSession failed:", err),
            )
        })
    },
    [client, rpc, windowId],
  )
}

export function useCloseTab() {
  const windowId = useWindowId()
  const client = useDbClient()
  const rpc = useRpc()
  return useCallback(
    (scopeId: string, paneId: string, tabId: string) => {
      let result: { chatId: string; scopeId: string } | null = null
      void client
        .update(root => {
          result = closeTabInRoot(root, windowId, scopeId, paneId, tabId)
        })
        .then(() => {
          if (!result) return
          void rpc.pi.sessions
            .createChatSession({ scopeId: result.scopeId, chatId: result.chatId })
            .catch(err =>
              console.error("[panes] closeTab createChatSession failed:", err),
            )
        })
    },
    [client, rpc, windowId],
  )
}

export function useAddPane() {
  const windowId = useWindowId()
  const client = useDbClient()
  const rpc = useRpc()
  return useCallback(
    (scopeId: string, afterPaneId?: string) => {
      let result: { paneId: string; chatId: string; scopeId: string } | null = null
      void client
        .update(root => {
          result = addPaneInRoot(root, windowId, scopeId, afterPaneId)
        })
        .then(() => {
          if (!result) return
          void rpc.pi.sessions
            .createChatSession({ scopeId: result.scopeId, chatId: result.chatId })
            .catch(err =>
              console.error("[panes] addPane createChatSession failed:", err),
            )
        })
    },
    [client, rpc, windowId],
  )
}

export function useClosePane() {
  const windowId = useWindowId()
  const client = useDbClient()
  return useCallback(
    (scopeId: string, paneId: string) => {
      void client.update(root => {
        closePaneInRoot(root, windowId, scopeId, paneId)
      })
    },
    [client, windowId],
  )
}

export function useOpenView() {
  const windowId = useWindowId()
  const client = useDbClient()
  return useCallback(
    (viewType: string, mode: OpenMode, args?: Record<string, unknown>) => {
      void client.update(root => {
        openViewInRoot(root, windowId, viewType, mode, args ?? {})
      })
    },
    [client, windowId],
  )
}
