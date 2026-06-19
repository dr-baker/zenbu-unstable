import { useEffect } from "react";
import { useDbClient, useEvents, useRpc } from "@zenbujs/core/react";
import type { SplitPaneResult } from "@/lib/window-state/types";
import { useWindowId } from "@/lib/window-state/window-id";
import { useSetWorkspaceRailOpen } from "@/lib/window-state/active-view";
import { useSetLeftSidebarOpen } from "@/lib/window-state/workspace-ui";
import {
  closeActivePaneInRoot,
  newChatInCurrentPaneInRoot,
  splitPaneNewChatInRoot,
  splitPaneSameSessionInRoot,
} from "@/lib/window-state/panes/splits";
import {
  openSettingsInRoot,
  openViewBySourceInRoot,
  openViewBySourceInWorkspaceInRoot,
  openViewInRoot,
} from "@/lib/window-state/panes/views";
import { requestFocusComposer } from "@/lib/focus-composer";
import { useSidebarActions } from "./use-sidebar-actions";

export function useAgentSidebarEvents() {
  const events = useEvents();
  const rpc = useRpc();
  const dbClient = useDbClient();
  const windowId = useWindowId();
  const setSidebarOpen = useSetLeftSidebarOpen();
  const setWorkspaceRailOpen = useSetWorkspaceRailOpen();
  const actions = useSidebarActions();

  useEffect(() => {
    const off = events.app.openFileInActivePane.subscribe(
      ({ directory, path }) => {
        void dbClient.update((root) => {
          openViewBySourceInRoot(root, windowId, "file", "file-tree-sidebar", {
            directory,
            path,
          });
        });
      },
    );
    return off;
  }, [events, dbClient, windowId]);

  useEffect(() => {
    const off = events.app.openViewInActivePane.subscribe(
      ({ viewType, source, args, placement }) => {
        void dbClient.update((root) => {
          openViewBySourceInRoot(
            root,
            windowId,
            viewType,
            source,
            args,
            placement ?? "right",
          );
        });
      },
    );
    return off;
  }, [events, dbClient, windowId]);

  useEffect(() => {
    const off = events.app.openSettings.subscribe((payload) => {
      void dbClient.update((root) => {
        const args: Record<string, unknown> = {};
        if (payload.tab) args.tab = payload.tab;
        if (payload.sectionId) args.sectionId = payload.sectionId;
        openSettingsInRoot(root, windowId, args);
      });
    });
    return off;
  }, [events, dbClient, windowId]);
  /**
   * this is surprising to me we model this as an event if its purely a db update
   */

  useEffect(() => {
    const off = events.app.openDiffInActivePane.subscribe(
      ({ workspaceId, scopeId, directory, path }) => {
        void dbClient.update((root) => {
          openViewBySourceInWorkspaceInRoot(
            root,
            windowId,
            workspaceId,
            scopeId,
            "git-diff",
            "git-tree-sidebar",
            { directory, path },
          );
        });
      },
    );
    return off;
  }, [events, dbClient, windowId]);

  useEffect(() => {
    const off = events.app.openToolOutputInActivePane.subscribe(
      ({ workspaceId, scopeId, sessionId, toolCallId }) => {
        void dbClient.update((root) => {
          openViewBySourceInWorkspaceInRoot(
            root,
            windowId,
            workspaceId,
            scopeId,
            "tool-output",
            "chat-tool-output",
            { sessionId, toolCallId },
          );
        });
      },
    );
    return off;
  }, [events, dbClient, windowId]);

  useEffect(() => {
    const off = events.app.openPullRequestsView.subscribe(
      ({ mode, prNumber, directory, openMode }) => {
        void dbClient.update((root) => {
          openViewInRoot(root, windowId, "pull-requests", openMode, {
            mode,
            prNumber,
            directory,
          });
        });
      },
    );
    return off;
  }, [events, dbClient, windowId]);

  useEffect(() => {
    const handleSplitResult = (
      result: SplitPaneResult | null,
      label: string,
    ) => {
      if (result?.kind === "empty-chat") {
        requestFocusComposer(result.composerId);
        return;
      }
      if (result?.kind === "chat" && result.needsSession) {
        void rpc.pi.sessions
          .createChatSession({
            scopeId: result.scopeId,
            chatId: result.chatId,
          })
          .catch((err) =>
            console.error(`[shortcuts] ${label} createChatSession failed:`, err),
          );
      }
    };
    const offSidebar = events.app.toggleSidebar.subscribe(() => {
      setSidebarOpen((o) => !o);
    });
    const offWorkspaceRail = events.app.toggleWorkspaceRail.subscribe(() => {
      setWorkspaceRailOpen((o) => !o);
    });
    const offSame = events.app.splitPaneSameSession.subscribe(() => {
      let result: SplitPaneResult | null = null;
      void dbClient
        .update((root) => {
          result = splitPaneSameSessionInRoot(root, windowId);
        })
        .then(() => handleSplitResult(result, "split-same-session"));
    });
    const offNew = events.app.splitPaneNewChat.subscribe(() => {
      let result: SplitPaneResult | null = null;
      void dbClient
        .update((root) => {
          result = splitPaneNewChatInRoot(root, windowId);
        })
        .then(() => handleSplitResult(result, "split-new-chat"));
    });
    const offClose = events.app.closeActivePane.subscribe(() => {
      void dbClient.update((root) => {
        closeActivePaneInRoot(root, windowId);
      });
    });
    const offNewInPane = events.app.newChatInCurrentPane.subscribe(() => {
      let result: SplitPaneResult | null = null;
      void dbClient
        .update((root) => {
          result = newChatInCurrentPaneInRoot(root, windowId);
        })
        .then(() => handleSplitResult(result, "new-chat-in-current-pane"));
    });
    return () => {
      offSidebar();
      offWorkspaceRail();
      offSame();
      offNew();
      offClose();
      offNewInPane();
    };
  }, [events, dbClient, rpc, windowId, setSidebarOpen, setWorkspaceRailOpen]);

  // ⌘N — same behaviour as the sidebar's "New Chat" button.
  useEffect(() => {
    const off = events.app.newChatReplaceActive.subscribe(() => {
      actions.handleNewChat();
    });
    return off;
  }, [events, actions.handleNewChat]);
}
