import { lazy, Suspense, useEffect, useMemo } from "react";
import { View, useDb, useDbClient } from "@zenbujs/core/react";
import { WorkspaceShell } from "./workspace-shell/workspace-shell";
import { TooltipProvider } from "@zenbu/ui/tooltip";
import { useThemeSync } from "@/lib/theme";
import { useAnalyticsSync } from "@/lib/analytics";
import { useWindowId } from "@/lib/window-state/window-id";
import { useActiveView, useShowOnboardingView } from "@/lib/window-state/active-view";
import { selectWorkspaceInRoot } from "@/lib/window-state/selection";
import { useSidebarTabSync } from "@/lib/window-state/sidebar-tab-sync";
import { perfTrace } from "@/lib/perf-trace";
import { PerfTraceRpcBridge } from "./perf-trace-rpc-bridge";
/**
 * we don't really need to lazy load this, can remove
 */

const AgentCompletionNotifier = lazy(() =>
  import("./agent-completion-notifier").then((m) => ({
    default: m.AgentCompletionNotifier,
  })),
)
const AgentsPalette = lazy(() =>
  import("./command-palette/agents-palette").then((m) => ({
    default: m.AgentsPalette,
  })),
)
const CommandPalette = lazy(() =>
  import("./command-palette/palette").then((m) => ({
    default: m.CommandPalette,
  })),
)
const KilledAgentsWatcher = lazy(() =>
  import("./killed-agents-watcher").then((m) => ({
    default: m.KilledAgentsWatcher,
  })),
)
const NotifyListener = lazy(() =>
  import("./notify-listener").then((m) => ({ default: m.NotifyListener })),
)
const OAuthFlowModal = lazy(() =>
  import("./auth/oauth-flow-modal").then((m) => ({
    default: m.OAuthFlowModal,
  })),
)
const Toaster = lazy(() =>
  import("./toaster").then((m) => ({ default: m.Toaster })),
)

function markAppReady(name: string) {
  try {
    ;(window as any).__zenbuBootTrace?.mark(name)
  } catch {}
}

function AppReadyMarker() {
  useEffect(() => {
    markAppReady("app-react-committed")
    requestAnimationFrame(() => {
      markAppReady("app-first-frame-after-commit")
    })
  }, [])
  return null
}

function PerfTraceSettingsSync() {
  const enabled = useDb(
    root => (root.app.settings as { perfTrace?: boolean }).perfTrace ?? false,
  )
  useEffect(() => {
    if (enabled) perfTrace.enable()
  }, [enabled])
  return null
}

/**
 * Read the `?route=<injection>` URL param the framework's
 * `WindowService.openWindow({ injection })` stamps into sub-window
 * URLs. When present, `App` renders `<View name={route} />` instead
 * of the default workspace shell so each new BrowserWindow lands
 * on the right top-level component (e.g. `chat-window`).
 */
function useRoute(): string | null {
  return useMemo(() => {
    if (typeof window === "undefined") return null
    return new URLSearchParams(window.location.search).get("route")
  }, [])
}

export function App() {
  markAppReady("app-function-entered")
  const route = useRoute()
  useSidebarTabSync()
  if (route) {
    // Sub-window: defer entirely to the injection. The injection
    // ships its own chrome (title bar, modals, etc.) so the host
    // doesn't try to wrap it with workspace UI it doesn't want.
    return (
      <TooltipProvider>
        <PerfTraceRpcBridge />
        <PerfTraceSettingsSync />
        <View name={route} args={{}} />
        <Suspense fallback={null}>
          <NotifyListener />
          <OAuthFlowModal />
          <Toaster position="top-right" />
        </Suspense>
      </TooltipProvider>
    )
  }
  const workspaces = useDb((root) =>
    Object.values(root.app.workspaces).filter((w) => !w.archived),
  );
  const activeView = useActiveView();
  const windowId = useWindowId();
  const dbClient = useDbClient();
  const showOnboardingView = useShowOnboardingView();
  useThemeSync();
  useAnalyticsSync();

  useReconcileActiveViewWithWorkspaces(
    workspaces,
    activeView,
    dbClient,
    windowId,
    showOnboardingView,
  );

  return (
    <TooltipProvider>
      <PerfTraceRpcBridge />
      <PerfTraceSettingsSync />
      <div className="flex h-full flex-col ">
        <div className="min-h-0 flex-1">
          <WorkspaceShell />
        </div>
      </div>
      <AppReadyMarker />
      <Suspense fallback={null}>
        <CommandPalette />
        <AgentsPalette />
        <KilledAgentsWatcher />
        <AgentCompletionNotifier />
        <NotifyListener />
        <OAuthFlowModal />
        <Toaster position="top-right" />
      </Suspense>
    </TooltipProvider>
  );
}

function useReconcileActiveViewWithWorkspaces(
  workspaces: Array<{ id: string; createdAt: number }>,
  activeView: any,
  dbClient: any,
  windowId: string,
  showOnboardingView: () => void,
) {
  useEffect(() => {
    // Don't override onboarding.
    if (activeView.kind === "onboarding") return;

    // Only check if we're focused on a workspace.
    if (activeView.kind === "workspace") {
      // If the workspace still exists, nothing to do.
      const exists = workspaces.some((w) => w.id === activeView.workspaceId);
      if (exists) return;

      // Pick the newest workspace, or show onboarding if none.
      const newest = workspaces
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      if (newest) {
        void dbClient.update((root: any) => {
          selectWorkspaceInRoot(root, windowId, newest.id);
        });
      } else {
        showOnboardingView();
      }
    }
  }, [workspaces, activeView, dbClient, windowId, showOnboardingView]);
}
