import { useCallback } from "react"
import { useDb, useDbClient } from "@zenbujs/core/react"
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
import { requestFocusComposer } from "@/lib/focus-composer"

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
  return useCallback(
    (scopeId: string, paneId: string) => {
      let result: ReturnType<typeof addTabInRoot> = null
      void client
        .update(root => {
          result = addTabInRoot(root, windowId, scopeId, paneId)
        })
        .then(() => {
          if (result?.kind === "empty-chat") requestFocusComposer(result.composerId)
        })
    },
    [client, windowId],
  )
}

export function useCloseTab() {
  const windowId = useWindowId()
  const client = useDbClient()
  return useCallback(
    (scopeId: string, paneId: string, tabId: string) => {
      let result: ReturnType<typeof closeTabInRoot> = null
      void client
        .update(root => {
          result = closeTabInRoot(root, windowId, scopeId, paneId, tabId)
        })
        .then(() => {
          if (result?.kind === "empty-chat") requestFocusComposer(result.composerId)
        })
    },
    [client, windowId],
  )
}

export function useAddPane() {
  const windowId = useWindowId()
  const client = useDbClient()
  return useCallback(
    (scopeId: string, afterPaneId?: string) => {
      let result: ReturnType<typeof addPaneInRoot> = null
      void client
        .update(root => {
          result = addPaneInRoot(root, windowId, scopeId, afterPaneId)
        })
        .then(() => {
          if (result?.kind === "empty-chat") requestFocusComposer(result.composerId)
        })
    },
    [client, windowId],
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
