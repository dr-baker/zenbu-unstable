import { definePlugin } from "@zenbujs/core/config";

/**
 * Settings plugin.
 *
 * Two component views, no iframes:
 *
 *   - `"settings"` — the main settings panel (theme, send-mode,
 *     chat background, accounts, pi, keyboard shortcuts). Rendered
 *     in any pane the same way as every other view, plus opened
 *     globally (workspace-less) when triggered from the rail.
 *   - `"settings-rail-button"` — a `meta.kind = "workspace-rail"`
 *     view that draws the gear button at the bottom of the host's
 *     workspace rail. Clicking it emits `events.app.openSettings`,
 *     which the host already routes to `openSettingsInRoot`.
 *
 * Owns its own DB section (`root.settings.ui`) for state that is
 * truly internal to the settings UI — currently just the last
 * selected tab so deep-linking and re-opening feel sticky. The
 * actual configuration the panels read/write (`root.app.settings.*`,
 * pi auth, etc.) lives in the plugins that own those subsystems
 * and is accessed via the typed `dependsOn` surface.
 */
export default definePlugin({
  name: "settings",
  services: ["./src/main/services/*.ts"],
  schema: "./src/main/schema.ts",
  migrations: "./migrations",
  dependsOn: [
    { name: "pi", from: "../pi/zenbu.plugin.ts" },{ name: "app", from: "../../zenbu.config.ts" }],
  icons: {
    // lucide: settings
    settings:
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>',
  },
});
