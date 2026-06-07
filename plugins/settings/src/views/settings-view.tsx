import { useCallback, useEffect, useRef } from "react";
import {
  useDb,
  useDbClient,
  type ViewComponentProps,
} from "@zenbujs/core/react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@zenbu/ui/tabs";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "@zenbu/ui/toggle-group";
import { ChatBackgroundRow } from "./panels/chat-background-row";
import { DefaultSendModeRow } from "./panels/default-send-mode-row";
import { ShortcutsPanel } from "./panels/shortcuts-panel";
import { AccountsPanel } from "./panels/accounts-panel";
import { PluginsPanel } from "./panels/plugins-panel";

type Theme = "light" | "dark" | "oled" | "system";

const THEME_OPTIONS: Theme[] = ["light", "dark", "oled", "system"];

/**
 * Tab ids for the settings view. Used as the controlled `value` for
 * the outer `<Tabs>` and also accepted as a view arg so other parts
 * of the app can deep-link directly to a specific tab.
 */
export type SettingsTab =
  | "general"
  | "accounts"
  | "shortcuts"
  | "plugins";

const VALID_TABS: ReadonlySet<SettingsTab> = new Set([
  "general",
  "accounts",
  "shortcuts",
  "plugins",
]);

type SettingsViewArgs = {
  tab?: SettingsTab;
  /** When `tab === "plugins"`, pre-select this section in the
   * Plugins-tab sidebar. Used by deep-links like pi-commands'
   * `/settings` slash command to drop the user directly on a
   * specific plugin's settings. */
  sectionId?: string;
};

/**
 * The settings view (`type: "settings"`, `rendering: "component"`).
 *
 * Lives in the host's React tree — no iframe, no postMessage bridge.
 * Args (`{ tab }`) flow in as a prop the way every component view
 * receives them.
 *
 * Last-selected tab persists in the settings plugin's own schema
 * (`root.settings.ui.lastTab`) so re-opening the panel feels sticky.
 * An explicit `args.tab` always wins; if no arg is provided we fall
 * back to whatever was last open.
 *
 * Deep-linking: the chat's empty-state auth card calls
 * `openViewInRoot(..., "settings", "new-tab", { tab: "accounts" })`
 * to drop the user directly on the Accounts tab. The `useEffect`
 * below follows re-mounts where the host passes a new tab arg.
 */
export default function SettingsView({
  args,
}: ViewComponentProps<SettingsViewArgs>) {
  const dbClient = useDbClient();
  const persistedTab = useDb(
    (root) => root.settings.ui.lastTab,
  ) as SettingsTab;

  // Always render from the persisted tab. A deep-link's `args.tab`
  // only seeds the *initial* selection (see the effect below) — it
  // must not pin the controlled value, otherwise clicking another
  // tab would write to the db but the render would keep snapping
  // back to the deep-linked tab, leaving the tabs feeling locked.
  const tab: SettingsTab = persistedTab;

  // Honor a deep-link's `{ tab }` arg by writing it into the
  // persisted last-selected tab — once per distinct arg value.
  // Tracking the last-applied arg in a ref means a re-render with
  // the same arg won't re-lock the tab after the user has clicked
  // elsewhere; only a genuinely new deep-link re-seeds it.
  const appliedTabArg = useRef<SettingsTab | null>(null);
  useEffect(() => {
    const requestedTab =
      args?.tab && VALID_TABS.has(args.tab) ? args.tab : null;
    if (!requestedTab) return;
    if (appliedTabArg.current === requestedTab) return;
    appliedTabArg.current = requestedTab;
    if (requestedTab === persistedTab) return;
    void dbClient.update((root) => {
      root.settings.ui.lastTab = requestedTab;
    });
  }, [args?.tab, persistedTab, dbClient]);

  // Honor a deep-link's `{ sectionId }` arg by pushing it into
  // the persisted last-selected section. The Plugins panel reads
  // from the db, so the change re-renders the sidebar selection
  // immediately.
  useEffect(() => {
    if (!args?.sectionId) return;
    void dbClient.update((root) => {
      root.settings.ui.lastPluginsSectionId = args.sectionId ?? null;
    });
  }, [args?.sectionId, dbClient]);

  const setTab = useCallback(
    (next: SettingsTab) => {
      void dbClient.update((root) => {
        root.settings.ui.lastTab = next;
      });
    },
    [dbClient],
  );

  return (
    // No `border-t` here on purpose: whatever sits above the view in
    // the host owns the top line. Drawing one inside the component
    // would just stack a second pixel on top.
    <div className="flex h-full w-full flex-col bg-background text-foreground">
      {/* `@container` makes this wrapper the query container so the
          settings layout responds to the *pane* width (it can be a
          full window or a narrow split), not the viewport. The
          Plugins tab + General rows below use `@max-[...]:` variants
          against it. */}
      <div className="@container mx-auto flex h-full w-full max-w-[1000px] flex-col px-6 py-6">
        <h1 className="text-[18px] font-semibold">Settings</h1>
        <Tabs
          value={tab}
          onValueChange={(value: string) => setTab(value as SettingsTab)}
          className="mt-4 flex min-h-0 flex-1 flex-col"
        >
          <TabsList>
            <TabsTrigger value="general">General</TabsTrigger>
            <TabsTrigger value="accounts">Accounts</TabsTrigger>
            <TabsTrigger value="shortcuts">Keyboard Shortcuts</TabsTrigger>
            <TabsTrigger value="plugins">Plugins</TabsTrigger>
          </TabsList>
          <TabsContent
            value="general"
            className="min-h-0 flex-1 overflow-auto"
          >
            <div className="flex flex-col gap-5 pt-3">
              <ThemeRow />
              <DefaultSendModeRow />
              <ChatBackgroundRow />
            </div>
          </TabsContent>
          <TabsContent
            value="accounts"
            className="min-h-0 flex-1 overflow-auto"
          >
            <AccountsPanel />
          </TabsContent>
          {/* `ShortcutsPanel` owns its own internal scroller, so the
              wrapper must NOT add `overflow-auto` — nested scrollers
              fight and the inner list ends up clipped early. */}
          <TabsContent value="shortcuts" className="min-h-0 flex-1">
            <ShortcutsPanel />
          </TabsContent>
          {/* Same story as `ShortcutsPanel` — `PluginsPanel` has its
              own scrollers (the sections sidebar and the items pane),
              so no `overflow-auto` here either. */}
          <TabsContent value="plugins" className="min-h-0 flex-1">
            <PluginsPanel />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

/**
 * Theme picker. Reads/writes `root.app.settings.theme` — the host's
 * `useThemeSync` (mounted at the root of the renderer) reacts to the
 * change and updates the `<html>` classes.
 */
function ThemeRow() {
  const dbClient = useDbClient();
  const preference = useDb((root) => root.app.settings.theme) as Theme;
  const setPreference = useCallback(
    (next: Theme) => {
      void dbClient.update((root) => {
        root.app.settings.theme = next;
      });
    },
    [dbClient],
  );

  return (
    <div className="flex items-center justify-between @max-[480px]:flex-wrap @max-[480px]:items-start">
      <span className="text-[12px] font-medium text-foreground">Theme</span>
      <ToggleGroup
        type="single"
        variant="outline"
        size="sm"
        value={preference}
        onValueChange={(value: string) => {
          if (value) setPreference(value as Theme);
        }}
      >
        {THEME_OPTIONS.map((option) => (
          <ToggleGroupItem
            key={option}
            value={option}
            className="capitalize text-[12px]"
          >
            {option}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}
