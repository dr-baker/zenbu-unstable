import { useCallback } from "react";
import { useDb, useDbClient } from "@zenbujs/core/react";
import type { ActiveView } from "./types";
import { useWindowId } from "./window-id";
import { activeWorkspaceIdOf } from "./derived";
import { ensureWindowState } from "./ensure";
import {
  selectChatInRoot,
  selectScopeInRoot,
  selectWorkspaceInRoot,
} from "./selection";

export function useActiveView() {
  const windowId = useWindowId();
  return useDb(
    (root) =>
      root.app.windowStates[windowId]?.activeView ?? { kind: "onboarding" },
  );
}

export function useActiveWorkspaceId(): string | null {
  const windowId = useWindowId();
  return useDb((root) => activeWorkspaceIdOf(root.app.windowStates[windowId]));
}

export function useActiveScopeId(): string | null {
  const windowId = useWindowId();
  return useDb(
    (root) => root.app.windowStates[windowId]?.selectedScopeId ?? null,
  );
}

/** Active chat = active tab in the active scope's panes. Falls
 * back to "any chat tab visible somewhere" so views like Files
 * don't make the sidebar lose its highlight. */
export function useActiveChatId(): string | null {
  const windowId = useWindowId();
  return useDb((root) => {
    const ws = root.app.windowStates[windowId];
    if (!ws) return null;
    const scopeId = ws.selectedScopeId;
    if (!scopeId) return null;
    const paneState = ws.scopePanes?.[scopeId];
    if (!paneState) return null;
    const pane =
      paneState.panes.find((p) => p.id === paneState.activePaneId) ??
      paneState.panes[0];
    const tab =
      pane?.tabs.find((t) => t.id === pane.activeTabId) ?? pane?.tabs[0];
    if (tab?.content.kind === "chat" && tab.content.chatId) {
      return tab.content.chatId;
    }
    // Fall through: pick any chat tab visible in this scope's panes.
    for (const p of paneState.panes) {
      const active = p.tabs.find((t) => t.id === p.activeTabId) ?? p.tabs[0];
      if (active?.content.kind === "chat" && active.content.chatId) {
        return active.content.chatId;
      }
    }
    for (const p of paneState.panes) {
      for (const t of p.tabs) {
        if (t.content.kind === "chat" && t.content.chatId)
          return t.content.chatId;
      }
    }
    return null;
  });
}

export function useSelectWorkspace() {
  const windowId = useWindowId();
  const client = useDbClient();
  return useCallback(
    (workspaceId: string) => {
      void client.update((root) => {
        selectWorkspaceInRoot(root, windowId, workspaceId);
      });
    },
    [client, windowId],
  );
}

export function useSelectScope() {
  const windowId = useWindowId();
  const client = useDbClient();
  return useCallback(
    (scopeId: string) => {
      void client.update((root) => {
        selectScopeInRoot(root, windowId, scopeId);
      });
    },
    [client, windowId],
  );
}

export function useSelectChat() {
  const windowId = useWindowId();
  const client = useDbClient();
  return useCallback(
    (chatId: string) => {
      void client.update((root) => {
        selectChatInRoot(root, windowId, chatId);
      });
    },
    [client, windowId],
  );
}

export function useShowOnboardingView() {
  const windowId = useWindowId();
  const client = useDbClient();
  return useCallback(() => {
    void client.update((root) => {
      const ws = ensureWindowState(root, windowId);
      ws.activeView = { kind: "onboarding" };
    });
  }, [client, windowId]);
}

export function useWorkspaceRailOpen(): boolean {
  const windowId = useWindowId();
  // On by default; user toggles via ⌘⇧B.
  return useDb(
    (root) => root.app.windowStates[windowId]?.workspaceRailOpen ?? true,
  );
}

export function useSetWorkspaceRailOpen() {
  const windowId = useWindowId();
  const client = useDbClient();
  return useCallback(
    (open: boolean | ((prev: boolean) => boolean)) => {
      void client.update((root) => {
        const ws = ensureWindowState(root, windowId);
        const prev = ws.workspaceRailOpen ?? true;
        ws.workspaceRailOpen = typeof open === "function" ? open(prev) : open;
      });
    },
    [client, windowId],
  );
}
